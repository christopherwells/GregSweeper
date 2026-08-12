// Persistence round-trip for the fields the save snapshot used to DROP
// (2026-07-10 audit):
//
//   (hintEvents was the third field here until the Lens was removed
//   2026-07-18; nothing produces a hint log any more.)
//
//   - usedPowerUps: a resumed challenge game that had already used a
//     power-up counted as a purist win on completion.
//   - the mode's own par + features: a resumed win rendered no par line and
//     priced its strikes against no baseline. (These were timedPar /
//     timedFeatures until Quick Play was absorbed into the dealt Challenge
//     match mode; the match pair carries the same contract, plus the match
//     STRUCTURE, whose loss would re-deal different boards mid-match.)
//
// Drives the REAL persist → resume path (not just the payload shape), with
// a rich DOM proxy shim so tryResumeGame's render calls no-op in node.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Headless DOM shim (importSmoke's proxy pattern) ────────────────────
function stubStyle() {
  return new Proxy({ setProperty() {}, getPropertyValue() { return ''; }, removeProperty() {} }, {
    get(t, p) { return p in t ? t[p] : ''; },
    set() { return true; },
  });
}
function stubEl() {
  return new Proxy(function () {}, {
    get(_t, prop) {
      switch (prop) {
        case 'style': return stubStyle();
        case 'dataset': return {};
        case 'classList': return { add() {}, remove() {}, toggle() {}, replace() {}, contains() { return false; } };
        case 'children': case 'childNodes':
          // Array-like: length 0 for loops, but a stub element for any
          // direct [idx] access so render helpers can no-op through it.
          return new Proxy([], { get(t, p) { return p in t ? t[p] : stubEl(); } });
        case 'length': return 0;
        case 'value': case 'textContent': case 'innerHTML': case 'innerText':
        case 'className': case 'id': case 'tagName': case 'nodeName': return '';
        case 'parentNode': case 'parentElement': case 'nextSibling':
        case 'previousSibling': case 'firstChild': case 'lastChild': return null;
        case 'getContext': return () => stubEl();
        case 'getBoundingClientRect':
          return () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });
        case 'querySelector': case 'closest': return () => null;
        case 'querySelectorAll': case 'getElementsByClassName': case 'getElementsByTagName': return () => [];
        case 'then': return undefined;
        case Symbol.toPrimitive: return () => '';
        case Symbol.iterator: return [][Symbol.iterator].bind([]);
        default: return () => stubEl();
      }
    },
    apply() { return stubEl(); },
  });
}
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  key: (i) => Array.from(store.keys())[i] ?? null,
  clear: () => store.clear(),
  get length() { return store.size; },
};
globalThis.document = {
  documentElement: stubEl(), body: stubEl(), head: stubEl(),
  createElement: () => stubEl(), createElementNS: () => stubEl(),
  createDocumentFragment: () => stubEl(), createTextNode: () => stubEl(),
  getElementById: () => stubEl(), querySelector: () => stubEl(),
  querySelectorAll: () => [], getElementsByClassName: () => [], getElementsByTagName: () => [],
  addEventListener() {}, removeEventListener() {},
  cookie: '', visibilityState: 'visible', hidden: false,
};
globalThis.window = {
  location: { search: '', hostname: 'localhost', pathname: '/', href: 'http://localhost/', origin: 'http://localhost' },
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  devicePixelRatio: 1, innerWidth: 800, innerHeight: 600,
  setTimeout, clearTimeout, setInterval, clearInterval,
};
if (typeof globalThis.navigator === 'undefined') {
  globalThis.navigator = { userAgent: 'node', platform: 'node', maxTouchPoints: 0, language: 'en-US', onLine: true };
}
globalThis.requestAnimationFrame = () => 0;
globalThis.getComputedStyle = () => stubStyle();
globalThis.matchMedia = globalThis.window.matchMedia;

const { state } = await import('../src/state/gameState.js');
const { persistGameState, tryResumeGame } = await import('../src/game/gamePersistence.js');
const { loadGameState } = await import('../src/storage/statsStorage.js');

function makeBoard(rows, cols) {
  const b = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      row.push({ row: r, col: c, isMine: false, isRevealed: false, isFlagged: false, adjacentMines: 0 });
    }
    b.push(row);
  }
  return b;
}

// A mid-match save: board 2 of 3, one board already banked. The entries
// carry real payloads because they ARE the match; isSaveResumable refuses a
// match save whose entries are missing, so a stub list would test nothing.
function matchEntries() {
  return [
    { seed: 'match:a', payload: { rows: 3, cols: 3, totalMines: 1 }, par: 40, spec: { shape: 'rect' } },
    { seed: 'match:b', payload: { rows: 3, cols: 3, totalMines: 1 }, par: 55, spec: { shape: 'rect' } },
    { seed: 'match:c', payload: { rows: 3, cols: 3, totalMines: 1 }, par: 70, spec: { shape: 'rect' } },
  ];
}

function setupMatchGame() {
  state.gameMode = 'match';
  state.status = 'playing';
  state.isArchivePlay = false;
  state.isDailyPractice = false;
  state.isLevelPractice = false;
  state.board = makeBoard(3, 3);
  state.rows = 3; state.cols = 3; state.totalMines = 1;
  state.board[2][2].isMine = true;
  state.flagCount = 0; state.revealedCount = 0;
  state.elapsedTime = 12; state.currentLevel = 2;
  state.powerUps = { revealSafe: 1, shield: 0, lifeline: 0, scanRowCol: 0, magnet: 0, xray: 0 };
  state.activeGimmicks = [];
  state.usedPowerUps = true;
  state.matchPar = 41.7;
  state.matchFeatures = { cellCount: 9, totalMines: 1 };
  state.match = {
    rules: { count: 3, shapes: ['rect'], mods: [], time: 'any', density: 'any' },
    entries: matchEntries(),
    current: 1,
    results: [{ seed: 'match:a', time: 30.5, penalty: 0, strikes: 0, par: 40 }],
  };
}

test('REGRESSION: usedPowerUps / matchPar / matchFeatures survive the save snapshot', () => {
  localStorage.clear();
  setupMatchGame();
  persistGameState();
  const saved = loadGameState('match');
  assert.ok(saved, 'the match slot must persist');
  assert.equal(saved.usedPowerUps, true, 'the purist flag must ride the save');
  assert.equal(saved.matchPar, 41.7);
  assert.deepEqual(saved.matchFeatures, { cellCount: 9, totalMines: 1 });
});

test('REGRESSION: the dealt entries ride the save, so a resume plays the SAME boards', () => {
  // The entries are the match. A save that dropped them would re-deal on
  // resume, handing the player different boards mid-match (and, once the
  // match node ships, different boards from the opponent's).
  localStorage.clear();
  setupMatchGame();
  persistGameState();
  const saved = loadGameState('match');
  assert.deepEqual(saved.match.entries.map((e) => e.seed), ['match:a', 'match:b', 'match:c']);
  assert.equal(saved.match.current, 1, 'the board index rides too');
  assert.deepEqual(saved.match.results[0], { seed: 'match:a', time: 30.5, penalty: 0, strikes: 0, par: 40 });
  assert.deepEqual(saved.match.rules.shapes, ['rect']);
});

test('REGRESSION: a resume brings all three fields back onto live state', () => {
  localStorage.clear();
  setupMatchGame();
  persistGameState();

  // Wipe the live fields the way a fresh boot would.
  state.usedPowerUps = false;
  state.matchPar = 0;
  state.matchFeatures = null;
  state.match = null;
  state.status = 'idle';

  const resumed = tryResumeGame('match');
  // The resume starts a real interval timer, so stop it or the test process hangs.
  if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }

  assert.equal(resumed, true, 'the match save must be resumable');
  assert.equal(state.usedPowerUps, true);
  assert.equal(state.matchPar, 41.7);
  assert.deepEqual(state.matchFeatures, { cellCount: 9, totalMines: 1 });
  assert.equal(state.match.current, 1);
  assert.deepEqual(state.match.entries.map((e) => e.seed), ['match:a', 'match:b', 'match:c']);
});

test('REGRESSION: a match save without its entries is REFUSED, not half-restored', () => {
  // Half-restoring would leave the mode with a rules object and no boards,
  // which newGame would then fill by dealing a different match.
  localStorage.clear();
  setupMatchGame();
  persistGameState();
  const saved = loadGameState('match');
  saved.match = { ...saved.match, entries: [] };
  localStorage.setItem('minesweeper_game_state_match', JSON.stringify(saved));
  state.match = null;
  assert.equal(tryResumeGame('match'), false);
  if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
});

test('a pre-fix save (fields absent) resumes with safe defaults', () => {
  localStorage.clear();
  setupMatchGame();
  persistGameState();
  const saved = loadGameState('match');
  delete saved.usedPowerUps;
  delete saved.matchPar;
  delete saved.matchFeatures;
  localStorage.setItem('minesweeper_game_state_match', JSON.stringify(saved));

  const resumed = tryResumeGame('match');
  if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }

  assert.equal(resumed, true);
  assert.equal(state.usedPowerUps, false);
  assert.equal(state.matchPar, 0);
  assert.equal(state.matchFeatures, null);
});

// ── Explicit topology (Coastline tiling boards) ────────────────────────
//
// The snapshot is JSON, and JSON.stringify drops properties stamped on the
// board ARRAY — which is why _wallEdges rides as its own top-level field.
// _cellNeighbors had no such field, so a tiling game saved and resumed came
// back RECTANGULAR mid-play, with no error: the board silently changes shape
// under the player, and the adjacency it was certified under is gone.
// Found in the Coastline Phase 1 adversarial review, 2026-07-19.

const { buildNeighborCache } = await import('../src/logic/adjacency.js');
const { buildTiling488 } = await import('./fixtures/tiling488.mjs');
const { defineCellNeighbors } = await import('../src/logic/adjacency.js');

function setupTilingGame() {
  // 3x3 octagons + 4 interstitial squares = 13 cells, in a 13x1 container.
  // Stamped with the FULL board-identity contract the generator emits —
  // topology AND geometry — because that is the only shape a real tiling
  // board ever has, and isSaveResumable now refuses a topology without its
  // geometry (issue #189).
  const T = buildTiling488(3, 3);
  state.gameMode = 'normal';
  state.status = 'playing';
  state.isArchivePlay = false;
  state.isDailyPractice = false;
  state.board = makeBoard(T.total, 1);
  state.rows = T.total; state.cols = 1; state.totalMines = 2;
  defineCellNeighbors(state.board, T.total, 1, T.adj);
  state.board._cellPos = T.cellPos;
  state.board._tiling = { type: T.type, M: 3, N: 3, wUnits: T.wUnits, hUnits: T.hUnits };
  state.board._tilingWalls = [];
  // A stored compass ray on one cell — on an explicit topology the ray is
  // stamped geometry, and dropping it from the save silently zeroed every
  // compass number on resume (the CELL_FIELDS defect replayed, issue #189).
  state.board[2][0].isCompass = true;
  state.board[2][0].compassArrow = '←';
  state.board[2][0].compassRay = [1, 0];
  state.flagCount = 0; state.revealedCount = 0;
  state.elapsedTime = 5; state.currentLevel = 1;
  state.powerUps = { revealSafe: 0, shield: 0, lifeline: 0, scanRowCol: 0, magnet: 0, xray: 0 };
  state.activeGimmicks = [];
  state.usedPowerUps = false;
  state.matchPar = 0;
  state.matchFeatures = null;
  state.match = null;
  return T;
}

test('REGRESSION: an explicit topology survives the save snapshot', () => {
  localStorage.clear();
  const T = setupTilingGame();
  persistGameState();

  const saved = loadGameState('challenge');
  assert.ok(saved, 'the slot must persist');
  assert.ok(saved.cellNeighbors, 'the topology must ride the save as its own field');
  assert.equal(saved.cellNeighbors.length, T.total);
  assert.deepEqual(saved.cellNeighbors, T.adj);

  // REGRESSION #189: the GEOMETRY rides alongside the graph. Without these a
  // resumed board carried a hexagonal adjacency but rendered as a
  // rectangular CSS grid (_cellPos is the renderer's own tiling test), with
  // walls invisible and no descriptor to rebuild from.
  assert.deepEqual(saved.cellPos, T.cellPos, 'cellPos must ride the save');
  assert.equal(saved.tiling.type, T.type, 'the tiling descriptor must ride the save');
  assert.deepEqual(saved.tilingWalls, [], 'the severed-edge list must ride the save');
  // And the stored compass ray survives per-cell — dropping it silently
  // zeroed every compass number when resume recomputed displayedMines.
  assert.deepEqual(saved.board[2][0].compassRay, [1, 0], 'compassRay must ride the cell snapshot');
});

test('REGRESSION: a resumed tiling board keeps its topology, not a rectangle', () => {
  localStorage.clear();
  const T = setupTilingGame();
  persistGameState();

  // Wipe live state the way a fresh boot would.
  state.board = null;
  state.status = 'idle';

  const resumed = tryResumeGame('normal');
  if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }

  assert.equal(resumed, true, 'the tiling save must be resumable');
  assert.ok(state.board._cellNeighbors, 'the restored board must carry its topology');
  assert.deepEqual(state.board._cellNeighbors, T.adj);

  // REGRESSION #189: the geometry restores WITH the graph, so the renderer's
  // own tiling test (_cellPos) passes and the board draws as its lattice.
  assert.deepEqual(state.board._cellPos, T.cellPos, 'the restored board must carry its geometry');
  assert.equal(state.board._tiling.type, T.type, 'the restored board must carry its descriptor');
  assert.deepEqual(state.board._tilingWalls, [], 'the restored board must carry its wall list (as an array)');
  // The stored compass ray came back, so the resume's recomputeDisplayedMines
  // read the same premise the board displayed before the save.
  assert.deepEqual(state.board[2][0].compassRay, [1, 0], 'the restored cell must keep its stored ray');

  // The thing that actually matters: every adjacency question asked of the
  // resumed board resolves through the tiling, not through its container.
  const cache = buildNeighborCache(state.board, state.rows, state.cols);
  assert.deepEqual(cache, T.adj);
  // A 13x1 container's own 8-neighborhood would give the middle cell 2
  // neighbors; the tiling gives the centre octagon 8.
  assert.equal(cache[T.octIndex(1, 1)].length, 8,
    'the centre octagon sees 8 — a rectangular read of a 13x1 strip could never');
});

test('an ordinary rectangular save carries no topology and resumes unchanged', () => {
  localStorage.clear();
  setupMatchGame();
  persistGameState();

  const saved = loadGameState('match');
  assert.equal(saved.cellNeighbors, null, 'no topology field on an ordinary board');

  const resumed = tryResumeGame('match');
  if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
  assert.equal(resumed, true);
  assert.equal(state.board._cellNeighbors, undefined, 'rectangular boards stay implicit');
});
