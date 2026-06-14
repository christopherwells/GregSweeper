// Archive replays must never persist: they share the daily save slot, so a
// saved archive would clobber an in-progress real daily (and a past-date save
// would fail resume anyway). Pins persistGameState's archive guard against a
// future refactor that drops it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Rich browser stubs so the DOM-coupled modules gamePersistence imports load
// in node. Set BEFORE the dynamic imports (static imports would hoist above
// these and crash on the missing globals). If a future DOM-module refactor
// needs another global at import time, this stub grows.
globalThis.localStorage = (() => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k), clear: () => m.clear(), key: i => [...m.keys()][i] ?? null, get length() { return m.size; } };
})();
globalThis.window = { location: { search: '', hostname: 'localhost', pathname: '/' }, addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } };
globalThis.document = {
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
  documentElement: { style: { setProperty() {} }, setAttribute() {}, getAttribute() { return null; }, classList: { add() {}, remove() {} } },
  body: { classList: { add() {}, remove() {} } },
};

const { state } = await import('../src/state/gameState.js');
const { persistGameState } = await import('../src/game/gamePersistence.js');
const { loadGameState } = await import('../src/storage/statsStorage.js');

function setupPlayingDaily() {
  state.gameMode = 'daily';
  state.status = 'playing';
  state.board = [[{ row: 0, col: 0, isMine: false, isRevealed: true, isFlagged: false, adjacentMines: 0 }]];
  state.rows = 1; state.cols = 1; state.totalMines = 0;
  state.powerUps = {};
}

test('an archive play does not write the daily save slot (no clobber)', () => {
  localStorage.clear();
  setupPlayingDaily();
  state.isArchivePlay = true;
  persistGameState();
  assert.equal(loadGameState('daily'), null, 'archive must not persist into the daily slot');
});

test('a real daily play DOES persist (guard is not over-broad)', () => {
  localStorage.clear();
  setupPlayingDaily();
  state.isArchivePlay = false;
  persistGameState();
  const saved = loadGameState('daily');
  assert.ok(saved && Array.isArray(saved.board), 'a real daily must persist into its slot');
});
