// Nightly integrity sweep for pre-written canonicals — the DETECTION layer
// for issue #114. The canonical-board paths (dailyBoard, weeklyBoard,
// dailyMeta, cruxes) are write-once but writable by ANY authenticated user,
// and clients play fetched canonicals verbatim. An attacker could pre-write
// a poisoned (unsolvable / lying-numbers) board for a far-future date and
// the legit precompute would silently skip it as "already written". This
// sweep re-verifies every FUTURE-dated canonical with the same solver the
// generator used and FAILS THE WORKFLOW LOUDLY on any mismatch — poison is
// caught days before it goes live, while the regenerate workflow can still
// replace it. Remediation for a failing date:
//   gh workflow run regenerate-daily-board.yml -f date=YYYY-MM-DD -f dryRun=false
// (for the CURRENT week's weeklyBoard, investigate first — regenerating a
// live week wipes its leaderboard and attempt markers).
//
// Read-only: every checked path is world-readable, so this needs NO secrets.
//
// Checks per future dailyBoard/{date} (and current/future weeklyBoard):
//   1. deserializes cleanly, sane dimensions, mine count === totalMines
//   2. adjacency + displayed-number layers recompute byte-identically
//      (recalcAllAdjacency + recomputeDisplayedMines — catches lying numbers;
//      the liar offset is stored per cell, so recompute is deterministic)
//   3. certifies from board center under the board's own gatedCert contract
//      (same acceptance as the generator: solvable || remainingUnknowns === 0)
//   4. dailyMeta features: STRUCTURAL keys must match a recompute exactly;
//      solver-derived move counts are warn-only (a solver change landing
//      mid-week may legitimately drift counts on boards written days ago)
//   5. cruxes payload is SOUND: its own numbers admit at least one provably
//      safe cell, and the claimed answer (when present) is among them
//
// Usage: node scripts/verify-canonical-boards.mjs   (exit 1 on any failure)

import { pathToFileURL } from 'node:url';
import { deserializeBoard } from '../src/firebase/dailyBoardSync.js';
import { recomputeDisplayedMines, recalcAllAdjacency } from '../src/logic/gimmicks.js';
import { isBoardSolvable, findDeducibleFrontier } from '../src/logic/boardSolver.js';
import { cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import { computeDailyFeatures } from '../src/logic/dailyFeatures.js';
import { getLocalDateString, getWeekStart } from '../src/logic/seededRandom.js';
import { SIGNATURE_EPOCH, verifyCanonicalPayloadSig } from '../src/logic/canonicalSignature.js';

/**
 * Signature gate for a FUTURE-dated canonical (issue #114): post-epoch it
 * must carry a VALID signature — the unsigned first-client-fallback shape is
 * written same-day, never ahead, so any unsigned future board is either
 * poison or a pipeline that lost its signing key. Pre-epoch boards pass.
 * @returns {Promise<{ok: boolean, reasons: string[]}>}
 */
export async function verifyFutureSignature(raw, key) {
  if (String(key).slice(0, 10) < SIGNATURE_EPOCH) return { ok: true, reasons: [] };
  if (!raw || typeof raw.sig !== 'string') {
    return { ok: false, reasons: ['post-epoch future canonical is UNSIGNED'] };
  }
  const valid = await verifyCanonicalPayloadSig(raw);
  return valid ? { ok: true, reasons: [] } : { ok: false, reasons: ['signature INVALID'] };
}

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';

// Feature keys that are pure structure — identical under any solver version,
// so a mismatch can only be tampering (or a real generator bug). The
// solver-derived move-type counts drift legitimately when solver changes
// land between a board's precompute night and this sweep, so they warn.
const STRUCTURAL_FEATURE_KEYS = [
  'rows', 'cols', 'cellCount', 'totalMines', 'wallEdgeCount',
  'mysteryCellCount', 'sonarCellCount', 'compassCellCount', 'wormholeCellCount',
  'liarCellCount', 'mirrorCellCount', 'lockedCellCount',
  'wormLoad',
];

/**
 * Verify one canonical board payload (daily or weekly — same format).
 * @param {Object} raw the dailyBoard/{date} or weeklyBoard/{weekStart} node
 * @returns {{ ok: boolean, reasons: string[], check: Object|null }}
 */
export function verifyCanonicalPayload(raw) {
  const reasons = [];
  let d;
  try {
    d = deserializeBoard(raw);
  } catch (e) {
    return { ok: false, reasons: [`deserialize failed: ${e.message}`], check: null };
  }
  const { board, rows, cols, totalMines } = d;

  // 1. Shape sanity.
  if (!(rows >= 5 && rows <= 30 && cols >= 5 && cols <= 30)) {
    reasons.push(`implausible dimensions ${rows}x${cols}`);
  }
  const cells = board.flat();
  const mineCount = cells.filter((c) => c.isMine).length;
  if (mineCount !== totalMines) {
    reasons.push(`mine count ${mineCount} !== totalMines ${totalMines}`);
  }
  if (reasons.length) return { ok: false, reasons, check: null };

  // 2. The stored number layers must recompute byte-identically. Snapshot,
  // recompute in the same order the generator does (adjacency first, then
  // the gimmick display layer), and diff.
  const storedAdj = cells.map((c) => c.adjacentMines);
  const storedDisp = cells.map((c) => c.displayedMines);
  recalcAllAdjacency(board);
  recomputeDisplayedMines(board);
  const adjDiffs = cells.filter((c, i) => c.adjacentMines !== storedAdj[i]).length;
  const dispDiffs = cells.filter((c, i) => c.displayedMines !== storedDisp[i]).length;
  if (adjDiffs > 0) reasons.push(`${adjDiffs} cell(s) with inconsistent adjacentMines`);
  if (dispDiffs > 0) reasons.push(`${dispDiffs} cell(s) with inconsistent displayedMines`);
  if (reasons.length) return { ok: false, reasons, check: null };

  // 3. Re-certify from board center under the board's own contract flag
  // (deserializeBoard restored _gatedCert). Same acceptance as the
  // generator's hard gate.
  const fr = Math.floor(rows / 2), fc = Math.floor(cols / 2);
  const check = isBoardSolvable(board, rows, cols, fr, fc);
  cleanSolverArtifacts(board);
  if (!(check.solvable || check.remainingUnknowns === 0)) {
    reasons.push(`board does NOT certify from center (${check.remainingUnknowns} unknowns left)`);
    return { ok: false, reasons, check };
  }
  return { ok: true, reasons: [], check };
}

/**
 * Verify a dailyMeta node against its (already-verified) board payload.
 * @returns {{ ok: boolean, reasons: string[], warnings: string[] }}
 */
export function verifyMetaAgainstBoard(raw, meta) {
  if (!meta || typeof meta.features !== 'object') {
    return { ok: false, reasons: ['dailyMeta missing or has no features node'], warnings: [] };
  }
  const d = deserializeBoard(raw);
  const fr = Math.floor(d.rows / 2), fc = Math.floor(d.cols / 2);
  const check = isBoardSolvable(d.board, d.rows, d.cols, fr, fc);
  cleanSolverArtifacts(d.board);
  const recomputed = computeDailyFeatures(
    // rngSeed drives the wormLoad recompute (per-egg lengths + the board's
    // move budget both derive from it)
    { board: d.board, rows: d.rows, cols: d.cols, totalMines: d.totalMines, activeGimmicks: d.activeGimmicks, rngSeed: d.rngSeed || '' },
    check,
  );
  const reasons = [];
  const warnings = [];
  for (const [key, val] of Object.entries(recomputed)) {
    const stored = meta.features[key];
    if (stored === val) continue;
    // A key ABSENT from the stored meta with a zero recompute is a feature
    // that didn't exist when the meta was written (e.g. wormLoad on a
    // board precomputed before worm tiles shipped) — pipeline vintage, not
    // tampering. A board that actually CARRIES the feature (recompute > 0)
    // against a meta without the key still hard-fails: an old pipeline
    // cannot have produced it.
    if (stored === undefined && val === 0) continue;
    if (STRUCTURAL_FEATURE_KEYS.includes(key)) {
      reasons.push(`features.${key}: stored ${stored} !== recomputed ${val}`);
    } else {
      warnings.push(`features.${key}: stored ${stored} vs recomputed ${val} (solver-derived; drift possible)`);
    }
  }
  return { ok: reasons.length === 0, reasons, warnings };
}

/**
 * Soundness check for a cruxes/{date} payload: from its OWN numbers + walls,
 * at least one cell must be provably safe, and the claimed answer (when
 * present) must be among them. Mirrors the teaser page's client-side
 * recompute, so it is version-independent — a stale-but-honest crux passes,
 * a lying one cannot.
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function verifyCruxPayload(crux) {
  if (!crux || !Number.isInteger(crux.rows) || !Number.isInteger(crux.cols) || !Array.isArray(crux.cells)) {
    return { ok: false, reasons: ['crux payload malformed'] };
  }
  const { rows, cols } = crux;
  if (rows < 2 || rows > 12 || cols < 2 || cols > 12) {
    return { ok: false, reasons: [`implausible crux dimensions ${rows}x${cols}`] };
  }
  const board = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => ({
      row: r, col: c,
      isMine: false, isRevealed: false, isFlagged: false,
      adjacentMines: 0, displayedMines: 0,
    })));
  for (const cell of crux.cells) {
    if (!cell || !Number.isInteger(cell.r) || !Number.isInteger(cell.c) || !Number.isInteger(cell.n)) continue;
    if (cell.r < 0 || cell.r >= rows || cell.c < 0 || cell.c >= cols) {
      return { ok: false, reasons: [`crux cell out of bounds (${cell.r},${cell.c})`] };
    }
    const b = board[cell.r][cell.c];
    b.isRevealed = true;
    b.adjacentMines = cell.n;
    b.displayedMines = cell.n;
  }
  if (Array.isArray(crux.walls) && crux.walls.length > 0) {
    board._wallEdges = new Set(crux.walls);
  }
  const frontier = findDeducibleFrontier(board, { respectFlags: false });
  const safe = frontier?.safe || [];
  if (safe.length === 0) {
    return { ok: false, reasons: ['crux admits NO provably safe cell from its own numbers'] };
  }
  if (crux.answer && Number.isInteger(crux.answer.r)) {
    const hit = safe.some((s) => s.row === crux.answer.r && s.col === crux.answer.c);
    if (!hit) return { ok: false, reasons: [`crux answer (${crux.answer.r},${crux.answer.c}) is not provably safe`] };
  }
  return { ok: true, reasons: [] };
}

async function dbGet(path) {
  const [node, query] = path.split('?');
  const r = await fetch(`${DB_BASE}/${node}.json${query ? `?${query}` : ''}`);
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return r.json();
}

async function main() {
  const today = getLocalDateString();
  const thisWeek = getWeekStart();
  console.log(`Sweeping canonicals after ${today} (ET) and weeks >= ${thisWeek}...\n`);

  const [dailyKeys, weeklyKeys] = await Promise.all([
    dbGet('dailyBoard?shallow=true'),
    dbGet('weeklyBoard?shallow=true'),
  ]);
  const futureDates = Object.keys(dailyKeys || {}).filter((d) => d > today).sort();
  const sweepWeeks = Object.keys(weeklyKeys || {}).filter((w) => w >= thisWeek).sort();

  const failures = [];
  let warned = 0;

  for (const date of futureDates) {
    const [raw, meta, crux] = await Promise.all([
      dbGet(`dailyBoard/${date}`),
      dbGet(`dailyMeta/${date}`),
      dbGet(`cruxes/${date}`),
    ]);
    const v = verifyCanonicalPayload(raw);
    const sigV = await verifyFutureSignature(raw, date);
    if (!v.ok || !sigV.ok) {
      failures.push({ path: `dailyBoard/${date}`, reasons: [...v.reasons, ...sigV.reasons], regen: date });
      console.log(`✗ dailyBoard/${date}: ${[...v.reasons, ...sigV.reasons].join('; ')}`);
      continue; // meta/crux checks would just cascade off the bad board
    }
    let line = `✓ dailyBoard/${date} certifies`;
    if (meta) {
      const m = verifyMetaAgainstBoard(raw, meta);
      if (!m.ok) {
        failures.push({ path: `dailyMeta/${date}`, reasons: m.reasons, regen: date });
        console.log(`✗ dailyMeta/${date}: ${m.reasons.join('; ')}`);
      } else if (m.warnings.length) {
        warned++;
        line += ` (meta warnings: ${m.warnings.join('; ')})`;
      }
    }
    if (crux) {
      const c = verifyCruxPayload(crux);
      if (!c.ok) {
        failures.push({ path: `cruxes/${date}`, reasons: c.reasons, regen: date });
        console.log(`✗ cruxes/${date}: ${c.reasons.join('; ')}`);
      }
    }
    console.log(line);
  }

  for (const week of sweepWeeks) {
    const raw = await dbGet(`weeklyBoard/${week}`);
    const v = verifyCanonicalPayload(raw);
    // The signature gate applies only to weeks that haven't started (the
    // current week's board legitimately predates the epoch or was written
    // by an unsigned pipeline run before this shipped).
    const sigV = week > thisWeek ? await verifyFutureSignature(raw, week) : { ok: true, reasons: [] };
    if (!v.ok || !sigV.ok) {
      failures.push({ path: `weeklyBoard/${week}`, reasons: [...v.reasons, ...sigV.reasons], regen: null, liveWeek: week === thisWeek });
      console.log(`✗ weeklyBoard/${week}: ${[...v.reasons, ...sigV.reasons].join('; ')}`);
    } else {
      console.log(`✓ weeklyBoard/${week} certifies`);
    }
  }

  console.log(`\nSwept ${futureDates.length} future daily board(s), ${sweepWeeks.length} weekly board(s).`);
  if (warned) console.log(`${warned} board(s) carry solver-derived meta drift (warn-only — see above).`);

  if (failures.length) {
    console.error(`\n*** ${failures.length} CANONICAL(S) FAILED VERIFICATION ***`);
    for (const f of failures) {
      console.error(`  ${f.path}: ${f.reasons.join('; ')}`);
      if (f.regen) {
        console.error(`    remediation: gh workflow run regenerate-daily-board.yml -f date=${f.regen} -f dryRun=false`);
      } else if (f.liveWeek) {
        console.error('    remediation: LIVE WEEK — investigate before regenerate-weekly-board.yml (it wipes the leaderboard + attempts).');
      } else {
        console.error('    remediation: gh workflow run regenerate-weekly-board.yml');
      }
    }
    process.exit(1);
  }
  console.log('All canonicals verified. ✓');
}

const _isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (_isMain) {
  main().catch((err) => {
    console.error('verify-canonical-boards failed:', err.message);
    process.exit(1);
  });
}
