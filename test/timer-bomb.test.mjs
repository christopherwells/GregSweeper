// Timer ↔ bomb-penalty integration. The 2026-06 bug was that stopTimer
// recomputed preciseTime from wall-clock and WIPED the bomb penalty,
// while the live display kept it — so the final time and par delta
// silently dropped the penalty. These tests lock the fold-in: the
// penalty must survive into preciseTime and the live display.
//
// 2026-07-04 incident (timer flash): headerRenderer's updateHeader carried
// an INLINED timer-display copy that skipped the bomb penalty, so every
// reveal / flag / bomb-popup close overwrote the penalized clock with raw
// wall-clock until the next tick — the daily/weekly timer visibly flashed
// between the two values all game. The display derivation now lives in
// gameState.getDisplayTime() and BOTH writers (timerManager's tick,
// updateHeader) must render it; the REGRESSION case below drives the real
// updateHeader against a shared-element DOM shim to pin that.
//
// Self-contained DOM shim installed BEFORE helpers so timerManager and
// headerRenderer — which pull in many document.querySelector handles —
// import cleanly in Node. Elements are CACHED per selector/id so a write
// through one module's handle is readable through another's (that
// same-element aliasing is what the regression test needs). helpers.mjs
// only fills globals if unset, so this richer document wins.

const stubEl = () => ({
  textContent: '', innerHTML: '', style: {}, dataset: {}, title: '', disabled: false,
  classList: { _s: new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);}, contains(c){return this._s.has(c);}, toggle(){} },
  children: [], appendChild(){}, removeChild(){}, setAttribute(){}, getAttribute(){return null;}, addEventListener(){},
  querySelector(){return stubEl();}, querySelectorAll(){return [];},
});
const _els = new Map();
const getEl = (key) => {
  if (!_els.has(key)) _els.set(key, stubEl());
  return _els.get(key);
};
globalThis.document = {
  getElementById: (id) => getEl('#' + id), querySelector: (sel) => getEl(sel), querySelectorAll: () => [],
  createElement: () => stubEl(), createElementNS: () => stubEl(), body: stubEl(),
  documentElement: stubEl(), // getThemeEmoji reads data-theme off it → null ⇒ 'classic'
};

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

let tm, gameState, hr;
try {
  tm = await import('../src/game/timerManager.js');
  gameState = await import('../src/state/gameState.js');
} catch { /* bomb feature not on this branch */ }
try {
  hr = await import('../src/ui/headerRenderer.js');
} catch { /* header import failure is asserted loudly in the REGRESSION case */ }
const HAS = !!(tm && gameState && typeof gameState.getActiveBombPenaltyTotal === 'function');

function setEvents(penalties) {
  gameState.state.gameMode = 'daily';
  gameState.state.dailyBombHitEvents = penalties.map(p => ({ penalty: p }));
  gameState.state.weeklyBombHitEvents = [];
  gameState.state.preciseTime = 0;
  gameState.state.elapsedTime = 0;
}

test('stopTimer folds the bomb penalty into preciseTime (the wiped-penalty bug)', { skip: !HAS }, () => {
  setEvents([15]);
  tm.startTimer();
  tm.stopTimer();
  // Wall-clock between start and stop is well under a second, so the
  // recorded time is the 15s penalty plus a sliver. The bug produced ~0.
  assert.ok(gameState.state.preciseTime >= 15 && gameState.state.preciseTime < 16,
    `preciseTime ${gameState.state.preciseTime} should include the 15s penalty`);
});

test('multiple hits sum into preciseTime', { skip: !HAS }, () => {
  setEvents([7.2, 3, 10.5]); // total 20.7
  tm.startTimer();
  tm.stopTimer();
  assert.ok(gameState.state.preciseTime >= 20.7 && gameState.state.preciseTime < 21.7,
    `preciseTime ${gameState.state.preciseTime} should include the 20.7s penalty total`);
});

test('no bomb hits → preciseTime is just wall-clock (no spurious penalty)', { skip: !HAS }, () => {
  setEvents([]);
  tm.startTimer();
  tm.stopTimer();
  assert.ok(gameState.state.preciseTime < 1,
    `clean play preciseTime ${gameState.state.preciseTime} should be ~0`);
});

test('getDisplayTime adds the penalty to the live wall-clock counter', { skip: !HAS }, () => {
  setEvents([12]);
  gameState.state.elapsedTime = 30; // pure wall-clock counter
  // Live display = floor(elapsedTime + penalty) = floor(30 + 12) = 42.
  // getDisplayTime lives in gameState (not timerManager) so headerRenderer
  // can share it without a ui → game import.
  assert.equal(gameState.getDisplayTime(), 42);
});

test('REGRESSION: updateHeader keeps the bomb penalty in the displayed time (timer-flash incident 2026-07-04)', { skip: !HAS }, () => {
  // If headerRenderer stops importing under the shim, fail loudly — a
  // silent skip here would un-pin the incident.
  assert.ok(hr, 'headerRenderer must import under the DOM shim');

  setEvents([12]);
  gameState.state.elapsedTime = 30;
  gameState.state.dailyBombHits = 1;
  gameState.state.status = 'playing';
  gameState.state.board = [];
  gameState.state.totalMines = 10;
  gameState.state.flagCount = 0;

  const timerEl = document.getElementById('timer-display');

  // The tick path renders the penalized total…
  tm.updateTimerDisplay();
  assert.equal(timerEl.textContent, '042', 'tick path must render elapsed + penalty');

  // …and the reveal path (updateHeader fires on every reveal, flag, and
  // bomb-popup close) must NOT overwrite it with raw wall-clock. Before
  // the fix this read '030' until the next tick — the visible flash.
  hr.updateHeader();
  assert.equal(timerEl.textContent, '042',
    'updateHeader must render the same penalty-inclusive time as the tick path');
});
