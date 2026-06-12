// modeTimed: the quick-play mode offset in the par model. Two-stage
// estimator in the R refit (personal-par residual mean, shrunken,
// activation-gated at 20 usable rows); the client term is exact:
// predictPar adds secModeTimed x features.modeTimed, nothing else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { predictPar } from '../src/logic/dailyFeatures.js';
import { PAR_MODEL } from '../src/logic/difficulty.js';

const base = {
  cellCount: 100, totalMines: 20,
  canonicalSubsetMoves: 2, genericSubsetMoves: 1, advancedLogicMoves: 1,
  wallEdgeCount: 0, zeroClusterCount: 3,
  mysteryCellCount: 0, liarCellCount: 0, lockedCellCount: 0,
  wormholePairCount: 0, mirrorPairCount: 0, sonarCellCount: 0, compassCellCount: 0,
  patternMoves: 3, searchMoves: 1,
};

test('modeTimed shifts par by exactly secModeTimed; daily untouched', () => {
  const daily = predictPar(base);
  const timed = predictPar({ ...base, modeTimed: 1 });
  assert.equal(Math.round((timed - daily) * 10) / 10,
    Math.round((PAR_MODEL.secModeTimed || 0) * 10) / 10);
  assert.equal(predictPar({ ...base, modeTimed: 0 }), daily);
});

test('shipped coefficient exists, finite, sign-free legal', () => {
  assert.equal(typeof PAR_MODEL.secModeTimed, 'number');
  assert.ok(Number.isFinite(PAR_MODEL.secModeTimed));
});

test('refit contract: the R script owns secModeTimed inside the markers', () => {
  // The PAR_MODEL block between the markers is overwritten by every
  // refit; if the R emit template ever drops secModeTimed, the client
  // term silently reads undefined -> 0 forever. Pin both sides.
  const r = readFileSync(new URL('../scripts/refit-par-model.R', import.meta.url), 'utf8');
  assert.ok(r.includes('secModeTimed:        %.3f'), 'R emit template must include secModeTimed');
  assert.ok(r.includes('new_coefs$secModeTimed'), 'R must compute/pass secModeTimed');
  const js = readFileSync(new URL('../src/logic/difficulty.js', import.meta.url), 'utf8');
  // lastIndexOf: the doc comment above the block MENTIONS both marker
  // names in prose; the real markers are the last occurrences.
  const block = js.slice(js.lastIndexOf('PAR_MODEL:START'), js.lastIndexOf('PAR_MODEL:END'));
  assert.ok(block.includes('secModeTimed'), 'secModeTimed must live INSIDE the refit-owned markers');
});
