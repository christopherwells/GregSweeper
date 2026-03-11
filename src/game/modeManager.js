import { state } from '../state/gameState.js?v=1.0';
import { $, $$ } from '../ui/domHelpers.js?v=1.0';
import { newGame } from './gameActions.js?v=1.0';
import { persistGameState, tryResumeGame } from './gamePersistence.js?v=1.0';
import { loadCheckpoint, loadStats } from '../storage/statsStorage.js?v=1.0';
import { CHAOS_UNLOCK_LEVEL } from '../logic/difficulty.js?v=1.0';

// ── Mode Manager ──────────────────────────────────────

const timedDiffPanel = $('#timed-difficulty');
const timedSizeTabs = $('#timed-size-tabs');
const skillTrainerContainer = $('#skill-trainer-container');
const boardContainer = $('#board-container');
const powerUpBar = $('#powerup-bar');
const flagModeBar = $('#flag-mode-bar');
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
  // Quick Play size tabs + timer toggle
  if (timedSizeTabs) {
    timedSizeTabs.classList.toggle('hidden', mode !== 'timed');
  }

  // Reset timer visibility when leaving Quick Play
  const timerEl = document.getElementById('timer-display');
  const timerToggle = document.getElementById('timer-toggle');
  if (mode !== 'timed') {
    state.timerHidden = false;
    if (timerEl) timerEl.style.visibility = 'visible';
    if (timerToggle) timerToggle.classList.remove('timer-off');
  } else {
    // Restore Quick Play timer state
    if (timerEl) timerEl.style.visibility = state.timerHidden ? 'hidden' : 'visible';
    if (timerToggle) timerToggle.classList.toggle('timer-off', state.timerHidden);
    // Sync active tab highlight to match state.currentLevel
    for (const t of document.querySelectorAll('.timed-tab')) {
      t.classList.toggle('active', parseInt(t.dataset.level, 10) === state.currentLevel);
    }
  }

  // Chaos modifier bar
  if (chaosModifierBar) {
    chaosModifierBar.classList.toggle('hidden', mode !== 'chaos');
  }

  // Power-ups hidden in chaos mode
  if (powerUpBar) {
    if (mode === 'chaos' || mode === 'skillTrainer') {
      powerUpBar.classList.add('hidden');
    } else {
      // Only show if not skill trainer (other modes manage visibility themselves)
    }
  }

  // Progress bar hidden in chaos mode
  if (progressBarContainer) {
    if (mode === 'chaos') {
      progressBarContainer.classList.add('hidden');
    }
  }

  // Skill trainer vs board visibility
  if (mode === 'skillTrainer') {
    if (gameHeader) gameHeader.classList.add('hidden');
    if (gameInfoBar) gameInfoBar.classList.add('hidden');
    if (progressBarContainer) progressBarContainer.classList.add('hidden');
    if (boardContainer) boardContainer.classList.add('hidden');
    if (powerUpBar) powerUpBar.classList.add('hidden');
    if (flagModeBar) flagModeBar.classList.add('hidden');
    // Lazy-load skill trainer UI
    import('../ui/skillTrainerUI.js?v=1.0.1').then(m => m.showSkillTrainer()).catch(err => {
      console.error('Failed to load Skill Trainer:', err);
      const c = document.getElementById('skill-trainer-container');
      if (c) { c.classList.remove('hidden'); c.innerHTML = '<p style="padding:20px;color:#ff6b6b;">Failed to load Skill Trainer. Try Settings → Clear Cache & Reload.</p>'; }
    });
  } else {
    if (gameHeader) gameHeader.classList.remove('hidden');
    if (gameInfoBar) gameInfoBar.classList.remove('hidden');
    if (boardContainer) boardContainer.classList.remove('hidden');
    if (skillTrainerContainer) skillTrainerContainer.classList.add('hidden');
    // Hide skill trainer if it was showing
    import('../ui/skillTrainerUI.js?v=1.0.1').then(m => m.hideSkillTrainer()).catch(() => {});
  }
}

export function switchMode(mode) {
  // Save current game state before switching (guard is inside persistGameState)
  persistGameState();

  state.gameMode = mode;
  updateModeUI(mode);

  // Skill trainer doesn't use normal game flow
  if (mode === 'skillTrainer') return;

  // Chaos mode: always start a fresh run (no resume)
  if (mode === 'chaos') {
    state.chaosRound = 1;
    state.chaosTotalTime = 0;
    state.chaosModifiers = [];
    state.currentLevel = 1;
    newGame();
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
