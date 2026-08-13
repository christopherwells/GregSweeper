import { state, clearCoastlinePractice } from '../state/gameState.js';
import { $ } from '../ui/domHelpers.js';
import { newGame, clearAllPlateTimers, rearmPlateTimers } from './gameActions.js';
import { persistGameState, tryResumeGame } from './gamePersistence.js';
import { loadCheckpoint, loadStats } from '../storage/statsStorage.js';
import { CHAOS_UNLOCK_LEVEL } from '../logic/difficulty.js';
import { matchRulesForLaunch, matchUnlocks } from '../logic/matchRules.js';
import { restorePreChaosTheme } from '../ui/themeManager.js';

// ── Mode Manager ──────────────────────────────────────

const boardContainer = $('#board-container');
const powerUpBar = $('#powerup-bar');
const gameHeader = $('#game-header');
const gameInfoBar = $('#game-info-bar');
const progressBarContainer = $('#progress-bar-container');
const chaosModifierBar = $('#chaos-modifier-bar');

export function updateModeUI(mode) {
  // Chaos modifier bar
  if (chaosModifierBar) {
    chaosModifierBar.classList.toggle('hidden', mode !== 'chaos');
  }

  // Power-ups hidden in chaos, weekly, and matches. Weekly is a time-trial
  // against a fixed board, letting players cheese with power-ups on later
  // attempts would defeat the bestTime leaderboard; a match's clocks feed
  // the match total (and, next PR, an opponent's comparison), so the same
  // economy applies, and the inventory is zeroed there anyway.
  if (powerUpBar) {
    if (mode === 'chaos' || mode === 'weekly' || mode === 'match') {
      powerUpBar.classList.add('hidden');
    } else {
      powerUpBar.classList.remove('hidden');
    }
  }

  // Progress bar hidden in chaos mode
  if (progressBarContainer) {
    if (mode === 'chaos') {
      progressBarContainer.classList.add('hidden');
    }
  }

  // Normal board visibility (Skill Trainer mode was removed 2026-05-13)
  if (gameHeader) gameHeader.classList.remove('hidden');
  if (gameInfoBar) gameInfoBar.classList.remove('hidden');
  if (boardContainer) boardContainer.classList.remove('hidden');
}

export function switchMode(mode) {
  // Save current game state before switching (guard is inside persistGameState)
  persistGameState();

  // The outgoing game's pressure-plate intervals must die here (issue
  // #192): their deadline is raw wall-clock and their only self-check is
  // `state.status !== 'playing'`, which a successful tryResumeGame below
  // sets right back to 'playing', so an orphaned plate would keep counting
  // through the mode switch and detonate handleLoss on the RESUMED game
  // (a daily has no loss state at all). The resumed game's own plates are
  // re-armed fresh below, matching the init-time resume sites in main.js.
  clearAllPlateTimers();

  // If we were in chaos and aren't anymore, undo the chaos theme override
  // before the new mode takes effect. Without this, returning to title later
  // could re-apply a stale "previous theme" over a theme the player chose
  // while in the intervening mode.
  if (state.gameMode === 'chaos' && mode !== 'chaos') {
    restorePreChaosTheme();
  }

  state.gameMode = mode;
  // A normal mode switch is never an archive replay (those go through
  // launchDailyArchive). Clear the flag so a resumed real daily can't
  // inherit a prior archive's identity and submit to the wrong path.
  state.isArchivePlay = false;
  state._archiveRaw = null;
  // Same for a past-weekly replay (those go through launchWeeklyArchive), so a
  // resumed real weekly can't inherit a past week's identity.
  state.isWeeklyArchive = false;
  state._weeklyArchiveRaw = null;
  // Likewise never a ?level= playtest (that flag is set only by the
  // test-build deep link), a real challenge entered afterward must record.
  state.isLevelPractice = false;
  state.climbBoardIndex = null;
  // Never carry a ?coastline= tiling practice into a real mode either.
  clearCoastlinePractice();
  updateModeUI(mode);

  // Chaos mode: always start a fresh run (no resume)
  if (mode === 'chaos') {
    state.chaosRound = 1;
    state.chaosTotalTime = 0;
    state.chaosModifiers = [];
    state.currentLevel = 1;
    newGame();
    return;
  }

  // Weekly mode: try to resume an in-progress attempt for today's day
  // index, otherwise start fresh. The resume check inside tryResumeGame
  // confirms `weeklySeed` and `weeklyDay` match the live values.
  if (mode === 'weekly') {
    if (!tryResumeGame(mode)) newGame();
    else rearmPlateTimers();
    return;
  }

  // Try to resume saved state for the target mode
  if (tryResumeGame(mode)) {
    rearmPlateTimers();
  } else {
    if (mode === 'normal') {
      // Fall back to last checkpoint (not Level 1) so mobile swipe-kill
      // doesn't lose all progress
      state.currentLevel = loadCheckpoint('challenge');
    } else {
      state.currentLevel = 1;
    }
    newGame();
  }
}

/**
 * Launch a Challenge match from the setup sheet's rules. Its own entry
 * path, the launchDailyArchive pattern, rather than a switchMode branch:
 * the outgoing game persists FIRST (so pre-setting match state cannot
 * forge its snapshot), then the match structure installs and newGame's
 * match branch deals. Rules are re-sanitized here against the CURRENT
 * unlocks, so a stale or hand-edited payload can never reach outside them
 * (his rule: the host's filter is the rules).
 *
 * A pinned board (?matchboard=, test-env) rides in as pinnedEntries with
 * isLevelPractice already set: the deal is skipped and nothing records.
 *
 * A SHARED match arrives with `shared` = { id, code, expiresAt, rules,
 * entries }, whose identity rides inside state.match and therefore inside the
 * save: the id is what every posted result needs, and the expiry is what stops
 * a stale run resuming into a node that will refuse it. A solo match passes
 * null and carries none of it, which is exactly what "solo" means to every
 * gate downstream. Its boards come in through `shared.entries` rather than
 * `pinnedEntries` so the two never blur: pinned means the test-env practice
 * board, and practice records nothing.
 */
export function launchMatch(rawRules, pinnedEntries = null, shared = null) {
  persistGameState();
  if (state.gameMode === 'chaos') restorePreChaosTheme();
  clearAllPlateTimers();
  const stats = loadStats();
  const maxLevel = stats.modeStats?.challenge?.maxLevelReached || 1;
  // Host re-sanitizes, guest plays the stored rules verbatim; the reasoning is
  // in matchRulesForLaunch, where a test can reach it.
  const rules = matchRulesForLaunch(rawRules, shared, matchUnlocks(maxLevel));
  const sharedEntries = (shared && Array.isArray(shared.entries)) ? shared.entries : null;
  const entries = sharedEntries || (Array.isArray(pinnedEntries) ? pinnedEntries : []);
  if (entries.length) rules.count = entries.length;
  state.gameMode = 'match';
  state.match = {
    rules,
    entries,
    // A RESUME carries the run's progress in from the match node, so
    // re-entering an unfinished shared match continues it instead of
    // restarting at board 1 and overwriting every result already posted
    // under its index (issue #317). A fresh launch passes neither and gets
    // the empty run these defaults describe.
    current: (shared && Number.isInteger(shared.current)) ? shared.current : 0,
    results: (shared && Array.isArray(shared.results)) ? shared.results : [],
    id: (shared && shared.id) || null,
    code: (shared && shared.code) || null,
    expiresAt: (shared && shared.expiresAt) || null,
  };
  // A shared match is never the pinned practice lane, and clearing the flag
  // here rather than trusting the caller keeps a stale practice run from
  // silently swallowing a real match's results.
  if (shared) state.isLevelPractice = false;
  state.isArchivePlay = false;
  state._archiveRaw = null;
  state.isWeeklyArchive = false;
  state._weeklyArchiveRaw = null;
  state.climbBoardIndex = null;
  clearCoastlinePractice();
  updateModeUI('match');
  newGame();
}

/** Resume a saved mid-board match from the setup sheet's Resume slot. */
export function resumeMatch() {
  persistGameState();
  if (state.gameMode === 'chaos') restorePreChaosTheme();
  clearAllPlateTimers();
  state.gameMode = 'match';
  state.isArchivePlay = false;
  state._archiveRaw = null;
  state.isWeeklyArchive = false;
  state._weeklyArchiveRaw = null;
  state.isLevelPractice = false;
  state.climbBoardIndex = null;
  clearCoastlinePractice();
  updateModeUI('match');
  if (!tryResumeGame('match')) {
    // The save went stale between the sheet's offer and the tap; a fresh
    // match under the saved rules beats a dead end.
    const saved = state.match;
    state.match = null;
    launchMatch(saved && saved.rules ? saved.rules : null);
    return;
  }
  rearmPlateTimers();
}

/**
 * Launch a replay of a PAST daily. The date's canonical `raw` is already
 * fetched and validated by the calendar caller (archive has no local-gen
 * fallback). Unlike switchMode('daily'), this does NOT resume the saved real
 * daily: it forces a fresh newGame with the archive flag and the caller-set
 * past date. The outgoing real game is persisted first, so returning to
 * today's daily resumes intact.
 *
 * @param {string} date YYYY-MM-DD (ET) of the past board
 * @param {Object} raw  serialized canonical board from loadDailyBoard
 */
export function launchDailyArchive(date, raw) {
  persistGameState();
  if (state.gameMode === 'chaos') restorePreChaosTheme();
  state.gameMode = 'daily';
  state.isDailyPractice = false;
  state.isArchivePlay = true;
  state.dailySeed = date;
  state._archiveRaw = { date, raw };
  updateModeUI('daily');
  newGame();
}

/**
 * Launch a replay of a PAST weekly, the weekly's counterpart to
 * launchDailyArchive, and deliberately its mirror image rather than a variant
 * of switchMode('weekly'): that path resumes this week's in-progress attempt,
 * which is exactly what a past week must not touch.
 *
 * The week's canonical `raw` is already fetched by the list caller (a past
 * week has no local-gen fallback). The outgoing game is persisted first, so
 * an in-progress real weekly attempt survives the detour and resumes intact.
 *
 * @param {string} weekStart YYYY-MM-DD Monday of the past week
 * @param {Object} raw       serialized canonical board from loadWeeklyBoard
 */
export function launchWeeklyArchive(weekStart, raw) {
  persistGameState();
  if (state.gameMode === 'chaos') restorePreChaosTheme();
  state.gameMode = 'weekly';
  state.isArchivePlay = false;
  state._archiveRaw = null;
  state.isWeeklyArchive = true;
  state.weeklySeed = weekStart;
  state._weeklyArchiveRaw = { weekStart, raw };
  state.isLevelPractice = false;
  state.climbBoardIndex = null;
  clearCoastlinePractice();
  updateModeUI('weekly');
  newGame();
}

export function isChaosUnlocked() {
  const stats = loadStats();
  const maxLevel = stats.modeStats?.challenge?.maxLevelReached || 1;
  return maxLevel >= CHAOS_UNLOCK_LEVEL;
}

