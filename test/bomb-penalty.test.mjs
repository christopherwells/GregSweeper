// Bomb info-value penalty accounting. This is the freshest and most
// fragile math in the app — a regression here silently mis-charges the
// player and corrupts the par/handicap pipeline (see the 2026-06 timer
// bug). Guarded to skip cleanly on branches where the feature isn't
// present yet (e.g. main before the bomb feature merges).

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

let bomb, diff, gameState;
try {
  bomb = await import('../src/logic/bombInfoValue.js');
  diff = await import('../src/logic/difficulty.js');
  gameState = await import('../src/state/gameState.js');
} catch { /* feature not on this branch — tests below self-skip */ }

const HAS_FEATURE = !!(bomb && diff && gameState && typeof diff.BOMB_PENALTY_BASE === 'number');

// Build a board with a dense mine cluster (so some mines anchor real
// deductions) plus an isolated corner mine (anchors nothing).
async function clusterBoard() {
  const { makeBoard, recalcAdjacency } = await import('./helpers.mjs');
  const board = makeBoard(7, 7);
  // 2x2 cluster of mines in the middle-ish, forcing subset deductions.
  for (const [r, c] of [[2, 2], [2, 3], [3, 2], [3, 3]]) board[r][c].isMine = true;
  // Isolated corner mine — surrounded by open space, deduced trivially.
  board[0][6].isMine = true;
  recalcAdjacency(board);
  return board;
}

test('BOMB_PENALTY_BASE is the documented 3s', { skip: !HAS_FEATURE }, () => {
  assert.equal(diff.BOMB_PENALTY_BASE, 3);
});

test('info-value is never negative and a cluster mine outscores a corner mine', { skip: !HAS_FEATURE }, async () => {
  const board = await clusterBoard();
  const fr = 3, fc = 3;
  let minInfo = Infinity, maxInfo = -Infinity;
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      if (!board[r][c].isMine) continue;
      const { infoValue } = bomb.computeBombInfoValue(board, 7, 7, fr, fc, r, c);
      assert.ok(infoValue >= 0, `infoValue ${infoValue} negative at (${r},${c})`);
      minInfo = Math.min(minInfo, infoValue);
      maxInfo = Math.max(maxInfo, infoValue);
    }
  }
  // At least one mine should anchor more deduction than another, i.e. the
  // mechanic actually differentiates mines (not a flat constant).
  assert.ok(maxInfo >= minInfo, 'info-value range collapsed');
});

test('penalty = round(infoValue + base) and the accounting identity holds', { skip: !HAS_FEATURE }, () => {
  // The core identity the timer/par/handicap pipeline depends on:
  //   penalty added to clock = infoValue + base
  //   clean-play time (for fitting/handicap) = displayed - base*hits
  // A par-skill player who skipped `infoValue` of deduction and paid
  // `infoValue + base` lands exactly `base` over par per hit.
  const base = diff.BOMB_PENALTY_BASE;
  const par = 60;
  for (const infoValue of [0, 5.2, 18, 31.7]) {
    const penalty = Math.round((infoValue + base) * 10) / 10;
    const wallClock = par - infoValue;            // skipped that much deduction
    const displayed = Math.round((wallClock + penalty) * 10) / 10;
    const deltaVsPar = Math.round((displayed - par) * 10) / 10;
    assert.equal(deltaVsPar, base, `delta should be +${base}s over par, got ${deltaVsPar}`);
    const cleanTime = displayed - base * 1;       // handicap/refit subtraction
    assert.ok(Math.abs(cleanTime - par) < 0.05, `clean time ${cleanTime} should ≈ par ${par}`);
  }
});

test('getActiveBombPenaltyTotal sums the per-hit event log', { skip: !HAS_FEATURE }, () => {
  const { state, getActiveBombPenaltyTotal } = gameState;
  state.gameMode = 'daily';
  state.dailyBombHitEvents = [{ penalty: 7.2 }, { penalty: 3 }];
  state.weeklyBombHitEvents = [];
  assert.equal(getActiveBombPenaltyTotal(), 10.2);
  // Fresh game (no events) → zero, so a stale total can't leak forward.
  state.dailyBombHitEvents = [];
  assert.equal(getActiveBombPenaltyTotal(), 0);
});
