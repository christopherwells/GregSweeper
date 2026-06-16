import { safeGet, safeSet, safeRemove, safeGetJSON, safeSetJSON, safeKeys } from './storageAdapter.js';
import { getLocalDateString } from '../logic/seededRandom.js';
import { applyStreakContinuation, projectContinuation, isStreakAlive, MOLT_CAP } from '../logic/moltDay.js';
import { isTestEnvironment } from '../firebase/env.js';
import { containsHateSpeech } from '../logic/nameFilter.js';

const STATS_KEY = 'minesweeper_stats';
const LEADERBOARD_KEY = 'minesweeper_daily_leaderboard';
const DAILY_PAR_KEY_PREFIX = 'minesweeper_daily_par_';
const DAILY_MOVES_KEY_PREFIX = 'minesweeper_daily_moves_';
const DAILY_FEATURES_KEY_PREFIX = 'minesweeper_daily_features_';
const DAILY_RESIDUALS_KEY = 'minesweeper_daily_residuals';
const THEME_KEY = 'minesweeper_theme';

// ── Local daily residuals (provisional handicap source) ──────────
// We persist {date, time, par} after each daily completion so the end-
// of-game modal can compute a provisional handicap before the nightly
// refit has accumulated enough plays to include the user. The Firebase
// users/{uid}/dailyHistory record is the same data with a server
// timestamp; the local cache exists so we can render synchronously on
// win without a round trip. Capped at the last 50 entries (handicap
// only ever needs the running mean, not the full history).

const RESIDUAL_HISTORY_CAP = 50;

export function appendDailyResidual({ date, time, par, bombHits = 0, bombPenalty = 0 }) {
  if (!date || typeof time !== 'number' || typeof par !== 'number' || par <= 0) return;
  const existing = safeGetJSON(DAILY_RESIDUALS_KEY, []);
  // De-duplicate by date — if the same daily is played and re-submitted
  // (rare), overwrite the prior entry rather than letting two rows for
  // the same date both feed the mean.
  const filtered = existing.filter(e => e && e.date !== date);
  // Persist bombHits and bombPenalty so the provisional-handicap
  // estimator can reconstruct clean-play time:
  //   - new info-value mechanic (bombPenalty > 0): `time` already includes
  //     the per-hit penalty, of which only the fixed base is a true cost;
  //     the estimator subtracts BOMB_PENALTY_BASE × bombHits.
  //   - legacy +10s/re-fog mechanic (bombPenalty 0, bombHits > 0): the
  //     estimator subtracts the fitted secPerBombHit × bombHits.
  // Older entries lack both fields — consumers default them to 0.
  filtered.push({ date, time, par, bombHits: bombHits || 0, bombPenalty: bombPenalty || 0 });
  // Keep only the most recent RESIDUAL_HISTORY_CAP entries; sort by
  // date ascending so slicing from the end keeps the newest plays.
  filtered.sort((a, b) => (a.date < b.date ? -1 : 1));
  const trimmed = filtered.length > RESIDUAL_HISTORY_CAP
    ? filtered.slice(-RESIDUAL_HISTORY_CAP) : filtered;
  safeSetJSON(DAILY_RESIDUALS_KEY, trimmed);
}

/**
 * Read the cached daily residuals as `[{ date, time, par }, ...]`. Used
 * by the end-of-game modal's provisional-handicap path to fall back to
 * a client-side mean residual when the refit handicap is unavailable.
 */
export function loadDailyResiduals() {
  const arr = safeGetJSON(DAILY_RESIDUALS_KEY, []);
  return Array.isArray(arr) ? arr.filter(e => e && typeof e.time === 'number' && typeof e.par === 'number') : [];
}

// ── Greg's Gym technique counts ──────────────────────────────────
// How many times the player has PERFORMED each named technique in the
// gym (the deducibility gate guarantees every count is a real worked
// deduction, never a guess). Local-only by design — the gym never
// touches scores, the par pipeline, or Firebase. Keyed by the
// patternNames classifier name ('count', '1-1', '1-2', '1-2-1',
// '1-2-2-1'). Read by the Field Notebook.
const GYM_TECHNIQUES_KEY = 'minesweeper_gym_techniques';

export function recordGymTechnique(name) {
  if (!name) return;
  const counts = safeGetJSON(GYM_TECHNIQUES_KEY, {});
  counts[name] = (counts[name] || 0) + 1;
  safeSetJSON(GYM_TECHNIQUES_KEY, counts);
}

export function getGymTechniqueCounts() {
  const counts = safeGetJSON(GYM_TECHNIQUES_KEY, {});
  return counts && typeof counts === 'object' ? counts : {};
}

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

/**
 * Remove per-date daily keys (par / moves / features) older than
 * `keepDays`. These accumulate one trio per played date forever —
 * a daily-habit player banks ~1 MB/year of feature JSON, and the
 * eventual quota failure downgrades storage to the silent in-memory
 * fallback. Nothing reads entries this old: residuals are capped at 50
 * and have their own store, the history chart reads Firebase, and the
 * par cache only matters for dates a player might still reopen.
 * Called once at boot.
 */
export function pruneOldDailyKeys(keepDays = 60) {
  const today = getLocalDateString();
  const [ty, tm, td] = today.split('-').map(Number);
  const cutoffMs = Date.UTC(ty, tm - 1, td) - keepDays * 24 * 3600 * 1000;
  let removed = 0;
  for (const prefix of [DAILY_PAR_KEY_PREFIX, DAILY_MOVES_KEY_PREFIX, DAILY_FEATURES_KEY_PREFIX]) {
    for (const key of safeKeys(prefix)) {
      const dateStr = key.slice(prefix.length);
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
      if (!m) continue; // unknown suffix shape — leave it alone
      const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (Number.isFinite(ms) && ms < cutoffMs) {
        safeRemove(key);
        removed++;
      }
    }
  }
  return removed;
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
  // Skill-feat counters (2026-06-10 achievements rebuild) — incremented
  // by saveGameResult from winLossHandler's honestly-detected feats.
  flaglessWins: 0,
  efficientWins: 0,
  searchWins: 0,
  liarWins: 0,
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
    daily: { ...createModeStats(), dailyStreak: 0, bestDailyStreak: 0, dailiesCompleted: 0, bombHits: 0, lastDailyCompletedDate: null, moltBanked: 0, moltLastUse: null },
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
  if (stats.flaglessWins == null) stats.flaglessWins = 0;
  if (stats.efficientWins == null) stats.efficientWins = 0;
  if (stats.searchWins == null) stats.searchWins = 0;
  if (stats.liarWins == null) stats.liarWins = 0;

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

// Transient marker for the most recent daily completion's molt-day outcome
// (a cover earned, covers spent). Set by saveGameResult, drained once by the
// win handler via consumeMoltEvent(). Deliberately NOT persisted, so a stale
// "earned" can never resurface on reload or ride along a later non-daily save.
let _lastMoltEvent = null;

export function saveGameResult(won, time, level, { isDaily = false, isArchive = false, usedPowerUps = false, gameMode = 'normal', hadGimmicks = false, skillFeats = {}, dailySeed = null } = {}) {
  const stats = loadStats();
  const modeKey = getModeKey(gameMode);
  const modeStats = stats.modeStats[modeKey];
  _lastMoltEvent = null;

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
      // Skill feats — booleans computed by the win handler from the
      // click timeline + the board's certified solve.
      if (skillFeats.flagless) stats.flaglessWins = (stats.flaglessWins || 0) + 1;
      if (skillFeats.efficient) stats.efficientWins = (stats.efficientWins || 0) + 1;
      if (skillFeats.search) stats.searchWins = (stats.searchWins || 0) + 1;
      if (skillFeats.liar) stats.liarWins = (stats.liarWins || 0) + 1;
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

  // Update per-mode stats. Archive replays are EXCLUDED here: a replayed past
  // daily counts as a generic win in the global stats above (so achievements
  // still fire) but must never touch any daily-mode counter — the daily-date
  // streak, completion totals, or daily win totals all live in this block,
  // and the daily-streak sub-block keys on modeKey, not the isDaily flag. See
  // the Daily Archive section in CLAUDE.md.
  if (modeStats && !isArchive) {
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
      // Daily-specific: consecutive-day streak with molt-day insurance. All
      // the earn / spend / reset math lives in the shared pure module so the
      // completion path, the app-load notice, and the push script agree.
      if (modeKey === 'daily') {
        modeStats.dailiesCompleted = (modeStats.dailiesCompleted || 0) + 1;
        // Use the puzzle's seed date (not current date) to avoid midnight-crossing bugs
        const today = dailySeed || getLocalDateString();
        const cont = applyStreakContinuation({
          lastDailyDate: modeStats.lastDailyCompletedDate,
          streak: modeStats.dailyStreak || 0,
          banked: modeStats.moltBanked || 0,
          today,
        });
        modeStats.dailyStreak = cont.streak;
        modeStats.moltBanked = cont.banked;
        modeStats.lastDailyCompletedDate = today;
        if (cont.coveredDates.length > 0) {
          // Persist the spend so the provisional notice survives a reload and
          // the win modal can name the covered day(s).
          modeStats.moltLastUse = { date: today, covered: cont.coveredDates, streakKept: cont.streak };
        }
        if (modeStats.dailyStreak > (modeStats.bestDailyStreak || 0)) {
          modeStats.bestDailyStreak = modeStats.dailyStreak;
        }
        _lastMoltEvent = {
          earned: cont.earned,
          coveredDates: cont.coveredDates,
          banked: cont.banked,
          streakKept: cont.streak,
        };
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

// Drain the molt-day outcome of the most recent daily completion. Returns
// { earned, coveredDates, banked, streakKept } once, then null until the next
// completion. The win handler calls this right after saveGameResult to decide
// whether to show the "molt day banked" or "molt day covered X" note.
export function consumeMoltEvent() {
  const e = _lastMoltEvent;
  _lastMoltEvent = null;
  return e;
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
    for (const m of ['challenge', 'timed', 'daily', 'weekly', 'skillTrainer', 'chaos']) {
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
  // Test branch: report no completion so the daily can be replayed
  // indefinitely for testing. localStorage is shared between the
  // master and test origins (same github.io host), so without this
  // override a real completion on master would lock test out too.
  if (isTestEnvironment()) return false;
  return safeGet(DAILY_COMPLETED_KEY) === dateStr;
}

export function markDailyCompleted(dateStr) {
  if (isTestEnvironment()) return;
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

// ── One-time newcomer notices ─────────────────────────
// Each first-encounter primer (the Modifier primer, the daily/weekly
// bomb-hit explainer, the par primer) shows once ever, then never
// again. One generic flag pair instead of three near-identical ones.
const ONE_TIME_KEY_PREFIX = 'minesweeper_seen_';

export function hasSeenNotice(name) {
  return safeGet(ONE_TIME_KEY_PREFIX + name) === 'true';
}

export function markNoticeSeen(name) {
  safeSet(ONE_TIME_KEY_PREFIX + name, 'true');
}

// ── Daily Streak ──────────────────────────────────────
export function getDailyStreak() {
  const stats = loadStats();
  const daily = stats.modeStats?.daily;
  if (!daily) return { streak: 0, best: 0, banked: 0 };
  const banked = Math.min(MOLT_CAP, Math.max(0, daily.moltBanked || 0));
  const today = getLocalDateString();
  const lastDate = daily.lastDailyCompletedDate;
  // The streak is live while the last completion was today or yesterday, OR a
  // banked molt day still covers the gap (it gets spent on the next
  // completion). Only a gap the bank cannot cover lapses to zero.
  if (lastDate && !isStreakAlive({ lastDailyDate: lastDate, banked, today })) {
    return { streak: 0, best: daily.bestDailyStreak || 0, banked };
  }
  return { streak: daily.dailyStreak || 0, best: daily.bestDailyStreak || 0, banked };
}

// Before the player plays today: if a molt day is currently holding the streak
// over a missed gap, describe the save so the daily card can surface it ahead
// of the completion. Returns { streakHeld, coveredDates } or null when there is
// nothing provisional to show (played today, or the gap is uncoverable).
export function getMoltProvisionalNotice() {
  const stats = loadStats();
  const daily = stats.modeStats?.daily;
  if (!daily || !daily.lastDailyCompletedDate) return null;
  const today = getLocalDateString();
  if (daily.lastDailyCompletedDate >= today) return null; // already played today
  const banked = Math.min(MOLT_CAP, Math.max(0, daily.moltBanked || 0));
  const proj = projectContinuation({
    lastDailyDate: daily.lastDailyCompletedDate,
    streak: daily.dailyStreak || 0,
    banked,
    today,
  });
  if (!proj.willCover) return null;
  // streakHeld is the CURRENT streak (the cover isn't spent until they play).
  return { streakHeld: daily.dailyStreak || 0, coveredDates: proj.coveredDates };
}

// Length of the maximal run of consecutive ET dates ending at the most
// recent completed date, computed from the authoritative completed-date
// set (users/{uid}/dailyHistory). Pure date math — no storage access.
// `dates` is an array of 'YYYY-MM-DD' strings; order/dupes don't matter.
export function computeStreakFromHistory(dates) {
  if (!Array.isArray(dates) || dates.length === 0) return { streak: 0, lastDate: null };
  const sorted = [...new Set(dates.filter(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
  if (sorted.length === 0) return { streak: 0, lastDate: null };
  const lastDate = sorted[sorted.length - 1];
  let streak = 1;
  for (let i = sorted.length - 1; i > 0; i--) {
    const diff = Math.round(
      (new Date(sorted[i] + 'T00:00:00') - new Date(sorted[i - 1] + 'T00:00:00')) / 86400000
    );
    if (diff === 1) streak++;
    else break; // gap (or dup, already de-duped) — run ends here
  }
  return { streak, lastDate };
}

// Reconcile the locally-stored streak against the authoritative
// completion history. UPWARD-ONLY: raises the stored streak when the
// history implies a longer run than the local counter knows about (an
// offline day that synced late, or a cross-device / uid-split play the
// counter missed). Never LOWERS — a shorter derived run isn't proof of a
// real break, because history can have holes from failed offline writes;
// genuine breaks are handled at play time by saveGameResult's reset-on-gap.
// This is the self-heal that recovers a streak corrupted by connectivity.
export function reconcileStreakFromHistory(dates) {
  const { streak, lastDate } = computeStreakFromHistory(dates);
  if (!lastDate || streak <= 0) return false;
  const stats = loadStats();
  if (!stats.modeStats) stats.modeStats = {};
  if (!stats.modeStats.daily) stats.modeStats.daily = {};
  const daily = stats.modeStats.daily;
  let changed = false;
  if (streak > (daily.dailyStreak || 0)) {
    daily.dailyStreak = streak;
    if (!daily.lastDailyCompletedDate || lastDate > daily.lastDailyCompletedDate) {
      daily.lastDailyCompletedDate = lastDate;
    }
    changed = true;
  }
  if (streak > (daily.bestDailyStreak || 0)) {
    daily.bestDailyStreak = streak;
    changed = true;
  }
  if (changed) {
    setJSON(STATS_KEY, stats);
    _statsCache = stats;
  }
  return changed;
}

// ── Player Name ──────────────────────────────────────

export function getPlayerName() {
  return safeGet(PLAYER_NAME_KEY) || '';
}

// Strip the chars Firebase rejects in leaderboard names (the regex on
// daily/$date/$entry/name and weekly/$weekStart/$uid/name). Without this
// the player can type, say, `Chris<3` in Settings, see it stored
// locally, and then have every score submission silently fail because
// the rule rejects the `<`. Strip on save so the local copy matches
// what would actually be accepted.
//
// Also rejects hate-speech names (slurs) so they never reach the
// leaderboard. Returns { ok, reason }: ok=false with reason='hate' means
// the name was NOT saved and the caller should surface a message. The
// server-side sweep is the authoritative backstop for anything that
// bypasses this (e.g. a direct Firebase write).
export function setPlayerName(name) {
  const cleaned = String(name || '').replace(/[<>&"'`@]/g, '').slice(0, 20);
  if (containsHateSpeech(cleaned)) {
    return { ok: false, reason: 'hate' };
  }
  safeSet(PLAYER_NAME_KEY, cleaned);
  return { ok: true, value: cleaned };
}

// Reset the daily-streak portion of local stats so the next applyCloudProgress
// call adopts the cloud values verbatim instead of treating local as "newer".
// Used when the user explicitly switches accounts on this device — the local
// daily plays belonged to the device's now-abandoned anonymous uid, not the
// account we're switching to.
//
// Also clears the daily-completed-today marker so the player can play today's
// daily under the new account if they haven't already on that account.
export function resetDailyStatsForAccountSwitch() {
  const stats = loadStats();
  if (stats.modeStats && stats.modeStats.daily) {
    stats.modeStats.daily.dailyStreak = 0;
    stats.modeStats.daily.bestDailyStreak = 0;
    stats.modeStats.daily.lastDailyCompletedDate = null;
    stats.modeStats.daily.moltBanked = 0;
    stats.modeStats.daily.moltLastUse = null;
  }
  setJSON(STATS_KEY, stats);
  _statsCache = stats;
  // Drop the per-date local caches keyed off the abandoned uid's plays —
  // the new account may have different par / move counts on the same date.
  try { safeRemove(DAILY_COMPLETED_KEY); } catch {}
}

// ── Cloud Progress Merge ──────────────────────────────
// Merges cloud-synced progress into local stats. By default takes the
// higher value for each field so progress only goes up (used on app
// init where local might have unflushed plays).
//
// When `opts.overwrite` is true (used by the real-time listener path
// where cloud IS the authoritative state — any write to users/{uid}
// just landed), values are adopted verbatim including downgrades.
// Otherwise an admin-side correction or a partner-device reset would
// be silently rejected by the max-merge.
export function applyCloudProgress({ maxCheckpoint, dailyStreak, bestDailyStreak, lastDailyDate, powerUps, moltDay }, opts = {}) {
  const overwrite = !!opts.overwrite;
  const stats = loadStats();
  let changed = false;

  // Challenge checkpoint
  if (maxCheckpoint != null && (overwrite || maxCheckpoint > (stats.maxLevelReached || 1))) {
    stats.maxLevelReached = maxCheckpoint;
    if (!stats.modeStats) stats.modeStats = {};
    if (!stats.modeStats.challenge) stats.modeStats.challenge = {};
    stats.modeStats.challenge.maxLevelReached = maxCheckpoint;
    // Also update the checkpoint storage so the player can select it
    saveCheckpoint('challenge', maxCheckpoint);
    changed = true;
  }

  // Daily streak sync. The molt-day bank + lastUse ride the SAME snapshot as
  // (dailyStreak, lastDailyDate): whichever side wins by the date-anchor rules
  // supplies ALL of them together, so the bank can never be paired with the
  // other side's streak.
  //   overwrite=true  (listener path): adopt cloud verbatim regardless of date
  //   overwrite=false (initial-load):
  //     - cloud date > local date → adopt cloud's streak + bank + date verbatim
  //       (even if the streak went DOWN — player broke it on another device).
  //     - cloud date === local date → defensively take the higher streak, and
  //       its bank with it.
  //     - cloud date < local date → keep local; cloud is stale.
  // bestDailyStreak is a separate high-water mark (a plain max), except under
  // overwrite where cloud is adopted verbatim (so an admin reset reflects too).
  const cloudMolt = (moltDay && typeof moltDay === 'object') ? moltDay : null;
  if (dailyStreak != null || bestDailyStreak != null || cloudMolt != null) {
    if (!stats.modeStats) stats.modeStats = {};
    if (!stats.modeStats.daily) stats.modeStats.daily = {};
    const daily = stats.modeStats.daily;
    // Adopt cloud's molt fields as a unit. A missing cloud node means the
    // account has no molt state yet, which is a real 0 (not "keep local").
    const adoptMolt = () => {
      daily.moltBanked = cloudMolt ? (cloudMolt.banked || 0) : 0;
      daily.moltLastUse = cloudMolt ? (cloudMolt.lastUse || null) : null;
    };
    if (overwrite) {
      if (dailyStreak != null) daily.dailyStreak = dailyStreak;
      if (bestDailyStreak != null) daily.bestDailyStreak = bestDailyStreak;
      if (lastDailyDate != null) daily.lastDailyCompletedDate = lastDailyDate;
      adoptMolt();
      changed = true;
    } else {
      const cloudDate = lastDailyDate;
      const localDate = daily.lastDailyCompletedDate;
      if (cloudDate && (!localDate || cloudDate > localDate)) {
        if (dailyStreak != null) daily.dailyStreak = dailyStreak;
        daily.lastDailyCompletedDate = cloudDate;
        adoptMolt();
        changed = true;
      } else if (cloudDate && cloudDate === localDate) {
        if (dailyStreak != null && dailyStreak > (daily.dailyStreak || 0)) {
          daily.dailyStreak = dailyStreak;
          adoptMolt(); // the bank follows the streak it belongs to
          changed = true;
        }
      }
      if (bestDailyStreak != null && bestDailyStreak > (daily.bestDailyStreak || 0)) {
        daily.bestDailyStreak = bestDailyStreak;
        changed = true;
      }
    }
  }

  if (changed) {
    setJSON(STATS_KEY, stats);
    _statsCache = stats;
  }

  // Power-up sync. Cloud is the cross-device source of truth.
  //   overwrite=true  (real-time listener): adopt cloud verbatim.
  //   overwrite=false (initial load): take max per type so an offline
  //     earn or spend on THIS device isn't silently discarded before the
  //     two sides have had a chance to converge. Worst case: a spent
  //     power-up briefly re-appears until the next saveProgress write;
  //     that's a minor UX hiccup vs permanently losing earned power-ups.
  if (powerUps && typeof powerUps === 'object') {
    const local = getJSON(POWERUPS_KEY, null);
    if (overwrite || !local) {
      setJSON(POWERUPS_KEY, powerUps);
      changed = true;
    } else {
      // Max-merge per mode per type.
      let anyChange = false;
      for (const mode of Object.keys(powerUps)) {
        const cloudMode = powerUps[mode] || {};
        const localMode = local[mode] || {};
        for (const type of Object.keys(cloudMode)) {
          const cloudVal = typeof cloudMode[type] === 'number' ? cloudMode[type] : 0;
          const localVal = typeof localMode[type] === 'number' ? localMode[type] : 0;
          if (cloudVal > localVal) {
            if (!local[mode]) local[mode] = {};
            local[mode][type] = cloudVal;
            anyChange = true;
          }
        }
      }
      if (anyChange) {
        setJSON(POWERUPS_KEY, local);
        changed = true;
      }
    }
  }

  // Keep DAILY_COMPLETED_KEY in sync with cloud's lastDailyDate so
  // multi-device users don't get prompted to "play today's daily" on
  // device B after device A already submitted. The two keys serve
  // different gates — stats.modeStats.daily.lastDailyCompletedDate
  // drives the streak math; DAILY_COMPLETED_KEY drives the daily-card
  // "completed" lock — but they should always agree on whether today
  // is done.
  if (lastDailyDate && typeof lastDailyDate === 'string' && lastDailyDate.length === 10) {
    const today = getLocalDateString();
    if (lastDailyDate === today && safeGet(DAILY_COMPLETED_KEY) !== today) {
      safeSet(DAILY_COMPLETED_KEY, today);
    }
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
