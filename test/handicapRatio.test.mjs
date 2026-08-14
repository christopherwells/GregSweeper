// Multiplicative-ratio handicap: the provisional estimator (geometric mean of
// time/par, shrunk toward k=1 and clamped) and the neutral defaults. The
// dual-reader format branch (logratio-v1 vs legacy additive) is exercised at
// the visual/e2e layer since it depends on a fetched file; the pure ratio math
// is pinned here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateHandicapDetails, estimateHandicapFromHistory,
  ratioDisplaySeconds, ratioDisplayPercent,
  HANDICAP_K_MIN, HANDICAP_K_MAX, RATING_REF_PAR,
  getRefPar, getHandicapSeconds,
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

test('REGRESSION: handicap rating sign — faster than Greg is POSITIVE, slower is NEGATIVE', () => {
  // A player FASTER than Greg (k < 1, Kate 0.876) reads positive; a SLOWER
  // player (k > 1, Sebastien 1.579) reads negative. The rating sign was inverted
  // on first ship (Christopher, 2026-07-02: "he should have a negative par").
  assert.ok(ratioDisplaySeconds(0.876, RATING_REF_PAR) > 0, 'faster player -> positive seconds');
  assert.ok(ratioDisplaySeconds(1.579, RATING_REF_PAR) < 0, 'slower player -> negative seconds');
  assert.ok(ratioDisplayPercent(0.876) > 0, 'faster player -> positive percent');
  assert.ok(ratioDisplayPercent(1.579) < 0, 'slower player -> negative percent');
  // Magnitudes at the one-minute unit: (1-0.876)*60 ≈ +7, (1-1.579)*60 ≈ -35.
  assert.equal(Math.round(ratioDisplaySeconds(0.876, RATING_REF_PAR)), 7);
  assert.equal(Math.round(ratioDisplaySeconds(1.579, RATING_REF_PAR)), -35);
  // Neutral k=1 is exactly zero on both.
  assert.equal(ratioDisplaySeconds(1, RATING_REF_PAR), 0);
  assert.equal(ratioDisplayPercent(1), 0);
});

// REGRESSION (2026-08-14): the seconds rating was quoted against the refit's
// median day-of par, shipped in handicaps.json and recomputed nightly, so the
// same player's chip could read a different number on a morning they had not
// played. displaySeconds is (1 - k) times a constant either way, so the fitted
// version carried no information the percent did not, only drift. His ruling:
// fix it at one minute, and read it as "per minute of Greg's pace".
test('the rating reference par is a FIXED one-minute unit, not a fitted number', () => {
  assert.equal(RATING_REF_PAR, 60, 'the unit is one minute');
  assert.equal(getRefPar(), RATING_REF_PAR,
    'and the accessor returns the constant, never a value read from the file');
  // The unrated default: k=1 reads as exactly zero, not as a made-up rating.
  assert.equal(getHandicapSeconds('nobody'), 0);
  // The parameter survives, because "how many seconds on THIS board" is a
  // different and still-useful question from the cross-board rating.
  assert.equal(getHandicapSeconds('nobody', 240), 0);
  assert.equal(Math.round(ratioDisplaySeconds(0.5, 240)), 120,
    'an explicit board par still scales the figure');
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
