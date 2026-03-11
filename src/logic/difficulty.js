// Challenge mode — 100 levels of progressive difficulty
// Boards grow from 5×5 up to 14×14. Timer is informational only (no countdown).
// Difficulty increases via mine density, grid size, and zero-cluster limits.
// Gimmicks are introduced at checkpoints starting at L11.
const CHALLENGE_LEVELS = [
  // Tutorial (L1–5): 5×5 → 7×7, very low density
  { rows: 5,  cols: 5,  mines: 2  },  // L1  — 8.0%
  { rows: 6,  cols: 6,  mines: 4  },  // L2  — 11.1%
  { rows: 6,  cols: 6,  mines: 5  },  // L3  — 13.9%
  { rows: 7,  cols: 7,  mines: 5  },  // L4  — 10.2%
  { rows: 7,  cols: 7,  mines: 6  },  // L5  — 12.2%

  // Learning (L6–10): 7×7 → 9×9, density 14–16%
  { rows: 7,  cols: 7,  mines: 7  },  // L6  — 14.3%
  { rows: 8,  cols: 8,  mines: 8  },  // L7  — 12.5%
  { rows: 8,  cols: 8,  mines: 10 },  // L8  — 15.6%
  { rows: 9,  cols: 9,  mines: 11 },  // L9  — 13.6%
  { rows: 9,  cols: 9,  mines: 13 },  // L10 — 16.0%

  // Intermediate (L11–20): 10×10, density 15–22%
  { rows: 10, cols: 10, mines: 16 },  // L11 — 16.0%
  { rows: 10, cols: 10, mines: 17 },  // L12 — 17.0%
  { rows: 10, cols: 10, mines: 18 },  // L13 — 18.0%
  { rows: 10, cols: 10, mines: 19 },  // L14 — 19.0%
  { rows: 10, cols: 10, mines: 20 },  // L15 — 20.0%
  { rows: 10, cols: 10, mines: 20 },  // L16 — 20.0%
  { rows: 10, cols: 10, mines: 21 },  // L17 — 21.0%
  { rows: 10, cols: 10, mines: 21 },  // L18 — 21.0%
  { rows: 10, cols: 10, mines: 22 },  // L19 — 22.0%
  { rows: 10, cols: 10, mines: 22 },  // L20 — 22.0%

  // Advanced (L21–40): 11×11 → 12×12, density 22–30%
  { rows: 11, cols: 11, mines: 27 },  // L21 — 22.3%
  { rows: 11, cols: 11, mines: 28 },  // L22 — 23.1%
  { rows: 11, cols: 11, mines: 29 },  // L23 — 24.0%
  { rows: 11, cols: 11, mines: 30 },  // L24 — 24.8%
  { rows: 11, cols: 11, mines: 31 },  // L25 — 25.6%
  { rows: 11, cols: 11, mines: 32 },  // L26 — 26.4%
  { rows: 11, cols: 11, mines: 33 },  // L27 — 27.3%
  { rows: 11, cols: 11, mines: 34 },  // L28 — 28.1%
  { rows: 11, cols: 11, mines: 35 },  // L29 — 28.9%
  { rows: 11, cols: 11, mines: 36 },  // L30 — 29.8%
  { rows: 12, cols: 12, mines: 36 },  // L31 — 25.0%
  { rows: 12, cols: 12, mines: 37 },  // L32 — 25.7%
  { rows: 12, cols: 12, mines: 38 },  // L33 — 26.4%
  { rows: 12, cols: 12, mines: 39 },  // L34 — 27.1%
  { rows: 12, cols: 12, mines: 40 },  // L35 — 27.8%
  { rows: 12, cols: 12, mines: 41 },  // L36 — 28.5%
  { rows: 12, cols: 12, mines: 42 },  // L37 — 29.2%
  { rows: 12, cols: 12, mines: 43 },  // L38 — 29.9%
  { rows: 12, cols: 12, mines: 43 },  // L39 — 29.9%
  { rows: 12, cols: 12, mines: 44 },  // L40 — 30.6%

  // Expert (L41–60): 12×12 → 13×13, density 30–33%
  { rows: 12, cols: 12, mines: 44 },  // L41 — 30.6%
  { rows: 12, cols: 12, mines: 45 },  // L42 — 31.3%
  { rows: 12, cols: 12, mines: 45 },  // L43 — 31.3%
  { rows: 12, cols: 12, mines: 46 },  // L44 — 31.9%
  { rows: 12, cols: 12, mines: 46 },  // L45 — 31.9%
  { rows: 12, cols: 12, mines: 47 },  // L46 — 32.6%
  { rows: 12, cols: 12, mines: 47 },  // L47 — 32.6%
  { rows: 12, cols: 12, mines: 48 },  // L48 — 33.3%
  { rows: 12, cols: 12, mines: 48 },  // L49 — 33.3%
  { rows: 13, cols: 13, mines: 50 },  // L50 — 29.6%
  { rows: 13, cols: 13, mines: 51 },  // L51 — 30.2%
  { rows: 13, cols: 13, mines: 52 },  // L52 — 30.8%
  { rows: 13, cols: 13, mines: 53 },  // L53 — 31.4%
  { rows: 13, cols: 13, mines: 53 },  // L54 — 31.4%
  { rows: 13, cols: 13, mines: 54 },  // L55 — 32.0%
  { rows: 13, cols: 13, mines: 54 },  // L56 — 32.0%
  { rows: 13, cols: 13, mines: 55 },  // L57 — 32.5%
  { rows: 13, cols: 13, mines: 55 },  // L58 — 32.5%
  { rows: 13, cols: 13, mines: 56 },  // L59 — 33.1%
  { rows: 13, cols: 13, mines: 56 },  // L60 — 33.1%

  // Legendary (L61–80): 13×13 → 14×14, density 30–36%
  { rows: 13, cols: 13, mines: 57 },  // L61 — 33.7%
  { rows: 13, cols: 13, mines: 57 },  // L62 — 33.7%
  { rows: 13, cols: 13, mines: 58 },  // L63 — 34.3%
  { rows: 13, cols: 13, mines: 58 },  // L64 — 34.3%
  { rows: 13, cols: 13, mines: 59 },  // L65 — 34.9%
  { rows: 13, cols: 13, mines: 59 },  // L66 — 34.9%
  { rows: 13, cols: 13, mines: 60 },  // L67 — 35.5%
  { rows: 13, cols: 13, mines: 60 },  // L68 — 35.5%
  { rows: 14, cols: 14, mines: 60 },  // L69 — 30.6%
  { rows: 14, cols: 14, mines: 61 },  // L70 — 31.1%
  { rows: 14, cols: 14, mines: 62 },  // L71 — 31.6%
  { rows: 14, cols: 14, mines: 63 },  // L72 — 32.1%
  { rows: 14, cols: 14, mines: 64 },  // L73 — 32.7%
  { rows: 14, cols: 14, mines: 65 },  // L74 — 33.2%
  { rows: 14, cols: 14, mines: 65 },  // L75 — 33.2%
  { rows: 14, cols: 14, mines: 66 },  // L76 — 33.7%
  { rows: 14, cols: 14, mines: 66 },  // L77 — 33.7%
  { rows: 14, cols: 14, mines: 67 },  // L78 — 34.2%
  { rows: 14, cols: 14, mines: 67 },  // L79 — 34.2%
  { rows: 14, cols: 14, mines: 68 },  // L80 — 34.7%

  // Mythic (L81–100): 14×14, density 34–38%
  // Smoothed ramp: no plateau longer than 3 levels, steady climb to L100
  { rows: 14, cols: 14, mines: 68 },  // L81 — 34.7%
  { rows: 14, cols: 14, mines: 68 },  // L82 — 34.7%
  { rows: 14, cols: 14, mines: 69 },  // L83 — 35.2%
  { rows: 14, cols: 14, mines: 69 },  // L84 — 35.2%
  { rows: 14, cols: 14, mines: 69 },  // L85 — 35.2%
  { rows: 14, cols: 14, mines: 70 },  // L86 — 35.7%
  { rows: 14, cols: 14, mines: 70 },  // L87 — 35.7%
  { rows: 14, cols: 14, mines: 71 },  // L88 — 36.2%
  { rows: 14, cols: 14, mines: 71 },  // L89 — 36.2%
  { rows: 14, cols: 14, mines: 71 },  // L90 — 36.2%
  { rows: 14, cols: 14, mines: 72 },  // L91 — 36.7%
  { rows: 14, cols: 14, mines: 72 },  // L92 — 36.7%
  { rows: 14, cols: 14, mines: 73 },  // L93 — 37.2%
  { rows: 14, cols: 14, mines: 73 },  // L94 — 37.2%
  { rows: 14, cols: 14, mines: 73 },  // L95 — 37.2%
  { rows: 14, cols: 14, mines: 74 },  // L96 — 37.8%
  { rows: 14, cols: 14, mines: 74 },  // L97 — 37.8%
  { rows: 14, cols: 14, mines: 75 },  // L98 — 38.3%
  { rows: 14, cols: 14, mines: 75 },  // L99 — 38.3%
  { rows: 14, cols: 14, mines: 75 },  // L100 — 38.3%
];

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
  if (level <= 5) return Infinity;   // Tutorial: no restriction
  if (level <= 10) return 10;
  if (level <= 20) return 8;
  if (level <= 30) return 6;
  if (level <= 50) return 4;
  if (level <= 70) return 3;
  return 2;                          // L71–100: near-zero openings
}

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
