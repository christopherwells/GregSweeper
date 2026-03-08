const STATS_KEY = 'minesweeper_stats';
const LEADERBOARD_KEY = 'minesweeper_daily_leaderboard';
const THEME_KEY = 'minesweeper_theme';
const POWERUPS_KEY = 'minesweeper_powerups';
const LIVES_KEY = 'minesweeper_lives';

// In-memory cache for stats to avoid repeated localStorage reads + JSON.parse
let _statsCache = null;

function getJSON(key, fallback) {
  try {
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : fallback;
  } catch {
    return fallback;
  }
}

function setJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // QuotaExceededError or other storage errors — log but don't crash
    console.warn(`localStorage write failed for "${key}":`, err.message);
  }
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

// Per-mode stats structure
function createModeStats() {
  return {
    totalGames: 0,
    wins: 0,
    losses: 0,
    currentStreak: 0,
    bestStreak: 0,
    maxLevelReached: 1,
    bestTimes: {},
    recentGames: [],
  };
}

function createDefaultModeStats() {
  return {
    challenge: createModeStats(),
    timed: createModeStats(),
    fogOfWar: createModeStats(),
    daily: { ...createModeStats(), dailyStreak: 0, bestDailyStreak: 0, dailiesCompleted: 0, bombHits: 0 },
  };
}

// Per-mode power-up pools
const DEFAULT_POWERUPS = {
  challenge: { revealSafe: 0, shield: 0, scanRowCol: 0, freeze: 0, xray: 0 },
  fogOfWar:  { revealSafe: 3, shield: 3, scanRowCol: 3, decode: 0 },
  // timed: no power-ups
  // daily: fixed set (not persisted)
};

export function loadStats() {
  // Return cached version if available
  if (_statsCache) return _statsCache;

  const stats = getJSON(STATS_KEY, { ...DEFAULT_STATS });
  // Backfill new fields for existing saves
  if (stats.maxLevelReached == null) stats.maxLevelReached = 1;
  if (stats.dailiesCompleted == null) stats.dailiesCompleted = 0;
  if (stats.puristWins == null) stats.puristWins = 0;

  // Migrate: if no modeStats, seed challenge stats from existing global stats
  if (!stats.modeStats) {
    stats.modeStats = createDefaultModeStats();
    // Seed challenge mode from existing global stats
    const ch = stats.modeStats.challenge;
    ch.totalGames = stats.totalGames;
    ch.wins = stats.wins;
    ch.losses = stats.losses;
    ch.currentStreak = stats.currentStreak;
    ch.bestStreak = stats.bestStreak;
    ch.maxLevelReached = stats.maxLevelReached;
    ch.bestTimes = { ...stats.bestTimes };
    ch.recentGames = [...stats.recentGames];
    setJSON(STATS_KEY, stats);
  }

  // Backfill any missing modes
  const defaults = createDefaultModeStats();
  for (const mode of Object.keys(defaults)) {
    if (!stats.modeStats[mode]) {
      stats.modeStats[mode] = defaults[mode];
    }
  }

  _statsCache = stats;
  return stats;
}

// Map internal gameMode values to modeStats keys
function getModeKey(gameMode) {
  if (gameMode === 'normal') return 'challenge';
  return gameMode;
}

export function saveGameResult(won, time, level, { isDaily = false, usedPowerUps = false, gameMode = 'normal' } = {}) {
  const stats = loadStats();
  const modeKey = getModeKey(gameMode);
  const modeStats = stats.modeStats[modeKey];

  // Update global stats
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

  stats.recentGames.push({ won, time, level, date: new Date().toISOString(), mode: modeKey });
  if (stats.recentGames.length > 50) {
    stats.recentGames = stats.recentGames.slice(-50);
  }

  // Update per-mode stats
  if (modeStats) {
    modeStats.totalGames++;
    if (won) {
      modeStats.wins++;
      modeStats.currentStreak++;
      if (modeStats.currentStreak > modeStats.bestStreak) {
        modeStats.bestStreak = modeStats.currentStreak;
      }
      const key = `level${level}`;
      if (!modeStats.bestTimes[key] || time < modeStats.bestTimes[key]) {
        modeStats.bestTimes[key] = time;
      }
      if (level > modeStats.maxLevelReached) {
        modeStats.maxLevelReached = level;
      }
      // Daily-specific
      if (modeKey === 'daily') {
        modeStats.dailiesCompleted = (modeStats.dailiesCompleted || 0) + 1;
        modeStats.dailyStreak = (modeStats.dailyStreak || 0) + 1;
        if (modeStats.dailyStreak > (modeStats.bestDailyStreak || 0)) {
          modeStats.bestDailyStreak = modeStats.dailyStreak;
        }
      }
    } else {
      modeStats.losses++;
      modeStats.currentStreak = 0;
      if (modeKey === 'daily') {
        modeStats.dailyStreak = 0;
      }
    }

    modeStats.recentGames.push({ won, time, level, date: new Date().toISOString() });
    if (modeStats.recentGames.length > 30) {
      modeStats.recentGames = modeStats.recentGames.slice(-30);
    }
  }

  setJSON(STATS_KEY, stats);
  _statsCache = stats; // Update cache
  return stats;
}

// ── Power-Up Persistence ──────────────────────────────

export function loadPowerUps() {
  const data = getJSON(POWERUPS_KEY, null);
  if (!data) return { ...DEFAULT_POWERUPS };
  // Backfill any missing modes
  for (const mode of Object.keys(DEFAULT_POWERUPS)) {
    if (!data[mode]) {
      data[mode] = { ...DEFAULT_POWERUPS[mode] };
    }
  }
  return data;
}

export function savePowerUps(powerUps) {
  setJSON(POWERUPS_KEY, powerUps);
}

export function loadModePowerUps(gameMode) {
  const modeKey = getModeKey(gameMode);
  const all = loadPowerUps();
  if (modeKey === 'timed') return {};       // Timed: no power-ups
  if (modeKey === 'daily') return {};        // Daily: not persisted
  return all[modeKey] ? { ...all[modeKey] } : {};
}

export function saveModePowerUps(gameMode, powerUps) {
  const modeKey = getModeKey(gameMode);
  if (modeKey === 'timed' || modeKey === 'daily') return; // Don't persist
  const all = loadPowerUps();
  all[modeKey] = { ...powerUps };
  savePowerUps(all);
}

// ── Leaderboard ───────────────────────────────────────

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

// ── Theme ─────────────────────────────────────────────

export function loadTheme() {
  return localStorage.getItem(THEME_KEY) || 'classic';
}

export function saveTheme(theme) {
  localStorage.setItem(THEME_KEY, theme);
}

// ── Lives Persistence ─────────────────────────────────

const DEFAULT_LIVES = { challenge: 0, fogOfWar: 0 };

export function loadModeLives(gameMode) {
  const modeKey = getModeKey(gameMode);
  if (modeKey !== 'challenge' && modeKey !== 'fogOfWar') return 0;
  const data = getJSON(LIVES_KEY, null);
  if (!data) return 0;
  return data[modeKey] || 0;
}

export function saveModeLives(gameMode, count) {
  const modeKey = getModeKey(gameMode);
  if (modeKey !== 'challenge' && modeKey !== 'fogOfWar') return;
  const data = getJSON(LIVES_KEY, { ...DEFAULT_LIVES });
  data[modeKey] = count;
  setJSON(LIVES_KEY, data);
}

// ── Checkpoint Storage ──────────────────────────────
const CHECKPOINT_KEY = 'minesweeper_checkpoints';

export function loadCheckpoint(gameMode) {
  const data = getJSON(CHECKPOINT_KEY) || {};
  return data[gameMode] || 1; // default checkpoint is level 1
}

export function saveCheckpoint(gameMode, level) {
  const data = getJSON(CHECKPOINT_KEY) || {};
  data[gameMode] = level;
  setJSON(CHECKPOINT_KEY, data);
}

// ── Game State Persistence ──────────────────────────
const GAME_STATE_KEY = 'minesweeper_game_state';

export function saveGameState(gameState) {
  setJSON(GAME_STATE_KEY, gameState);
}

export function loadGameState() {
  return getJSON(GAME_STATE_KEY);
}

export function clearGameState() {
  try {
    localStorage.removeItem(GAME_STATE_KEY);
  } catch (e) {
    // ignore
  }
}

// ── Reset ─────────────────────────────────────────────

export function resetStats() {
  const freshStats = { ...DEFAULT_STATS, modeStats: createDefaultModeStats() };
  setJSON(STATS_KEY, freshStats);
  _statsCache = freshStats; // Update cache with fresh stats
  setJSON(POWERUPS_KEY, { ...DEFAULT_POWERUPS });
  setJSON(LIVES_KEY, { ...DEFAULT_LIVES });
  localStorage.removeItem(LEADERBOARD_KEY);
  localStorage.removeItem(CHECKPOINT_KEY);
  localStorage.removeItem(GAME_STATE_KEY);
}

/**
 * Invalidate the in-memory stats cache so the next loadStats()
 * re-reads from localStorage. Use when external code modifies
 * stats directly in localStorage.
 */
export function invalidateStatsCache() {
  _statsCache = null;
}

// ── Onboarding ──────────────────────────────────────
const ONBOARDING_KEY = 'minesweeper_onboarded';

export function isOnboarded() {
  return localStorage.getItem(ONBOARDING_KEY) === 'true';
}

export function setOnboarded() {
  try {
    localStorage.setItem(ONBOARDING_KEY, 'true');
  } catch (e) {
    // ignore
  }
}
