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

function _firebaseDb() {
  if (typeof firebase === 'undefined' || !firebase.apps?.length) return null;
  try { return firebase.database(); } catch { return null; }
}

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
 * Try to load the canonical board for a date. Returns null if Firebase
 * is unavailable, the path is empty, or the read times out.
 * @param {string} dateString YYYY-MM-DD
 * @returns {Promise<object|null>}
 */
export async function loadDailyBoard(dateString) {
  const db = _firebaseDb();
  if (!db) return null;
  try {
    const ref = db.ref(`${DB_PATH}/${dateString}`);
    const snap = await Promise.race([
      ref.once('value'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT_MS)),
    ]);
    if (!snap.exists()) return null;
    return snap.val();
  } catch (err) {
    console.warn('loadDailyBoard failed:', err.message);
    return null;
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
  const db = _firebaseDb();
  if (!db) return false;
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
