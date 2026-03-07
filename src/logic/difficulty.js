const LEVELS = [
  { rows: 10, cols: 10, mines: 10, timeLimit: 120 },   // Level 1
  { rows: 11, cols: 11, mines: 14, timeLimit: 140 },   // Level 2
  { rows: 12, cols: 12, mines: 19, timeLimit: 160 },   // Level 3
  { rows: 13, cols: 13, mines: 24, timeLimit: 190 },   // Level 4
  { rows: 14, cols: 14, mines: 30, timeLimit: 220 },   // Level 5
  { rows: 15, cols: 15, mines: 37, timeLimit: 260 },   // Level 6
  { rows: 16, cols: 16, mines: 44, timeLimit: 300 },   // Level 7
  { rows: 17, cols: 17, mines: 52, timeLimit: 350 },   // Level 8
  { rows: 18, cols: 18, mines: 60, timeLimit: 400 },   // Level 9
  { rows: 19, cols: 19, mines: 68, timeLimit: 460 },   // Level 10
];

export function getDifficultyForLevel(level) {
  const capped = Math.min(Math.max(level, 1), LEVELS.length);
  return { ...LEVELS[capped - 1] };
}

export const MAX_LEVEL = LEVELS.length;
