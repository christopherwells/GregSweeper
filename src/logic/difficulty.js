// Challenge mode — 20 levels of progressive difficulty
// Board capped at 12×12 to prevent fat-finger issues on mobile.
// Difficulty increases via mine density (~12% at L1 → ~35% at L20).
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

  // Expert (L16–20): 12×12, density 30–35% (nearly impossible)
  { rows: 12, cols: 12, mines: 45, timeLimit: 320 },   // L16 — 31.3%
  { rows: 12, cols: 12, mines: 47, timeLimit: 340 },   // L17 — 32.6%
  { rows: 12, cols: 12, mines: 48, timeLimit: 360 },   // L18 — 33.3%
  { rows: 12, cols: 12, mines: 49, timeLimit: 380 },   // L19 — 34.0%
  { rows: 12, cols: 12, mines: 50, timeLimit: 400 },   // L20 — 34.7%
];

// Timed mode — classic Minesweeper sizes (Beginner, Intermediate, Expert)
const TIMED_LEVELS = [
  { rows: 9,  cols: 9,  mines: 10,  timeLimit: 90,  label: 'Beginner' },
  { rows: 16, cols: 16, mines: 40,  timeLimit: 300, label: 'Intermediate' },
  { rows: 16, cols: 30, mines: 99,  timeLimit: 600, label: 'Expert' },
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
  return 4;                          // L15+: very tight
}

export const MAX_LEVEL = CHALLENGE_LEVELS.length;
export const MAX_TIMED_LEVEL = TIMED_LEVELS.length;
