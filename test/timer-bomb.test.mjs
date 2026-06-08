// Timer ↔ bomb-penalty integration. The 2026-06 bug was that stopTimer
// recomputed preciseTime from wall-clock and WIPED the bomb penalty,
// while the live display kept it — so the final time and par delta
// silently dropped the penalty. These tests lock the fold-in: the
// penalty must survive into preciseTime and the live display.
//
// Self-contained DOM shim (stub elements) installed BEFORE helpers so
// timerManager — which pulls in many document.querySelector handles —
// imports cleanly in Node. helpers.mjs only fills globals if unset, so
// this richer document wins.

const stubEl = () => ({
  textContent: '', style: {},
  classList: { _s: new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);}, contains(c){return this._s.has(c);}, toggle(){} },
  children: [], appendChild(){}, removeChild(){}, setAttribute(){}, getAttribute(){return null;}, addEventListener(){},
  querySelector(){return stubEl();}, querySelectorAll(){return [];},
});
globalThis.document = {
  getElementById: () => stubEl(), querySelector: () => stubEl(), querySelectorAll: () => [],
  createElement: () => stubEl(), createElementNS: () => stubEl(), body: stubEl(),
};

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

let tm, gameState;
try {
  tm = await import('../src/game/timerManager.js');
  gameState = await import('../src/state/gameState.js');
} catch { /* bomb feature not on this branch */ }
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
  assert.equal(tm.getDisplayTime(), 42);
});
