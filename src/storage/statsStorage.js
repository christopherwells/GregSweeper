import { safeGet, safeSet, safeRemove, safeGetJSON, safeSetJSON } from './storageAdapter.js';
import { getLocalDateString } from '../logic/seededRandom.js';

const STATS_KEY = 'minesweeper_stats';
const LEADERBOARD_KEY = 'minesweeper_daily_leaderboard';
const DAILY_PAR_KEY_PREFIX = 'minesweeper_daily_par_';
const DAILY_MOVES_KEY_PREFIX = 'minesweeper_daily_moves_';
const DAILY_FEATURES_KEY_PREFIX = 'minesweeper_daily_features_';
const THEME_KEY = 'minesweeper_theme';

export function saveDailyPar(dateStr, par, moves, features) {
  safeSet(DAILY_PAR_KEY_PREFIX + dateStr, String(par));
  safeSet(DAILY_MOVES_KEY_PREFIX + dateStr, String(moves));
  if (features && typeof features === 'object') {
    safeSetJSON(DAILY_FEATURES_KEY_PREFIX + dateStr, features);
  }
}

export function loadDailyPar(dateStr) {
  const par = parseFloat(safeGet(DAILY_PAR_KEY_PREFIX + dateStr)) || 0;
  const moves = parseInt(safeGet(DAILY_MOVES_KEY_PREFIX + dateStr)) || 0;
  const features = safeGetJSON(DAILY_FEATURES_KEY_PREFIX + dateStr, null);
  return { par, moves, features };
}
const POWERUPS_KEY = 'minesweeper_powerups';
const LIVES_KEY = 'minesweeper_lives';
const PLAYER_NAME_KEY = 'minesweeper_player_name';
const LAST_SEEN_VERSION_KEY = 'minesweeper_last_seen_version';

// In-memory cache for stats to avoid repeated reads + JSON.parse
let _statsCache = null;

function getJSON(key, fallback) {
  return safeGetJSON(key, fallback);
}

function setJSON(key, value) {
  safeSetJSON(key, value);
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
  gimmickWins: 0,
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
    skillTrainer: createModeStats(),
    daily: { ...createModeStats(), dailyStreak: 0, bestDailyStreak: 0, dailiesCompleted: 0, bombHits: 0, lastDailyCompletedDate: null },
    chaos: { ...createModeStats(), bestRun: 0, totalRuns: 0 },
  };
}

// Per-mode power-up pools
const DEFAULT_POWERUPS = {
  challenge: { revealSafe: 0, shield: 0, lifeline: 0, scanRowCol: 0, magnet: 0, xray: 0 },
};

export function loadStats() {
  // Return cached version if available
  if (_statsCache) return _statsCache;

  const stats = getJSON(STATS_KEY, { ...DEFAULT_STATS });
  // Backfill new fields for existing saves
  if (stats.maxLevelReached == null) stats.maxLevelReached = 1;
  if (stats.dailiesCompleted == null) stats.dailiesCompleted = 0;
  if (stats.puristWins == null) stats.puristWins = 0;
  if (stats.gimmickWins == null) stats.gimmickWins = 0;

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

export function saveGameResult(won, time, level, { isDaily = false, usedPowerUps = false, gameMode = 'normal', hadGimmicks = false, dailySeed = null } = {}) {
  const stats = loadStats();
  const modeKey = getModeKey(gameMode);
  const modeStats = stats.modeStats[modeKey];

  // Update global stats (chaos mode is tracked per-mode only — skip global streak/bestTimes/purist)
  const isChaos = modeKey === 'chaos';
  stats.totalGames++;
  if (won) {
    stats.wins++;
    if (!isChaos) {
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
      if (!usedPowerUps) {
        stats.puristWins++;
      }
      if (hadGimmicks) {
        stats.gimmickWins = (stats.gimmickWins || 0) + 1;
      }
    }
    if (isDaily) {
      stats.dailiesCompleted++;
    }
  } else {
    stats.losses++;
    if (!isChaos) {
      stats.currentStreak = 0;
    }
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
      // Daily-specific: consecutive-day streak validation
      if (modeKey === 'daily') {
        modeStats.dailiesCompleted = (modeStats.dailiesCompleted || 0) + 1;
        // Use the puzzle's seed date (not current date) to avoid midnight-crossing bugs
        const today = dailySeed || getLocalDateString();
        const lastDate = modeStats.lastDailyCompletedDate;
        if (lastDate) {
          const last = new Date(lastDate + 'T00:00:00');
          const now = new Date(today + 'T00:00:00');
          const diffDays = Math.round((now - last) / 86400000);
          if (diffDays === 1) {
            // Consecutive day — increment streak
            modeStats.dailyStreak = (modeStats.dailyStreak || 0) + 1;
          } else if (diffDays === 0) {
            // Same day — don't change streak (already counted)
          } else {
            // Gap — reset streak
            modeStats.dailyStreak = 1;
          }
        } else {
          modeStats.dailyStreak = 1;
        }
        modeStats.lastDailyCompletedDate = today;
        if (modeStats.dailyStreak > (modeStats.bestDailyStreak || 0)) {
          modeStats.bestDailyStreak = modeStats.dailyStreak;
        }
      }
    } else {
      modeStats.losses++;
      modeStats.currentStreak = 0;
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
  return safeGet(THEME_KEY) || 'classic';
}

export function saveTheme(theme) {
  safeSet(THEME_KEY, theme);
}

// ── Lives Persistence ─────────────────────────────────

const DEFAULT_LIVES = { challenge: 0 };

export function loadModeLives(gameMode) {
  const modeKey = getModeKey(gameMode);
  if (modeKey !== 'challenge') return 0;
  const data = getJSON(LIVES_KEY, null);
  if (!data) return 0;
  return data[modeKey] || 0;
}

export function saveModeLives(gameMode, count) {
  const modeKey = getModeKey(gameMode);
  if (modeKey !== 'challenge') return;
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

// ── Per-Mode Game State Persistence ─────────────────
const GAME_STATE_PREFIX = 'minesweeper_game_state_';
const LEGACY_GAME_STATE_KEY = 'minesweeper_game_state';

function gameStateKey(mode) {
  const modeKey = mode === 'normal' ? 'challenge' : mode;
  return GAME_STATE_PREFIX + modeKey;
}

export function saveGameState(gameState) {
  const key = gameStateKey(gameState.gameMode || 'normal');
  setJSON(key, gameState);
}

export function loadGameState(mode) {
  if (mode) {
    return getJSON(gameStateKey(mode));
  }
  // No mode specified — try legacy key and migrate
  const legacy = getJSON(LEGACY_GAME_STATE_KEY);
  if (legacy) {
    const m = legacy.gameMode || 'normal';
    setJSON(gameStateKey(m), legacy);
    safeRemove(LEGACY_GAME_STATE_KEY);
    return legacy;
  }
  return null;
}

export function clearGameState(mode) {
  if (mode) {
    safeRemove(gameStateKey(mode));
  } else {
    // Clear all mode states (used by reset)
    for (const m of ['challenge', 'timed', 'daily', 'skillTrainer', 'chaos']) {
      safeRemove(gameStateKey(m));
    }
    safeRemove(LEGACY_GAME_STATE_KEY);
  }
}

// ── Reset ─────────────────────────────────────────────

export function resetStats() {
  const freshStats = { ...DEFAULT_STATS, modeStats: createDefaultModeStats() };
  setJSON(STATS_KEY, freshStats);
  _statsCache = freshStats; // Update cache with fresh stats
  setJSON(POWERUPS_KEY, { ...DEFAULT_POWERUPS });
  setJSON(LIVES_KEY, { ...DEFAULT_LIVES });
  safeRemove(LEADERBOARD_KEY);
  safeRemove(CHECKPOINT_KEY);
  clearGameState(); // clears all mode states
}

/**
 * Invalidate the in-memory stats cache so the next loadStats()
 * re-reads from localStorage. Use when external code modifies
 * stats directly in localStorage.
 */
export function invalidateStatsCache() {
  _statsCache = null;
}

// ── Daily Completion Tracking ────────────────────────
const DAILY_COMPLETED_KEY = 'minesweeper_daily_completed_date';

export function isDailyCompleted(dateStr) {
  return safeGet(DAILY_COMPLETED_KEY) === dateStr;
}

export function markDailyCompleted(dateStr) {
  safeSet(DAILY_COMPLETED_KEY, dateStr);
}

// ── Onboarding ──────────────────────────────────────
const ONBOARDING_KEY = 'minesweeper_onboarded';

export function isOnboarded() {
  return safeGet(ONBOARDING_KEY) === 'true';
}

export function setOnboarded() {
  safeSet(ONBOARDING_KEY, 'true');
}

// ── Daily Streak ──────────────────────────────────────
export function getDailyStreak() {
  const stats = loadStats();
  const daily = stats.modeStats?.daily;
  if (!daily) return { streak: 0, best: 0 };
  // Validate streak is still active (last completed was today or yesterday)
  const today = getLocalDateString();
  const lastDate = daily.lastDailyCompletedDate;
  if (lastDate) {
    const last = new Date(lastDate + 'T00:00:00');
    const now = new Date(today + 'T00:00:00');
    const diffDays = Math.round((now - last) / 86400000);
    if (diffDays > 1) {
      // Streak has lapsed
      return { streak: 0, best: daily.bestDailyStreak || 0 };
    }
  }
  return { streak: daily.dailyStreak || 0, best: daily.bestDailyStreak || 0 };
}

// ── Player Name ──────────────────────────────────────

export function getPlayerName() {
  return safeGet(PLAYER_NAME_KEY) || '';
}

export function setPlayerName(name) {
  safeSet(PLAYER_NAME_KEY, name);
}

// ── Cloud Progress Merge ──────────────────────────────
// Merges cloud-synced progress into local stats. Takes the higher value
// for each field so progress only goes up. Called silently on app init.
export function applyCloudProgress({ maxCheckpoint, dailyStreak, bestDailyStreak, lastDailyDate }) {
  const stats = loadStats();
  let changed = false;

  // Challenge checkpoint: take the higher value
  if (maxCheckpoint != null && maxCheckpoint > (stats.maxLevelReached || 1)) {
    stats.maxLevelReached = maxCheckpoint;
    if (!stats.modeStats) stats.modeStats = {};
    if (!stats.modeStats.challenge) stats.modeStats.challenge = {};
    stats.modeStats.challenge.maxLevelReached = maxCheckpoint;
    // Also update the checkpoint storage so the player can select it
    saveCheckpoint('challenge', maxCheckpoint);
    changed = true;
  }

  // Daily streak sync. The most recent play wins (it has the latest info):
  //   - cloud date > local date → adopt cloud's streak AND date, even if
  //     the streak went DOWN (player broke streak on another device).
  //   - cloud date === local date → defensively take the higher streak.
  //   - cloud date < local date → keep local; cloud is stale.
  // bestDailyStreak is a high-water mark, always take the higher value.
  if (dailyStreak != null || bestDailyStreak != null) {
    if (!stats.modeStats) stats.modeStats = {};
    if (!stats.modeStats.daily) stats.modeStats.daily = {};
    const daily = stats.modeStats.daily;
    const cloudDate = lastDailyDate;
    const localDate = daily.lastDailyCompletedDate;
    if (cloudDate && (!localDate || cloudDate > localDate)) {
      // Cloud is strictly newer — adopt its streak + date verbatim.
      if (dailyStreak != null) daily.dailyStreak = dailyStreak;
      daily.lastDailyCompletedDate = cloudDate;
      changed = true;
    } else if (cloudDate && cloudDate === localDate) {
      // Same date — keep the higher streak (should normally match anyway).
      if (dailyStreak != null && dailyStreak > (daily.dailyStreak || 0)) {
        daily.dailyStreak = dailyStreak;
        changed = true;
      }
    }
    if (bestDailyStreak != null && bestDailyStreak > (daily.bestDailyStreak || 0)) {
      daily.bestDailyStreak = bestDailyStreak;
      changed = true;
    }
  }

  if (changed) {
    setJSON(STATS_KEY, stats);
    _statsCache = stats;
  }
  return changed;
}

// ── What's New Version Tracking ──────────────────────

export function getLastSeenVersion() {
  return safeGet(LAST_SEEN_VERSION_KEY) || '';
}

export function setLastSeenVersion(version) {
  safeSet(LAST_SEEN_VERSION_KEY, version);
}
