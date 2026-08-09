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

test('first strike: penalty = round(infoValue + base) and the accounting identity holds', { skip: !HAS_FEATURE }, () => {
  // The core identity the timer/par/handicap pipeline depends on, for the
  // FIRST strike (the common case — most bomb-hit plays hit once):
  //   penalty added to clock = infoValue + base
  //   clean-play time (for fitting/handicap) = displayed - base*hits
  // A par-skill player who skipped `infoValue` of deduction and paid
  // `infoValue + base` lands exactly `base` over par. (Later strikes escalate
  // the base — see the next test.)
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

test('ramped base: 1st strike = base, each later strike adds half a base', { skip: !HAS_FEATURE }, () => {
  // handleDailyBombHit computes penalty = round((infoValue + rampedBase)*10)/10,
  // rampedBase(n) = base × (1 + ramp × (n-1)), n = priorHits + 1. A gentle ramp
  // (the >30% anti-cheat handles brute-force) while the info-value rides on top.
  const base = diff.BOMB_PENALTY_BASE;   // 3
  const ramp = diff.BOMB_PENALTY_RAMP;   // 0.5
  assert.equal(ramp, 0.5);
  const penaltyFor = (infoValue, n) => Math.round((infoValue + base * (1 + ramp * (n - 1))) * 10) / 10;
  // Zero-info strikes cost 3, 4.5, 6, 7.5 … (base, then +half-a-base each).
  assert.deepEqual([1, 2, 3, 4].map(n => penaltyFor(0, n)), [3, 4.5, 6, 7.5]);
  // The first strike is exactly the standard base — a lone hit is unchanged.
  assert.equal(penaltyFor(5.2, 1), Math.round((5.2 + base) * 10) / 10);
  // Info-value rides on top of the ramped base (3rd strike base = 6).
  assert.equal(penaltyFor(12.4, 3), Math.round((12.4 + 6) * 10) / 10);
});

test('isBombHitCheat: excavating the board is a probing run, a bad day is not', { skip: !HAS_FEATURE }, () => {
  const {
    isBombHitCheat, BOMB_HIT_CHEAT_FRACTION, BOMB_HIT_CHEAT_FLOOR,
    BOMB_HIT_EXCAVATED_FRACTION,
  } = diff;
  assert.equal(BOMB_HIT_CHEAT_FRACTION, 0.50);
  assert.equal(BOMB_HIT_CHEAT_FLOOR, 10);
  assert.equal(BOMB_HIT_EXCAVATED_FRACTION, 0.80);

  // REGRESSION (2026-08-09, Kate): today's daily was a 36-cell Kites board with
  // NINE mines. Under the old flat "> 30% of mines" the gate refused a run at
  // THREE hits — an ordinary bad day on the dearest lattice we ship — and she
  // lost both her leaderboard row and the dot on her own history chart. The
  // fraction was written against 25-30-mine rectangles, where it meant nine
  // mistakes; the shape rotation moved the scale under it.
  assert.equal(isBombHitCheat(3, 9), false, 'three hits on a 9-mine board is a bad day, not a probe');
  assert.equal(isBombHitCheat(4, 9), false);
  // The smallest shipped tiling configs (floret / deltoidal 2x3) carry SIX
  // mines, where the old rule refused at two.
  assert.equal(isBombHitCheat(2, 6), false, 'two hits on a 6-mine board is not a probe');
  assert.equal(isBombHitCheat(3, 6), false);

  // Arm 1 — far more mistakes than a bad day. The floor binds below 20 mines.
  assert.equal(isBombHitCheat(10, 20), false, 'floor is inclusive: 10 is allowed');
  assert.equal(isBombHitCheat(11, 20), true);
  assert.equal(isBombHitCheat(14, 28), false, 'half of 28 is 14, and "more than" is strict');
  assert.equal(isBombHitCheat(15, 28), true);
  assert.equal(isBombHitCheat(21, 42), false);
  assert.equal(isBombHitCheat(22, 42), true);

  // Arm 2 — you excavated the board. This is the ONLY arm that can fire where
  // the floor exceeds the mine count, so without it every board of 10 mines or
  // fewer would be ungated even against a total excavation.
  assert.equal(isBombHitCheat(7, 9), false);
  assert.equal(isBombHitCheat(8, 9), true, '8 of 9 mines found by detonation');
  assert.equal(isBombHitCheat(9, 9), true);
  assert.equal(isBombHitCheat(6, 6), true, 'every mine on the board');
  assert.equal(isBombHitCheat(5, 6), true);

  // The three real probing episodes on record stay refused, which is what
  // makes the loosening a no-op on the historical fit.
  assert.equal(isBombHitCheat(34, 34), true);
  assert.equal(isBombHitCheat(32, 32), true);
  assert.equal(isBombHitCheat(34, 42), true);
  // The worst GENUINE run on record (Kate, 2026-05-01) had two hits of headroom
  // under the old rule and comfortably clears the new one.
  assert.equal(isBombHitCheat(7, 28), false);

  assert.equal(isBombHitCheat(0, 20), false);
  // Degenerate inputs never trip — gimmick-free modes pass totalMines but 0
  // hits, and a missing totalMines must fail open (no false cheat flag).
  assert.equal(isBombHitCheat(0, 0), false);
  assert.equal(isBombHitCheat(5, undefined), false);
  assert.equal(isBombHitCheat(undefined, 20), false);
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
