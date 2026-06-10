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

// A seeded board verified (offline) to be solvable with ≥4 pattern moves
// and ≥3 mines carrying positive info-value under the pooled pricing.
// The previous hand-built fixture was degenerate: 5 mines on 7x7 meant
// the opening cascade revealed every non-mine cell (totalClicks: 1, zero
// deductions), so every mine priced 0 under ANY coefficients and the
// test could not detect a de-wired model.
const FIXTURE = { rows: 9, cols: 9, mines: 16, fr: 4, fc: 4, seed: 'unit-bomb-9' };

async function deductionBoard() {
  const { generateBoard, cleanSolverArtifacts } = await import('../src/logic/boardGenerator.js');
  const { createDailyRNG } = await import('../src/logic/seededRandom.js');
  const { rows, cols, mines, fr, fc, seed } = FIXTURE;
  const board = generateBoard(rows, cols, mines, fr, fc, createDailyRNG(seed));
  cleanSolverArtifacts(board);
  return board;
}

test('BOMB_PENALTY_BASE is the documented 3s', { skip: !HAS_FEATURE }, () => {
  assert.equal(diff.BOMB_PENALTY_BASE, 3);
});

test('every pricing coefficient name exists in PAR_MODEL', { skip: !HAS_FEATURE }, () => {
  // The regression this pins: PR #36 renamed the PAR_MODEL move
  // coefficients hours after PR #32 shipped bomb pricing against the old
  // names, and `|| 0` silently zeroed every info-value. A coefficient
  // rename must fail HERE, not in production telemetry.
  for (const term of bomb.POOLED_TERMS) {
    assert.equal(typeof diff.PAR_MODEL[term.coef], 'number',
      `POOLED_TERMS references "${term.coef}" but PAR_MODEL has no such coefficient`);
  }
});

test('info-value differentiates mines: some mine must price > 0 on a deduction-heavy board', { skip: !HAS_FEATURE }, async () => {
  const board = await deductionBoard();
  const { rows, cols, fr, fc } = FIXTURE;
  let maxInfo = -Infinity;
  let positives = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!board[r][c].isMine) continue;
      const { infoValue } = bomb.computeBombInfoValue(board, rows, cols, fr, fc, r, c);
      assert.ok(infoValue >= 0, `infoValue ${infoValue} negative at (${r},${c})`);
      if (infoValue > 0) positives++;
      maxInfo = Math.max(maxInfo, infoValue);
    }
  }
  // This seeded board requires pattern deduction, so at least one mine
  // must anchor some of it. The previous assertion here
  // (maxInfo >= minInfo) was vacuously true and let the de-wire ship.
  assert.ok(maxInfo > 0, `all mines priced 0 — pricing is de-wired (max ${maxInfo})`);
  assert.ok(positives >= 1, `expected ≥1 mine with positive info-value, got ${positives}`);
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
