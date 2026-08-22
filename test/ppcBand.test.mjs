// The validator's ppc acceptance band, which is PER FACE.
//
// HIS RULING (2026-08-20): Option 1, max(flat, k x (spread - 1)) at k = 0.20.
// The flat 12% is sized on the MEASUREMENT's precision, and that premise holds
// only while every face is about equally precise. It is not: `spread`
// (maxPar/minPar over a face's own draws) runs from 1.0 to past 7 on the
// shipped pool, so for a wide-spread face the flat band tested where the seed
// sample happened to land rather than whether the stored price still describes
// the spec.
//
// K WAS RE-DERIVED BEFORE BUILDING (2026-08-22), because the ruling's
// measurement predates the rate form, which re-scales par per cell entirely.
// Re-measured over the validator's own 290 priced faces at 16-seed stores
// against 10-seed fresh passes, which is production's own comparison:
// k = 0.20 covers 92.4%, against the 93% it was chosen for under M1.
//
// Run: node --test test/ppcBand.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ppcBandFor, ppcBandWidth, PPC_BAND, PPC_BAND_K, PPC_BAND_MAX,
  challengeSpecForLevel, CHALLENGE_MAX_LEVEL,
} from '../src/logic/challenge250.js';
import { LADDER_POOL, ENDLESS_POOL, CHALLENGE_POOL } from '../src/logic/challengePool.js';

test('a face with no measured spread keeps exactly the band it always had', () => {
  // An unmeasured face is not a licence. Absence must read as the flat band,
  // never as a wide one, or adding the field would have quietly loosened
  // every entry that predates the capture.
  for (const missing of [undefined, null, NaN, 0, -1, 'x']) {
    assert.equal(ppcBandWidth(/** @type {any} */ (missing)), PPC_BAND,
      `${String(missing)} must read as the flat band`);
  }
  // spread 1.0 means every draw priced identically: nothing to widen for.
  assert.equal(ppcBandWidth(1), PPC_BAND);
  assert.deepEqual(ppcBandFor({ ppc: 1 }), [1 - PPC_BAND, 1 + PPC_BAND]);
});

test('the band widens with the face\'s own disagreement, and only past the flat width', () => {
  // Below the crossover the flat band is already wider than k x (spread - 1),
  // so a tightly measured face is judged exactly as before.
  const crossover = 1 + PPC_BAND / PPC_BAND_K;   // 1.6 at the shipped constants
  assert.equal(ppcBandWidth(crossover - 0.01), PPC_BAND, 'just inside: unchanged');
  assert.ok(ppcBandWidth(crossover + 0.5) > PPC_BAND, 'past it: widened');
  // And it is the ruled formula, not an approximation of one.
  const s = 2.4;
  assert.equal(ppcBandWidth(s), PPC_BAND_K * (s - 1));
  // Monotone: a noisier face never gets a tighter band than a quieter one.
  let prev = 0;
  for (let x = 1; x <= 8; x += 0.25) {
    const w = ppcBandWidth(x);
    assert.ok(w >= prev, `width fell from ${prev} to ${w} at spread ${x}`);
    prev = w;
  }
});

test('the band is CAPPED, so it can never stop being a test', () => {
  // Uncapped, the widest face on the shipped pool (spread 7.18) earned a
  // +-124% band, which accepts almost any price and reports it as a pass.
  for (const wild of [5, 7.18, 16.08, 1000]) {
    assert.equal(ppcBandWidth(wild), PPC_BAND_MAX,
      `spread ${wild} must clamp to the cap`);
  }
  // The cap has to sit ABOVE the flat band or it would tighten faces instead
  // of loosening them, and above the acceptance's own implication (spread 2)
  // or every compliant face would clamp.
  assert.ok(PPC_BAND_MAX > PPC_BAND);
  assert.ok(PPC_BAND_MAX > PPC_BAND_K * (2 - 1));
});

test('the band is symmetric around the stored price', () => {
  const [lo, hi] = ppcBandFor({ ppc: 2, spread: 2.5 });
  assert.ok(Math.abs((2 - lo) - (hi - 2)) < 1e-12, 'lean in either direction is a bias in when it fires');
  assert.equal(ppcBandFor({ ppc: null }), null, 'an opener validates on deductions, not price');
});

test('every priced pool entry carries a spread, and every dealt spec keeps it', () => {
  // THE WIRING IS THE WHOLE FEATURE. It shipped once doing nothing: the pool
  // carried every spread and challengeSpecForLevel composed its spec from an
  // explicit field list that did not include it, so the check read the flat
  // width for all 250 levels and the validator's failure count did not move.
  for (const [name, pool] of [['LADDER_POOL', LADDER_POOL], ['ENDLESS_POOL', ENDLESS_POOL],
                              ['CHALLENGE_POOL', CHALLENGE_POOL]]) {
    const priced = pool.filter((s) => s.ppc != null);
    const missing = priced.filter((s) => !(Number(s.spread) > 0));
    assert.equal(missing.length, 0,
      `${name}: ${missing.length} of ${priced.length} priced entries carry no spread`
      + ' — re-run scripts/capture-pool-spreads.mjs');
    // NON-VACUITY: the table must actually hold priced entries.
    assert.ok(priced.length > 0, `${name} holds no priced entries`);
  }

  let priced = 0, carried = 0;
  for (let lv = 1; lv <= CHALLENGE_MAX_LEVEL; lv++) {
    const spec = challengeSpecForLevel(lv);
    if (!spec || spec.ppc == null) continue;
    priced++;
    if (Number(spec.spread) > 0) carried++;
  }
  assert.ok(priced > 100, `only ${priced} priced levels found; the scan is measuring nothing`);
  assert.equal(carried, priced,
    `${priced - carried} of ${priced} priced levels lose their spread on the way to the band`);
});

test('the widened band actually reaches real faces, and not all of them', () => {
  // Both halves matter. If nothing widened, the feature is inert; if
  // everything widened, the flat band has been abandoned rather than kept for
  // the faces it still fits. Measured at the capture: 369 of 694 keep 12%.
  const all = [...LADDER_POOL, ...ENDLESS_POOL, ...CHALLENGE_POOL].filter((s) => s.ppc != null);
  const widths = all.map((s) => ppcBandWidth(s.spread));
  const flat = widths.filter((w) => w === PPC_BAND).length;
  assert.ok(flat > 0, 'no face keeps the flat band; the widening is indiscriminate');
  assert.ok(flat < widths.length, 'no face is widened; the per-face band is inert');
  assert.ok(Math.max(...widths) <= PPC_BAND_MAX, 'a face escaped the cap');
});
