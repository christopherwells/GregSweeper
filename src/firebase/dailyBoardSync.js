// Canonical-board sync — every player on the same EST date plays the
// EXACT same board layout, no matter what version of the JS bundle
// they're running or which experiment-target they have cached.
//
// The mechanism: the first client (or the GitHub Actions pre-gen
// workflow) writes the fully-resolved board state to Firebase under
// `dailyBoard/{date}` with write-once rules. Every subsequent player
// fetches it instead of regenerating locally. This eliminates two
// classes of divergence at once:
//   1. Code-version drift — two clients on different cached SW
//      bundles producing different boards from the same seed.
//   2. Experiment-target drift — two clients with different cached
//      `experimentTarget.json` picking different trial winners.
//
// Re-derivation drift is also handled: we serialize `adjacentMines`
// and `displayedMines` per cell, so future changes to wall-aware
// adjacency or gimmick-display logic don't retroactively change the
// numbers a past day showed.

import { waitForFirebaseReady } from './waitForFirebase.js';
import { isTestEnvironment } from './env.js';
import { getCachedDailyBoard, cacheDailyBoard, addDays, PREFETCH_DAILY_DAYS } from './boardCache.js';
import { assessCanonicalTrust } from '../logic/canonicalSignature.js';
// adjacency.js is a LEAF module (imports nothing), so this cannot cycle.
import { defineCellNeighbors } from '../logic/adjacency.js';
// tilingGeometry.js is likewise a leaf; only the storability predicate and its
// bounds are used here, not the builders.
import { containerIsStorable, CANONICAL_MIN_DIM, CANONICAL_MAX_DIM } from '../logic/tilingGeometry.js';
import { etDateStringOfMs } from '../logic/seededRandom.js';
import { reportCaughtError } from '../diagnostics/errorReporter.js';

/**
 * The #114 trust gate, applied to EVERY canonical this client is about to
 * consume (network or cache): pre-epoch boards are grandfathered, signed
 * boards must verify, unsigned post-epoch boards are trusted only in the
 * first-client-fallback shape (written inside their own play window — see
 * canonicalSignature.js). A rejected canonical is treated as MISSING, so the
 * caller falls back to local generation instead of playing a poisoned board.
 * Verifier-machinery exceptions fail OPEN with a report: a browser quirk
 * must never brick a legitimate daily, and an attacker cannot trigger an
 * exception (a bad signature is a clean `false`, not a throw).
 *
 * @param {object|null} raw  fetched/cached canonical payload
 * @param {string} key       date (daily) or weekStart (weekly)
 * @param {'daily'|'weekly'} kind
 * @returns {Promise<object|null>} the payload, or null when untrusted
 */
export async function gateCanonicalTrust(raw, key, kind) {
  if (!raw) return null;
  try {
    const verdict = await assessCanonicalTrust(raw, key, kind, etDateStringOfMs);
    if (verdict.trusted) return raw;
    console.warn(`canonical ${kind}/${key} REJECTED: ${verdict.reason}`);
    reportCaughtError('canonical-trust-reject', new Error(`${kind}/${key}: ${verdict.reason}`));
    return null;
  } catch (err) {
    reportCaughtError('canonical-trust-error', err);
    return raw;
  }
}

const DB_PATH = 'dailyBoard';
const FETCH_TIMEOUT_MS = 5000;
const WRITE_TIMEOUT_MS = 5000;

// Per-cell fields we ship across the wire. Anything not listed here
// is dropped on serialise — keeps the payload tight and prevents
// accidental leaks of solver scratch state (`isRevealed`, etc.).
const CELL_FIELDS = [
  // Primary state
  'isMine',
  'adjacentMines',
  'displayedMines',
  // Liar
  'isLiar', 'liarOffset', 'inLiarZone',
  // Mystery
  'isMystery',
  // Locked
  'isLocked',
  // Wormhole
  'isWormhole', 'wormholePair', 'wormholePairIndex',
  // Mirror
  'mirrorPair', 'mirrorZone',
  // Sonar
  'isSonar', 'sonarCount',
  // Compass. `compassRay` is the STORED ray — on an explicit topology a
  // compass is a geometry question the neighbor graph cannot answer, so
  // applyGimmicks computes the ray once from cell positions and stamps it,
  // and BOTH the displayed number (recomputeDisplayedMines) and the certifier
  // (buildStaticGimmickConstraints) read it back through compassRayCells.
  // Dropping it here does not fail loudly: compassRayCells returns [] for a
  // cell without one, so every compass number on a restored tiling board would
  // quietly become 0 and the certifier would prove from a premise the board
  // never displayed. Absent on rectangles (they derive the ray from row/col),
  // where _serializeCell prunes it as undefined.
  'isCompass', 'compassDir', 'compassArrow', 'compassCount', 'compassRay',
  // Pressure plate
  'isPressurePlate', 'plateTimer', 'plateDisarmed',
  // Worm Tiles (egg positions are canonical; the crawling worm is runtime)
  'isWormEgg',
];

// waitForFirebaseReady lives in ./waitForFirebase.js so weeklyBoardSync
// and the main.js startup gate can share the exact same readiness
// machinery — the canonical-board correctness contract depends on it.

function _serializeCell(cell) {
  const out = {};
  for (const key of CELL_FIELDS) {
    const v = cell[key];
    if (v === undefined || v === null) continue;
    if (typeof v === 'boolean' && v === false) continue; // false ≡ default; saves ~30% payload
    out[key] = v;
  }
  return out;
}

function _deserializeCell(raw, r, c) {
  // CRITICAL: every cell MUST carry its row and col. Many code paths
  // (updateCells from cascade-reveal, pressure-plate DOM lookup,
  // power-up cell handlers, gimmick stamping in applied[]) read
  // cell.row / cell.col directly. Without them, updateCell(undefined,
  // undefined) silently no-ops and the DOM never reflects state
  // changes — every reveal cascade looks frozen even though the state
  // is updating underneath. Found this the hard way after a player
  // reported "tapping does nothing" on the canonical-board ship.
  const cell = {
    row: r,
    col: c,
    isMine: false,
    adjacentMines: 0,
    isMystery: false,
    isLiar: false,
    inLiarZone: false,
    isLocked: false,
    isWormhole: false,
    isSonar: false,
    isCompass: false,
    isPressurePlate: false,
    plateDisarmed: false,
    isWormEgg: false,
    isFlagged: false,
    isRevealed: false,
  };
  if (!raw) return cell;
  // Apply the explicitly-present fields. Defaults above cover anything
  // the serializer pruned (false-valued booleans, missing optionals).
  for (const key of CELL_FIELDS) {
    if (key in raw) cell[key] = raw[key];
  }
  return cell;
}

/**
 * Serialise the full live board state into a JSON-safe object suitable
 * for Firebase write. Cells are flattened row-major; wallEdges become
 * a string[] (keys like "r1,c1-r2,c2" — opaque to this layer, the
 * walls module owns the format).
 *
 * @param {object} args
 * @param {Array<Array<object>>} args.board
 * @param {number} args.rows
 * @param {number} args.cols
 * @param {number} args.totalMines
 * @param {string} args.rngSeed
 * @param {string[]} args.activeGimmicks
 * @param {string} [args.codeVersion] — for forensic provenance only
 * @returns {object}
 */
export function serializeBoard({ board, rows, cols, totalMines, rngSeed, activeGimmicks, codeVersion, firstClick }) {
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push(_serializeCell(board[r][c]));
    }
  }
  const out = {
    rows, cols, totalMines,
    rngSeed: rngSeed || '',
    activeGimmicks: Array.isArray(activeGimmicks) ? [...activeGimmicks] : [],
    cells,
  };
  if (codeVersion) out.codeVersion = codeVersion;
  if (board._wallEdges instanceof Set && board._wallEdges.size > 0) {
    out.wallEdges = Array.from(board._wallEdges);
  }
  // Certification-contract flag: this board was certified with sonar /
  // compass / wormhole constraints reveal-gated (boardSolver reads it as
  // its default). Old clients ignore the field and solve ungated — safe,
  // because a gated certificate implies an ungated one (gating only
  // removes constraints).
  if (board._gatedCert) out.gatedCert = true;

  // ── Explicit topology + geometry (Project Coastline tiling boards) ──
  //
  // A tiling board's adjacency is a GRAPH stamped on the board ARRAY, and
  // JSON.stringify drops properties stamped on an array — the same trap the
  // game save hit in Phase 1, where a saved tiling game resumed RECTANGULAR
  // mid-play. Here it would be worse than mid-play: the canonical IS the
  // board, so every client would deserialize a rectangle, recompute both
  // number layers against the 8-neighborhood, and disagree with the layout
  // the board was certified under.
  //
  // These are STORED rather than rebuilt from the {type, M, N} descriptor,
  // even though buildTiling is pure and reproduces them exactly (measured, to
  // 9 decimal places). Re-deriving is precisely what the canonical-board
  // architecture exists to prevent — "same seed + different code = different
  // board" is its founding divergence source — and `cellNeighbors` is the
  // adjacency the certificate was issued against, so it must be frozen
  // bytes, not a function call whose definition can move underneath it. The
  // game save stores `cellNeighbors` verbatim for the same reason. The cost
  // is ~4 KB on a tiling day against ~1-3 KB for a rectangle, paid only on
  // the days that carry a tiling; a rectangular board emits none of these
  // fields and its payload is byte-identical to before.
  if (board._cellNeighbors) {
    // A container the canonical rules would reject means this board can never
    // be stored, and the only symptom of letting it through is a write that
    // silently fails and a canonical that never appears. Fail here instead,
    // naming the reason. (Depends only on the cell count's factors — see
    // containerIsStorable.)
    if (!containerIsStorable(rows * cols)) {
      throw new Error(
        `serializeBoard: ${rows}x${cols} container (${rows * cols} cells) is outside the `
        + `canonical dimension bounds [${CANONICAL_MIN_DIM}, ${CANONICAL_MAX_DIM}]; `
        + 'pick tiling dimensions whose cell count factors more evenly',
      );
    }
    // Post-wall-severing: a wall on a tiling removes the edge from the graph
    // outright, so this list already IS the walled topology and the certifier
    // needs nothing else to agree with the generator.
    out.cellNeighbors = board._cellNeighbors.map((list) => [...list]);
  }
  if (board._cellPos) {
    out.cellPos = board._cellPos.map((p) => ({ cx: p.cx, cy: p.cy, shape: p.shape }));
  }
  if (board._tiling) {
    const t = board._tiling;
    // M and N are load-bearing, not documentation: applyWallsTiling rebuilds
    // the wireframe through buildTiling(type, M, N).
    out.tiling = { type: t.type, M: t.M, N: t.N, wUnits: t.wUnits, hUnits: t.hUnits };
  }
  // The cell this board was CERTIFIED from, as a flat index. Daily and weekly
  // certify from the board's centre, and on a rectangle that is the container
  // centre — which is why it has never needed storing. On a tiling the
  // container is an arbitrary exact factorization (63 hexagons ship as 7×9), so
  // the container centre is an unrelated cell and re-certifying from it proves
  // nothing about the board the player opens. The generator alone knows the
  // real opener (`buildTiling(...).centerIndex`), so it travels with the board
  // rather than being re-derived from a builder whose indexing could move.
  if (Number.isInteger(firstClick)) out.firstClick = firstClick;
  if (Array.isArray(board._tilingWalls) && board._tilingWalls.length > 0) {
    // Render geometry for the wall bars, plus the severed pair (a/b) that
    // `wallEdgeCount` counts. Derivable from the topology diff, but shipping
    // it keeps the restore path a pure data load with no rebuild step.
    out.tilingWalls = board._tilingWalls.map((w) => ({
      a: w.a, b: w.b, x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2,
    }));
  }
  return out;
}

/**
 * Reconstruct a live board (the same shape gameActions expects) from a
 * serialised object fetched from Firebase. The returned object has the
 * board grid plus side metadata so the caller can splice into
 * `state.board / state.rows / state.cols / state.totalMines /
 * state.activeGimmicks` directly.
 *
 * @param {object} raw
 * @returns {{ board: Array<Array<object>>, rows: number, cols: number, totalMines: number, activeGimmicks: string[], rngSeed: string }}
 */
export function deserializeBoard(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('deserializeBoard: empty payload');
  }
  const { rows, cols, totalMines, cells, wallEdges, activeGimmicks, rngSeed } = raw;
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || !Array.isArray(cells)) {
    throw new Error('deserializeBoard: malformed payload');
  }
  if (cells.length !== rows * cols) {
    throw new Error(`deserializeBoard: cell count ${cells.length} does not match ${rows}x${cols}`);
  }

  const board = new Array(rows);
  for (let r = 0; r < rows; r++) {
    const row = new Array(cols);
    for (let c = 0; c < cols; c++) {
      row[c] = _deserializeCell(cells[r * cols + c], r, c);
    }
    board[r] = row;
  }
  if (Array.isArray(wallEdges) && wallEdges.length > 0) {
    board._wallEdges = new Set(wallEdges);
  }
  // Restore the certification contract: boards without the flag were
  // certified ungated and must keep that contract on every solver
  // surface (historical canonicals predate reveal gating).
  if (raw.gatedCert === true) board._gatedCert = true;

  // ── Explicit topology + geometry (Coastline tiling canonicals) ──
  //
  // Stamped BEFORE anything reads the board, exactly as tryResumeGame does
  // for the game save: every adjacency question downstream — the flood, the
  // chord, the mine counters, the certifier, the feature vector — resolves
  // through this, so a board that is going to be non-rectangular has to be
  // non-rectangular from its first read.
  //
  // defineCellNeighbors VALIDATES (length, bounds, no self-loops, no
  // duplicates, and above all SYMMETRY) and THROWS naming the violation. That
  // is deliberate: this payload arrived from outside the process, and an
  // asymmetric edge list does not crash, it quietly certifies a board nobody
  // can solve, because one cell's clue counts a mine the mine's own
  // neighborhood does not count back. Throwing routes a corrupt topology into
  // the same path as any other malformed canonical — the caller treats the
  // board as MISSING and falls back to local generation, rather than shipping
  // a board whose adjacency disagrees with its numbers.
  if (raw.cellNeighbors !== undefined) {
    if (!Array.isArray(raw.cellNeighbors)) {
      throw new Error('deserializeBoard: cellNeighbors must be an array');
    }
    defineCellNeighbors(board, rows, cols, raw.cellNeighbors);
  }
  if (Array.isArray(raw.cellPos)) board._cellPos = raw.cellPos;
  if (raw.tiling && typeof raw.tiling === 'object') board._tiling = { ...raw.tiling };
  // Always an ARRAY on a tiling board (applyWallsTiling writes [] when no wall
  // survives its connectivity check), because two live consumers branch on it:
  // the renderer routes wall drawing on its length, and computeDailyFeatures
  // derives wallEdgeCount from it. Left undefined on a rectangle so that
  // feature keeps reading _wallEdges.
  if (Array.isArray(raw.tilingWalls)) board._tilingWalls = raw.tilingWalls;
  else if (board._cellNeighbors) board._tilingWalls = [];

  // The certified opener, as a flat index, with ONE definition for every
  // consumer. A stored `firstClick` wins; otherwise it is the container centre,
  // which is the historical contract and stays exactly right for every
  // rectangular canonical ever written. Returned rather than left to callers
  // because the container-centre formula was hand-copied into the nightly
  // sweep twice and its test once, and on a tiling all three were wrong.
  const centreIndex = Math.floor(rows / 2) * cols + Math.floor(cols / 2);
  const firstClick = Number.isInteger(raw.firstClick)
    && raw.firstClick >= 0 && raw.firstClick < rows * cols
    ? raw.firstClick
    : centreIndex;

  return {
    board,
    rows,
    cols,
    totalMines: Number(totalMines) || 0,
    activeGimmicks: Array.isArray(activeGimmicks) ? activeGimmicks : [],
    rngSeed: typeof rngSeed === 'string' ? rngSeed : '',
    firstClick,
  };
}

/**
 * Try to load the canonical board for a date. Waits up to
 * FIREBASE_READY_TIMEOUT_MS for the SDK to finish initializing before
 * giving up — without this wait, a cold-load race would silently fall
 * through to local generation and produce a divergent board for the
 * same date as another player who got the canonical.
 *
 * Returns null when:
 *   - Firebase did not initialize within the timeout (treat as offline).
 *   - The path exists in the database but contains no value.
 *   - The fetch itself fails or times out.
 *
 * Throws nothing. The caller can distinguish offline vs. empty-canonical
 * via `isFirebaseOnline()` if it needs to.
 *
 * @param {string} dateString YYYY-MM-DD
 * @returns {Promise<object|null>}
 */
export async function loadDailyBoard(dateString) {
  // Network-first with cache fallback. Canonical boards are write-once
  // at the RULES layer, but an admin regeneration (service-account
  // bypass — scripts/regenerate-daily-board.mjs) can replace an
  // UNPLAYED future board, e.g. the 2026-06-14 reveal-gating
  // re-certification. A blindly authoritative cache would pin every
  // client that had prefetched the old layout to a divergent board on
  // the day. Cost while online: one ~2KB fetch per load — the
  // pre-boardCache behavior. Offline, the cached copy below is still
  // what keeps the daily playable.
  const cached = getCachedDailyBoard(dateString);

  let db;
  try {
    db = await waitForFirebaseReady();
  } catch (err) {
    console.warn('loadDailyBoard:', err.message);
    // offline — the cached canonical is the best truth available
    return gateCanonicalTrust(cached, dateString, 'daily');
  }
  try {
    const ref = db.ref(`${DB_PATH}/${dateString}`);
    const snap = await Promise.race([
      ref.once('value'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT_MS)),
    ]);
    // Server reachable and empty = there IS no canonical for this date
    // (admin deletions must always be followed immediately by a
    // rewrite). Don't resurrect a cached copy the server disowned —
    // fall through to the caller's local-generation path.
    if (!snap.exists()) return null;
    const val = await gateCanonicalTrust(snap.val(), dateString, 'daily');
    // An untrusted canonical is never cached — a poisoned board must not
    // gain offline persistence.
    if (val) cacheDailyBoard(dateString, val); // refresh local cache for offline replays
    return val;
  } catch (err) {
    console.warn('loadDailyBoard fetch failed:', err.message);
    return gateCanonicalTrust(cached, dateString, 'daily');
  }
}

/**
 * Fetch the crux teaser for a date (cruxes/{date}) — the precomputed
 * "find the safe square" mini-puzzle shown by the ?crux= share route.
 * Returns the payload or null (no crux for the date, or Firebase
 * unreachable). No caching: the teaser is a one-off share view, not a
 * replayable board. World-readable, so it works logged-out.
 *
 * @param {string} dateString YYYY-MM-DD
 * @returns {Promise<object|null>}
 */
export async function loadCrux(dateString) {
  let db;
  try {
    db = await waitForFirebaseReady();
  } catch (err) {
    console.warn('loadCrux:', err.message);
    return null;
  }
  try {
    const snap = await Promise.race([
      db.ref(`cruxes/${dateString}`).once('value'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT_MS)),
    ]);
    return snap.exists() ? snap.val() : null;
  } catch (err) {
    console.warn('loadCrux fetch failed:', err.message);
    return null;
  }
}

// How many recent rolled-up heatmaps the journal exhibit pulls. The node
// grows one small entry per day forever, so the read is bounded by key
// rather than fetching the whole history to draw one board.
const HEATMAP_FETCH_LIMIT = 45;

/**
 * Fetch the most recent rolled-up board heatmaps (boardHeatmap/{date}),
 * newest last. Written server-side by scripts/rollup-board-heatmap.mjs
 * and world-readable, so this works without auth. Returns [] when the
 * node is empty and [] on failure — the exhibit is decoration, and a
 * heatmap outage must never break the notebook.
 *
 * @param {number} [limit]
 * @returns {Promise<Array<{date: string, payload: object}>>}
 */
export async function loadRecentBoardHeatmaps(limit = HEATMAP_FETCH_LIMIT) {
  let db;
  try {
    db = await waitForFirebaseReady();
  } catch (err) {
    console.warn('loadRecentBoardHeatmaps:', err.message);
    return [];
  }
  try {
    const snap = await Promise.race([
      db.ref('boardHeatmap').orderByKey().limitToLast(limit).once('value'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT_MS)),
    ]);
    const val = snap.val() || {};
    return Object.keys(val)
      .filter(date => val[date] && typeof val[date] === 'object')
      .map(date => ({ date, payload: val[date] }));
  } catch (err) {
    console.warn('loadRecentBoardHeatmaps fetch failed:', err.message);
    return [];
  }
}

/**
 * Fetch + cache the upcoming week of daily boards (today .. today+6 ET) so
 * they stay playable through an offline stretch. Best-effort, sequential,
 * and skips dates already cached — a failure just means that day isn't
 * cached yet. Intended to run in the background after boot.
 *
 * @param {string} today YYYY-MM-DD (ET)
 */
export async function prefetchUpcomingDailyBoards(today) {
  if (typeof today !== 'string' || !today) return;
  for (let i = 0; i < PREFETCH_DAILY_DAYS; i++) {
    const date = addDays(today, i);
    if (getCachedDailyBoard(date)) continue;
    try { await loadDailyBoard(date); } catch { /* best-effort */ }
  }
}

/**
 * Write the canonical board for a date (write-once at the rules layer
 * — duplicate writes silently no-op via the `!data.exists()` guard).
 * Returns true on success, false on any failure including
 * already-written. Caller should treat false as "fall back to local
 * generation OR refetch in case someone else just wrote."
 *
 * @param {string} dateString YYYY-MM-DD
 * @param {object} payload — output of serializeBoard()
 * @returns {Promise<boolean>}
 */
export async function saveDailyBoard(dateString, payload) {
  // Test branch: don't overwrite the production canonical board.
  // Test-branch code may generate a slightly different layout than
  // master if any board-generation logic has changed, and a stray
  // write would clobber the real canonical that every real player
  // is using today.
  if (isTestEnvironment()) return false;
  let db;
  try {
    db = await waitForFirebaseReady();
  } catch (err) {
    console.warn('saveDailyBoard:', err.message);
    return false;
  }
  try {
    const ref = db.ref(`${DB_PATH}/${dateString}`);
    const writePayload = {
      ...payload,
      writtenAt: firebase.database.ServerValue.TIMESTAMP,
    };
    await Promise.race([
      ref.set(writePayload),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), WRITE_TIMEOUT_MS)),
    ]);
    return true;
  } catch (err) {
    // Permission-denied here means another client already wrote — fine,
    // we'll re-read on the next attempt. Anything else is a real error.
    console.warn('saveDailyBoard failed:', err.message);
    return false;
  }
}
