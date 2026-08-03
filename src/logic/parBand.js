// Par bands (Christopher's ruling, 2026-08-02): every daily should land at
// par between 20s and 240s, every weekly between 60s and 360s, each
// distribution skewed lightly toward the easy end with occasional hard
// boards. This module is the ONE source of the band constants, the
// date-seeded target-par draw, and the closeness weighting that steers the
// existing candidate selection toward the day's target. It is consumed by
// BOTH sides of each determinism-critical mirror pair — selectDailyRngSeed.js
// / daily-board-pipeline.mjs and selectWeeklyRngSeed.js (which the weekly
// precompute now calls directly) — so the banding rule can never drift
// between client and precompute the way the slot arithmetic once did.
//
// The distribution is the "hard-day coin" he picked from a rendered
// comparison (2026-08-02, against a single scaled Beta and a log-uniform),
// with the easy hill ANCHORED where he approved it and only the hard reach
// extended when the ceilings rose to 240s/360s in the same conversation:
//   85% of days: easy draw — Beta(2, 5) scaled onto [lo, easyHi]
//   15% of days: hard draw — Beta(2, 2) scaled onto [hardLo, hi]
// easyHi/hardLo keep the original 180s/300s bands' geometry (hardLo is the
// old top-45% cut), so the median day is unchanged from what he signed off
// on and only the hard tail reaches further.
//
// Determinism notes, because every client and the precompute must draw the
// SAME target from the date string alone:
// - The regime coin and the position draw always consume exactly two rng()
//   calls, in that order, from a namespaced stream (`:parTarget` daily,
//   `:weeklyParTarget` weekly — distinct because a weekStart IS a Monday
//   date string, and sharing the namespace would correlate every Monday
//   daily with its week's weekly).
// - Both Beta inverses go through closed-form polynomial CDFs bisected with
//   +,-,× only — bit-identical on every JS engine. Math.exp/Math.log appear
//   only in the closeness kernel, the same functions predictPar itself
//   already uses upstream of every comparison, so the kernel adds no new
//   cross-engine divergence class.

import { createDailyRNG } from './seededRandom.js';

/**
 * @typedef {Object} ParBand
 * @property {number} lo     floor of the band (seconds of par)
 * @property {number} hi     ceiling of the band
 * @property {number} easyHi ceiling of the 85% easy draw
 * @property {number} hardLo floor of the 15% hard draw
 */

/** @type {ParBand} */
export const DAILY_PAR_BAND = Object.freeze({ lo: 20, hi: 240, easyHi: 180, hardLo: 108 });
/** @type {ParBand} */
export const WEEKLY_PAR_BAND = Object.freeze({ lo: 60, hi: 360, easyHi: 300, hardLo: 192 });

// P(a day draws from the hard span). The legible knob behind "occasional
// hard boards" — at 0.15, about one day a week runs hard.
export const HARD_DAY_PROB = 0.15;

// Width of the log-scale closeness kernel. A candidate 1.42× off the target
// keeps ~61% of its mission score, 2× off ~14%, 3× off under 1% — decisive
// banding while mission weights still settle contests among near-target
// candidates (measured shift in mission-win shares ≤ ~4 points).
export const PAR_KERNEL_SIGMA = 0.35;

// Closed-form regularized incomplete Beta CDFs (integer parameters give
// pure polynomials): Beta(2,5) — the easy hill; Beta(2,2) — the hard bump.
const betaCdf25 = x => ((((5 * x - 24) * x + 45) * x - 40) * x + 15) * x * x;
const betaCdf22 = x => (3 - 2 * x) * x * x;

/**
 * Invert a monotone CDF on [0,1] by fixed-depth bisection. 48 halvings pin
 * the answer to ~4e-15 with nothing but +,-,× — no engine-variant math.
 * @param {(x: number) => number} cdf
 * @param {number} u
 * @returns {number}
 */
function invertCdf(cdf, u) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) < u) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Draw the target par for one date from a band, consuming exactly two rng()
 * calls (regime coin, then position). Exposed for tests; production callers
 * use the two named draws below so the namespace can never be mistyped.
 * @param {() => number} rng
 * @param {ParBand} band
 * @returns {number} target par in seconds, inside [band.lo, band.hi]
 */
export function drawTargetPar(rng, band) {
  const regime = rng();
  const u = rng();
  if (regime < 1 - HARD_DAY_PROB) {
    return band.lo + invertCdf(betaCdf25, u) * (band.easyHi - band.lo);
  }
  return band.hardLo + invertCdf(betaCdf22, u) * (band.hi - band.hardLo);
}

/**
 * The daily target par for a date. Deterministic from the date string alone
 * — no fetched file, so every client, the precompute, and parResolve agree
 * without coordination (the resolveDailyShape pattern).
 * @param {string} dateString YYYY-MM-DD
 * @returns {number}
 */
export function drawDailyTargetPar(dateString) {
  return drawTargetPar(createDailyRNG(`${dateString}:parTarget`), DAILY_PAR_BAND);
}

/**
 * The weekly target par for a week. Namespaced apart from the daily draw —
 * weekStart is itself a Monday date string.
 * @param {string} weekStart YYYY-MM-DD (a Monday)
 * @returns {number}
 */
export function drawWeeklyTargetPar(weekStart) {
  return drawTargetPar(createDailyRNG(`${weekStart}:weeklyParTarget`), WEEKLY_PAR_BAND);
}

/**
 * Closeness of a candidate's par to the target, in (0, 1] — a Gaussian in
 * log-par, so 2× over and 2× under the target weigh the same (the par model
 * is multiplicative; symmetric ratios are the honest symmetry).
 * @param {number} par
 * @param {number} targetPar
 * @returns {number}
 */
export function parKernel(par, targetPar) {
  const z = Math.log(par / targetPar) / PAR_KERNEL_SIGMA;
  return Math.exp(-0.5 * z * z);
}

/**
 * The band weight a candidate carries into selection: 0 outside the band
 * (the hard clamp that ends out-of-band boards), the closeness kernel
 * inside it.
 * @param {number} par
 * @param {number} targetPar
 * @param {ParBand} band
 * @returns {number}
 */
export function parBandWeight(par, targetPar, band) {
  if (!(par >= band.lo && par <= band.hi)) return 0;
  return parKernel(par, targetPar);
}

/**
 * Band weights for a slate of scored candidates, with the two fallbacks
 * every caller needs to agree on:
 * - a candidate without a finite par gets weight 0 (it cannot claim band
 *   fitness);
 * - if NO candidate lands inside the band, the clamp lifts and the raw
 *   kernel ranks by closeness alone, so the pick degrades to
 *   nearest-the-band rather than to undefined behavior.
 * Returns null when no candidate carries a finite par at all — the caller
 * falls back to its pre-band behavior verbatim (the legacy path a stale
 * entry shape would otherwise break).
 * @param {Array<{par?: number}>} entries
 * @param {number} targetPar
 * @param {ParBand} band
 * @returns {number[]|null}
 */
export function bandWeightsFor(entries, targetPar, band) {
  const pars = entries.map(e => (e && Number.isFinite(e.par) ? e.par : null));
  if (!pars.some(p => p !== null)) return null;
  const clamped = pars.map(p => (p === null ? 0 : parBandWeight(p, targetPar, band)));
  if (clamped.some(w => w > 0)) return clamped;
  return pars.map(p => (p === null ? 0 : parKernel(p, targetPar)));
}

/**
 * Banded argmax for the weekly contest: highest score × band weight wins,
 * earliest slot on ties (matching the strict `>` the un-banded argmax
 * used). If every weighted score is 0 — every in-band candidate scored 0 —
 * the band weight alone decides, so the pick is still the closest board
 * rather than slot order. Entries without finite pars fall back to the
 * plain score argmax (legacy behavior).
 * @param {Array<{score: number, par?: number}>} entries
 * @param {number} targetPar
 * @param {ParBand} band
 * @returns {number} index of the winning entry, or -1 for an empty slate
 */
export function bandedArgmax(entries, targetPar, band) {
  if (!Array.isArray(entries) || entries.length === 0) return -1;
  const weights = bandWeightsFor(entries, targetPar, band);
  let best = -1, bestVal = -Infinity;
  for (let i = 0; i < entries.length; i++) {
    const score = typeof entries[i]?.score === 'number' ? entries[i].score : 0;
    const val = weights === null ? score : score * weights[i];
    if (val > bestVal) { bestVal = val; best = i; }
  }
  if (weights !== null && bestVal <= 0) {
    for (let i = 0; i < entries.length; i++) {
      if (weights[i] > bestVal) { bestVal = weights[i]; best = i; }
    }
  }
  return best;
}
