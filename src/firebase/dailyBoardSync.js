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
  // Compass
  'isCompass', 'compassDir', 'compassArrow', 'compassCount',
  // Pressure plate
  'isPressurePlate', 'plateTimer', 'plateDisarmed',
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
export function serializeBoard({ board, rows, cols, totalMines, rngSeed, activeGimmicks, codeVersion }) {
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
  return {
    board,
    rows,
    cols,
    totalMines: Number(totalMines) || 0,
    activeGimmicks: Array.isArray(activeGimmicks) ? activeGimmicks : [],
    rngSeed: typeof rngSeed === 'string' ? rngSeed : '',
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
    return cached; // offline — the cached canonical is the best truth available
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
    const val = snap.val();
    cacheDailyBoard(dateString, val); // refresh local cache for offline replays
    return val;
  } catch (err) {
    console.warn('loadDailyBoard fetch failed:', err.message);
    return cached;
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
