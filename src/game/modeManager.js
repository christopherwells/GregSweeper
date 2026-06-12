import { state } from '../state/gameState.js';
import { $, $$ } from '../ui/domHelpers.js';
import { newGame } from './gameActions.js';
import { persistGameState, tryResumeGame } from './gamePersistence.js';
import { loadCheckpoint, loadStats } from '../storage/statsStorage.js';
import { CHAOS_UNLOCK_LEVEL } from '../logic/difficulty.js';
import { restorePreChaosTheme } from '../main.js';

// ── Mode Manager ──────────────────────────────────────

const timedDiffPanel = $('#timed-difficulty');
const timedSizeTabs = $('#timed-size-tabs');
const boardContainer = $('#board-container');
const powerUpBar = $('#powerup-bar');
const gameHeader = $('#game-header');
const gameInfoBar = $('#game-info-bar');
const progressBarContainer = $('#progress-bar-container');
const chaosModifierBar = $('#chaos-modifier-bar');

export function updateTimedDiffVisibility() {
  if (timedDiffPanel) {
    if (state.gameMode === 'timed') {
      timedDiffPanel.classList.remove('hidden');
    } else {
      timedDiffPanel.classList.add('hidden');
    }
  }
}

export function updateModeUI(mode) {
  // Quick Play size tabs
  if (timedSizeTabs) {
    timedSizeTabs.classList.toggle('hidden', mode !== 'timed');
  }

  if (mode === 'timed') {
    // Sync active tab highlight to match state.currentLevel
    for (const t of document.querySelectorAll('.timed-tab')) {
      const isActive = parseInt(t.dataset.level, 10) === state.currentLevel;
      t.classList.toggle('active', isActive);
      t.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
  }

  // Chaos modifier bar
  if (chaosModifierBar) {
    chaosModifierBar.classList.toggle('hidden', mode !== 'chaos');
  }

  // Power-ups hidden in chaos and weekly. Weekly is a time-trial against
  // a fixed board — letting players cheese with power-ups on later
  // attempts would defeat the bestTime leaderboard.
  if (powerUpBar) {
    if (mode === 'chaos' || mode === 'weekly') {
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

  // If we were in chaos and aren't anymore, undo the chaos theme override
  // before the new mode takes effect. Without this, returning to title later
  // could re-apply a stale "previous theme" over a theme the player chose
  // while in the intervening mode.
  if (state.gameMode === 'chaos' && mode !== 'chaos') {
    restorePreChaosTheme();
  }

  state.gameMode = mode;
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
    return;
  }

  // Try to resume saved state for the target mode
  if (!tryResumeGame(mode)) {
    if (mode === 'normal') {
      // Fall back to last checkpoint (not Level 1) so mobile swipe-kill
      // doesn't lose all progress
      state.currentLevel = loadCheckpoint('challenge');
    } else if (mode !== 'timed') {
      state.currentLevel = 1;
    }
    newGame();
  }
}

export function isChaosUnlocked() {
  const stats = loadStats();
  const maxLevel = stats.modeStats?.challenge?.maxLevelReached || 1;
  return maxLevel >= CHAOS_UNLOCK_LEVEL;
}

export function syncTimedDiffButtons() {
  for (const d of $$('.timed-diff-btn')) {
    d.classList.toggle('active', parseInt(d.dataset.level, 10) === state.currentLevel);
  }
}
