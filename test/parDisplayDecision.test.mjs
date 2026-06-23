// Daily win-modal par display decision. Pins the newcomer gate (first few
// dailies show plain "vs Greg" only), the refit-vs-provisional handicap
// resolution, and the ±0.5s delta thresholds + wording. These drive whether a
// brand-new player's first result screen is a wall of jargon and whether the
// delta is measured against Greg's par or the player's personal par.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveParDisplay, NEWCOMER_DAILY_LIMIT } from '../src/logic/parDisplayDecision.js';

// residuals are {date, time, par, bombHits}; only time/par matter to the math.
function residualsOf(n, time = 100, par = 100) {
  return Array.from({ length: n }, (_, i) => ({ date: 'd' + i, time, par, bombHits: 0 }));
}

test('newcomer gate: at or below the limit, the handicap is ignored and only plain par shows', () => {
  const d = resolveParDisplay({ precise: 50, dailyPar: 60, refitHandicap: -5, residuals: residualsOf(NEWCOMER_DAILY_LIMIT) });
  assert.equal(d.isNewcomerDaily, true);
  assert.equal(d.useHandicap, false, 'a known handicap is still suppressed for a newcomer');
  assert.equal(d.referencePar, 60, 'reference is Greg par, not personal');
  assert.equal(d.parClass, 'par-under');
  assert.equal(d.deltaText, '10.0s under par', 'wording is plain "par", not "your par"');
});

test('refit handicap past the newcomer gate: delta is vs personal par', () => {
  const d = resolveParDisplay({ precise: 50, dailyPar: 60, refitHandicap: -5, residuals: residualsOf(5) });
  assert.equal(d.isNewcomerDaily, false);
  assert.equal(d.useHandicap, true);
  assert.equal(d.personalPar, 55);
  assert.equal(d.referencePar, 55);
  assert.equal(d.parClass, 'par-under');
  assert.equal(d.deltaText, '5.0s under your par');
  assert.equal(d.provisional, null);
  assert.equal(d.yourParLabel, 'Your par: ');
});

test('provisional handicap: refit 0 falls back to the mean residual, labeled with the play count', () => {
  // 4 plays, each 8s over par → provisional handicap +8, non-newcomer (>3).
  const d = resolveParDisplay({ precise: 100, dailyPar: 100, refitHandicap: 0, residuals: residualsOf(4, 108, 100) });
  assert.equal(d.useHandicap, true);
  assert.equal(d.handicap, 8);
  assert.ok(d.provisional && d.provisional.n === 4);
  assert.equal(d.personalPar, 108);
  assert.equal(d.deltaText, '8.0s under your par', '100 vs personal par 108 is 8s under');
  assert.equal(d.yourParLabel, 'Your par (provisional, 4 plays): ');
});

test('delta thresholds: ±0.5s is the even band, otherwise under/over', () => {
  const base = { dailyPar: 60, refitHandicap: 0, residuals: residualsOf(5, 60, 60) }; // handicap resolves to 0
  assert.equal(resolveParDisplay({ ...base, precise: 60.4 }).parClass, 'par-even');
  assert.equal(resolveParDisplay({ ...base, precise: 59.6 }).parClass, 'par-even');
  assert.equal(resolveParDisplay({ ...base, precise: 60.4 }).deltaText, 'Even par!');
  assert.equal(resolveParDisplay({ ...base, precise: 60.6 }).parClass, 'par-over');
  assert.equal(resolveParDisplay({ ...base, precise: 60.6 }).deltaText, '0.6s over par');
  assert.equal(resolveParDisplay({ ...base, precise: 59.4 }).parClass, 'par-under');
});

test('even wording switches to "your par" when a handicap is in play', () => {
  const d = resolveParDisplay({ precise: 57.2, dailyPar: 60, refitHandicap: -3, residuals: residualsOf(5) });
  assert.equal(d.useHandicap, true);
  assert.equal(d.personalPar, 57);
  assert.equal(d.parClass, 'par-even');
  assert.equal(d.deltaText, 'Even with your par!');
});

test('handicap of 0 past the gate uses Greg par directly', () => {
  // 5 plays exactly on par → provisional handicap 0 → useHandicap false.
  const d = resolveParDisplay({ precise: 70, dailyPar: 60, refitHandicap: 0, residuals: residualsOf(5, 60, 60) });
  assert.equal(d.handicap, 0);
  assert.equal(d.useHandicap, false);
  assert.equal(d.referencePar, 60);
  assert.equal(d.deltaText, '10.0s over par');
});

test('the "one more daily" hint shows at exactly one residual', () => {
  assert.equal(resolveParDisplay({ precise: 70, dailyPar: 60, refitHandicap: 0, residuals: residualsOf(1) }).showOneMoreHint, true);
  assert.equal(resolveParDisplay({ precise: 70, dailyPar: 60, refitHandicap: 0, residuals: residualsOf(2) }).showOneMoreHint, false);
  assert.equal(resolveParDisplay({ precise: 70, dailyPar: 60, refitHandicap: 0, residuals: residualsOf(0) }).showOneMoreHint, false);
});

test('missing residuals are treated as an empty list (newcomer, no crash)', () => {
  const d = resolveParDisplay({ precise: 70, dailyPar: 60, refitHandicap: 0, residuals: null });
  assert.equal(d.isNewcomerDaily, true);
  assert.equal(d.useHandicap, false);
  assert.equal(d.referencePar, 60);
});
