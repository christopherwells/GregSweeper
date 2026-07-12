// Per-mine chord charging on daily/weekly (2026-07-12): a chord across two
// wrong flags exposes BOTH real mines in one gesture, and each one is now
// charged as its own strike — its own marginal info-value, its own ramped
// base, its own event row and strike marker — via handleDailyBombHit's
// batch (extraMines). The old flow re-fogged the extras and charged only
// the primary, hiding intel the player had already been shown. CALL-tested
// headless via the shared domShim.

import './domShim.mjs';
import { makeStateBoard } from './domShim.mjs';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const { state } = await import('../src/state/gameState.js');
const { setMuted } = await import('../src/audio/sounds.js');
const { recalcAllAdjacency } = await import('../src/logic/gimmicks.js');
const { BOMB_PENALTY_BASE, BOMB_PENALTY_RAMP } = await import('../src/logic/difficulty.js');
const { markNoticeSeen } = await import('../src/storage/statsStorage.js');
const { handleDailyBombHit } = await import('../src/game/winLossHandler.js');

setMuted(true);
// Skip the first-strike explainer modal path (needs MutationObserver);
// the transient-popup path is the one the batch popup rides.
markNoticeSeen('bombhit_explainer_v2');

function freshDaily(mode = 'daily') {
  state.gameMode = mode;
  state.status = 'playing';
  state.rows = 5;
  state.cols = 5;
  state.board = makeStateBoard(5, 5, [[0, 0], [0, 2]]);
  recalcAllAdjacency(state.board);
  state.totalMines = 2;
  state.elapsedTime = 10;
  state.modalPaused = false;
  state.dailyBombHits = 0;
  state.dailyBombHitEvents = [];
  state.weeklyBombHits = 0;
  state.weeklyBombHitEvents = [];
  state.dailyFeatures = null;
  state.weeklyFeatures = null;
}

test('REGRESSION: a two-mine chord charges BOTH mines — two events, ramped bases, two strike markers', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    freshDaily();
    handleDailyBombHit(0, 0, [{ row: 0, col: 2 }]);

    assert.equal(state.dailyBombHits, 2, 'both mines count toward the strike total (and the anti-cheat fraction)');
    assert.equal(state.dailyBombHitEvents.length, 2, 'one event row per mine');
    const [e1, e2] = state.dailyBombHitEvents;
    assert.deepEqual([e1.row, e1.col], [0, 0]);
    assert.deepEqual([e2.row, e2.col], [0, 2]);
    // Ramp: strike 1 base = BOMB_PENALTY_BASE, strike 2 = base × (1 + RAMP).
    // info-value rides on top (≥ 0), so penalties are at least the bases.
    assert.ok(e1.penalty >= BOMB_PENALTY_BASE - 1e-9, `first penalty ${e1.penalty} carries the base`);
    assert.ok(e2.penalty >= BOMB_PENALTY_BASE * (1 + BOMB_PENALTY_RAMP) - 1e-9,
      `second penalty ${e2.penalty} carries the RAMPED base — it is a real second strike, not a copy`);
    assert.equal(e1.t, e2.t, "a chord's mines share the one gesture's timestamp");

    for (const [r, c] of [[0, 0], [0, 2]]) {
      assert.equal(state.board[r][c].isStrike, true, `mine ${r},${c} stays revealed as a strike marker`);
      assert.equal(state.board[r][c].isRevealed, true);
      assert.equal(state.board[r][c].isMine, true, 'the mine is preserved — adjacent numbers must not drop');
    }

    mock.timers.tick(2100); // drain the popup → finishBombHit
    assert.equal(state.modalPaused, false, 'the pause/popup machinery ran once and released');
  } finally {
    mock.timers.reset();
  }
});

test('a single hit without extras behaves exactly as before', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    freshDaily();
    handleDailyBombHit(0, 0);
    assert.equal(state.dailyBombHits, 1);
    assert.equal(state.dailyBombHitEvents.length, 1);
    assert.ok(state.dailyBombHitEvents[0].penalty >= BOMB_PENALTY_BASE - 1e-9);
    mock.timers.tick(2100);
  } finally {
    mock.timers.reset();
  }
});

test('weekly routes the batch to the weekly counters', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    freshDaily('weekly');
    handleDailyBombHit(0, 0, [{ row: 0, col: 2 }]);
    assert.equal(state.weeklyBombHits, 2);
    assert.equal(state.weeklyBombHitEvents.length, 2);
    assert.equal(state.dailyBombHits, 0, 'the daily counters stay untouched');
    mock.timers.tick(2100);
  } finally {
    mock.timers.reset();
  }
});

test('a duplicate or malformed extra is ignored, never double-charged', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    freshDaily();
    handleDailyBombHit(0, 0, [{ row: 0, col: 0 }, null, { row: 'x', col: 2 }]);
    assert.equal(state.dailyBombHits, 1, 'the primary repeated as an extra must not charge twice');
    mock.timers.tick(2100);
  } finally {
    mock.timers.reset();
  }
});
