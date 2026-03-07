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
};

export function loadStats() {
  return getJSON(STATS_KEY, { ...DEFAULT_STATS });
}

export function saveGameResult(won, time, level) {
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
