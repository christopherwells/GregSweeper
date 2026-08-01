// Quick play has its OWN par equation (win-censored sample: only wins
// report, so timed cannot pool with the uncensored daily completions).
// PAR_MODEL_TIMED ships as a copy of the daily model until the refit
// activates it at TIMED_FIT_THRESHOLD usable rows; predictPar selects
// the model on features.modeTimed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { predictPar } from '../src/logic/dailyFeatures.js';
import { PAR_MODEL, PAR_MODEL_TIMED } from '../src/logic/difficulty.js';

const base = {
  cellCount: 100, totalMines: 20,
  canonicalSubsetMoves: 2, genericSubsetMoves: 1, advancedLogicMoves: 1,
  wallEdgeCount: 0, zeroClusterCount: 3,
  mysteryCellCount: 0, liarCellCount: 0, lockedCellCount: 0,
  wormholePairCount: 0, mirrorPairCount: 0, sonarCellCount: 0, compassCellCount: 0,
  patternMoves: 3, searchMoves: 1,
};

test('predictPar selects the timed model on modeTimed boards', () => {
  const daily = predictPar(base);
  const timed = predictPar({ ...base, modeTimed: 1 });
  // Hand-compute the timed linear predictor, then back-transform per scale.
  const lp = PAR_MODEL_TIMED.intercept
    + PAR_MODEL_TIMED.secPerCell * 100 + PAR_MODEL_TIMED.secPerMineFlag * 20
    + PAR_MODEL_TIMED.secPerPatternMove * 3 + PAR_MODEL_TIMED.secPerSearchMove * 1
    + PAR_MODEL_TIMED.secPerZeroCluster * 3;
  const expect = PAR_MODEL_TIMED.scale === 'log' ? Math.exp(lp) : lp;
  assert.equal(timed, Math.round(expect * 10) / 10);
  // Daily stays on the main model regardless of the timed block.
  assert.equal(predictPar({ ...base, modeTimed: 0 }), daily);
});

test('every daily coefficient has a timed counterpart (copy-of-daily shape)', () => {
  for (const k of Object.keys(PAR_MODEL)) {
    if (k === 'secModeTimed') continue; // retired field, must not return
    if (k === 'scale') {
      // The scale marker is a string, not a coefficient; both models must agree.
      assert.equal(PAR_MODEL_TIMED.scale, PAR_MODEL.scale, 'timed scale must match daily');
      continue;
    }
    assert.equal(typeof PAR_MODEL_TIMED[k], 'number', `PAR_MODEL_TIMED.${k} missing`);
  }
  assert.equal(PAR_MODEL.secModeTimed, undefined, 'the offset coefficient is retired');
});

test('refit contract: R owns the TIMED block inside its own markers', () => {
  const r = readFileSync(new URL('../scripts/refit-par-model.R', import.meta.url), 'utf8');
  assert.ok(r.includes('TIMED_PAR_MODEL:START'), 'R must patch the timed markers');
  // 2026-08-01: the hand sprintf template (whose fingerprint was
  // `timed_coefs$secPerCompassCell` in an argument list) is gone; the block
  // is emitted per key by the shared generator, so the thing to pin is that
  // timed_coefs feeds it.
  assert.ok(r.includes('ordered_model_fields(timed_coefs)'),
    'R must emit the timed coefficients through the shared block generator');
  assert.ok(r.includes('time <= 3 * predicted'), 'the slow-tail (AFK) outlier screen must exist');
  const js = readFileSync(new URL('../src/logic/difficulty.js', import.meta.url), 'utf8');
  const block = js.slice(js.lastIndexOf('TIMED_PAR_MODEL:START'), js.lastIndexOf('TIMED_PAR_MODEL:END'));
  assert.ok(block.includes('PAR_MODEL_TIMED'), 'timed model must live inside its refit-owned markers');
});
