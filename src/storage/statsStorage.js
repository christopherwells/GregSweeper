const STATS_KEY = 'minesweeper_stats';
const LEADERBOARD_KEY = 'minesweeper_daily_leaderboard';
const THEME_KEY = 'minesweeper_theme';

function getJSON(key, fallback) {
  try {
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : fallback;
  } catch {
    return fallback;
  }
}

function setJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

const DEFAULT_STATS = {
  totalGames: 0,
  wins: 0,
  losses: 0,
  currentStreak: 0,
  bestStreak: 0,
  bestTimes: {},
  recentGames: [],
  maxLevelReached: 1,
  dailiesCompleted: 0,
  puristWins: 0,
};

export function loadStats() {
  const stats = getJSON(STATS_KEY, { ...DEFAULT_STATS });
  // Backfill new fields for existing saves
  if (stats.maxLevelReached == null) stats.maxLevelReached = 1;
  if (stats.dailiesCompleted == null) stats.dailiesCompleted = 0;
  if (stats.puristWins == null) stats.puristWins = 0;
  return stats;
}

export function saveGameResult(won, time, level, { isDaily = false, usedPowerUps = false } = {}) {
  const stats = loadStats();
  stats.totalGames++;
  if (won) {
    stats.wins++;
    stats.currentStreak++;
    if (stats.currentStreak > stats.bestStreak) {
      stats.bestStreak = stats.currentStreak;
    }
    const key = `level${level}`;
    if (!stats.bestTimes[key] || time < stats.bestTimes[key]) {
      stats.bestTimes[key] = time;
    }
    if (level > stats.maxLevelReached) {
      stats.maxLevelReached = level;
    }
    if (isDaily) {
      stats.dailiesCompleted++;
    }
    if (!usedPowerUps) {
      stats.puristWins++;
    }
  } else {
    stats.losses++;
    stats.currentStreak = 0;
  }

  stats.recentGames.push({ won, time, level, date: new Date().toISOString() });
  if (stats.recentGames.length > 50) {
    stats.recentGames = stats.recentGames.slice(-50);
  }

  setJSON(STATS_KEY, stats);
  return stats;
}

export function loadDailyLeaderboard(dateString) {
  const all = getJSON(LEADERBOARD_KEY, {});
  return all[dateString] || [];
}

export function addDailyLeaderboardEntry(dateString, name, time) {
  const all = getJSON(LEADERBOARD_KEY, {});
  if (!all[dateString]) all[dateString] = [];
  all[dateString].push({ name, time, timestamp: Date.now() });
  all[dateString].sort((a, b) => a.time - b.time);
  setJSON(LEADERBOARD_KEY, all);
  return all[dateString];
}

export function loadTheme() {
  return localStorage.getItem(THEME_KEY) || 'classic';
}

export function saveTheme(theme) {
  localStorage.setItem(THEME_KEY, theme);
}
