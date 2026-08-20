// Log-scale (multiplicative) par model — the 2026-07 migration from an
// additive seconds model to `par = exp(Xβ)`. Selected by `model.scale`.
// The additive path stays byte-identical (pinned in par-and-serialize);
// this file pins the log path via the injectable applyParModel /
// breakdownPar(features, model) seams so the shipped globals aren't mutated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyParModel, breakdownPar } from '../src/logic/dailyFeatures.js';

// A small log model: intercept and coefficients are LOG-multipliers.
const LOG_MODEL = {
  scale: 'log',
  intercept: 2.0, // exp(2) = 7.389s baseline for an empty board
  // The RATE form (2026-08-20): size is carried by log(cells) alone and the
  // board-scaling counts enter divided by the board.
  secPerLogCell: 1.0,
  secPerMineRate: 0.05,
  secPerPatternRate: 0.03,
  secPerSearchRate: 0.04,
  secPerWallEdge: 0.005,
  secPerZeroCluster: 0.01,
  secPerMysteryCell: 0.02,
  secPerLiarCell: 0.03,
  secPerLockedCell: 0.02,
  secPerWormholePair: 0.02,
  secPerMirrorPair: 0.04,
  secPerSonarCell: 0.02,
  secPerCompassCell: 0.03,
};

const round1 = (x) => Math.round(x * 10) / 10;

test('applyParModel exponentiates on a log-scale model', () => {
  // Only cellCount set: acc = intercept + secPerLogCell·log(100)
  //                          = 2.0 + 1.0 × 4.60517 = 6.60517.
  const par = applyParModel({ cellCount: 100 }, LOG_MODEL);
  assert.equal(par, round1(Math.exp(2.0 + Math.log(100))));
  // exp(2)·100, the elasticity-1 reading: a hundred cells at exp(2) each.
  assert.equal(par, round1(Math.exp(2.0) * 100));
});

test('REGRESSION: log par is never negative on a tiny board (the pathology the migration fixes)', () => {
  // An all-zero feature vector — the smallest board — was negative under the
  // additive intercept (-16.92). Under exp() it is exp(intercept) > 0.
  const par = applyParModel({}, LOG_MODEL);
  assert.ok(par > 0, `tiny-board par must be positive, got ${par}`);
  assert.equal(par, round1(Math.exp(2.0)));
});

test('log par is monotonic in a positive coefficient', () => {
  const lo = applyParModel({ advancedLogicMoves: 1 }, LOG_MODEL);
  const hi = applyParModel({ advancedLogicMoves: 5 }, LOG_MODEL);
  assert.ok(hi > lo, `par should rise with search moves: ${lo} -> ${hi}`);
});

test('log breakdownPar: seconds chips sum to par and reflect the log-share allocation', () => {
  const features = {
    cellCount: 120,
    totalMines: 20,
    canonicalSubsetMoves: 4,
    genericSubsetMoves: 2,
    advancedLogicMoves: 3,
    liarCellCount: 5,
  };
  const par = applyParModel(features, LOG_MODEL);
  const chips = breakdownPar(features, LOG_MODEL);
  // Every chip reads in seconds and is positive.
  for (const c of chips) assert.ok(c.seconds > 0, `chip ${c.label} not positive`);
  // A baseline chip and the two reasoning/modifier groups are present.
  const labels = chips.map(c => c.label);
  assert.ok(labels.includes('baseline'), 'baseline chip present');
  assert.ok(labels.includes('search moves'), 'search-moves chip present');
  assert.ok(labels.includes('liar'), 'liar chip present');
  // Chips sum to par (within rounding of each 0.1s chip).
  const total = chips.reduce((s, c) => s + c.seconds, 0);
  assert.ok(Math.abs(total - par) <= 0.3, `chips ${total} should sum to par ${par}`);
  // Sorted descending, baseline last.
  assert.equal(chips[chips.length - 1].label, 'baseline');
});

test('log breakdownPar: a bare board yields only the baseline chip', () => {
  const chips = breakdownPar({ cellCount: 60, totalMines: 10 }, LOG_MODEL);
  assert.equal(chips.length, 1);
  assert.equal(chips[0].label, 'baseline');
});
