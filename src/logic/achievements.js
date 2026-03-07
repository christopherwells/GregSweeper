// Achievement definitions and checker
const ACHIEVEMENTS = [
  { id: 'first_win',      icon: '🏅', name: 'First Victory',     desc: 'Win your first game',              check: (s) => s.wins >= 1 },
  { id: 'win_5',          icon: '⭐', name: 'Getting Good',       desc: 'Win 5 games',                      check: (s) => s.wins >= 5 },
  { id: 'win_25',         icon: '🌟', name: 'Veteran',            desc: 'Win 25 games',                     check: (s) => s.wins >= 25 },
  { id: 'win_100',        icon: '💎', name: 'GregSweeper Master', desc: 'Win 100 games',                    check: (s) => s.wins >= 100 },
  { id: 'streak_3',       icon: '🔥', name: 'On Fire',            desc: 'Win 3 games in a row',             check: (s) => s.bestStreak >= 3 },
  { id: 'streak_5',       icon: '🔥', name: 'Unstoppable',        desc: 'Win 5 games in a row',             check: (s) => s.bestStreak >= 5 },
  { id: 'streak_10',      icon: '💥', name: 'Legendary Streak',   desc: 'Win 10 games in a row',            check: (s) => s.bestStreak >= 10 },
  { id: 'speed_30',       icon: '⚡', name: 'Speed Demon',        desc: 'Win in under 30 seconds',          check: (s) => hasTimedWin(s, 30) },
  { id: 'speed_15',       icon: '🚀', name: 'Lightning Fast',     desc: 'Win in under 15 seconds',          check: (s) => hasTimedWin(s, 15) },
  { id: 'level_5',        icon: '📈', name: 'Climbing Up',        desc: 'Reach level 5',                    check: (s) => s.maxLevelReached >= 5 },
  { id: 'level_10',       icon: '👑', name: 'Summit',             desc: 'Reach level 10',                   check: (s) => s.maxLevelReached >= 10 },
  { id: 'daily_1',        icon: '📅', name: 'Daily Player',       desc: 'Complete a daily challenge',       check: (s) => s.dailiesCompleted >= 1 },
  { id: 'daily_7',        icon: '📆', name: 'Weekly Warrior',     desc: 'Complete 7 daily challenges',      check: (s) => s.dailiesCompleted >= 7 },
  { id: 'play_50',        icon: '🎮', name: 'Dedicated',          desc: 'Play 50 games',                    check: (s) => s.totalGames >= 50 },
  { id: 'no_powerup_win', icon: '💪', name: 'Purist',             desc: 'Win without using any power-ups',  check: (s) => s.puristWins >= 1 },
];

function hasTimedWin(stats, threshold) {
  return stats.recentGames.some(g => g.won && g.time <= threshold);
}

const ACHIEVEMENTS_KEY = 'minesweeper_achievements';

export function loadUnlocked() {
  try {
    return JSON.parse(localStorage.getItem(ACHIEVEMENTS_KEY)) || [];
  } catch { return []; }
}

function saveUnlocked(list) {
  localStorage.setItem(ACHIEVEMENTS_KEY, JSON.stringify(list));
}

/**
 * Check stats and return any newly unlocked achievements.
 */
export function checkAchievements(stats) {
  const unlocked = loadUnlocked();
  const newlyUnlocked = [];

  for (const ach of ACHIEVEMENTS) {
    if (unlocked.includes(ach.id)) continue;
    if (ach.check(stats)) {
      unlocked.push(ach.id);
      newlyUnlocked.push(ach);
    }
  }

  if (newlyUnlocked.length > 0) {
    saveUnlocked(unlocked);
  }

  return newlyUnlocked;
}

export function getAllAchievements() {
  return ACHIEVEMENTS;
}

export function getUnlockedCount() {
  return loadUnlocked().length;
}

export function getTotalCount() {
  return ACHIEVEMENTS.length;
}
