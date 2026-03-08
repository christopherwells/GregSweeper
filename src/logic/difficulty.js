// Challenge mode — 50 levels of progressive difficulty
// Boards grow from 8×8 up to 14×14 at the highest levels.
// Difficulty increases via mine density, grid size, time pressure, and zero-cluster limits.
const CHALLENGE_LEVELS = [
  // Learning (L1–5): 8×8 → 10×10, density 12–16%
  { rows: 8,  cols: 8,  mines: 8,  timeLimit: 90  },   // L1  — 12.5%
  { rows: 8,  cols: 8,  mines: 10, timeLimit: 90  },   // L2  — 15.6%
  { rows: 9,  cols: 9,  mines: 11, timeLimit: 100 },   // L3  — 13.6%
  { rows: 9,  cols: 9,  mines: 13, timeLimit: 110 },   // L4  — 16.0%
  { rows: 10, cols: 10, mines: 16, timeLimit: 120 },   // L5  — 16.0%

  // Intermediate (L6–10): 10×10 → 11×11, density 18–25%
  { rows: 10, cols: 10, mines: 18, timeLimit: 130 },   // L6  — 18.0%
  { rows: 10, cols: 10, mines: 20, timeLimit: 140 },   // L7  — 20.0%
  { rows: 11, cols: 11, mines: 24, timeLimit: 160 },   // L8  — 19.8%
  { rows: 11, cols: 11, mines: 27, timeLimit: 180 },   // L9  — 22.3%
  { rows: 11, cols: 11, mines: 30, timeLimit: 200 },   // L10 — 24.8%

  // Advanced (L11–15): 11×11 → 12×12, density 25–30%
  { rows: 11, cols: 11, mines: 33, timeLimit: 220 },   // L11 — 27.3%
  { rows: 12, cols: 12, mines: 36, timeLimit: 240 },   // L12 — 25.0%
  { rows: 12, cols: 12, mines: 39, timeLimit: 260 },   // L13 — 27.1%
  { rows: 12, cols: 12, mines: 42, timeLimit: 280 },   // L14 — 29.2%
  { rows: 12, cols: 12, mines: 44, timeLimit: 300 },   // L15 — 30.6%

  // Expert (L16–20): 12×12, density 30–35%
  { rows: 12, cols: 12, mines: 45, timeLimit: 320 },   // L16 — 31.3%
  { rows: 12, cols: 12, mines: 47, timeLimit: 340 },   // L17 — 32.6%
  { rows: 12, cols: 12, mines: 48, timeLimit: 360 },   // L18 — 33.3%
  { rows: 12, cols: 12, mines: 49, timeLimit: 380 },   // L19 — 34.0%
  { rows: 12, cols: 12, mines: 50, timeLimit: 400 },   // L20 — 34.7%

  // Legendary (L21–30): 12×12, density 35–40%, tighter timers
  { rows: 12, cols: 12, mines: 51, timeLimit: 380 },   // L21 — 35.4%
  { rows: 12, cols: 12, mines: 52, timeLimit: 360 },   // L22 — 36.1%
  { rows: 12, cols: 12, mines: 53, timeLimit: 340 },   // L23 — 36.8%
  { rows: 12, cols: 12, mines: 54, timeLimit: 320 },   // L24 — 37.5%
  { rows: 12, cols: 12, mines: 54, timeLimit: 300 },   // L25 — 37.5%
  { rows: 12, cols: 12, mines: 55, timeLimit: 290 },   // L26 — 38.2%
  { rows: 12, cols: 12, mines: 56, timeLimit: 280 },   // L27 — 38.9%
  { rows: 12, cols: 12, mines: 56, timeLimit: 260 },   // L28 — 38.9%
  { rows: 12, cols: 12, mines: 57, timeLimit: 250 },   // L29 — 39.6%
  { rows: 12, cols: 12, mines: 58, timeLimit: 240 },   // L30 — 40.3%

  // Mythic (L31–37): 13×13 (169 cells), density 30–35%, tighter timers
  { rows: 13, cols: 13, mines: 52, timeLimit: 240 },   // L31 — 30.8%
  { rows: 13, cols: 13, mines: 54, timeLimit: 235 },   // L32 — 32.0%
  { rows: 13, cols: 13, mines: 55, timeLimit: 230 },   // L33 — 32.5%
  { rows: 13, cols: 13, mines: 57, timeLimit: 225 },   // L34 — 33.7%
  { rows: 13, cols: 13, mines: 58, timeLimit: 220 },   // L35 — 34.3%
  { rows: 13, cols: 13, mines: 59, timeLimit: 215 },   // L36 — 34.9%
  { rows: 13, cols: 13, mines: 60, timeLimit: 210 },   // L37 — 35.5%

  // Titan (L38–43): 14×14 (196 cells), density 32–36%, squeezed timers
  { rows: 14, cols: 14, mines: 63, timeLimit: 210 },   // L38 — 32.1%
  { rows: 14, cols: 14, mines: 65, timeLimit: 208 },   // L39 — 33.2%
  { rows: 14, cols: 14, mines: 67, timeLimit: 205 },   // L40 — 34.2%
  { rows: 14, cols: 14, mines: 68, timeLimit: 202 },   // L41 — 34.7%
  { rows: 14, cols: 14, mines: 69, timeLimit: 200 },   // L42 — 35.2%
  { rows: 14, cols: 14, mines: 70, timeLimit: 197 },   // L43 — 35.7%

  // Immortal (L44–50): 14×14, density 36–38%, brutal time pressure
  { rows: 14, cols: 14, mines: 71, timeLimit: 195 },   // L44 — 36.2%
  { rows: 14, cols: 14, mines: 72, timeLimit: 192 },   // L45 — 36.7%
  { rows: 14, cols: 14, mines: 73, timeLimit: 190 },   // L46 — 37.2%
  { rows: 14, cols: 14, mines: 74, timeLimit: 188 },   // L47 — 37.8%
  { rows: 14, cols: 14, mines: 74, timeLimit: 185 },   // L48 — 37.8%
  { rows: 14, cols: 14, mines: 75, timeLimit: 182 },   // L49 — 38.3%
  { rows: 14, cols: 14, mines: 75, timeLimit: 180 },   // L50 — 38.3%
];

// Timed mode — mobile-friendly sizes, count UP (no countdown)
// Difficulty via mine density, all boards fit on 375px screens.
const TIMED_LEVELS = [
  { rows: 9,  cols: 9,  mines: 10,  label: 'Beginner' },     // 12.3%
  { rows: 11, cols: 11, mines: 25,  label: 'Intermediate' },  // 20.7%
  { rows: 13, cols: 13, mines: 40,  label: 'Expert' },        // 23.7%
];

// Speed ratings — thresholds in seconds per difficulty
const SPEED_THRESHOLDS = [
  // Beginner:     Diamond ≤30, Gold ≤60, Silver ≤120
  { diamond: 30, gold: 60, silver: 120 },
  // Intermediate: Diamond ≤60, Gold ≤120, Silver ≤240
  { diamond: 60, gold: 120, silver: 240 },
  // Expert:       Diamond ≤90, Gold ≤180, Silver ≤360
  { diamond: 90, gold: 180, silver: 360 },
];

// Fog of War mode — uses same curve as Challenge for progressive difficulty
// (Fog effects ramp separately via fogOfWar.js)

export function getDifficultyForLevel(level) {
  const capped = Math.min(Math.max(level, 1), CHALLENGE_LEVELS.length);
  return { ...CHALLENGE_LEVELS[capped - 1] };
}

export function getTimedDifficulty(level) {
  const capped = Math.min(Math.max(level, 1), TIMED_LEVELS.length);
  return { ...TIMED_LEVELS[capped - 1] };
}

// Anti-zero-cluster thresholds per level
export function getMaxZeroCluster(level) {
  if (level <= 4) return Infinity;  // No restriction for early levels
  if (level <= 9) return 8;
  if (level <= 14) return 6;
  if (level <= 20) return 4;        // L15–20: very tight
  if (level <= 37) return 3;        // L21–37: extremely tight
  return 2;                          // L38–50: near-zero openings
}

/** Get speed rating for timed mode completion.
 *  @param {number} level 1-based timed level
 *  @param {number} time  completion time in seconds
 *  @returns {{ icon: string, name: string, tier: number }} rating info
 */
export function getSpeedRating(level, time) {
  const idx = Math.min(Math.max(level, 1), SPEED_THRESHOLDS.length) - 1;
  const t = SPEED_THRESHOLDS[idx];
  if (time <= t.diamond) return { icon: '💎', name: 'Diamond', tier: 4 };
  if (time <= t.gold)    return { icon: '🥇', name: 'Gold',    tier: 3 };
  if (time <= t.silver)  return { icon: '🥈', name: 'Silver',  tier: 2 };
  return                          { icon: '🥉', name: 'Bronze',  tier: 1 };
}

export const MAX_LEVEL = CHALLENGE_LEVELS.length;
export const MAX_TIMED_LEVEL = TIMED_LEVELS.length;
