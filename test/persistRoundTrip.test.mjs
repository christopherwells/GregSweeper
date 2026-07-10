// Persistence round-trip for the fields the save snapshot used to DROP
// (2026-07-10 audit):
//
//   - hintEvents: the Lens log rides every daily/weekly submission so the
//     nightly refit can EXCLUDE hinted plays from the par fit. A resumed
//     daily that had used the Lens submitted WITHOUT its log — the play
//     entered the fit as unhinted and contaminated the model.
//   - usedPowerUps: a resumed challenge game that had already used a
//     power-up counted as a purist win on completion.
//   - timedPar / timedFeatures: a resumed timed win lost its par line and
//     its timed/{pushId} fit row.
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

function setupTimedGame() {
  state.gameMode = 'timed';
  state.status = 'playing';
  state.isArchivePlay = false;
  state.isDailyPractice = false;
  state.board = makeBoard(3, 3);
  state.rows = 3; state.cols = 3; state.totalMines = 1;
  state.board[2][2].isMine = true;
  state.flagCount = 0; state.revealedCount = 0;
  state.elapsedTime = 12; state.currentLevel = 2;
  state.powerUps = { revealSafe: 1, shield: 0, lifeline: 0, scanRowCol: 0, magnet: 0, xray: 0 };
  state.activeGimmicks = [];
  state.hintEvents = [{ t: 4.2, kind: 'region' }];
  state.usedPowerUps = true;
  state.timedPar = 41.7;
  state.timedFeatures = { cellCount: 9, totalMines: 1, modeTimed: 1 };
}

test('REGRESSION: hintEvents / usedPowerUps / timedPar / timedFeatures survive the save snapshot', () => {
  localStorage.clear();
  setupTimedGame();
  persistGameState();
  const saved = loadGameState('timed');
  assert.ok(saved, 'the timed slot must persist');
  assert.deepEqual(saved.hintEvents, [{ t: 4.2, kind: 'region' }], 'the Lens log must ride the save');
  assert.equal(saved.usedPowerUps, true, 'the purist flag must ride the save');
  assert.equal(saved.timedPar, 41.7);
  assert.deepEqual(saved.timedFeatures, { cellCount: 9, totalMines: 1, modeTimed: 1 });
});

test('REGRESSION: the resume path restores all four fields onto live state', () => {
  localStorage.clear();
  setupTimedGame();
  persistGameState();

  // Wipe the live fields the way a fresh boot would.
  state.hintEvents = [];
  state.usedPowerUps = false;
  state.timedPar = 0;
  state.timedFeatures = null;
  state.status = 'idle';

  const resumed = tryResumeGame('timed');
  // The resume starts a real interval timer — stop it so the test process exits.
  if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }

  assert.equal(resumed, true, 'the timed save must be resumable');
  assert.deepEqual(state.hintEvents, [{ t: 4.2, kind: 'region' }]);
  assert.equal(state.usedPowerUps, true);
  assert.equal(state.timedPar, 41.7);
  assert.deepEqual(state.timedFeatures, { cellCount: 9, totalMines: 1, modeTimed: 1 });
});

test('a pre-fix save (fields absent) resumes with safe defaults', () => {
  localStorage.clear();
  setupTimedGame();
  persistGameState();
  const saved = loadGameState('timed');
  delete saved.hintEvents;
  delete saved.usedPowerUps;
  delete saved.timedPar;
  delete saved.timedFeatures;
  localStorage.setItem('minesweeper_game_state_timed', JSON.stringify(saved));

  const resumed = tryResumeGame('timed');
  if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }

  assert.equal(resumed, true);
  assert.deepEqual(state.hintEvents, []);
  assert.equal(state.usedPowerUps, false);
  assert.equal(state.timedPar, 0);
  assert.equal(state.timedFeatures, null);
});
