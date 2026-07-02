// Daily win-modal par display decision. Pins the newcomer gate (first few
// dailies show plain "vs Greg" only), the refit-vs-provisional handicap
// resolution, and the ±0.5s delta thresholds + wording. The handicap is now a
// MULTIPLICATIVE ratio k: personalPar = dailyPar × k + bombSeconds, and the
// provisional fallback is a geometric-mean ratio of the player's residuals.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveParDisplay, NEWCOMER_DAILY_LIMIT } from '../src/logic/parDisplayDecision.js';

// residuals are {date, time, par}; only time/par matter to the math.
function residualsOf(n, time = 100, par = 100) {
  return Array.from({ length: n }, (_, i) => ({ date: 'd' + i, time, par }));
}

test('newcomer gate: at or below the limit, the handicap is ignored and only plain par shows', () => {
  const d = resolveParDisplay({ precise: 50, dailyPar: 60, refitRatio: 0.9, isRated: true, residuals: residualsOf(NEWCOMER_DAILY_LIMIT) });
  assert.equal(d.isNewcomerDaily, true);
  assert.equal(d.useHandicap, false, 'a known handicap is still suppressed for a newcomer');
  assert.equal(d.referencePar, 60, 'reference is Greg par, not personal');
  assert.equal(d.parClass, 'par-under');
  assert.equal(d.deltaText, '10.0s under par', 'wording is plain "par", not "your par"');
});

test('refit ratio past the newcomer gate: delta is vs personal par (dailyPar × k)', () => {
  const d = resolveParDisplay({ precise: 85, dailyPar: 100, refitRatio: 0.9, isRated: true, residuals: residualsOf(5) });
  assert.equal(d.isNewcomerDaily, false);
  assert.equal(d.useHandicap, true);
  assert.equal(d.personalPar, 90);          // 100 × 0.9
  assert.equal(d.referencePar, 90);
  assert.equal(d.parClass, 'par-under');
  assert.equal(d.deltaText, '5.0s under your par');
  assert.equal(d.provisional, null);
  assert.equal(d.yourParLabel, 'Your par: ');
});

test('refit bombSeconds add on top of the ratio par', () => {
  const d = resolveParDisplay({ precise: 100, dailyPar: 100, refitRatio: 0.9, refitBombSeconds: 5, isRated: true, residuals: residualsOf(5) });
  assert.equal(d.personalPar, 95);          // 100 × 0.9 + 5
});

test('provisional handicap: not rated falls back to the geometric-mean ratio, labeled with the play count', () => {
  // 4 plays each 8% over par → geometric-mean ratio 1.08, shrunk toward 1
  // (n/(n+3) = 4/7 in log space) → k ≈ 1.045; non-newcomer (> 3 plays).
  const d = resolveParDisplay({ precise: 100, dailyPar: 100, refitRatio: 1, isRated: false, residuals: residualsOf(4, 108, 100) });
  assert.equal(d.useHandicap, true);
  assert.equal(d.ratio, 1.045);
  assert.ok(d.provisional && d.provisional.n === 4);
  assert.ok(Math.abs(d.personalPar - 104.5) < 1e-6);
  assert.equal(d.deltaText, '4.5s under your par', '100 vs personal par 104.5 is 4.5s under');
  assert.equal(d.yourParLabel, 'Your par (provisional, 4 plays): ');
});

test('delta thresholds: ±0.5s is the even band, otherwise under/over', () => {
  const base = { dailyPar: 60, refitRatio: 1, isRated: false, residuals: residualsOf(5, 60, 60) }; // ratio resolves to 1
  assert.equal(resolveParDisplay({ ...base, precise: 60.4 }).parClass, 'par-even');
  assert.equal(resolveParDisplay({ ...base, precise: 59.6 }).parClass, 'par-even');
  assert.equal(resolveParDisplay({ ...base, precise: 60.4 }).deltaText, 'Even par!');
  assert.equal(resolveParDisplay({ ...base, precise: 60.6 }).parClass, 'par-over');
  assert.equal(resolveParDisplay({ ...base, precise: 60.6 }).deltaText, '0.6s over par');
  assert.equal(resolveParDisplay({ ...base, precise: 59.4 }).parClass, 'par-under');
});

test('even wording switches to "your par" when a handicap is in play', () => {
  const d = resolveParDisplay({ precise: 57.2, dailyPar: 60, refitRatio: 0.95, isRated: true, residuals: residualsOf(5) });
  assert.equal(d.useHandicap, true);
  assert.equal(d.personalPar, 57);          // 60 × 0.95
  assert.equal(d.parClass, 'par-even');
  assert.equal(d.deltaText, 'Even with your par!');
});

test('a ratio of exactly 1 past the gate uses Greg par directly', () => {
  // 5 plays exactly on par → provisional ratio 1 → useHandicap false.
  const d = resolveParDisplay({ precise: 70, dailyPar: 60, refitRatio: 1, isRated: false, residuals: residualsOf(5, 60, 60) });
  assert.equal(d.ratio, 1);
  assert.equal(d.useHandicap, false);
  assert.equal(d.referencePar, 60);
  assert.equal(d.deltaText, '10.0s over par');
});

test('the "one more daily" hint shows at exactly one residual', () => {
  assert.equal(resolveParDisplay({ precise: 70, dailyPar: 60, refitRatio: 1, isRated: false, residuals: residualsOf(1) }).showOneMoreHint, true);
  assert.equal(resolveParDisplay({ precise: 70, dailyPar: 60, refitRatio: 1, isRated: false, residuals: residualsOf(2) }).showOneMoreHint, false);
  assert.equal(resolveParDisplay({ precise: 70, dailyPar: 60, refitRatio: 1, isRated: false, residuals: residualsOf(0) }).showOneMoreHint, false);
});

test('missing residuals are treated as an empty list (newcomer, no crash)', () => {
  const d = resolveParDisplay({ precise: 70, dailyPar: 60, refitRatio: 1, isRated: false, residuals: null });
  assert.equal(d.isNewcomerDaily, true);
  assert.equal(d.useHandicap, false);
  assert.equal(d.referencePar, 60);
});
