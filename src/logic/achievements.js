// Tiered rank system — progression based on total wins
const TIERS = [
  { id: 'bronze',   icon: '🥉', name: 'Bronze',   winsRequired: 1,   color: '#cd7f32' },
  { id: 'silver',   icon: '🥈', name: 'Silver',   winsRequired: 5,   color: '#c0c0c0' },
  { id: 'gold',     icon: '🥇', name: 'Gold',     winsRequired: 15,  color: '#ffd700' },
  { id: 'platinum', icon: '💎', name: 'Platinum', winsRequired: 30,  color: '#e5e4e2' },
  { id: 'emerald',  icon: '💚', name: 'Emerald',  winsRequired: 50,  color: '#50c878' },
  { id: 'diamond',  icon: '👑', name: 'Diamond',  winsRequired: 100, color: '#b9f2ff' },
];

/**
 * Get the current tier based on total wins.
 * Returns null if no tier reached yet.
 */
export function getCurrentTier(stats) {
  let current = null;
  for (const tier of TIERS) {
    if (stats.wins >= tier.winsRequired) {
      current = tier;
    }
  }
  return current;
}

/**
 * Get the next tier to unlock.
 * Returns null if already at max tier.
 */
export function getNextTier(stats) {
  for (const tier of TIERS) {
    if (stats.wins < tier.winsRequired) {
      return tier;
    }
  }
  return null;
}

/**
 * Get all tier definitions.
 */
export function getAllTiers() {
  return TIERS;
}

/**
 * Check if a tier-up happened between previous and current wins.
 * Returns the newly reached tier, or null.
 */
export function checkTierUp(prevWins, currentWins) {
  let latest = null;
  for (const tier of TIERS) {
    if (prevWins < tier.winsRequired && currentWins >= tier.winsRequired) {
      latest = tier;
    }
  }
  return latest;
}

/**
 * Get progress info toward next tier.
 */
export function getTierProgress(stats) {
  const current = getCurrentTier(stats);
  const next = getNextTier(stats);

  if (!next) {
    return { current, next: null, progress: 1, winsToNext: 0 };
  }

  const prevThreshold = current ? current.winsRequired : 0;
  const range = next.winsRequired - prevThreshold;
  const progress = (stats.wins - prevThreshold) / range;

  return {
    current,
    next,
    progress: Math.min(1, Math.max(0, progress)),
    winsToNext: next.winsRequired - stats.wins,
  };
}
