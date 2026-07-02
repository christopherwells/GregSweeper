// Multiplicative-ratio handicap: the provisional estimator (geometric mean of
// time/par, shrunk toward k=1 and clamped) and the neutral defaults. The
// dual-reader format branch (logratio-v1 vs legacy additive) is exercised at
// the visual/e2e layer since it depends on a fetched file; the pure ratio math
// is pinned here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateHandicapDetails, estimateHandicapFromHistory,
  HANDICAP_K_MIN, HANDICAP_K_MAX,
} from '../src/logic/handicaps.js';

const pairs = (ratios, par = 100) => ratios.map((r, i) => ({ time: r * par, predictedPar: par, date: 'd' + i }));

test('provisional k is the GEOMETRIC mean of time/par (not the arithmetic mean)', () => {
  // Ratios 0.5 and 2.0: geometric mean = 1.0 (arithmetic would be 1.25).
  // n=2 shrink factor 2/5 applied in log space to meanLog=0 leaves k=1.
  const est = estimateHandicapDetails(pairs([0.5, 2.0]));
  assert.equal(est.k, 1);
  assert.equal(est.n, 2);
  assert.equal(est.provisional, true);
});

test('provisional k shrinks toward 1 for small samples and relaxes as n grows', () => {
  const few = estimateHandicapDetails(pairs(Array(2).fill(2.0)));
  const many = estimateHandicapDetails(pairs(Array(20).fill(2.0)));
  assert.ok(few.k > 1 && few.k < many.k, `few ${few.k} should shrink below many ${many.k}`);
  assert.ok(many.k < 2.0, 'even 20 plays stays under the raw ratio (some shrink remains)');
});

test('provisional k is bounded by the WIDE sanity clamp [HANDICAP_K_MIN, HANDICAP_K_MAX]', () => {
  // The bound only rejects garbage; a real player is never near it. Feed ratios
  // well past even the wide [0.1, 10] bound (after shrinkage) to trip it.
  const slow = estimateHandicapDetails(pairs(Array(30).fill(100)));   // absurdly slow
  const fast = estimateHandicapDetails(pairs(Array(30).fill(0.001))); // absurdly fast
  assert.equal(slow.k, HANDICAP_K_MAX);
  assert.equal(fast.k, HANDICAP_K_MIN);
});

test('below the minimum pair count returns null; the wrapper defaults to neutral k=1', () => {
  assert.equal(estimateHandicapDetails(pairs([1.5])), null);
  assert.equal(estimateHandicapDetails([]), null);
  assert.equal(estimateHandicapDetails(null), null);
  assert.equal(estimateHandicapFromHistory(pairs([1.5])), 1);
  assert.equal(estimateHandicapFromHistory(pairs([2.0, 2.0])), estimateHandicapDetails(pairs([2.0, 2.0])).k);
});

test('non-positive or malformed pairs are ignored, not counted', () => {
  const est = estimateHandicapDetails([
    { time: 100, predictedPar: 100 },
    { time: 0, predictedPar: 100 },      // zero time — skipped
    { time: 100, predictedPar: 0 },      // zero par — skipped
    { time: 'x', predictedPar: 100 },    // non-number — skipped
    { time: 120, predictedPar: 100 },
  ]);
  assert.equal(est.n, 2, 'only the two valid pairs count');
});
