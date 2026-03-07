const LEVELS = [
  { rows: 10, cols: 10, mines: 10 },
  { rows: 10, cols: 10, mines: 13 },
  { rows: 10, cols: 10, mines: 16 },
  { rows: 12, cols: 12, mines: 22 },
  { rows: 12, cols: 12, mines: 28 },
  { rows: 14, cols: 14, mines: 35 },
  { rows: 14, cols: 14, mines: 42 },
  { rows: 16, cols: 16, mines: 50 },
  { rows: 16, cols: 16, mines: 56 },
  { rows: 16, cols: 16, mines: 62 },
];

export function getDifficultyForLevel(level) {
  const capped = Math.min(Math.max(level, 1), LEVELS.length);
  return { ...LEVELS[capped - 1] };
}

export const MAX_LEVEL = LEVELS.length;
