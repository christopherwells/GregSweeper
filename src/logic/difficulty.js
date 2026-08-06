// Shared difficulty constants and the non-ladder mode tables (Quick Play,
// Chaos), plus the refit-owned par models. The challenge ladder itself
// lives in challenge250.js: a level is an authored par-rating spec, drawn
// fresh and certified per attempt (the 120-level sawtooth this module used
// to compute was retired by the Challenge 250 engine).

// ── Shared constants ──────────────────────────────────
export const PLATE_MIN_SECONDS = 8;
export const PLATE_SECONDS_PER_STEP = 10;
// Each disarm target the Pass-A estimator could NOT resolve needs
// subset/tank reasoning; it is billed at PLATE_TIER_SECONDS. This is
// DECOUPLED from PAR_MODEL: under the log-scale par model the tier
// coefficients are log-MULTIPLIERS, not seconds, so the old
// `PLATE_TIER_WEIGHT × tier-coef` read no longer yields a seconds price.
// The fixed value preserves the ~16s/hard-target the additive model
// produced (max(pattern,search) ≈ 1.9s × the old weight of 8, above the
// per-step floor). Plate timing is calibration, not proof (the certificate
// never modeled wall-clock), so a stable fixed rate is an acceptable price
// and no longer chases fit-day tier-coefficient noise. The cap keeps a
// many-hard-target plate from becoming a non-event.
export const PLATE_TIER_SECONDS = 16;
export const PLATE_MAX_SECONDS = 90;

/**
 * Seconds for a pressure-plate countdown, from the disarm estimate.
 * @param {{steps: number, unsolved: number}} est estimatePlateMovesToDisarm result
 */
export function plateSeconds(est) {
  // A stuck target can never price below the classic per-step rate.
  const perHardTarget = Math.max(PLATE_SECONDS_PER_STEP, PLATE_TIER_SECONDS);
  const raw = est.steps * PLATE_SECONDS_PER_STEP + est.unsolved * perHardTarget;
  return Math.max(PLATE_MIN_SECONDS, Math.min(PLATE_MAX_SECONDS, Math.round(raw)));
}

// Board width is hard-capped at 12 cells on every viewport. Wider boards
// either force a scroll (rejected on mobile) or shrink cells below the iOS
// 44pt tap target. With width=12 and the existing --cell-size of 28px on
// mobile (≤480px viewport), a board fits 12 × 28 = 336 px plus gaps inside
// the 390 px iPhone portrait viewport without scrolling. Rows are NOT
// capped — taller boards (weekly samples up to 14 rows) are allowed because
// the renderer fits cells to BOTH width and height, shrinking the cell so the
// whole board stays inside the 70vh scroll wrapper (_fitCellSize in
// boardRenderer.js). Mines are rescaled to preserve density.
export const BOARD_WIDTH_CAP = 12;

export function applyWidthCap(rows, cols, mines) {
  if (cols <= BOARD_WIDTH_CAP) return { rows, cols, mines };
  const density = mines / (rows * cols);
  const newCols = BOARD_WIDTH_CAP;
  const newMines = Math.max(2, Math.round(rows * newCols * density));
  return { rows, cols: newCols, mines: newMines };
}

// Greg-par model. Coefficients are fit in R against real daily completion
// data and written here; the JS side just applies the formula via
// computeDailyFeatures + predictPar in src/logic/dailyFeatures.js. When the
// block carries `scale: 'log'`, par = exp(intercept + Σ coef·feature) (a
// multiplicative, lognormal-median model; coefficients are log-multipliers);
// without that marker predictPar applies the legacy additive-seconds form.
//
// The block between PAR_MODEL:START and PAR_MODEL:END is OVERWRITTEN
// AUTOMATICALLY every day at 10am ET by the "Refit Greg-par" GitHub Action
// (.github/workflows/refit-par-model.yml). Do not edit by hand between the
// markers — your changes will be lost on the next scheduled refit.
// To tune by hand, disable the workflow first or edit the R script in
// scripts/refit-par-model.R.
// PAR_MODEL:START
export const PAR_MODEL = {
  // Last refit: 2026-08-06 | brms (4 users · max Rhat = 1.003, min ESS = 1398, divergent = 0/4000) | N=400 scores, 164 dates, 6 players | R²=0.496 (log scale)
  // scale:"log" => par = exp(intercept + Σ coef·feature): multiplicative,
  // lognormal MEDIAN. Coefficients are LOG-MULTIPLIERS per unit, NOT seconds.
  scale: 'log',
  intercept: 3.0076,
  secPerCell: 0.00055,
  secPerMineFlag: 0.04953,
  secPerPatternMove: 0.02104,
  secPerSearchMove: 0.01319,
  secPerWallEdge: 0.00181,
  secPerZeroCluster: 0.00109,
  secPerMysteryCell: 0.00137,
  secPerLiarCell: 0.00124,
  secPerLockedCell: 0.02788,
  secPerWormholePair: 0.00947,
  secPerMirrorPair: 0.02304,
  secPerSonarCell: 0.05353,
  secPerCompassCell: 0.02545,
  secPerWormLoad: 0.00689,
};
// PAR_MODEL:END

// Quick play has its OWN equation (Christopher, 2026-06-12): timed
// rows exist only when someone WINS — losses die on a mine and never
// report — so the sample is win-censored and cannot be pooled with
// the (effectively uncensored) daily completions. PAR_MODEL_TIMED is
// therefore "par for a WINNING quick-play run": fitted by the nightly
// refit on handicap-adjusted timed wins with priors centered on the
// daily posterior, two-tailed outlier screening (AFK rows like a 181s
// beginner board are dropped), and shipped as a verbatim copy of
// PAR_MODEL until TIMED_FIT_THRESHOLD usable rows exist. The block
// between the markers is refit-owned, same contract as PAR_MODEL.
// TIMED_PAR_MODEL:START
export const PAR_MODEL_TIMED = {
  // Last refit: 2026-08-06 | brms-timed (n=136)
  // scale:"log" => par = exp(intercept + Σ coef·feature): multiplicative,
  // lognormal MEDIAN. Coefficients are LOG-MULTIPLIERS per unit, NOT seconds.
  // Below the activation threshold this is a verbatim copy of the daily model.
  scale: 'log',
  intercept: 2.6975,
  secPerCell: 0.00136,
  secPerMineFlag: 0.04722,
  secPerPatternMove: 0.04883,
  secPerSearchMove: 0.01864,
  secPerWallEdge: 0.00232,
  secPerZeroCluster: 0.00148,
  secPerMysteryCell: 0.00176,
  secPerLiarCell: 0.00159,
  secPerLockedCell: 0.03545,
  secPerWormholePair: 0.01229,
  secPerMirrorPair: 0.02948,
  secPerSonarCell: 0.06816,
  secPerCompassCell: 0.03254,
  secPerWormLoad: 0.00869,
};
// TIMED_PAR_MODEL:END

// Per-shape par equations (Project Coastline; Christopher's ruling
// 2026-08-01: "we might just want different par equations for each shape...
// priors can be informed by the square tilings"). One FULL coefficient set
// per non-rectangular tiling, keyed by the exact TILING_TYPES strings from
// src/logic/tilingGeometry.js — the registry lockstep is pinned by
// test/tilingParModelContract.test.mjs rather than an import, because this
// module sits in the typecheck gate's curated set and must stay leaf-light.
// ('6.6.6' is a deep-link alias for 'hex' and deliberately NOT a key here;
// modelFor in dailyFeatures.js normalizes it.)
//
// This replaces the six secPerShape* intercept offsets, which asserted a
// lattice can only shift par by a constant. The nightly R refit fits ONE
// joint model — the base features plus, per shape, a 0/1 indicator (the old
// offset relocated as that shape's intercept deviation) and a SIGNED
// shape-by-feature interaction deviation per coefficient, with the player
// random intercept shared so handicaps stay jointly estimated — then ships
// each block here as base + deviations. Since 2026-08-03 the core
// deviations (intercept, per-cell, per-mine, per shape) are LAB-SEEDED from
// the completed Par Lab battery (Christopher's ruling; the fit is
// scripts/fit-parlab-priors.qmd, its posteriors frozen in
// scripts/data/parlab-prior-centers.json): each ships its lab center until
// live tiling rows exist, then the fitted posterior — under a
// normal(lab mean, 2 x lab sd) prior — takes over continuously. Negative
// composed coefficients are expected (a lattice can price a feature BELOW
// the square rate; hex charges less per cell, more per mine). Unseeded
// terms, including every gimmick-by-shape cell (his n=1
// observations-not-conclusions ruling), keep zero-centered priors and ship
// 0 until NEW_FEATURE_DATA_THRESHOLD (20) nonzero fit rows earn them. The
// contract test pins block minus base against the frozen lab JSON.
//
// The block between the markers is refit-owned, same contract as PAR_MODEL.
// PAR_MODEL_SHAPES:START
export const PAR_MODEL_SHAPES = {
  // Last refit: 2026-08-06 | composed: PAR_MODEL base + per-shape deviations
  // Deviations: fitted posterior where live rows exist; the Par Lab center
  // (scripts/data/parlab-prior-centers.json, the 2026-08-03 seeding ruling)
  // where none do; 0 for unseeded terms until 20 nonzero fit rows
  // (NEW_FEATURE_DATA_THRESHOLD) earn them.
  '4.8.8': {
    scale: 'log',
    intercept: 2.8504,
    secPerCell: -0.00268,
    secPerMineFlag: 0.09752,
    secPerPatternMove: 0.02104,
    secPerSearchMove: 0.01319,
    secPerWallEdge: 0.00181,
    secPerZeroCluster: 0.00109,
    secPerMysteryCell: 0.00137,
    secPerLiarCell: 0.00124,
    secPerLockedCell: 0.02788,
    secPerWormholePair: 0.00947,
    secPerMirrorPair: 0.02304,
    secPerSonarCell: 0.05353,
    secPerCompassCell: 0.02545,
    secPerWormLoad: 0.00689,
  },
  hex: {
    scale: 'log',
    intercept: 2.6381,
    secPerCell: -0.00547,
    secPerMineFlag: 0.10683,
    secPerPatternMove: 0.02104,
    secPerSearchMove: 0.01319,
    secPerWallEdge: 0.00181,
    secPerZeroCluster: 0.00109,
    secPerMysteryCell: 0.00137,
    secPerLiarCell: 0.00124,
    secPerLockedCell: 0.02788,
    secPerWormholePair: 0.00947,
    secPerMirrorPair: 0.02304,
    secPerSonarCell: 0.05353,
    secPerCompassCell: 0.02545,
    secPerWormLoad: 0.00689,
  },
  cairo: {
    scale: 'log',
    intercept: 2.6990,
    secPerCell: 0.02644,
    secPerMineFlag: -0.00708,
    secPerPatternMove: 0.02104,
    secPerSearchMove: 0.01319,
    secPerWallEdge: 0.00181,
    secPerZeroCluster: 0.00109,
    secPerMysteryCell: 0.00137,
    secPerLiarCell: 0.00124,
    secPerLockedCell: 0.02788,
    secPerWormholePair: 0.00947,
    secPerMirrorPair: 0.02304,
    secPerSonarCell: 0.05353,
    secPerCompassCell: 0.02545,
    secPerWormLoad: 0.00689,
  },
  floret: {
    scale: 'log',
    intercept: 3.2085,
    secPerCell: -0.00191,
    secPerMineFlag: 0.10235,
    secPerPatternMove: 0.02104,
    secPerSearchMove: 0.01319,
    secPerWallEdge: 0.00181,
    secPerZeroCluster: 0.00109,
    secPerMysteryCell: 0.00137,
    secPerLiarCell: 0.00124,
    secPerLockedCell: 0.02788,
    secPerWormholePair: 0.00947,
    secPerMirrorPair: 0.02304,
    secPerSonarCell: 0.05353,
    secPerCompassCell: 0.02545,
    secPerWormLoad: 0.00689,
  },
  rhombille: {
    scale: 'log',
    intercept: 3.0568,
    secPerCell: -0.00962,
    secPerMineFlag: 0.11712,
    secPerPatternMove: 0.02104,
    secPerSearchMove: 0.01319,
    secPerWallEdge: 0.00181,
    secPerZeroCluster: 0.00109,
    secPerMysteryCell: 0.00137,
    secPerLiarCell: 0.00124,
    secPerLockedCell: 0.02788,
    secPerWormholePair: 0.00947,
    secPerMirrorPair: 0.02304,
    secPerSonarCell: 0.05353,
    secPerCompassCell: 0.02545,
    secPerWormLoad: 0.00689,
  },
  deltoidal: {
    scale: 'log',
    intercept: 3.4953,
    secPerCell: -0.00147,
    secPerMineFlag: 0.11983,
    secPerPatternMove: 0.02104,
    secPerSearchMove: 0.01319,
    secPerWallEdge: 0.00181,
    secPerZeroCluster: 0.00109,
    secPerMysteryCell: 0.00137,
    secPerLiarCell: 0.00124,
    secPerLockedCell: 0.02788,
    secPerWormholePair: 0.00947,
    secPerMirrorPair: 0.02304,
    secPerSonarCell: 0.05353,
    secPerCompassCell: 0.02545,
    secPerWormLoad: 0.00689,
  },
};
// PAR_MODEL_SHAPES:END

// Bomb-hit penalty: flat component added on top of the info-value cost
// computed by src/logic/bombInfoValue.js. The info-value alone can be 0
// for a mine the solver was about to nail anyway; the base keeps every
// bomb-pop slightly punishing so it's never a strict-zero shortcut, and
// preserves solving as the intended path.
export const BOMB_PENALTY_BASE = 3;

// Escalation: each successive strike adds BOMB_PENALTY_RAMP of the base on top
// of the previous one, so the n-th strike's base = BOMB_PENALTY_BASE × (1 +
// BOMB_PENALTY_RAMP × (n-1)) → +3s, +4.5s, +6s, +7.5s … The first strike is
// unchanged (a lone hit costs the standard base), and the ramp is gentle on
// purpose: the >30% anti-cheat handles brute-forcers, so this only needs to
// discourage casual mine-popping, not clobber a player who hits a couple
// legitimately. (Was a steeper × n ramp; softened 2026-06-16.)
export const BOMB_PENALTY_RAMP = 0.5;

// Anti-cheat: a player who detonates more than this fraction of the board's
// mines isn't playing — they're probing the layout by popping mines (daily /
// weekly have no game-over, so nothing stops them). Such a run is never
// leaderboarded (and so never feeds the par fit). Pure + exported so the
// submission gate and tests share one definition.
export const BOMB_HIT_CHEAT_FRACTION = 0.30;
export function isBombHitCheat(bombHits, totalMines) {
  return typeof totalMines === 'number' && totalMines > 0
    && typeof bombHits === 'number'
    && bombHits > BOMB_HIT_CHEAT_FRACTION * totalMines;
}

// Daily board dimension ranges (seeded RNG picks within these)
export const DAILY_MIN_SIZE = 8;
export const DAILY_SIZE_RANGE = 5;   // 8–12
export const DAILY_MIN_DENSITY = 0.14;
export const DAILY_DENSITY_RANGE = 0.16; // 14%–30%

// Weekly board dimensions — same density range as daily but a wider
// size band, since the player gets 7 attempts on the same board and
// we want some weeks to feel chunky. The 14×14 cap matches challenge
// L120's max so we don't introduce new size territory.
export const WEEKLY_MIN_SIZE = 8;
export const WEEKLY_SIZE_RANGE = 7;  // 8–14

// Quick Play (internally "timed") — mobile-friendly sizes, count UP (no countdown)
const TIMED_LEVELS = [
  { rows: 9,  cols: 9,  mines: 10,  label: 'Beginner' },     // 12.3%
  { rows: 11, cols: 11, mines: 25,  label: 'Intermediate' },  // 20.7%
  { rows: 13, cols: 13, mines: 40,  label: 'Expert' },        // 23.7%
  { rows: 14, cols: 14, mines: 55,  label: 'Extreme' },       // 28.1%
];

// Speed ratings — thresholds in seconds per difficulty
const SPEED_THRESHOLDS = [
  { diamond: 30, gold: 60, silver: 120 },
  { diamond: 60, gold: 120, silver: 240 },
  { diamond: 90, gold: 180, silver: 360 },
  { diamond: 120, gold: 240, silver: 480 },
];

export function getTimedDifficulty(level) {
  const idx = Math.min(Math.max(level, 1), TIMED_LEVELS.length) - 1;
  const { rows, cols, mines, label } = TIMED_LEVELS[idx];
  return { ...applyWidthCap(rows, cols, mines), label };
}

export function getSpeedRating(level, time) {
  const idx = Math.min(Math.max(level, 1), SPEED_THRESHOLDS.length) - 1;
  const t = SPEED_THRESHOLDS[idx];
  if (time <= t.diamond) return { icon: '💎', name: 'Diamond', tier: 4 };
  if (time <= t.gold)    return { icon: '🥇', name: 'Gold',    tier: 3 };
  if (time <= t.silver)  return { icon: '🥈', name: 'Silver',  tier: 2 };
  return                          { icon: '🥉', name: 'Bronze',  tier: 1 };
}

export const MAX_TIMED_LEVEL = TIMED_LEVELS.length;

// ── Chaos Mode Difficulty ─────────────────────────────
// Each round gets progressively harder: bigger board, more mines, more modifiers
export function getChaosDifficulty(round) {
  const r = Math.max(1, round);
  const size = Math.min(7 + r, 14);          // 8×8 → caps at 14×14 (cols later capped to 12)
  const density = Math.min(0.16 + r * 0.02, 0.36); // 18% → caps at 36%
  const mines = Math.max(2, Math.round(size * size * density));
  const modifierCount = Math.min(2 + Math.floor((r - 1) / 2), 7); // 2 → caps at 7
  return { ...applyWidthCap(size, size, mines), modifierCount };
}

// Chaos unlocks at L100 (his ruling 2026-08-04). It was 50 on the old
// 120-level ladder — 42% of the climb — and 50 on a 250-level ladder
// would hand Chaos over at 20%, far earlier in the journey than it used
// to arrive.
export const CHAOS_UNLOCK_LEVEL = 100;
