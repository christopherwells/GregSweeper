// Banded per-date daily configs for tiling days (Par Bands, Phase 2 —
// Christopher's chipped follow-up to the 2026-08-02 band ruling and the
// 2026-08-03 Par Lab prior fit).
//
// Phase 1 banded the RECTANGULAR daily by weighting its existing 10-way
// candidate contest toward the day's target par. A tiling day has no contest
// to weight: it is single-candidate by design (the client fallback must
// replay selection deterministically, and ten rhombille generations is
// minutes of phone CPU), and its config was a FIXED per-shape entry in
// COASTLINE_BOARDS — which is how deltoidal's daily priced ~285 s against
// the 240 s band ceiling. This module is the inversion the fit was built
// for: each lattice's lab-seeded equation (PAR_MODEL_SHAPES), turned into a
// per-date DRAW over a table of proven configs, weighted by the same
// closeness kernel the rectangular lottery uses, against the same
// date-seeded target par.
//
// How a config is priced — the load-bearing design decision: each entry
// freezes the MEDIAN FEATURE VECTOR of its offline generation probes
// (scripts/calibrate-tiling-band-configs.mjs), not a par number. Pricing
// happens at draw time through the live predictPar, which dispatches to the
// shape's own PAR_MODEL_SHAPES block — so when the nightly refit updates a
// lattice's equation from live tiling scores (the seeded deviations take
// live data continuously), config selection re-prices itself the same
// night, with no re-calibration commit. A frozen par would go quietly stale
// against exactly the refits this architecture exists to absorb. The cost
// is the standard code-version-drift residual (a stale-bundle client can
// price a config differently), which the canonical-board architecture
// absorbs for everyone online, same as every selection-rule change before
// this one.
//
// Honesty asterisk, documented rather than hidden: the banding selects on
// the config's median PLAIN par. The day's realized par scatters around
// that median (layout luck) and rides above it by the mission modifier's
// term (most tiling days force-inject one gimmick). Both effects are small
// against the kernel's width (sigma 0.35 keeps ~61% weight at 1.42x off),
// and the rectangular path accepts the same class of slack — its pool
// usually tops out ~100-140 s against hard targets. Reach limits are real
// too: deltoidal's cheapest proven config prices ~70 s, so a 30 s easy-day
// target on a deltoidal day ships the closest board the lattice HAS, via
// the kernel fallback — the band is a constraint, not a coverage promise
// (the same reading as the rectangular pool's ~32 s floor).
//
// Every entry is generation-PROVEN offline before it ships (the
// validate-parlab-battery pattern): plain probes for the feature medians,
// plus every tiling-safe gimmick singly and one stacked pair, all required
// to certify. Entries below the constructive threshold on a Laves lattice
// carry `constructive: true` (rejection sampling is weak exactly there —
// floret 7/12 at 0.208, deltoidal 8/12 at 0.181 — while the constructive
// placer goes 30/30); generateTilingBoard's forceConstructive opt-in routes
// them. Rhombille needs no flag: its proven floor (0.23) is already above
// the threshold. One entry per shape is `fallback: true` — the
// generation-robust in-band retry if the drawn entry's generation exhausts
// on a live date seed (deterministic, so every client retries identically),
// before the existing rectangle fallback.
//
// LIVE with the rest of the rotation since v1.10. It shipped dark first
// (nothing reached this module while TILING_ROTATION_START was null), and the
// flip is what made these tables load-bearing for real boards.

import { createDailyRNG } from './seededRandom.js';
import {
  drawDailyTargetPar, drawWeeklyTargetPar, bandWeightsFor, DAILY_PAR_BAND, WEEKLY_PAR_BAND,
} from './parBand.js';
import { predictPar } from './dailyFeatures.js';

// One rng stream per decision (the shapeRotation convention): the config
// lottery draws from `${date}:shapeConfig`, disjoint from every existing
// consumer of the date seed (`:shape`, `:shapeMission`, `:parTarget`,
// `:missionDraw`, `:trialN`, `-gimmick`, `:worm:`, `:tiling:`). The target
// par itself comes from drawDailyTargetPar's own `:parTarget` stream — the
// SAME stream the rectangular path reads, deliberately: a date has ONE
// target par regardless of which shape its daily drew.
const CONFIG_NAMESPACE = ':shapeConfig';
// Distinct from the daily's: a weekStart IS a Monday date string, so sharing
// the stream would tie every Monday's weekly config to that day's daily draw.
const WEEKLY_CONFIG_NAMESPACE = ':weeklyShapeConfig';

/**
 * @typedef {Object} BandEntry
 * @property {string} id            stable name (used in tests and logs)
 * @property {number} M             lattice dimension (per-tiling meaning)
 * @property {number} N             lattice dimension
 * @property {number} mines
 * @property {boolean} [constructive] route generation to the constructive
 *   placer (sub-threshold Laves entries only)
 * @property {boolean} [fallback]   the shape's generation-failure retry entry
 * @property {Object} features      frozen probe-median feature vector: exact
 *   cellCount/totalMines plus median reasoning counts, priced through the
 *   live shape equation at draw time
 */

// The tables. Frozen by scripts/calibrate-tiling-band-configs.mjs (probe
// medians over 12 plain generations per entry at the 2026-08-03 lab-seeded
// equations); entries chosen to span each lattice's reachable slice of the
// daily band [20, 240] with interior margin (~30-215 s at freeze), log-spaced
// so the kernel always has a near neighbor. Re-run the calibrator after any
// refit that moves a shape equation materially — the pricing test going red
// is the designed alarm for an entry drifting out of the band.
/** @type {Record<string, BandEntry[]>} */
export const TILING_BAND_CONFIGS = {
  '4.8.8': [
    { id: '450d14', M: 5, N: 6, mines: 7, features: { cellCount: 50, totalMines: 7, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 2 } },       // ~29s
    { id: '472d14', M: 6, N: 7, mines: 10, features: { cellCount: 72, totalMines: 10, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 3 } },     // ~37s
    { id: '485d14', M: 7, N: 7, mines: 12, features: { cellCount: 85, totalMines: 12, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 4 } },     // ~44s
    { id: '472d22', M: 6, N: 7, mines: 16, fallback: true, features: { cellCount: 72, totalMines: 16, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 5 } }, // ~68s
    { id: '485d22', M: 7, N: 7, mines: 19, features: { cellCount: 85, totalMines: 19, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 5.5 } },   // ~90s
    { id: '498d22', M: 8, N: 7, mines: 22, features: { cellCount: 98, totalMines: 22, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 6 } },     // ~118s
    { id: '498d26', M: 8, N: 7, mines: 25, features: { cellCount: 98, totalMines: 25, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 1, zeroClusterCount: 5 } },     // ~163s
    // The table's dearest entry, and the ONE violation of the 2026-08-06 phone
    // cap that a transpose could not fix: the old 8x9 was 9 pitch units wide
    // against the 4.8.8's cap of 7.77, and its own transpose is square. So it
    // is re-picked rather than turned — taller and slightly larger at the same
    // par, which the cap allows because height is the looser budget. Density
    // falls to 0.187, still routed constructive: rejection sampling gets less
    // reliable as the patch grows, and this is the largest 4.8.8 the table
    // ships, so it is the last entry to gamble 600 attempts on.
    { id: '4150d19', M: 12, N: 7, mines: 28, constructive: true, features: { cellCount: 150, totalMines: 28, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 10 } }, // ~182s
  ],
  hex: [
    { id: 'h49d18', M: 7, N: 7, mines: 9, features: { cellCount: 49, totalMines: 9, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 2 } },       // ~27s
    { id: 'h110d14', M: 11, N: 10, mines: 15, features: { cellCount: 110, totalMines: 15, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 3.5 } }, // ~38s
    { id: 'h63d22', M: 9, N: 7, mines: 14, features: { cellCount: 63, totalMines: 14, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 4 } },     // ~43s
    { id: 'h63d25', M: 9, N: 7, mines: 16, fallback: true, features: { cellCount: 63, totalMines: 16, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 4 } }, // ~54s
    { id: 'h81d25', M: 9, N: 9, mines: 20, features: { cellCount: 81, totalMines: 20, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 4 } },     // ~76s
    { id: 'h81d28', M: 9, N: 9, mines: 23, features: { cellCount: 81, totalMines: 23, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 4 } },     // ~106s
    { id: 'h110d25', M: 11, N: 10, mines: 28, features: { cellCount: 110, totalMines: 28, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 4.5 } }, // ~158s
    { id: 'h110d28', M: 11, N: 10, mines: 31, features: { cellCount: 110, totalMines: 31, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 4.5 } }, // ~218s
  ],
  // Cairo prices by SIZE alone (its fitted per-mine deviation cancels the
  // base rate — the lab's "difficulty lives in the large corner" finding), so
  // the ladder is its four storable size rungs, with mine-count variants at
  // three of them: same par, different totalMines, which is exactly the
  // within-shape variation the live fit needs to keep the per-mine deviation
  // identified (pricing cannot distinguish them; the lottery splits between
  // them near-uniformly).
  cairo: [
    { id: 'c49d18', M: 5, N: 6, mines: 9, constructive: true, features: { cellCount: 49, totalMines: 9, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 1.5 } }, // ~49s
    { id: 'c49d29', M: 5, N: 6, mines: 14, features: { cellCount: 49, totalMines: 14, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 2 } },     // ~49s
    { id: 'c60d23', M: 6, N: 6, mines: 14, fallback: true, features: { cellCount: 60, totalMines: 14, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 2 } }, // ~65s
    { id: 'c66d18', M: 10, N: 4, mines: 12, constructive: true, features: { cellCount: 66, totalMines: 12, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 2.5 } }, // ~77s
    { id: 'c66d27', M: 10, N: 4, mines: 18, features: { cellCount: 66, totalMines: 18, canonicalSubsetMoves: 0.5, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 3 } },  // ~77s
    { id: 'c84d18', M: 7, N: 7, mines: 15, constructive: true, features: { cellCount: 84, totalMines: 15, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 2 } }, // ~123s
    { id: 'c84d29', M: 7, N: 7, mines: 24, features: { cellCount: 84, totalMines: 24, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 3 } },     // ~123s
  ],
  floret: [
    { id: 'f36d17', M: 2, N: 3, mines: 6, constructive: true, features: { cellCount: 36, totalMines: 6, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 2 } }, // ~41s
    { id: 'f48d21', M: 2, N: 4, mines: 10, constructive: true, fallback: true, features: { cellCount: 48, totalMines: 10, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 2 } }, // ~61s
    { id: 'f48d25', M: 2, N: 4, mines: 12, features: { cellCount: 48, totalMines: 12, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 2 } },     // ~76s
    { id: 'f72d21', M: 3, N: 4, mines: 15, constructive: true, features: { cellCount: 72, totalMines: 15, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 2 } }, // ~100s
    { id: 'f96d18', M: 4, N: 4, mines: 17, constructive: true, features: { cellCount: 96, totalMines: 17, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 4 } }, // ~119s
    { id: 'f72d28', M: 3, N: 4, mines: 20, features: { cellCount: 72, totalMines: 20, canonicalSubsetMoves: 1, genericSubsetMoves: 1.5, advancedLogicMoves: 0, zeroClusterCount: 3 } },   // ~182s
  ],
  rhombille: [
    { id: 'r48d23', M: 4, N: 4, mines: 11, features: { cellCount: 48, totalMines: 11, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 1.5 } },   // ~47s
    { id: 'r60d23', M: 4, N: 5, mines: 14, fallback: true, features: { cellCount: 60, totalMines: 14, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 2 } }, // ~61s
    { id: 'r72d24', M: 6, N: 4, mines: 17, features: { cellCount: 72, totalMines: 17, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 2 } },     // ~78s
    { id: 'r60d28', M: 4, N: 5, mines: 17, features: { cellCount: 60, totalMines: 17, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 2 } },     // ~88s
    { id: 'r72d28', M: 6, N: 4, mines: 20, features: { cellCount: 72, totalMines: 20, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 2 } },     // ~113s
  ],
  // Deltoidal's cheapest proven config prices ~63 s — the lattice cannot
  // reach the easy hill's lower half, so sub-63 targets ship the 63 s entry
  // via the kernel (documented reach limit). Its old fixed config (72 cells,
  // 18 mines, ~285 s) is exactly what this table exists to retire.
  deltoidal: [
    { id: 'd36d17', M: 2, N: 3, mines: 6, constructive: true, fallback: true, features: { cellCount: 36, totalMines: 6, canonicalSubsetMoves: 0, genericSubsetMoves: 0.5, advancedLogicMoves: 0, zeroClusterCount: 1 } }, // ~63s
    { id: 'd36d25', M: 2, N: 3, mines: 9, features: { cellCount: 36, totalMines: 9, canonicalSubsetMoves: 0, genericSubsetMoves: 0, advancedLogicMoves: 0, zeroClusterCount: 1 } },       // ~90s
    { id: 'd48d21', M: 4, N: 2, mines: 10, constructive: true, features: { cellCount: 48, totalMines: 10, canonicalSubsetMoves: 0, genericSubsetMoves: 3, advancedLogicMoves: 0, zeroClusterCount: 3 } }, // ~106s
    { id: 'd48d27', M: 4, N: 2, mines: 13, features: { cellCount: 48, totalMines: 13, canonicalSubsetMoves: 0, genericSubsetMoves: 1, advancedLogicMoves: 0, zeroClusterCount: 2 } },     // ~150s
    { id: 'd72d18', M: 4, N: 3, mines: 13, constructive: true, features: { cellCount: 72, totalMines: 13, canonicalSubsetMoves: 0, genericSubsetMoves: 3, advancedLogicMoves: 2, zeroClusterCount: 2 } }, // ~153s
    { id: 'd72d21', M: 4, N: 3, mines: 15, constructive: true, features: { cellCount: 72, totalMines: 15, canonicalSubsetMoves: 0, genericSubsetMoves: 4, advancedLogicMoves: 0, zeroClusterCount: 2 } }, // ~194s
  ],
};

/**
 * The feature vector an entry prices under: its frozen medians plus the
 * shape key (predictPar dispatches on tilingType to the shape's own block).
 * @param {string} type
 * @param {BandEntry} entry
 */
export function bandEntryFeatures(type, entry) {
  return { ...entry.features, tilingType: type };
}

/**
 * Price an entry through the LIVE per-shape equation. This is the number the
 * band lottery weighs — the median plain-board par of the config at today's
 * shipped coefficients.
 * @param {string} type
 * @param {BandEntry} entry
 * @returns {number} seconds
 */
export function priceBandEntry(type, entry) {
  return predictPar(bandEntryFeatures(type, entry));
}

/**
 * Draw one entry index from priced entries against a target par. Pure and
 * rng-injected for tests; production goes through tilingConfigAttempts.
 *
 * Weights follow bandWeightsFor exactly (the one banding rule): closeness
 * kernel inside the band, 0 outside; if NO entry is in-band the clamp lifts
 * and the raw kernel ranks by closeness alone. The draw is a weighted
 * lottery (P proportional to weight) rather than an argmax, for the same
 * reason the daily mission winner is (2026-07-30): an argmax is a
 * monoculture — nearby targets always ship the identical config — while a
 * lottery samples the whole in-band table, which is also what varies
 * cellCount/totalMines across a shape's live rows (the collinearity the
 * fixed configs could never break, and the reason live data can keep
 * updating the lab-seeded size/density deviations).
 *
 * Consumes EXACTLY ONE rng() call on every path, so the stream contract
 * survives any future fallback edit.
 *
 * @param {() => number} rng
 * @param {number[]} prices per-entry par at the live equation
 * @param {number} targetPar
 * @returns {number} index into prices; 0 when the slate is degenerate
 */
export function pickBandedEntry(rng, prices, targetPar, band = DAILY_PAR_BAND) {
  const u = rng();
  const weights = bandWeightsFor(prices.map((par) => ({ par })), targetPar, band);
  if (weights === null) return 0;
  const totalW = weights.reduce((a, b) => a + b, 0);
  if (!(totalW > 0)) return 0;
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (u * totalW < acc) return i;
  }
  return weights.length - 1;
}

/**
 * The generation attempts for a tiling day's config, in order: the banded
 * draw first, then (when different) the shape's designated fallback entry.
 * Every step is deterministic from the date string, so the precompute, the
 * client fallback, and parResolve run the identical attempt list — the
 * missionSlots lesson applied to configs.
 *
 * A missing/invalid date (defensive; no production caller does this) yields
 * the fallback entry alone rather than a throw — a deterministic degenerate,
 * never a divergence.
 *
 * @param {string} type a TILING_TYPES entry
 * @param {string} dateString YYYY-MM-DD (ET)
 * @returns {BandEntry[]} one or two entries; empty only for an unknown shape
 */
export function tilingConfigAttempts(type, dateString) {
  const entries = TILING_BAND_CONFIGS[type] || [];
  if (entries.length === 0) return [];
  const fallback = entries.find((e) => e.fallback === true) || entries[0];
  if (typeof dateString !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    return [fallback];
  }
  const targetPar = drawDailyTargetPar(dateString);
  const rng = createDailyRNG(`${dateString}${CONFIG_NAMESPACE}`);
  const idx = pickBandedEntry(rng, entries.map((e) => priceBandEntry(type, e)), targetPar);
  const drawn = entries[idx];
  return drawn === fallback ? [drawn] : [drawn, fallback];
}

/**
 * The banded config a tiling daily plays on a date — the drawn entry itself
 * (its generation-failure retry is tilingConfigAttempts' second element).
 * @param {string} type
 * @param {string} dateString
 * @returns {BandEntry|null}
 */
export function drawDailyTilingConfig(type, dateString) {
  const attempts = tilingConfigAttempts(type, dateString);
  return attempts.length ? attempts[0] : null;
}

/**
 * The weekly analogue: the same generation-proven tables, drawn against the
 * WEEKLY par band and the week's own target.
 *
 * There is no weekly shape ROTATION — a tiling weekly happens only when one
 * is deliberately built (the v1.10 launch week) — but when one is, its config
 * has to be chosen against the band the weekly actually lives in ([60, 360]s
 * against the daily's [20, 240]s), or a week-long board would be priced for a
 * daily.
 *
 * The namespace is distinct from the daily's for the reason parBand.js gives
 * about its own target streams: a weekStart IS a Monday date string, so a
 * shared namespace would lock every launch Monday's weekly to the same config
 * its daily drew.
 *
 * Reach is the honest limit here. The tables were calibrated to the DAILY
 * band and top out around 218s (Honeycomb), so a weekly target above that
 * ships the table's hardest in-band entry — the same "the band is a
 * constraint, not a coverage target" reading the daily side documents.
 *
 * @param {string} type a TILING_TYPES entry
 * @param {string} weekStart YYYY-MM-DD (the ET Monday)
 * @returns {BandEntry[]} drawn entry first, then the shape's fallback
 */
export function tilingWeeklyConfigAttempts(type, weekStart) {
  const entries = TILING_BAND_CONFIGS[type] || [];
  if (entries.length === 0) return [];
  const fallback = entries.find((e) => e.fallback === true) || entries[0];
  if (typeof weekStart !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return [fallback];
  }
  const targetPar = drawWeeklyTargetPar(weekStart);
  const rng = createDailyRNG(`${weekStart}${WEEKLY_CONFIG_NAMESPACE}`);
  const idx = pickBandedEntry(
    rng, entries.map((e) => priceBandEntry(type, e)), targetPar, WEEKLY_PAR_BAND,
  );
  const drawn = entries[idx];
  return drawn === fallback ? [drawn] : [drawn, fallback];
}
