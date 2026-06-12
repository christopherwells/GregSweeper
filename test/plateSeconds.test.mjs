// Pressure-plate timer pricing (no-guess contract, temporal gap —
// 2026-06-12). The old sizing (Pass-A steps x 10s, stuck targets ~free)
// systematically under-timed exactly the plates needing the hardest
// reasoning. plateSeconds keeps the classic rate for Pass-A work and
// bills each STUCK target at the par model's fitted tier price, with
// floor, cap, and a never-below-classic guarantee per hard target.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  plateSeconds, PLATE_MIN_SECONDS, PLATE_SECONDS_PER_STEP,
  PLATE_TIER_WEIGHT, PLATE_MAX_SECONDS, PAR_MODEL,
} from '../src/logic/difficulty.js';

test('easy plates keep the classic sizing exactly', () => {
  assert.equal(plateSeconds({ steps: 3, unsolved: 0 }), 30);
  assert.equal(plateSeconds({ steps: 1, unsolved: 0 }), 10);
});

test('floor and cap', () => {
  assert.equal(plateSeconds({ steps: 0, unsolved: 0 }), PLATE_MIN_SECONDS);
  assert.equal(plateSeconds({ steps: 9, unsolved: 50 }), PLATE_MAX_SECONDS);
});

test('stuck targets are billed at the tier price (injected model)', () => {
  const model = { secPerPatternMove: 2.0, secPerSearchMove: 1.0 };
  // 2 steps x 10 + 2 hard x ceil(8 x 2.0)=16 -> 20 + 32 = 52
  assert.equal(plateSeconds({ steps: 2, unsolved: 2 }, model), 52);
});

test('uses the DEARER of pattern/search (fit-day noise can invert them)', () => {
  const model = { secPerPatternMove: 1.0, secPerSearchMove: 2.5 };
  // hard target: ceil(8 x 2.5) = 20
  assert.equal(plateSeconds({ steps: 0, unsolved: 1 }, model), 20);
});

test('a stuck target never prices below the classic per-step rate', () => {
  // Degenerate refit: tiny tier coefficients must not make hard
  // targets cheaper than the old fudge ever did.
  const model = { secPerPatternMove: 0.1, secPerSearchMove: 0.05 };
  assert.equal(plateSeconds({ steps: 0, unsolved: 2 }, model),
    Math.max(PLATE_MIN_SECONDS, 2 * PLATE_SECONDS_PER_STEP));
});

test('live PAR_MODEL: sane, bounded, and harder-than-easy for stuck work', () => {
  const easy = plateSeconds({ steps: 2, unsolved: 0 });
  const hard = plateSeconds({ steps: 2, unsolved: 2 });
  assert.ok(Number.isFinite(hard));
  assert.ok(hard > easy, 'stuck targets must add time');
  assert.ok(hard <= PLATE_MAX_SECONDS && easy >= PLATE_MIN_SECONDS);
  assert.ok(PLATE_TIER_WEIGHT > 0 && PAR_MODEL.secPerPatternMove > 0);
});
