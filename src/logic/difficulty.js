// Challenge mode — 120 levels with sawtooth difficulty progression.
// Each gimmick introduction (L11, L21, ..., L91) drops the board to 11×11
// and reduces density, creating a grace period to learn the new mechanic.
// Between intros, board size ramps back up to ~12×14 and density climbs.
// After all gimmicks are introduced (L91+), a final 30-level ramp reaches
// 12-wide at 34% density with heavy modifier stacking.

// ── Shared constants ──────────────────────────────────
export const PLATE_MIN_SECONDS = 8;
export const PLATE_SECONDS_PER_STEP = 10;
// Each disarm target the Pass-A estimator could NOT resolve needs
// subset/tank reasoning; it is billed at PLATE_TIER_WEIGHT x the par
// model's fitted per-tier cost (the dearer of pattern/search — fit-day
// noise can invert the two). Calibration, not proof: the certificate
// still doesn't model wall-clock, but the deadline now scales with the
// same fitted difficulty prices par uses instead of ignoring hard
// reasoning entirely. The cap keeps a many-hard-target plate from
// becoming a non-event.
export const PLATE_TIER_WEIGHT = 8;
export const PLATE_MAX_SECONDS = 90;

/**
 * Seconds for a pressure-plate countdown, from the disarm estimate.
 * @param {{steps: number, unsolved: number}} est estimatePlateMovesToDisarm result
 * @param {object} model PAR_MODEL (injectable for tests)
 */
export function plateSeconds(est, model = PAR_MODEL) {
  const tierSec = Math.max(model.secPerPatternMove || 0, model.secPerSearchMove || 0);
  // A stuck target can never price below the classic per-step rate,
  // whatever the day's refit put in the tier coefficients.
  const perHardTarget = Math.max(PLATE_SECONDS_PER_STEP, Math.ceil(PLATE_TIER_WEIGHT * tierSec));
  const raw = est.steps * PLATE_SECONDS_PER_STEP + est.unsolved * perHardTarget;
  return Math.max(PLATE_MIN_SECONDS, Math.min(PLATE_MAX_SECONDS, Math.round(raw)));
}
export const LIFELINE_WIN_REWARD_CHANCE = 0.3;

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
  // Last refit: 2026-06-15 | brms (3 users · max Rhat = 1.004, min ESS = 1222, divergent = 0/4000) | N=206 scores, 98 dates, 5 players | R²=0.565
  intercept: -13.32,

  // Size baseline. cellCount is the lone size axis (it absorbs trivial
  // propagation); totalMines stays a raw count. (2026-06-08 rework.)
  secPerCell:        0.133,
  secPerMineFlag:    3.317,

  // Reasoning tiers: pattern = canonical + generic subsets; search = advanced.
  secPerPatternMove: 2.027,
  secPerSearchMove:  1.119,

  // Board structure.
  secPerWallEdge:    0.151,
  secPerZeroCluster: 0.510,

  // Modifier cells (kept split; sparse, prior-anchored until data builds).
  secPerMysteryCell:   0.820,
  secPerLiarCell:      0.737,
  secPerLockedCell:    0.803,
  secPerWormholePair:  0.754,
  secPerMirrorPair:    1.448,
  secPerSonarCell:     0.802,
  secPerCompassCell:   0.832,

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
  // Last refit: 2026-06-15 | copy-of-daily
  intercept: -13.32,
  secPerCell:        0.133,
  secPerMineFlag:    3.317,
  secPerPatternMove: 2.027,
  secPerSearchMove:  1.119,
  secPerWallEdge:    0.151,
  secPerZeroCluster: 0.510,
  secPerMysteryCell:   0.820,
  secPerLiarCell:      0.737,
  secPerLockedCell:    0.803,
  secPerWormholePair:  0.754,
  secPerMirrorPair:    1.448,
  secPerSonarCell:     0.802,
  secPerCompassCell:   0.832,
};
// TIMED_PAR_MODEL:END

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

  return applyWidthCap(size, size, mines);
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
  const idx = Math.min(Math.max(level, 1), TIMED_LEVELS.length) - 1;
  const { rows, cols, mines, label } = TIMED_LEVELS[idx];
  return { ...applyWidthCap(rows, cols, mines), label };
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
  const size = Math.min(7 + r, 14);          // 8×8 → caps at 14×14 (cols later capped to 12)
  const density = Math.min(0.16 + r * 0.02, 0.36); // 18% → caps at 36%
  const mines = Math.max(2, Math.round(size * size * density));
  const modifierCount = Math.min(2 + Math.floor((r - 1) / 2), 7); // 2 → caps at 7
  return { ...applyWidthCap(size, size, mines), modifierCount };
}

export const CHAOS_UNLOCK_LEVEL = 50;
