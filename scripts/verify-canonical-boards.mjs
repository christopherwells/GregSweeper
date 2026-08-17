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
//   4. dailyMeta features: every key must match a recompute exactly UNLESS
//      computeDailyFeatures declares it solver-derived, in which case it warns
//      (a solver change landing mid-week may legitimately drift counts on
//      boards written days ago). Structural is the DEFAULT, so a feature added
//      to the vector is guarded without anyone remembering to list it here.
//   5. cruxes payload is SOUND: its own numbers admit at least one provably
//      safe cell, and the claimed answer (when present) is among them
//
// Usage: node scripts/verify-canonical-boards.mjs   (exit 1 on any failure)
//        node scripts/verify-canonical-boards.mjs --fixture <snapshot.json>
//
// FIXTURE MODE is the pre-merge smoke for the ORCHESTRATION in main(). The
// pure verdict functions are exported and unit-tested, but both times this
// workflow died in production (2026-08-13/14, the first match_ row under
// daily/; #260 before it, the weekly-first rows) the crash was in the loop
// that feeds them, and nothing ran that loop before 2 AM. A fixture run
// replays main() over a committed snapshot (test/fixtures/canonical-sweep.json,
// rebuilt by scripts/build-sweep-fixture.mjs) with the clock anchored INSIDE
// the snapshot, so the dataset stays "future" forever and every daily/ key
// family the scan must survive is exercised at PR time. The snapshot carries a
// planted divergent row, so the smoke also proves detection rather than only
// completion.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { deserializeBoard } from '../src/firebase/dailyBoardSync.js';
import { recomputeDisplayedMines, recalcAllAdjacency } from '../src/logic/gimmicks.js';
import { isBoardSolvable, findDeducibleFrontier } from '../src/logic/boardSolver.js';
import { resolveStoredAnchor } from '../src/logic/startAnchor.js';
import { cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import { computeDailyFeatures, SOLVER_DERIVED_FEATURE_KEYS } from '../src/logic/dailyFeatures.js';
import { getLocalDateString, getWeekStart } from '../src/logic/seededRandom.js';
import { SIGNATURE_EPOCH, verifyCanonicalPayloadSig } from '../src/logic/canonicalSignature.js';
import { CANONICAL_ERA_START } from '../src/logic/archiveEligibility.js';
// The ONE rule for which canonical node a score bucket is checked against.
// Extracted for the submit path (#260) after the weekly-first guard spent its
// whole life reading a node that does not exist; the sweep reads it from there
// rather than growing a second copy that can drift the same way.
import { canonicalSeedPath } from '../src/logic/submitGate.js';
// The one rule for 'which seed did this row play', including when that cannot
// be answered at all. Pure, so it is tested by behaviour rather than by grep.
import { rowPlayedSeed } from '../src/logic/scoreRowMatch.js';
// The weekly mode's own era. Weekly canonicals were never regenerated the way
// the pre-canonical-era dailies were, so this floor is documentation more than
// defence, but a divergence detector without an era floor is the thing that
// cries wolf 91 times.
import { FIRST_ARCHIVE_WEEK } from '../src/logic/weeklyProgress.js';

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

const _args = process.argv.slice(2);
const _fxAt = _args.indexOf('--fixture');
const FIXTURE = _fxAt >= 0 && _args[_fxAt + 1]
  ? JSON.parse(readFileSync(_args[_fxAt + 1], 'utf8'))
  : null;

/**
 * Resolve one dbGet path against a fixture snapshot the way Firebase would:
 * segment walk, null for anything absent, and `shallow=true` returning a
 * key map. Exported so the smoke test can pin the resolution rules
 * themselves.
 */
export function fixtureGet(db, path) {
  const [node, query] = String(path).split('?');
  let cur = db;
  for (const seg of node.split('/')) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = cur[seg];
  }
  if (cur === undefined || cur === null) return null;
  if (query && query.includes('shallow=true') && typeof cur === 'object') {
    return Object.fromEntries(Object.keys(cur).map((k) => [k, true]));
  }
  return cur;
}

// A feature key is STRUCTURAL — identical under any solver version, so a
// mismatch can only be tampering or a real generator bug — unless
// computeDailyFeatures declares it solver-derived. Solver-derived counts drift
// legitimately when a solver change lands between a board's precompute night
// and this sweep, so those warn instead of failing.
//
// The default is deliberately HARD-FAIL, and the tag list is imported from the
// producer rather than kept here. This sweep used to hold its own hand-written
// ALLOWLIST of structural names, which failed twice over in the same stroke
// (issue #180): two entries named fields computeDailyFeatures never emits
// (`wormholeCellCount`/`mirrorCellCount` — it emits the PAIR counts, since a
// player reasons about a pair), and because the comparison loop iterates the
// RECOMPUTED keys those dead names matched nothing while both real modifier
// counts fell through to warn-only with the workflow staying green. Every
// structural feature the allowlist simply never mentioned — density,
// gimmickTypeCount, nonZeroSafeCellCount, zeroClusterCount (a SHIPPED par
// predictor) and the four clueShare* — was unguarded the same way.
//
// Inverting it fixes the class, not the instance: a structural feature added
// to computeDailyFeatures tomorrow is guarded the moment it exists, and the
// cost of mis-tagging is now a loud false alarm rather than a silent hole.
function isSolverDerived(key) {
  return SOLVER_DERIVED_FEATURE_KEYS.includes(key);
}

// The ship date (ET) of the newest key computeDailyFeatures emits.
//
// It exists because inverting the default above collides with the precompute
// HORIZON. A stored meta cannot carry a feature that did not exist when it was
// written, `dailyMeta/{date}` is write-once, and the pipeline writes up to
// seven days ahead — so for a week after any new feature key ships, every
// future board in flight has a meta that legitimately lacks it. That is
// pipeline vintage, not tampering, and hard-failing it would wedge this alarm
// on exactly the false positives that make an alarm worth ignoring. MEASURED:
// with the clue shares (shipped 2026-07-18) and an absence-hard-fails rule,
// dailyMeta/2026-07-19..22 all fail on `clueShare2: stored undefined`, and the
// printed remediation would have regenerated four perfectly good boards.
//
// `writtenAt` is the honest discriminator: the rules validate it as
// `=== now` on a write-once path, so it is a server stamp a poisoner cannot
// backdate.
//
// BUMP THIS in the same commit as any new feature key. Forgetting it turns the
// nightly red for up to a week on legitimate boards — loud and self-announcing,
// which is the safe direction to fail, but it is the maintenance this costs.
// Exported so the vintage-vs-lying tests anchor to the LIVE epoch rather
// than the clock — a bump here must never break the pin that post-epoch
// omission hard-fails.
//
// The date is a soft MERGE DEADLINE: metas written after it by a pipeline
// that predates the newest keys hard-fail as lying-by-omission, so if the
// PR carrying a bump has not deployed by the epoch's 00:00 UTC precompute,
// move the date forward. Failing red-on-legit is the designed loud
// direction, but there is no reason to walk into it.
export const FEATURES_EPOCH = '2026-08-04';   // contribution keys + locked split (ship buffer); tilingType 07-23; clueShare* 07-18
const FEATURES_EPOCH_MS = Date.parse(`${FEATURES_EPOCH}T00:00:00Z`);

/**
 * Is an ABSENT feature key silence rather than a lie?
 *
 * Two ways it can be. The recompute is ZERO — the board does not carry the
 * thing, so a pipeline that never knew the key is indistinguishable from one
 * that wrote 0. Or the meta predates the key existing at all. Anything else —
 * a meta written by a pipeline that knew the key, on a board that carries it —
 * is lying BY OMISSION, and still hard-fails: without that, a poisoner could
 * zero any feature simply by leaving it out.
 *
 * A meta with no usable `writtenAt` is treated as RECENT (strict). Every real
 * meta carries one; only hand-built test payloads do not.
 */
function isVintageAbsence(meta, recomputedValue) {
  if (recomputedValue === 0) return true;
  return typeof meta.writtenAt === 'number' && meta.writtenAt < FEATURES_EPOCH_MS;
}

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

  // 3. Re-certify from the board's certified opener under its own contract
  // flag (deserializeBoard restored _gatedCert). Same acceptance as the
  // generator's hard gate. The opener comes from deserializeBoard so this
  // cannot drift from what the generator certified: on a rectangle it is the
  // container centre exactly as before, and on a tiling it is the stored
  // centre cell, since a tiling's container is an arbitrary factorization and
  // its "middle" slot is an unrelated cell.
  const fr = Math.floor(d.firstClick / cols), fc = d.firstClick % cols;
  const check = isBoardSolvable(board, rows, cols, fr, fc);
  cleanSolverArtifacts(board);
  if (!(check.solvable || check.remainingUnknowns === 0)) {
    reasons.push(`board does NOT certify from center (${check.remainingUnknowns} unknowns left)`);
    return { ok: false, reasons, check };
  }

  // 4. The STORED Start-here anchor, when present (his 2026-08-17 ruling:
  // chosen at precompute, rendered verbatim). A stored anchor the board
  // does not stand behind is a marker lying to every player at once, so
  // it is verified the way the client verifies it: bounds, not a mine,
  // and its OWN full solve certifies. Absence is fine (pre-ship vintage;
  // the client's legacy fallback covers it), a bad one is a hard failure.
  if (d.bestStart != null) {
    const anchor = resolveStoredAnchor(board, rows, cols, d.bestStart);
    cleanSolverArtifacts(board);
    if (!anchor) {
      reasons.push(`stored bestStart ${d.bestStart} does not certify (bounds, mine, or an incomplete solve)`);
      return { ok: false, reasons, check };
    }
  }
  return { ok: true, reasons: [], check };
}

/**
 * Verify a dailyMeta node against its (already-verified) board payload.
 * @returns {{ ok: boolean, reasons: string[], warnings: string[] }}
 */
export function verifyMetaAgainstBoard(raw, meta, date = null) {
  if (!meta || typeof meta.features !== 'object') {
    return { ok: false, reasons: ['dailyMeta missing or has no features node'], warnings: [] };
  }
  // Before canonical storage existed, the stored board was REGENERATED by
  // scripts/backfill-old-dailies.mjs while the meta still describes the
  // per-device board actually played (unrecoverable, never stored). The two
  // therefore describe different boards by construction, and recomputing one
  // against the other proves nothing — it is provenance, not tampering. The
  // meta is the record that matters here: the score rows join to it, so the
  // par fit reads a consistent meta+score pair on these dates and only the
  // canonical is the imposter. (The refit draws the same line as
  // DIGIT_ERA_START, which is why it cannot derive clue digits before it.)
  //
  // Production never reaches this branch — the sweep only walks FUTURE dates —
  // but an audit run over history otherwise reports ~49 false alarms, which is
  // exactly how a real failure gets lost in the noise.
  if (date && date < CANONICAL_ERA_START) {
    return {
      ok: true,
      reasons: [],
      warnings: [`pre-canonical-era date (< ${CANONICAL_ERA_START}): board was regenerated by the `
        + 'backfill and its meta describes the originally-played board; comparison skipped'],
      preCanonicalEra: true,
    };
  }
  const d = deserializeBoard(raw);
  // Same single definition of the certified opener as verifyCanonicalPayload.
  const fr = Math.floor(d.firstClick / d.cols), fc = d.firstClick % d.cols;
  const check = isBoardSolvable(d.board, d.rows, d.cols, fr, fc);
  cleanSolverArtifacts(d.board);
  const recomputed = computeDailyFeatures(
    // rngSeed drives the wormLoad recompute (per-egg lengths + the board's
    // move budget both derive from it)
    { board: d.board, rows: d.rows, cols: d.cols, totalMines: d.totalMines, activeGimmicks: d.activeGimmicks, rngSeed: d.rngSeed || '' },
    check,
    // The contribution keys recompute from the same stored opener the
    // certification check above uses. They are solver-derived, so a stored
    // value that drifts after a solver change WARNS rather than fails.
    { contributionOpener: { row: fr, col: fc } },
  );
  const reasons = [];
  const warnings = [];
  for (const [key, val] of Object.entries(recomputed)) {
    const stored = meta.features[key];
    if (stored === val) continue;
    // A key ABSENT from the stored meta is pipeline vintage rather than
    // tampering when the board does not carry the feature, or when the meta
    // was written before the feature existed — see isVintageAbsence.
    if (stored === undefined) {
      if (isVintageAbsence(meta, val)) {
        warnings.push(`features.${key}: absent from the stored meta, recomputes ${val} (pipeline vintage)`);
        continue;
      }
      reasons.push(`features.${key}: absent from a meta written after the feature shipped (recomputes ${val})`);
      continue;
    }
    if (isSolverDerived(key)) {
      warnings.push(`features.${key}: stored ${stored} vs recomputed ${val} (solver-derived; drift possible)`);
    } else {
      reasons.push(`features.${key}: stored ${stored} !== recomputed ${val}`);
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
  if (FIXTURE) return fixtureGet(FIXTURE.db || {}, path);
  const [node, query] = path.split('?');
  const r = await fetch(`${DB_BASE}/${node}.json${query ? `?${query}` : ''}`);
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return r.json();
}

/**
 * What the divergence scan does with one bucket under `daily/`, and the reason
 * in the caller's own words when the answer is "nothing".
 *
 * The scan reads whatever keys `daily/` actually holds, and that is three
 * families now: dates, `{weekStart}_weekly_first` fit rows, and since
 * 2026-08-13 `match_<hash>` rows from Challenge runs. A match board has no
 * canonical to diverge from, so canonicalSeedPath returns null for it, and the
 * sweep passed that null straight into dbGet, where `path.split` threw and the
 * exception ended the whole scan. The submit path skips that read already
 * (firebaseLeaderboard.js); this second caller never did, so the answer lives
 * in one named rule both the scan and its test can ask.
 *
 * Every skip is a REASON rather than a bare false, because the one thing this
 * scan must never do is report clean over a population it never looked at.
 *
 * @param {string} bucket  a key under `daily/`
 * @returns {{seedPath: string|null, skip: string|null}}
 */
export function divergenceBucketPlan(bucket) {
  // No canonical BY RULE. A match board is dealt from the committed library and
  // re-certified from its stored payload at install, which proves more than a
  // seed comparison could: that the numbers describe the mines and the board is
  // solvable from its opener. Checked before the era floor so the verdict never
  // rides on where a hex key happens to sort against a date.
  const seedPath = canonicalSeedPath(bucket);
  if (!seedPath) return { seedPath: null, skip: 'no-canonical-by-rule' };
  // Every board before the canonical era was regenerated by
  // backfill-old-dailies.mjs, so its stored seed disagrees with the canonical
  // BY CONSTRUCTION. Without this floor the scan reports 91 rows that are all
  // fine, and an alarm that cries wolf 91 times is not an alarm.
  if (bucket < CANONICAL_ERA_START) return { seedPath: null, skip: 'pre-era' };
  return { seedPath, skip: null };
}

async function main() {
  // In fixture mode the clock comes from the snapshot, never the wall: a
  // committed dataset with real dates would silently age out of "future" and
  // the smoke would pass while sweeping nothing (the vacuity class).
  const today = FIXTURE ? FIXTURE.today : getLocalDateString();
  const thisWeek = FIXTURE ? FIXTURE.thisWeek : getWeekStart();
  if (FIXTURE) {
    console.log('FIXTURE MODE: sweeping a committed snapshot, not production. '
      + 'A pass here says the machinery runs, nothing about live boards.');
  }
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
      const m = verifyMetaAgainstBoard(raw, meta, date);
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

  // -- Divergent score rows -------------------------------------------
  // The sweep above only looks FORWARD, at boards nobody has played yet.
  // Divergence is the opposite shape: a row already written against a board
  // that is NOT the day's canonical, which then joins the wrong feature
  // vector in the par fit and sits on a leaderboard comparing people who
  // played different puzzles. Two of those went unnoticed for two months
  // (found 2026-08-07) because nothing looked for them.
  //
  // Reported, never auto-deleted. Deleting player data on a schedule is fine
  // right up until the day a canonical is itself wrong, and then it silently
  // removes legitimate scores. scripts/audit-divergent-scores.mjs --only is
  // the remediation, and a human names the rows.
  //
  // FOUR row families now, because the weekly has two of its own and the
  // Challenge match added a third under the daily's own path. `daily/` holds
  // the day-of rows, the {weekStart}_weekly_first fit rows AND the
  // match_<hash> rows; `weekly/` holds one row per player per week. Which of
  // them gets compared, and the reason when one does not, is
  // divergenceBucketPlan above, so the era floor and the no-canonical families
  // are one rule in one place rather than a condition per family here.
  //
  // Each of the two families past the day-of daily cost something on arrival.
  // The weekly fit rows were looked up at dailyBoard/{weekStart}_weekly_first,
  // a node that does not exist, so the `typeof canonicalSeed !== 'string'`
  // guard dropped all 36 of them under a clean line (#260, fixed by reading the
  // path rule from the submit side rather than growing a second copy). The
  // match rows then landed with no canonical at all, and the scan threw on the
  // first one it met. Neither is a comparison this can make, so both are
  // COUNTED and printed.
  const divergent = [];
  // A row with no seed cannot be checked, and counting those is the difference
  // between "nothing is wrong" and "nothing was looked at". Weekly leaderboard
  // rows only started carrying rngSeed on 2026-08-07 (#262), so most of the
  // existing ones land here.
  const unverifiable = { weeklyFirst: 0, weekly: 0 };
  // Buckets the scan deliberately did not compare, counted in ROWS because that
  // is the number comparable to the divergence count above it. Two reasons,
  // reported apart: `byRule` is a family that has no canonical at all (match
  // rows), `noNode` is a bucket whose canonical node came back empty, which is
  // the silent-skip shape this whole scan exists to end.
  const skipped = { byRule: 0, noNode: 0 };
  let divergentScanFailed = null;
  try {
    const scores = await dbGet('daily');
    for (const [bucket, rows] of Object.entries(scores || {})) {
      if (!rows || typeof rows !== 'object') continue;
      const plan = divergenceBucketPlan(bucket);
      if (plan.skip === 'pre-era') continue;
      if (plan.skip) { skipped.byRule += Object.keys(rows).length; continue; }
      const canonicalSeed = await dbGet(plan.seedPath);
      if (typeof canonicalSeed !== 'string') {  // no canonical to compare against
        skipped.noNode += Object.keys(rows).length;
        continue;
      }
      for (const [pushId, row] of Object.entries(rows)) {
        if (!row || typeof row !== 'object') continue;
        const verdict = rowPlayedSeed('daily', bucket, row);
        if (verdict.unverifiable) { unverifiable[verdict.unverifiable]++; continue; }
        const played = verdict.seed;
        if (played !== canonicalSeed) {
          divergent.push({ path: `daily/${bucket}/${pushId}`, id: `${bucket}/${pushId}`, name: row.name || '?', played, canonical: canonicalSeed });
        }
      }
    }

    // The weekly leaderboard. One row per player per week, keyed by uid rather
    // than a push id, and a weekly attempt is one of only seven, so a row on
    // the wrong board costs more than a daily one does.
    const weeklyScores = await dbGet('weekly');
    for (const [weekStart, rows] of Object.entries(weeklyScores || {})) {
      if (weekStart < FIRST_ARCHIVE_WEEK || !rows || typeof rows !== 'object') continue;
      const canonicalSeed = await dbGet(`weeklyBoard/${weekStart}/rngSeed`);
      if (typeof canonicalSeed !== 'string') continue;
      for (const [uid, row] of Object.entries(rows)) {
        if (!row || typeof row !== 'object') continue;
        const verdict = rowPlayedSeed('weekly', weekStart, row);
        if (verdict.unverifiable) { unverifiable[verdict.unverifiable]++; continue; }
        if (verdict.seed !== canonicalSeed) {
          divergent.push({ path: `weekly/${weekStart}/${uid}`, id: `${weekStart}/${uid}`, name: row.name || '?', played: verdict.seed, canonical: canonicalSeed });
        }
      }
    }
  } catch (err) {
    // A scan that could not run must never read as a clean one.
    divergentScanFailed = err.message;
  }
  if (divergent.length) {
    console.error(`\n*** ${divergent.length} DIVERGENT SCORE ROW(S) ***`);
    for (const d of divergent) {
      console.error(`  ${d.path}  ${d.name}  played ${d.played}, canonical ${d.canonical}`);
    }
    // A real incident is one or two rows; a hundred means the comparison
    // itself is wrong, and printing a hundred --only flags invites pasting it.
    const remediable = divergent.slice(0, 10);
    console.error('  remediation: node scripts/audit-divergent-scores.mjs --delete '
      + remediable.map((d) => `--only ${d.id}`).join(' '));
    if (divergent.length > remediable.length) {
      console.error(`  (${divergent.length - remediable.length} more not listed — at this volume, check the comparison before deleting anything)`);
    }
    console.error('  (needs FIREBASE_SERVICE_ACCOUNT - these rows are append-only to every client)');
  } else if (divergentScanFailed) {
    console.error(`
*** DIVERGENT-SCORE SCAN DID NOT RUN: ${divergentScanFailed} ***`);
    console.error('  Treat as unknown, not clean — the rows it looks for are invisible everywhere else.');
    process.exitCode = 1;
  } else {
    console.log('No divergent score rows since the canonical era began (daily, weekly-first and weekly).');
  }
  // Printed whether or not anything diverged, because "clean" over a sample
  // that was mostly skipped is the reading this is here to prevent.
  if (unverifiable.weeklyFirst || unverifiable.weekly) {
    console.log(`  (${unverifiable.weeklyFirst} weekly-first and ${unverifiable.weekly} weekly row(s) carry no seed `
      + 'and could not be checked either way — rows written before the weekly recorded one)');
  }
  if (skipped.byRule) {
    console.log(`  (${skipped.byRule} match row(s) have no canonical to diverge from; a match board is dealt `
      + 'from the committed library and re-certified from its stored payload at install)');
  }
  if (skipped.noNode) {
    console.log(`  (${skipped.noNode} row(s) sit in a post-era bucket whose canonical node is empty, `
      + 'so no comparison was possible: a bucket key nothing pre-wrote a board for)');
  }

  if (failures.length || divergent.length) {
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
