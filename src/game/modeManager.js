import { state } from '../state/gameState.js?v=0.9';
import { $, $$ } from '../ui/domHelpers.js?v=0.9';
import { newGame } from './gameActions.js?v=0.9';
import { persistGameState, tryResumeGame } from './gamePersistence.js?v=0.9';

// ── Mode Manager ──────────────────────────────────────

const timedDiffPanel = $('#timed-difficulty');

export function updateTimedDiffVisibility() {
  if (timedDiffPanel) {
    if (state.gameMode === 'timed') {
      timedDiffPanel.classList.remove('hidden');
    } else {
      timedDiffPanel.classList.add('hidden');
    }
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
