import { state } from '../state/gameState.js?v=0.9';
import { $, $$ } from '../ui/domHelpers.js?v=0.9';
import { newGame } from './gameActions.js?v=0.9';
import { persistGameState, tryResumeGame } from './gamePersistence.js?v=0.9';

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

export function updateTimedDiffVisibility() {
  if (timedDiffPanel) {
    if (state.gameMode === 'timed') {
      timedDiffPanel.classList.remove('hidden');
    } else {
      timedDiffPanel.classList.add('hidden');
    }
  }
}

function updateModeUI(mode) {
  // Timed size tabs
  if (timedSizeTabs) {
    timedSizeTabs.classList.toggle('hidden', mode !== 'timed');
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
    import('../ui/skillTrainerUI.js?v=0.9').then(m => m.showSkillTrainer());
  } else {
    if (gameHeader) gameHeader.classList.remove('hidden');
    if (gameInfoBar) gameInfoBar.classList.remove('hidden');
    if (boardContainer) boardContainer.classList.remove('hidden');
    if (skillTrainerContainer) skillTrainerContainer.classList.add('hidden');
    // Hide skill trainer if it was showing
    import('../ui/skillTrainerUI.js?v=0.9').then(m => m.hideSkillTrainer()).catch(() => {});
  }
}

export function switchMode(mode) {
  // Save current game state before switching (if playing)
  if (state.status === 'playing') {
    persistGameState();
  }

  state.gameMode = mode;
  if (mode !== 'timed') state.currentLevel = 1;
  for (const m of $$('.mode-btn')) m.classList.toggle('active', m.dataset.mode === mode);
  for (const p of $$('.mode-pill')) p.classList.toggle('active', p.dataset.mode === mode);
  updateTimedDiffVisibility();
  updateModeUI(mode);

  // Skill trainer doesn't use normal game flow
  if (mode === 'skillTrainer') return;

  // Try to resume saved state for the target mode
  if (!tryResumeGame(mode)) {
    newGame();
  }
}

export function syncTimedDiffButtons() {
  for (const d of $$('.timed-diff-btn')) {
    d.classList.toggle('active', parseInt(d.dataset.level, 10) === state.currentLevel);
  }
}
