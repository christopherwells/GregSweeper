// Pressure-plate timer pricing (no-guess contract, temporal gap —
// 2026-06-12). The old sizing (Pass-A steps x 10s, stuck targets ~free)
// systematically under-timed exactly the plates needing the hardest
// reasoning. plateSeconds keeps the classic rate for Pass-A work and
// bills each STUCK target at PLATE_TIER_SECONDS, with floor, cap, and a
// never-below-classic guarantee per hard target.
//
// DECOUPLED FROM PAR_MODEL (log-model migration): the old code borrowed
// `PLATE_TIER_WEIGHT × max(secPerPatternMove, secPerSearchMove)` from the
// par model to price a stuck target. Under the log-scale par model those
// coefficients are log-MULTIPLIERS, not seconds, so the read no longer
// yields a seconds price. plateSeconds now uses the fixed PLATE_TIER_SECONDS
// (calibrated to the ~16s/hard-target the additive model produced) and
// takes NO model argument.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  plateSeconds, PLATE_MIN_SECONDS, PLATE_SECONDS_PER_STEP,
  PLATE_TIER_SECONDS, PLATE_MAX_SECONDS,
} from '../src/logic/difficulty.js';

test('easy plates keep the classic sizing exactly', () => {
  assert.equal(plateSeconds({ steps: 3, unsolved: 0 }), 30);
  assert.equal(plateSeconds({ steps: 1, unsolved: 0 }), 10);
});

test('floor and cap', () => {
  assert.equal(plateSeconds({ steps: 0, unsolved: 0 }), PLATE_MIN_SECONDS);
  assert.equal(plateSeconds({ steps: 9, unsolved: 50 }), PLATE_MAX_SECONDS);
});

test('stuck targets are billed at the fixed tier price', () => {
  // 2 steps x 10 + 2 hard x PLATE_TIER_SECONDS(16) -> 20 + 32 = 52
  const perHard = Math.max(PLATE_SECONDS_PER_STEP, PLATE_TIER_SECONDS);
  assert.equal(plateSeconds({ steps: 2, unsolved: 2 }), 2 * PLATE_SECONDS_PER_STEP + 2 * perHard);
  assert.equal(plateSeconds({ steps: 2, unsolved: 2 }), 52);
});

test('REGRESSION: plateSeconds ignores any injected model (decoupled from PAR_MODEL)', () => {
  // The par model is now log-scale; its coefficients are not seconds. A
  // stray second argument must not change the price — the old code read it.
  const withoutModel = plateSeconds({ steps: 2, unsolved: 2 });
  const withGarbageModel = plateSeconds({ steps: 2, unsolved: 2 }, { secPerPatternMove: 999, secPerSearchMove: 999 });
  assert.equal(withGarbageModel, withoutModel);
});

test('a stuck target never prices below the classic per-step rate', () => {
  assert.ok(PLATE_TIER_SECONDS >= PLATE_SECONDS_PER_STEP,
    'the fixed tier price must not undercut the classic per-step rate');
  // 2 hard targets, no steps: 2 x max(10, 16) = 32.
  assert.equal(plateSeconds({ steps: 0, unsolved: 2 }), 2 * Math.max(PLATE_SECONDS_PER_STEP, PLATE_TIER_SECONDS));
});

test('live pricing: sane, bounded, and harder-than-easy for stuck work', () => {
  const easy = plateSeconds({ steps: 2, unsolved: 0 });
  const hard = plateSeconds({ steps: 2, unsolved: 2 });
  assert.ok(Number.isFinite(hard));
  assert.ok(hard > easy, 'stuck targets must add time');
  assert.ok(hard <= PLATE_MAX_SECONDS && easy >= PLATE_MIN_SECONDS);
});
