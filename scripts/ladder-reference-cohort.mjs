// THE LADDER'S YARDSTICK — the consistent players the difficulty scale is
// anchored to, and how a par-second is converted into one of their seconds.
//
// WHY THIS EXISTS. Par is fit so that the play-weighted geometric mean of the
// player handicaps is 1, which makes it the time of the average player IN THE
// FIT. That is the right definition for par itself — Christopher's ruling is
// that Greg stays the median of the complete population, and nothing here
// changes the model or the handicaps. But it makes the absolute level of par a
// property of WHO IS PLAYING, and the challenge ladder is sorted and filtered
// by absolute numbers of par-seconds: the tier anchors (T1 0.55 through T12
// 3.60), the 8-minute par ceiling, and the endless zone's 3.5 s/cell
// admission floor. If the second stretches, all three move without a single
// board having changed.
//
// MEASURED, before building this (scripts/intercept-sensitivity.qmd, on the
// live data: 399 rows, four players at 164/159/70/6 plays). Three newcomers at
// 1.6x the current pace, playing 60 boards each, move par by x1.15. Five at
// 2.0x move it x1.46. The consequences all point the same way — the ladder
// gets EASIER, quietly:
//   - a "3.5 s/cell" endless floor really admits boards worth 3.06 today, and
//     2.40 in the worst scenario tried;
//   - 9% of the ladder pool crosses the 480s par ceiling, rising to 20%, so
//     the large boards silently drop out of the material.
// Pricing in cohort seconds instead held the scale between 0.93 and 1.08
// across all eighteen scenarios, mostly inside two percent.
//
// Those figures are an UPPER BOUND: the measurement used `lmer`, and the
// nightly pipeline's brms fit partial-pools newcomers harder than ML does, so
// the real drift should be smaller. The direction is not in doubt.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HANDICAPS = path.join(__dirname, '..', 'src', 'logic', 'handicaps.json');

/**
 * The reference cohort, by uid — Christopher's call, 2026-08-08: Kate, Sebas
 * and the-anemone-guy (his own account).
 *
 * WRITTEN OUT RATHER THAN DERIVED, deliberately. A rule like "everyone with 50
 * or more plays" keeps itself current, which sounds like a feature and is not:
 * a fourth regular crossing the threshold would re-scale the whole ladder with
 * nobody having decided anything. Changing this list IS a decision to re-scale,
 * and should be made as one.
 *
 * Names are here for readability only; the uid is what matters.
 */
export const REFERENCE_COHORT = Object.freeze({
  V07QPXYaICOOcP5ev6DXa2yG9y92: 'the-anemone-guy',
  F8UjG44sGhXWFmqtKbd3h4Vpvcx1: 'Kate',
  l0szSlaOvVb67aYrDzNU7j687BC3: 'Sebas',
});

/**
 * The cohort's geometric-mean handicap at the moment the anchor was adopted
 * (2026-08-08), FROZEN.
 *
 * Dividing by it is what makes the switch a no-op on the day: without it,
 * moving to cohort seconds would multiply every stored price by 1.0668 in one
 * step, and since the tier anchors and the endless floor are fixed numbers,
 * that would silently make the whole ladder about 7% easier. The anchor is
 * meant to stop the scale drifting, not to give it one free shove.
 */
export const LADDER_SCALE_BASE = 1.0668;

/**
 * The factor converting a par-second into a ladder-second.
 *
 * It is recomputed from the CURRENT handicaps each time the pool is priced,
 * which is Christopher's call (2026-08-08: "it can get harder... there's still
 * a lot of ambiguity in the different tiles right now"). Two things follow,
 * and they are different in kind:
 *
 *   - ROSTER CHANGES ARE ABSORBED. Slower players joining inflates par and
 *     deflates the cohort's handicaps by about the same factor, so the product
 *     holds still. This is the whole point.
 *   - THE COHORT'S OWN IMPROVEMENT IS NOT, and should not be. As the three get
 *     faster their handicaps fall, ladder-seconds shrink, and reaching 3.60
 *     s/cell takes a structurally harder board. The ladder stiffens as they
 *     learn the lattices. That is intended.
 *
 * A cohort member missing from handicaps.json is SKIPPED rather than treated
 * as neutral: a player below the fit's inclusion threshold has no handicap,
 * and folding in a 1.0 for them would drag the anchor toward the population
 * mean, which is exactly what this exists to avoid. All three missing falls
 * back to 1 with a warning, so a broken handicaps file cannot silently
 * re-price the pool.
 *
 * @returns {number} multiply a par value by this to get ladder-seconds
 */
export function referenceScale() {
  let handicaps;
  try {
    handicaps = JSON.parse(fs.readFileSync(HANDICAPS, 'utf8')).handicaps || {};
  } catch {
    console.warn('reference cohort: handicaps.json unreadable — pricing at the frozen base');
    return 1;
  }
  const ks = Object.keys(REFERENCE_COHORT)
    .map((uid) => handicaps[uid])
    .filter((k) => typeof k === 'number' && k > 0);

  if (!ks.length) {
    console.warn('reference cohort: no member has a handicap — pricing at the frozen base');
    return 1;
  }
  if (ks.length < Object.keys(REFERENCE_COHORT).length) {
    console.warn(`reference cohort: only ${ks.length} of ${Object.keys(REFERENCE_COHORT).length} members have handicaps`);
  }
  const kRef = Math.exp(ks.reduce((a, k) => a + Math.log(k), 0) / ks.length);
  return kRef / LADDER_SCALE_BASE;
}
