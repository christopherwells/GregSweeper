// Shared setup for the Node test suite (run via `node --test test/`).
//
// The pure-logic modules under test occasionally touch browser globals
// (localStorage via storageAdapter, window.location for env detection).
// node --test runs each test file in its own process, so importing this
// module for its side effects at the top of a test file installs a
// minimal, deterministic shim for that process. No real browser needed.

// In-memory localStorage so storage-backed helpers (boardCache,
// statsStorage residuals) round-trip predictably instead of relying on
// storageAdapter's internal Map fallback.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    key: (i) => Array.from(store.keys())[i] ?? null,
    clear: () => store.clear(),
    get length() { return store.size; },
  };
}

// env.js reads window.location to decide test vs prod; a plain localhost
// origin keeps isTestEnvironment() false and stable.
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { location: { search: '', hostname: 'localhost', pathname: '/' } };
}

// Some UI-adjacent modules probe for document; a null-returning stub is
// enough for the pure paths the tests exercise.
if (typeof globalThis.document === 'undefined') {
  globalThis.document = { getElementById: () => null };
}

// Build a fresh, plain Minesweeper board grid for solver/chord tests.
// Each cell carries the fields the solver and chord logic read.
export function makeBoard(rows, cols) {
  const board = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      row.push({
        row: r, col: c,
        isMine: false, adjacentMines: 0, displayedMines: undefined,
        isRevealed: false, isFlagged: false, isStrike: false,
        isMystery: false, isLiar: false, isLocked: false,
        isWormhole: false, isSonar: false, isCompass: false,
      });
    }
    board.push(row);
  }
  return board;
}

// Recompute adjacentMines from mine placement (wall-unaware — fine for
// the small hand-built boards in the chord/solver unit tests).
export function recalcAdjacency(board) {
  const rows = board.length, cols = board[0].length;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (board[r][c].isMine) continue;
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && board[nr][nc].isMine) n++;
        }
      }
      board[r][c].adjacentMines = n;
    }
  }
}
