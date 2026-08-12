import { safeGet, safeSet, safeRemove, safeGetJSON, safeSetJSON, safeKeys } from './storageAdapter.js';
import { getLocalDateString, getWeekStart } from '../logic/seededRandom.js';
import { applyStreakContinuation, projectContinuation, isStreakAlive, backfillGrant, MOLT_CAP } from '../logic/moltDay.js';
import {
  applyWeekContinuation, liveWeekStreak, projectWeekContinuation,
  weekStreakFromHistory, bankableWeeks,
} from '../logic/weeklyProgress.js';
import { CHALLENGE_250_EPOCH } from '../logic/challenge250.js';
import { clearSeenGimmicks } from '../logic/gimmicks.js';
import { challengeSaveIsCurrent } from '../logic/resumeEligibility.js';
import { isTestEnvironment } from '../firebase/env.js';
import { containsHateSpeech } from '../logic/nameFilter.js';

const STATS_KEY = 'minesweeper_stats';
const LEADERBOARD_KEY = 'minesweeper_daily_leaderboard';
const DAILY_PAR_KEY_PREFIX = 'minesweeper_daily_par_';
const DAILY_MOVES_KEY_PREFIX = 'minesweeper_daily_moves_';
const DAILY_FEATURES_KEY_PREFIX = 'minesweeper_daily_features_';
const DAILY_RESIDUALS_KEY = 'minesweeper_daily_residuals';

// ── Climb library seen-tracking ─────────────────────────
// His cycle rule: a dealt board is marked seen; once every board in a
// level's bin has been seen, the cycle resets and the bin is fresh again.
// One JSON map { level: [seed, ...] }, local-only like the modifier
// seen-set. Practice runs (?level=, the shared-localStorage lesson) never
// write here; the gate is the caller's (climbDeal checks isLevelPractice).
const CLIMB_SEEN_KEY = 'minesweeper_climb_seen';

export function getClimbSeen(level) {
  const map = safeGetJSON(CLIMB_SEEN_KEY, {});
  const arr = map[String(level)];
  return Array.isArray(arr) ? arr : [];
}

export function setClimbSeen(level, seeds) {
  const map = safeGetJSON(CLIMB_SEEN_KEY, {});
  map[String(level)] = Array.isArray(seeds) ? seeds : [];
  safeSetJSON(CLIMB_SEEN_KEY, map);
}

// The ENDLESS library's seen-cycle is GLOBAL (one map for the whole
// library, keyed by page so the deal can weigh pages without fetching
// them), not per-level: past the crown a level has no bin of its own and
// his cycle rule applies to the library entire. Same practice gate as the
// ladder's (the caller checks isLevelPractice).
const ENDLESS_SEEN_KEY = 'minesweeper_climb_endless_seen';

export function getEndlessSeen() {
  const map = safeGetJSON(ENDLESS_SEEN_KEY, {});
  return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
}

export function setEndlessSeen(map) {
  safeSetJSON(ENDLESS_SEEN_KEY, map && typeof map === 'object' ? map : {});
}

// The MATCH library's seen-cycle (Challenge mode): one flat list of
// `page:idx` keys across the whole library, his cycle rule applied per
// eligible space by matchRules.pickMatchBoards. Keys are stable across the
// nightly reprice (boards never move between pages); a full library rebuild
// resets the cycle, which is self-healing and worth no bookkeeping. Same
// practice gate as the ladder's (matchDeal checks isLevelPractice).
const MATCH_SEEN_KEY = 'minesweeper_match_seen';

export function getMatchSeen() {
  const arr = safeGetJSON(MATCH_SEEN_KEY, []);
  return Array.isArray(arr) ? arr : [];
}

export function setMatchSeen(keys) {
  safeSetJSON(MATCH_SEEN_KEY, Array.isArray(keys) ? keys : []);
}
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
  // De-duplicate by date, if the same daily is played and re-submitted
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
  // Older entries lack both fields, consumers default them to 0.
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
// deduction, never a guess). Local-only by design, the gym never
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
 * `keepDays`. These accumulate one trio per played date forever,
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
      if (!m) continue; // unknown suffix shape, leave it alone
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
  // Skill-feat counters (2026-06-10 achievements rebuild), incremented
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
    // 'match' is the head-to-head Challenge mode; 'timed' is the Quick Play
    // it absorbed, kept here because its stored rows are a player's history
    // and dropping the key would orphan them.
    match: createModeStats(),
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

// Map internal gameMode values to modeStats keys. THE one definition: the
// ladder runs as 'normal' at runtime and stores as 'challenge', and every
// consumer of that fact routes through here. It is exported for the stats
// modal, whose tab ids are the same key space.
export function getModeKey(gameMode) {
  if (gameMode === 'normal') return 'challenge';
  return gameMode;
}

// Resolve the per-mode stats block for a UI surface. The 'normal' → 'challenge'
// key mapping lives ONLY in getModeKey; a caller that hand-rolls the key can
// silently read the wrong node, the Challenge stats tab read
// stats.modeStats.normal (always undefined) and fell back to the all-modes
// aggregate for months (2026-07-10 audit). Returns null when the mode has no
// block yet so callers keep their own fallback semantics.
export function statsForMode(stats, gameMode) {
  return (stats && stats.modeStats && stats.modeStats[getModeKey(gameMode)]) || null;
}

// Transient marker for the most recent daily completion's molt-day outcome
// (a cover earned, covers spent). Set by saveGameResult, drained once by the
// win handler via consumeMoltEvent(). Deliberately NOT persisted, so a stale
// "earned" can never resurface on reload or ride along a later non-daily save.
let _lastMoltEvent = null;

export function saveGameResult(won, time, level, { isDaily = false, isArchive = false, isPractice = false, isLevelPractice = false, usedPowerUps = false, gameMode = 'normal', hadGimmicks = false, skillFeats = {}, dailySeed = null } = {}) {
  const stats = loadStats();
  const modeKey = getModeKey(gameMode);
  const modeStats = stats.modeStats[modeKey];
  _lastMoltEvent = null;

  // A ?level= playtest run (test builds only) records NOTHING: no games
  // played, no streaks, no bestTimes, and above all no maxLevelReached,
  // the checkpoint ladder must never unlock from a practice jump.
  if (isLevelPractice) return stats;

  // Update global stats (chaos mode is tracked per-mode only, skip global streak/bestTimes/purist)
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
      // Skill feats, booleans computed by the win handler from the
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

  // Update per-mode stats. Archive replays AND practice dailies (?seed=) are
  // EXCLUDED here: both count as a generic win in the global stats above (so
  // achievements still fire) but must never touch any daily-mode counter,
  // the daily-date streak, molt bank, completion totals, and daily win totals
  // all live in this block, and the daily-streak sub-block keys on modeKey,
  // not the isDaily flag. Without the isPractice guard a ?seed= win ran the
  // streak block with dailySeed=null, stamping the REAL date, inflating the
  // streak/bestDailyStreak, and spending banked molt days on a throwaway
  // board (issue #131). See the Daily Archive section in CLAUDE.md.
  if (modeStats && !isArchive && !isPractice) {
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
      // completion path, the app-load notice, and the push script are kept consistent.
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
  if (modeKey === 'match') return {};       // Match: no power-ups
  if (modeKey === 'daily') return {};        // Daily: not persisted
  return all[modeKey] ? { ...all[modeKey] } : {};
}

export function saveModePowerUps(gameMode, powerUps) {
  const modeKey = getModeKey(gameMode);
  if (modeKey === 'match' || modeKey === 'daily') return; // Don't persist
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

// Checkpoints are keyed by the same 'normal' → 'challenge' mapping every other
// per-mode store uses (getModeKey, gameStateKey). They were NOT: the
// level-advance handler wrote `saveCheckpoint(state.gameMode, …)`, i.e.
// 'normal', while the fresh-start reader and the C250 reset both used
// 'challenge', so the ladder kept TWO entries for one number and the reset
// only ever cleared one of them. The pre-C250 checkpoint sat in the other one
// untouched (issue #239). Normalizing here is what makes it one number again;
// any legacy 'normal' entry is orphaned by the same stroke and dropped by the
// reset below.
function checkpointKey(gameMode) {
  return getModeKey(gameMode);
}

export function loadCheckpoint(gameMode) {
  const data = getJSON(CHECKPOINT_KEY) || {};
  return data[checkpointKey(gameMode)] || 1; // default checkpoint is level 1
}

export function saveCheckpoint(gameMode, level) {
  const data = getJSON(CHECKPOINT_KEY) || {};
  data[checkpointKey(gameMode)] = level;
  setJSON(CHECKPOINT_KEY, data);
}

// ── Per-Mode Game State Persistence ─────────────────
const GAME_STATE_PREFIX = 'minesweeper_game_state_';
const LEGACY_GAME_STATE_KEY = 'minesweeper_game_state';

function gameStateKey(mode) {
  // Routes through getModeKey rather than restating it. A second copy of this
  // mapping is what issue #239 was: the level-advance handler wrote its
  // checkpoint under an un-normalized key, so one number lived in two places
  // and a returning player was offered a game the reset had already taken.
  return GAME_STATE_PREFIX + getModeKey(mode);
}

export function saveGameState(gameState) {
  const key = gameStateKey(gameState.gameMode || 'normal');
  setJSON(key, gameState);
}

export function loadGameState(mode) {
  if (mode) {
    return getJSON(gameStateKey(mode));
  }
  // No mode specified, try legacy key and migrate
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
    for (const m of ['challenge', 'match', 'timed', 'daily', 'weekly', 'skillTrainer', 'chaos']) {
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
// WHICH board that completion was for. The date alone cannot answer the
// question the daily-card lock actually asks, "has this account finished
// TODAY'S CANONICAL board?", because a client that missed the canonical and
// generated locally completes a different board on the same date. Until
// 2026-08-07 the only record of which board was played lived in the cloud
// score row, and the submit guard (#252) stopped writing that row for exactly
// the divergent case the unlock reads, so the fact went unrecorded everywhere.
// Written beside the date, so an absent value means a completion recorded
// before this shipped (vintage), never "played the canonical".
const DAILY_COMPLETED_SEED_KEY = 'minesweeper_daily_completed_seed';
// "This device completed a board today, but not the day's board." Set when the
// boot gate proves divergence; read by applyCloudProgress, which would
// otherwise re-lock the card from the cloud's `lastDailyDate` within
// milliseconds, the divergent play still counts for the streak by design, so
// the cloud legitimately says "played today" while the canonical sits unplayed.
const DAILY_REPLAY_UNLOCK_KEY = 'minesweeper_daily_replay_unlocked';

export function isDailyCompleted(dateStr) {
  // Test branch: report no completion so the daily can be replayed
  // indefinitely for testing. localStorage is shared between the
  // master and test origins (same github.io host), so without this
  // override a real completion on master would lock test out too.
  if (isTestEnvironment()) return false;
  return safeGet(DAILY_COMPLETED_KEY) === dateStr;
}

/**
 * What this device remembers about today's daily: the date it recorded a
 * completion for, and the board seed that completion was on. A null `seed` is
 * a completion recorded before seeds were tracked, UNKNOWN, not "canonical".
 */
export function getDailyCompletionRecord() {
  return {
    date: safeGet(DAILY_COMPLETED_KEY) || null,
    seed: safeGet(DAILY_COMPLETED_SEED_KEY) || null,
  };
}

/**
 * Unlock today's daily for a replay because the board this device completed
 * was NOT the day's canonical: the score was refused at submit, so the real
 * board is still unplayed and the player is not on the board.
 *
 * The unlock has to be STICKY. Clearing the completed date alone lasts
 * milliseconds, applyCloudProgress re-derives the lock from the cloud's
 * `lastDailyDate`, and the progress listener re-applies the cloud on every
 * write under users/{uid} (a lastSeen beacon is enough). The divergent play
 * deliberately still counts for the streak, so the cloud is right to say
 * "played today"; it just cannot answer "played WHICH board". This marker is
 * that answer, and it is what the re-lock defers to.
 */
export function unlockDailyReplay(dateStr) {
  if (isTestEnvironment() || !dateStr) return;
  safeRemove(DAILY_COMPLETED_KEY);
  safeRemove(DAILY_COMPLETED_SEED_KEY);
  safeSet(DAILY_REPLAY_UNLOCK_KEY, dateStr);
  // The cached par / moves / features describe the board that was played, and
  // it was the wrong one, leaving them would print a stale par on the Daily
  // card and hand parResolve a feature vector for a layout the player is about
  // to stop playing. Dropped here rather than at each call site so the boot
  // gate and the at-submit unlock cannot disagree about what a replay resets.
  safeRemove(DAILY_PAR_KEY_PREFIX + dateStr);
  safeRemove(DAILY_MOVES_KEY_PREFIX + dateStr);
  safeRemove(DAILY_FEATURES_KEY_PREFIX + dateStr);
}

export function isDailyReplayUnlocked(dateStr) {
  return !!dateStr && safeGet(DAILY_REPLAY_UNLOCK_KEY) === dateStr;
}

/**
 * @param {string} dateStr    the board's date (state.dailySeed)
 * @param {string|null} seed  the effective rngSeed of the board completed,
 *                            `${date}:trialN` on experiment days, the bare
 *                            date otherwise. Recorded so a later boot can tell
 *                            whether this account has finished the day's real
 *                            board without needing a cloud row to exist.
 */
export function markDailyCompleted(dateStr, seed = null) {
  if (isTestEnvironment()) return;
  safeSet(DAILY_COMPLETED_KEY, dateStr);
  if (seed) safeSet(DAILY_COMPLETED_SEED_KEY, seed);
  else safeRemove(DAILY_COMPLETED_SEED_KEY);
  // A completion supersedes any standing replay unlock, including the one
  // that granted this very replay.
  safeRemove(DAILY_REPLAY_UNLOCK_KEY);
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

/**
 * The STORED daily-progress snapshot in cloud-payload shape, or null when
 * this device has no daily history to report.
 *
 * The molt bank and last-use ride WITH the streak and its date because a
 * cross-device merge adopts them as one unit, a bank paired with the other
 * side's streak is the incoherent state applyCloudProgress exists to prevent.
 * Stored values, not the lapse-adjusted read of getDailyStreak: a lapse is a
 * view, and writing it would make it permanent for every device.
 */
export function getDailyCloudSnapshot() {
  const daily = loadStats().modeStats?.daily;
  if (!daily || !daily.lastDailyCompletedDate) return null;
  return {
    dailyStreak: daily.dailyStreak || 0,
    bestDailyStreak: daily.bestDailyStreak || 0,
    lastDailyDate: daily.lastDailyCompletedDate,
    moltDay: {
      banked: Math.min(MOLT_CAP, Math.max(0, daily.moltBanked || 0)),
      lastUse: daily.moltLastUse || null,
    },
  };
}

// ── Week streak ───────────────────────────────────────
// The weekly's counterpart to the daily streak: one completion banks the
// week, and consecutive banked weeks are the streak (his rule, 2026-08-05,
// "only need to play one of the weekly"). No molt days: a week is already
// seven chances at one board, so there is nothing for insurance to insure.
//
// It lives in a TOP-LEVEL stats field rather than in modeStats.weekly, which
// does not exist, createDefaultModeStats has never had a weekly block, and
// adding one would silently start routing every weekly completion through
// saveGameResult's per-mode counters, which is a different change than this.
// One object so the (streak, best, lastWeek) trio is always read and written
// as one snapshot, the moltDay lesson.
const DEFAULT_WEEK_STREAK = { streak: 0, best: 0, lastWeek: null };

function readWeekStreak(stats) {
  const w = stats.weekStreak;
  if (!w || typeof w !== 'object') return { ...DEFAULT_WEEK_STREAK };
  return {
    streak: Math.max(0, Number(w.streak) || 0),
    best: Math.max(0, Number(w.best) || 0),
    lastWeek: typeof w.lastWeek === 'string' ? w.lastWeek : null,
  };
}

/**
 * The week streak as the card should show it: the stored run while it is still
 * alive, 0 once it has lapsed. `best` is a high-water mark and never lapses.
 */
export function getWeekStreak(currentWeek = getWeekStart()) {
  const rec = readWeekStreak(loadStats());
  return { streak: liveWeekStreak(rec, currentWeek), best: rec.best, lastWeek: rec.lastWeek };
}

/**
 * The STORED week-streak trio, exactly as the cloud node carries it, the
 * payload shape `saveProgress({ weekStreak })` expects, defined once so the
 * completion path and the self-heal cannot send different shapes.
 *
 * Deliberately NOT lapse-adjusted, unlike getWeekStreak: the card shows 0 for
 * a lapsed run, but writing that 0 to the cloud would make a read-side view
 * permanent and hand every other device a break that has not happened.
 */
export function getWeekStreakRecord() {
  return readWeekStreak(loadStats());
}

/**
 * Bank a weekly completion. Idempotent within a week, later days of a week
 * already banked leave everything where it is, which is what makes "one of the
 * seven" the rule rather than "the first of the seven".
 *
 * @param {string} weekStart the completed board's week
 * @returns {{streak: number, best: number, lastWeek: string, extended: boolean}}
 */
export function recordWeeklyCompletion(weekStart) {
  const stats = loadStats();
  const next = applyWeekContinuation(readWeekStreak(stats), weekStart);
  stats.weekStreak = { streak: next.streak, best: next.best, lastWeek: next.lastWeek };
  setJSON(STATS_KEY, stats);
  _statsCache = stats;
  return next;
}

/**
 * Reconcile the stored week streak against the weeks the player has actually
 * played, from their own cloud-synced per-week records: `weeklyAttempts`
 * (attemptedWeeks) and `weeklyCompletions` (completedWeeks).
 *
 * UPWARD-ONLY, exactly like reconcileStreakFromHistory: it raises a streak the
 * counter never knew about and never lowers one, because a short derived run
 * is not proof of a break, a failed write leaves a hole in the history, while
 * a genuine break is handled at play time by applyWeekContinuation.
 *
 * This is what the feature shipped WITHOUT, and the omission was immediate:
 * a counter that only starts counting when it ships tells a player who has
 * never missed a weekly that they have no streak, with fourteen weeks of their
 * own history sitting in the account (his report, 2026-08-05).
 *
 * WHICH weeks may bank is bankableWeeks' question, and the boundary is stated
 * there in full: before WEEKLY_COMPLETIONS_EPOCH an ATTEMPT still banks its
 * week (the only per-week record of that era, deliberately generous on
 * history the player cannot replay), and from the epoch on only a COMPLETION
 * does, so an opened-and-abandoned week no longer counts once the completion
 * record covers its era. The CURRENT week is excluded from BOTH sources: the
 * player can still earn it honestly before Sunday, and this runs on every
 * boot, so counting it banked a week for one click, spliced it onto a genuine
 * run, and raised the monotonic `best` beyond recovery (issue #254).
 *
 * @param {string[]|null} attemptedWeeks weeks opened, from fetchPlayedWeeks
 * @param {string} currentWeek this week's Monday anchor
 * @param {string[]|null} completedWeeks weeks finished, from fetchCompletedWeeks
 * @returns {boolean} true when anything moved
 */
export function reconcileWeekStreakFromHistory(attemptedWeeks, currentWeek = getWeekStart(), completedWeeks = null) {
  const { streak, lastWeek } = weekStreakFromHistory(
    bankableWeeks({ attempted: attemptedWeeks, completed: completedWeeks, currentWeek }));
  if (!lastWeek || streak <= 0) return false;
  const stats = loadStats();
  const rec = readWeekStreak(stats);
  const next = { ...rec };
  let changed = false;

  // A later week than the counter knows about means completions it missed.
  if (!rec.lastWeek || lastWeek > rec.lastWeek) {
    next.lastWeek = lastWeek;
    next.streak = Math.max(rec.streak, streak);
    changed = true;
  } else if (streak > rec.streak) {
    // Same or earlier last week, but a longer run behind it.
    next.streak = streak;
    changed = true;
  }
  if (next.streak > next.best) { next.best = next.streak; changed = true; }

  if (changed) {
    stats.weekStreak = next;
    setJSON(STATS_KEY, stats);
    _statsCache = stats;
  }
  return changed;
}

/**
 * Before the player has played this week: what completing it would do, so the
 * card can say the streak is riding on this week rather than announcing it
 * only after the fact.
 */
export function getWeekStreakNotice(currentWeek = getWeekStart()) {
  const rec = readWeekStreak(loadStats());
  if (!rec.lastWeek || rec.lastWeek === currentWeek) return null;
  const { streak, atRisk } = projectWeekContinuation(rec, currentWeek);
  return atRisk ? { streakHeld: streak - 1, wouldBe: streak } : null;
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

// One-time launch grant: an existing streak earns the molt days it would have
// banked under the new mechanic (>4 -> 1, >9 -> 2). Self-guarding via state, so
// it can run every boot safely: it only ever fires for a never-engaged account
// (no bank, no prior use) that already holds a streak, and never re-grants once
// a molt day has been banked or spent (so it can't undo a spend cross-device).
// Local-only; the next completion syncs the bank to the cloud, and a second
// device converges from the same shared streak. Returns true if it granted.
export function backfillMoltDays() {
  const stats = loadStats();
  const daily = stats.modeStats?.daily;
  if (!daily) return false;
  if ((daily.moltBanked || 0) > 0 || daily.moltLastUse) return false;
  const grant = backfillGrant(getDailyStreak().streak);
  if (grant <= 0) return false;
  daily.moltBanked = grant;
  setJSON(STATS_KEY, stats);
  _statsCache = stats;
  return true;
}

// ── Challenge 250 progression reset ─────────────────────────────────────
// Everyone replays from L1 (his ruling: no memento of the old 120 climb).
// One-time and epoch-guarded, so it runs safely every boot: once the stats
// carry CHALLENGE_250_EPOCH it never fires again. What resets is
// PROGRESSION, max level, the checkpoint ladder, per-level best times
// (the old level numbers name different boards now), and the challenge
// power-up inventory (wipe to zero; earns are tier-scaled from here).
// Career counters (wins, losses, streaks, feats) survive: they are
// history, not position. The first-encounter modifier seen-set is
// deliberately untouched, popups do NOT re-show after the reset.
// Cross-device: applyCloudProgress only adopts maxCheckpoint/powerUps
// from a cloud snapshot carrying THIS epoch, so a stale device's
// pre-reset values can never resurrect the climb (the moltDay
// date-anchored-snapshot lesson). Returns true if it reset.
export function applyChallenge250Reset() {
  const stats = loadStats();

  // The first-encounter modifier cards clear on their OWN marker, deliberately
  // separate from the progression epoch below.
  //
  // They were left ALONE when the reset first shipped, on the reasoning that a
  // player who had already met walls should not be re-taught them. That was
  // wrong, and the symptom was immediate: the ladder was rebuilt from level 1
  // for everyone, walls now debut at L6 and liar at L11, and a returning
  // player met both with no card at all, an opener that reads as broken
  // rather than as familiar (his report, 2026-08-04).
  //
  // A separate marker is what lets this reach players whose progression reset
  // ALREADY ran. Folding it into the epoch guard below would either miss them
  // entirely or, if the epoch were bumped to catch them, wipe the climb they
  // have built since. The shape cards are untouched: that set was born with
  // this ladder, so nothing in it is stale.
  let changed = false;
  if (stats.challengeSeenEpoch !== CHALLENGE_250_EPOCH) {
    clearSeenGimmicks();
    stats.challengeSeenEpoch = CHALLENGE_250_EPOCH;
    setJSON(STATS_KEY, stats);
    _statsCache = stats;
    changed = true;
  }

  if (stats.challengeEpoch !== CHALLENGE_250_EPOCH) {
    stats.maxLevelReached = 1;
    stats.bestTimes = {};
    if (stats.modeStats?.challenge) {
      stats.modeStats.challenge.maxLevelReached = 1;
      stats.modeStats.challenge.bestTimes = {};
    }
    stats.challengeEpoch = CHALLENGE_250_EPOCH;
    setJSON(STATS_KEY, stats);
    _statsCache = stats;
    saveCheckpoint('challenge', 1);
    // Wipe the challenge power-up pool to zeros (all six types stay).
    const all = loadPowerUps();
    all.challenge = { ...DEFAULT_POWERUPS.challenge };
    savePowerUps(all);
    changed = true;
  }

  // The pre-reset ARTIFACTS, on their own marker for the same reason the cards
  // have one: this has to reach players whose progression reset already ran.
  // It runs AFTER the progression reset above, because the position it judges
  // a save against is the post-reset one, comparing against the old ladder's
  // maxLevelReached would find every stale save perfectly in order.
  //
  // The reset wiped the stats and the checkpoint, but a challenge game left in
  // progress on the old ladder kept its level in a storage family the reset
  // never touched, and the legacy 'normal' checkpoint entry kept the old
  // block. So the player was back at Level 1 while the game still offered to
  // continue from wherever they had been, and finishing that board re-stamped
  // maxLevelReached into the epoch-matched cloud node, out of the reset's reach
  // forever (issue #239).
  //
  // Dropping the save destroys nothing legitimate: challengeSaveIsCurrent is
  // the same gate the resume now applies, so this only removes what would be
  // refused anyway, clearing the artifact rather than leaving it sitting in
  // the slot un-resumable.
  if (stats.challengeArtifactEpoch !== CHALLENGE_250_EPOCH) {
    const savedChallenge = getJSON(gameStateKey('normal'));
    const maxWon = stats.modeStats?.challenge?.maxLevelReached || stats.maxLevelReached || 1;
    if (savedChallenge && !challengeSaveIsCurrent(savedChallenge, maxWon)) {
      clearGameState('normal');
    }
    const cps = getJSON(CHECKPOINT_KEY) || {};
    if (cps.normal != null) {
      delete cps.normal;          // orphaned by checkpointKey's normalization
      setJSON(CHECKPOINT_KEY, cps);
    }
    stats.challengeArtifactEpoch = CHALLENGE_250_EPOCH;
    setJSON(STATS_KEY, stats);
    _statsCache = stats;
    changed = true;
  }

  return changed;
}

// Transient "celebrate the molt day you just earned" flag. The win path sets
// it on an earning completion; the title screen drains it once to show the
// earned popup + the crab-placement animation. Persisted (survives the
// game-over -> title hop and a reload), cleared on consume.
const MOLT_CELEBRATE_KEY = 'minesweeper_molt_celebrate';
export function flagMoltCelebrate() {
  safeSet(MOLT_CELEBRATE_KEY, '1');
}
export function consumeMoltCelebrate() {
  const pending = safeGet(MOLT_CELEBRATE_KEY) === '1';
  if (pending) safeRemove(MOLT_CELEBRATE_KEY);
  return pending;
}

// Length of the maximal run of consecutive ET dates ending at the most
// recent completed date, computed from the authoritative completed-date
// set (users/{uid}/dailyHistory). Pure date math, no storage access.
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
    else break; // gap (or dup, already de-duped), run ends here
  }
  return { streak, lastDate };
}

// Reconcile the locally-stored streak against the authoritative
// completion history. UPWARD-ONLY: raises the stored streak when the
// history implies a longer run than the local counter knows about (an
// offline day that synced late, or a cross-device / uid-split play the
// counter missed). Never LOWERS, a shorter derived run isn't proof of a
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
// Used when the user explicitly switches accounts on this device, the local
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
  // Drop the per-date local caches keyed off the abandoned uid's plays,
  // the new account may have different par / move counts on the same date.
  // The completion's board seed and any replay unlock describe the abandoned
  // account's play, so they go with it; leaving the unlock behind would
  // suppress the new account's own cloud re-lock.
  try { safeRemove(DAILY_COMPLETED_KEY); } catch {}
  try { safeRemove(DAILY_COMPLETED_SEED_KEY); } catch {}
  try { safeRemove(DAILY_REPLAY_UNLOCK_KEY); } catch {}
}

// ── Cloud Progress Merge ──────────────────────────────
// Merges cloud-synced progress into local stats. By default takes the
// higher value for each field so progress only goes up (used on app
// init where local might have unflushed plays).
//
// When `opts.overwrite` is true (used by the real-time listener path
// where cloud IS the authoritative state, any write to users/{uid}
// just landed), values are adopted verbatim including downgrades.
// Otherwise an admin-side correction or a partner-device reset would
// be silently rejected by the max-merge.
export function applyCloudProgress({ maxCheckpoint, dailyStreak, bestDailyStreak, lastDailyDate, powerUps, moltDay, challenge250, weekStreak }, opts = {}) {
  const overwrite = !!opts.overwrite;
  const stats = loadStats();
  let changed = false;

  // Challenge progression adopts ONLY from the `challenge250` node (epoch
  // + maxCheckpoint + the challenge power-up pool, written atomically by
  // post-reset clients, see saveProgress). The legacy top-level
  // `maxCheckpoint` and `powerUps.challenge` fields are pre-reset history
  // by definition: old clients keep writing them, and adopting one on
  // EITHER merge path (the overwrite listener re-applies the cloud on
  // every snapshot) would resurrect the wiped 120-ladder climb or the
  // old hoard. The epoch inside the node guards the NEXT reset the same
  // way.
  const c250 = (challenge250 && typeof challenge250 === 'object'
    && challenge250.epoch === CHALLENGE_250_EPOCH) ? challenge250 : null;
  const cloudCheckpoint = c250 && typeof c250.maxCheckpoint === 'number' ? c250.maxCheckpoint : null;

  // Challenge checkpoint
  if (cloudCheckpoint != null && (overwrite || cloudCheckpoint > (stats.maxLevelReached || 1))) {
    stats.maxLevelReached = cloudCheckpoint;
    if (!stats.modeStats) stats.modeStats = {};
    if (!stats.modeStats.challenge) stats.modeStats.challenge = {};
    stats.modeStats.challenge.maxLevelReached = cloudCheckpoint;
    // Also update the checkpoint storage so the player can select it
    saveCheckpoint('challenge', cloudCheckpoint);
    changed = true;
  }

  // Daily streak sync. The molt-day bank + lastUse ride the SAME snapshot as
  // (dailyStreak, lastDailyDate): whichever side wins by the date-anchor rules
  // supplies ALL of them together, so the bank can never be paired with the
  // other side's streak.
  //   overwrite=true  (listener path): adopt cloud verbatim regardless of date
  //   overwrite=false (initial-load):
  //     - cloud date > local date → adopt cloud's streak + bank + date verbatim
  //       (even if the streak went DOWN, player broke it on another device).
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
    // Adopt cloud's molt fields as a unit, but ONLY when the cloud actually
    // carries molt state. A missing node, or the bare default {banked:0, no
    // lastUse}, is the pre-molt shape every LEGACY account holds: it is absence
    // of information, NOT an authoritative 0. Treating it as a real 0 (the
    // overwrite listener re-applies the cloud on every snapshot) wiped the
    // one-time backfill grant on every boot, so an existing-streak player never
    // kept the molt days they were granted. When the cloud has nothing real to
    // say, keep the local bank: the next completion syncs it up, and a second
    // device converges from the same shared streak (backfillGrant is a pure
    // function of the streak, so both devices compute the same grant).
    const cloudHasMolt = !!cloudMolt && ((cloudMolt.banked || 0) > 0 || !!cloudMolt.lastUse);
    const adoptMolt = () => {
      if (!cloudHasMolt) return;
      daily.moltBanked = cloudMolt.banked || 0;
      daily.moltLastUse = cloudMolt.lastUse || null;
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

  // Week streak. Same WEEK-anchored rules the daily streak uses on dates, and
  // adopted as one snapshot for the same reason:
  //   overwrite=true  (listener): cloud is authoritative, adopt verbatim.
  //   overwrite=false (initial load): cloud week newer → adopt verbatim (even
  //     a SHORTER streak: the other device knows something this one doesn't);
  //     same week → keep the longer; cloud older → keep local.
  // `best` is a high-water mark, so it maxes except under overwrite.
  // A cloud node with no `lastWeek` says nothing about position and is
  // ignored, absence of information is not an authoritative zero (the molt
  // legacy-preserve lesson one field over).
  const cloudWeek = (weekStreak && typeof weekStreak === 'object') ? weekStreak : null;
  if (cloudWeek) {
    const local = readWeekStreak(stats);
    const next = { ...local };
    if (overwrite) {
      if (typeof cloudWeek.lastWeek === 'string') next.lastWeek = cloudWeek.lastWeek;
      if (cloudWeek.streak != null) next.streak = Math.max(0, Number(cloudWeek.streak) || 0);
      if (cloudWeek.best != null) next.best = Math.max(0, Number(cloudWeek.best) || 0);
      changed = true;
    } else if (typeof cloudWeek.lastWeek === 'string') {
      if (!local.lastWeek || cloudWeek.lastWeek > local.lastWeek) {
        next.lastWeek = cloudWeek.lastWeek;
        next.streak = Math.max(0, Number(cloudWeek.streak) || 0);
        changed = true;
      } else if (cloudWeek.lastWeek === local.lastWeek
          && (Number(cloudWeek.streak) || 0) > local.streak) {
        next.streak = Math.max(0, Number(cloudWeek.streak) || 0);
        changed = true;
      }
      const cloudBest = Math.max(0, Number(cloudWeek.best) || 0);
      if (cloudBest > next.best) { next.best = cloudBest; changed = true; }
    }
    stats.weekStreak = next;
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
  // The CHALLENGE pool comes exclusively from the epoch-gated challenge250
  // node (c250 above); the legacy powerUps node's challenge key is
  // pre-reset history and is dropped on the floor here. Non-challenge
  // pools (chaos) still ride the legacy node, the reset never touches
  // them.
  const cloudChallengePU = c250 && c250.powerUps && typeof c250.powerUps === 'object' ? c250.powerUps : null;
  const legacyPU = (powerUps && typeof powerUps === 'object') ? { ...powerUps } : null;
  if (legacyPU) delete legacyPU.challenge;
  const cloudPU = (cloudChallengePU || (legacyPU && Object.keys(legacyPU).length > 0))
    ? { ...(legacyPU || {}), ...(cloudChallengePU ? { challenge: cloudChallengePU } : {}) }
    : null;
  if (cloudPU) {
    const local = getJSON(POWERUPS_KEY, null);
    if (overwrite || !local) {
      // Mode-scoped verbatim: each pool the cloud actually SPEAKS for
      // replaces the local pool wholesale (so an admin zeroing sticks),
      // but a pool the cloud never mentions stays local, absence is
      // absence of information, not an authoritative empty (the moltDay
      // legacy-preserve rule; without this, any listener snapshot from a
      // device that had not synced its pools yet wiped local inventory).
      const base = (local && typeof local === 'object') ? { ...local } : {};
      for (const mode of Object.keys(cloudPU)) base[mode] = cloudPU[mode];
      setJSON(POWERUPS_KEY, base);
      changed = true;
    } else {
      // Max-merge per mode per type.
      let anyChange = false;
      for (const mode of Object.keys(cloudPU)) {
        const cloudMode = cloudPU[mode] || {};
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
  // different gates, stats.modeStats.daily.lastDailyCompletedDate
  // drives the streak math; DAILY_COMPLETED_KEY drives the daily-card
  // "completed" lock, but they should always agree on whether today
  // is done.
  //
  // `lastDailyDate` answers "played a daily today", which is the STREAK fact.
  // It cannot answer "finished today's canonical", which is what the lock
  // actually gates, and those came apart the moment a divergent board could
  // count for the streak while its score was refused. So a proven-divergent
  // completion on this device outranks the cloud's coarser date here. Without
  // this deferral the boot gate's unlock is undone on the next write to
  // users/{uid}, which the listener applies verbatim; a lastSeen beacon does
  // it, so the card would flick back to "completed" seconds after unlocking.
  if (lastDailyDate && typeof lastDailyDate === 'string' && lastDailyDate.length === 10) {
    const today = getLocalDateString();
    if (lastDailyDate === today
        && safeGet(DAILY_COMPLETED_KEY) !== today
        && !isDailyReplayUnlocked(today)) {
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
