const LEVELS = [
  { rows: 10, cols: 10, mines: 10, timeLimit: 120 },
  { rows: 10, cols: 10, mines: 13, timeLimit: 140 },
  { rows: 10, cols: 10, mines: 16, timeLimit: 160 },
  { rows: 12, cols: 12, mines: 22, timeLimit: 200 },
  { rows: 12, cols: 12, mines: 28, timeLimit: 230 },
  { rows: 14, cols: 14, mines: 35, timeLimit: 280 },
  { rows: 14, cols: 14, mines: 42, timeLimit: 320 },
  { rows: 16, cols: 16, mines: 50, timeLimit: 380 },
  { rows: 16, cols: 16, mines: 56, timeLimit: 420 },
  { rows: 16, cols: 16, mines: 62, timeLimit: 480 },
];

export function getDifficultyForLevel(level) {
  const capped = Math.min(Math.max(level, 1), LEVELS.length);
  return { ...LEVELS[capped - 1] };
}

export const MAX_LEVEL = LEVELS.length;
