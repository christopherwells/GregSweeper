// Multi-tier achievement system
// Each achievement category has 5 tiers: bronze → silver → gold → emerald → diamond
// One drawn medal per tier. Platinum was dropped (2026-06-23) so the
// ladder matches the five-medal set — no more ⭐ emoji fallback.

const TIER_NAMES = ['bronze', 'silver', 'gold', 'emerald', 'diamond'];
const TIER_ICONS = {
  bronze:   '🥉',
  silver:   '🥈',
  gold:     '🥇',
  emerald:  '💚',
  diamond:  '💎',
};
const TIER_COLORS = {
  bronze:   '#cd7f32',
  silver:   '#c0c0c0',
  gold:     '#ffd700',
  emerald:  '#50c878',
  diamond:  '#b9f2ff',
};

// Two groups, rendered as separate sections:
//   'feat'     — engine-certified skill (the identity: what you DID)
//   'progress' — accumulation and bests
const CATEGORIES = [
  {
    id: 'wins',
    name: 'Victory',
    icon: '🏆',
    group: 'progress',
    desc: 'Total wins',
    thresholds: [1, 5, 25, 100, 200],
    getValue: (s) => s.wins,
    format: (v) => `${v} win${v !== 1 ? 's' : ''}`,
  },
  {
    id: 'streak',
    name: 'On Fire',
    icon: '🔥',
    group: 'progress',
    desc: 'Best win streak',
    thresholds: [3, 5, 10, 25, 50],
    getValue: (s) => s.bestStreak,
    format: (v) => `${v} streak`,
  },
  {
    id: 'speed',
    name: 'Speed Demon',
    icon: '⚡',
    group: 'progress',
    desc: 'Fastest win',
    thresholds: [60, 45, 30, 15, 10],
    getValue: (s) => {
      const wins = (s.recentGames || []).filter(g => g.won);
      if (wins.length === 0) return Infinity;
      return Math.min(...wins.map(g => g.time));
    },
    format: (v) => `Under ${v}s`,
    inverted: true, // lower is better
  },
  {
    id: 'daily',
    name: 'Daily Player',
    icon: '📅',
    group: 'progress',
    desc: 'Daily challenges completed',
    thresholds: [1, 5, 10, 30, 50],
    getValue: (s) => s.dailiesCompleted || 0,
    format: (v) => `${v} daily${v !== 1 ? 's' : ''}`,
  },
  // ── Skill feats (2026-06-10 rebuild) ────────────────
  // Honestly detectable from the click timeline + the board's CERTIFIED
  // solve — never heuristics. "Survivor" (total wins, duplicate of
  // Victory) and "Dedicated" (total games, pure attendance) were cut to
  // make room: an achievement should certify something the player DID,
  // not how long they've been around.
  {
    id: 'flagless',
    name: 'Flagless',
    icon: '🏳️',
    group: 'feat',
    desc: 'Wins without placing a single flag',
    thresholds: [1, 5, 15, 50, 100],
    getValue: (s) => s.flaglessWins || 0,
    format: (v) => `${v} flagless win${v !== 1 ? 's' : ''}`,
  },
  {
    id: 'efficient',
    name: 'No Wasted Clicks',
    icon: '🎯',
    group: 'feat',
    desc: 'Wins matching the certified solve’s click count',
    thresholds: [1, 5, 15, 50, 100],
    getValue: (s) => s.efficientWins || 0,
    format: (v) => `${v} efficient win${v !== 1 ? 's' : ''}`,
  },
  {
    id: 'tankCommander',
    name: 'Tank Commander',
    icon: '🧮',
    group: 'feat',
    desc: 'Wins on boards that provably require search reasoning',
    thresholds: [1, 3, 10, 35, 60],
    getValue: (s) => s.searchWins || 0,
    format: (v) => `${v} search win${v !== 1 ? 's' : ''}`,
  },
  {
    id: 'lieDetector',
    name: 'Lie Detector',
    icon: '🕵️',
    group: 'feat',
    desc: 'Wins on boards that provably require liar reasoning',
    thresholds: [1, 3, 8, 25, 50],
    getValue: (s) => s.liarWins || 0,
    format: (v) => `${v} liar win${v !== 1 ? 's' : ''}`,
  },
  {
    id: 'purist',
    name: 'Fearless',
    icon: '💪',
    group: 'feat',
    desc: 'Wins without power-ups',
    thresholds: [1, 5, 15, 50, 100],
    getValue: (s) => s.puristWins || 0,
    format: (v) => `${v} unaided win${v !== 1 ? 's' : ''}`,
  },
  // ── Mode-Specific Achievements ──────────────────────
  {
    id: 'challengeClimber',
    name: 'Challenger',
    icon: '⛏️',
    group: 'progress',
    desc: 'Challenge level reached',
    thresholds: [10, 25, 50, 100, 120],
    getValue: (s) => (s.modeStats?.challenge?.maxLevelReached) || (s.maxLevelReached || 1),
    format: (v) => `Level ${v}`,
  },
  {
    id: 'timedSpeed',
    name: 'Speedrunner',
    icon: '⏱️',
    group: 'progress',
    desc: 'Best timed win',
    thresholds: [120, 90, 60, 25, 15],
    getValue: (s) => {
      const timed = s.modeStats?.timed;
      if (!timed) return Infinity;
      const wins = (timed.recentGames || []).filter(g => g.won);
      if (wins.length === 0) return Infinity;
      return Math.min(...wins.map(g => g.time));
    },
    format: (v) => `Under ${v}s`,
    inverted: true,
  },
  {
    id: 'gimmickMaster',
    name: 'Modifier Master',
    icon: '🎪',
    group: 'progress',
    desc: 'Beat levels with modifiers active',
    thresholds: [1, 5, 15, 50, 100],
    getValue: (s) => s.gimmickWins || 0,
    format: (v) => `${v} modifier win${v !== 1 ? 's' : ''}`,
  },
  {
    id: 'dailyStreak',
    name: 'Daily Devotee',
    icon: '📆',
    group: 'progress',
    desc: 'Daily challenge streak',
    thresholds: [3, 7, 14, 30, 60],
    getValue: (s) => s.modeStats?.daily?.bestDailyStreak || 0,
    format: (v) => `${v} day${v !== 1 ? 's' : ''}`,
  },
];

/**
 * Get the current tier index (0-5) for a category, or -1 if none unlocked.
 */
function getCategoryTierIndex(category, stats) {
  const value = category.getValue(stats);
  let tierIdx = -1;
  for (let i = 0; i < category.thresholds.length; i++) {
    if (category.inverted ? value <= category.thresholds[i] : value >= category.thresholds[i]) {
      tierIdx = i;
    }
  }
  return tierIdx;
}

/**
 * Get all categories with their current state.
 */
export function getAchievementState(stats) {
  return CATEGORIES.map(cat => {
    const tierIdx = getCategoryTierIndex(cat, stats);
    const currentTier = tierIdx >= 0 ? TIER_NAMES[tierIdx] : null;
    const nextTierIdx = tierIdx + 1;
    const hasNextTier = nextTierIdx < TIER_NAMES.length;

    let progress = 0;
    let nextValue = null;
    if (hasNextTier) {
      const value = cat.getValue(stats);
      const currentThreshold = tierIdx >= 0 ? cat.thresholds[tierIdx] : 0;
      const nextThreshold = cat.thresholds[nextTierIdx];

      if (cat.inverted) {
        // For inverted (lower-is-better): progress is how close to next threshold
        const range = currentThreshold - nextThreshold;
        progress = range > 0 ? Math.max(0, Math.min(1, (currentThreshold - value) / range)) : 0;
      } else {
        const range = nextThreshold - (tierIdx >= 0 ? currentThreshold : 0);
        progress = range > 0 ? Math.max(0, Math.min(1, (value - (tierIdx >= 0 ? currentThreshold : 0)) / range)) : 0;
      }
      nextValue = nextThreshold;
    }

    return {
      ...cat,
      value: cat.getValue(stats),
      tierIndex: tierIdx,
      currentTier,
      currentTierIcon: currentTier ? TIER_ICONS[currentTier] : '🔒',
      currentTierColor: currentTier ? TIER_COLORS[currentTier] : '#666',
      nextTier: hasNextTier ? TIER_NAMES[nextTierIdx] : null,
      nextTierIcon: hasNextTier ? TIER_ICONS[TIER_NAMES[nextTierIdx]] : null,
      nextValue,
      progress,
      totalUnlocked: tierIdx + 1,
    };
  });
}

/**
 * Get total achievement score (sum of all tier levels).
 */
export function getTotalScore(stats) {
  let total = 0;
  let max = 0;
  for (const cat of CATEGORIES) {
    total += getCategoryTierIndex(cat, stats) + 1;
    max += TIER_NAMES.length;
  }
  return { total: Math.max(0, total), max };
}

/**
 * Check for newly unlocked tiers after a game.
 * Compares previous stats to current stats.
 */
export function checkNewUnlocks(prevStats, currentStats) {
  const newUnlocks = [];
  for (const cat of CATEGORIES) {
    const prevTier = getCategoryTierIndex(cat, prevStats);
    const currTier = getCategoryTierIndex(cat, currentStats);
    if (currTier > prevTier) {
      // One or more tiers unlocked
      for (let i = prevTier + 1; i <= currTier; i++) {
        newUnlocks.push({
          category: cat.name,
          categoryId: cat.id,
          categoryIcon: cat.icon,
          tier: TIER_NAMES[i],
          tierIcon: TIER_ICONS[TIER_NAMES[i]],
          tierColor: TIER_COLORS[TIER_NAMES[i]],
        });
      }
    }
  }
  return newUnlocks;
}

/**
 * Get the highest tier achieved across all categories.
 */
export function getHighestTier(stats) {
  let best = -1;
  for (const cat of CATEGORIES) {
    const idx = getCategoryTierIndex(cat, stats);
    if (idx > best) best = idx;
  }
  return best >= 0 ? { name: TIER_NAMES[best], icon: TIER_ICONS[TIER_NAMES[best]] } : null;
}

export function getAllTierNames() {
  return TIER_NAMES;
}

export function getTierIcon(tierName) {
  return TIER_ICONS[tierName] || '🔒';
}

export function getTierColor(tierName) {
  return TIER_COLORS[tierName] || '#666';
}
