// Challenge mode — 120 levels with sawtooth difficulty progression.
// Each gimmick introduction (L11, L21, ..., L91) drops the board to 11×11
// and reduces density, creating a grace period to learn the new mechanic.
// Between intros, board size ramps back up to 14×14 and density climbs.
// After all gimmicks are introduced (L91+), a final 30-level ramp reaches
// 14×14 at 34% density with heavy modifier stacking.

// ── Shared constants ──────────────────────────────────
export const PLATE_MIN_SECONDS = 8;
export const PLATE_SECONDS_PER_STEP = 10;
export const LIFELINE_WIN_REWARD_CHANCE = 0.3;

// Greg-par linear model. Coefficients are fit in R against real daily
// completion data and written here; the JS side just applies the formula
// via computeDailyFeatures + predictPar in src/logic/dailyFeatures.js.
//
// The block between PAR_MODEL:START and PAR_MODEL:END is OVERWRITTEN
// AUTOMATICALLY every day at 10am ET by the "Refit Greg-par" GitHub Action
// (.github/workflows/refit-par-model.yml). Do not edit by hand between the
// markers — your changes will be lost on the next scheduled refit.
// To tune by hand, disable the workflow first or edit the R script in
// scripts/refit-par-model.R.
// PAR_MODEL:START
export const PAR_MODEL = {
  // Last refit: 2026-04-28 | brms (2 users · max Rhat = 1.004, min ESS = 1568, divergent = 0/4000) | N=95 scores, 49 dates, 2 players | R²=0.561
  intercept: 0.00,

  // Move-type coefficients (primary)
  secPerPassAMove:            0.61,
  secPerCanonicalSubsetMove:  4.25,
  secPerGenericSubsetMove:    2.29,
  secPerAdvancedLogicMove:    1.22,
  secPerDisjunctiveMove:      7.53,

  // Board shape (secondary)
  secPerCell:      0.033,
  secPerMineFlag:  1.364,
  secPerWallEdge:  0.217,

  // Gimmick cell counts (tertiary)
  secPerMysteryCell:   0.949,
  secPerLiarCell:      0.763,
  secPerLockedCell:    0.554,
  secPerWormholePair:  1.631,
  secPerMirrorPair:    1.197,
  secPerSonarCell:     0.738,
  secPerCompassCell:   0.993,

  // Structural features (v1.5.16+)
  secPerNonZeroSafeCell:  0.352,
  secPerZeroCluster:      0.690,
};
// PAR_MODEL:END

// Daily board dimension ranges (seeded RNG picks within these)
export const DAILY_MIN_SIZE = 8;
export const DAILY_SIZE_RANGE = 5;   // 8–12
export const DAILY_MIN_DENSITY = 0.14;
export const DAILY_DENSITY_RANGE = 0.16; // 14%–30%

// Gimmick introduction levels (non-chaosOnly)
const GIMMICK_INTROS = [11, 21, 31, 41, 51, 61, 71, 81, 91];

// Peak density at the END of each 10-level gimmick block.
// These ramp from 20% to 33%, with the final block (L91-120) peaking at 34%.
const PEAK_DENSITIES = [0.20, 0.24, 0.27, 0.29, 0.30, 0.31, 0.32, 0.33, 0.34];

export const MAX_LEVEL = 120;

export function getDifficultyForLevel(level) {
  const lv = Math.min(Math.max(level, 1), MAX_LEVEL);

  // ── L1-10: Tutorial ramp (no gimmicks) ──
  if (lv <= 10) {
    // Size ramps 5→9, density ramps 8%→16%
    const t = (lv - 1) / 9; // 0.0 at L1, 1.0 at L10
    const size = Math.round(5 + t * 4);
    const density = 0.08 + t * 0.08;
    const mines = Math.max(2, Math.round(size * size * density));
    return { rows: size, cols: size, mines };
  }

  // ── L11-120: Sawtooth gimmick blocks ──

  // Find which block we're in
  let blockIdx = 0;
  for (let i = GIMMICK_INTROS.length - 1; i >= 0; i--) {
    if (lv >= GIMMICK_INTROS[i]) { blockIdx = i; break; }
  }

  const blockStart = GIMMICK_INTROS[blockIdx];
  const blockEnd = blockIdx < 8 ? GIMMICK_INTROS[blockIdx + 1] - 1 : MAX_LEVEL;
  const blockLen = blockEnd - blockStart; // 9 for regular blocks, 29 for final
  const progress = blockLen > 0 ? (lv - blockStart) / blockLen : 0; // 0.0→1.0

  // Board size: 11 at block start, ramps to 14 at block end
  const size = Math.round(11 + progress * 3);

  // Density: drops 10% (relative) from previous peak, ramps to this block's peak
  const peakDensity = PEAK_DENSITIES[blockIdx];
  const prevPeak = blockIdx === 0 ? 0.16 : PEAK_DENSITIES[blockIdx - 1];
  const dropDensity = prevPeak * 0.90; // 10% relative reduction
  const density = dropDensity + progress * (peakDensity - dropDensity);

  // Compute mines, hard cap at 34%
  const effectiveDensity = Math.min(density, 0.34);
  const mines = Math.max(2, Math.round(size * size * effectiveDensity));

  return { rows: size, cols: size, mines };
}

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
  const capped = Math.min(Math.max(level, 1), TIMED_LEVELS.length);
  return { ...TIMED_LEVELS[capped - 1] };
}

// Minimum solver technique level required to verify a board for the given
// challenge level. The solver returns techniqueLevel:
//   0 = solved by simple Pass A propagation alone
//   1 = required Pass B subset / superset analysis
//   2 = required Pass C tank or gauss enumeration
//   3 = required disjunctive (liar) reasoning to make a deduction
// Boards verified below this floor are rejected by the generator and
// regenerated, so the player at higher challenge levels actually needs
// to apply the corresponding technique to win.
export function getRequiredTechnique(level) {
  if (level <= 30) return 0;   // tutorial / first 2 modifier blocks: any board OK
  if (level <= 60) return 1;   // L31–60: must require subset reasoning
  if (level <= 90) return 2;   // L61–90: must require advanced (tank/gauss)
  return 2;                     // L91+: same advanced floor (pushing to 3 would
                                //        starve generators that don't pick liar)
}

// Anti-zero-cluster thresholds per level
export function getMaxZeroCluster(level) {
  if (level <= 5) return Infinity;   // Tutorial: no restriction
  if (level <= 10) return 10;
  if (level <= 20) return 8;
  if (level <= 30) return 6;
  if (level <= 50) return 4;
  if (level <= 70) return 3;
  return 2;                          // L71–120: near-zero openings
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
  const size = Math.min(7 + r, 14);          // 8×8 → caps at 14×14
  const density = Math.min(0.16 + r * 0.02, 0.36); // 18% → caps at 36%
  const mines = Math.max(2, Math.round(size * size * density));
  const modifierCount = Math.min(2 + Math.floor((r - 1) / 2), 7); // 2 → caps at 7
  return { rows: size, cols: size, mines, modifierCount };
}

export const CHAOS_UNLOCK_LEVEL = 50;
