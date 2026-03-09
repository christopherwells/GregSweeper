import { state } from '../state/gameState.js?v=0.9.1';
import {
  $, $$, mineCounterEl, levelDisplay, checkpointDisplay,
  streakDisplayEl, cellsRemainingEl, progressBarContainer,
  progressBarFill, progressBarMarkers, bestTimeDisplay,
  maxLevelDisplay, resetBtn, streakBorder,
  flagModeBar, flagModeToggle, flagModeIcon, flagModeLabel,
} from './domHelpers.js?v=0.9.1';
import { getThemeEmoji } from './boardRenderer.js?v=0.9.1';
import { getTimedDifficulty, getSpeedRating, MAX_LEVEL } from '../logic/difficulty.js?v=0.9.1';
import { loadStats } from '../storage/statsStorage.js?v=0.9.1';

// ── Checkpoint Display ─────────────────────────────────
export const CHECKPOINT_INTERVAL = 5;

export function getCheckpointForLevel(level) {
  return Math.floor((level - 1) / CHECKPOINT_INTERVAL) * CHECKPOINT_INTERVAL + 1;
}

export function updateCheckpointDisplay() {
  if (!checkpointDisplay) return;
  const isLevelMode = state.gameMode === 'normal';
  if (isLevelMode && state.checkpoint > 1) {
    checkpointDisplay.textContent = `🏁 CP ${state.checkpoint}`;
    checkpointDisplay.classList.remove('hidden');
  } else {
    checkpointDisplay.classList.add('hidden');
  }
}

export function updateProgressBar() {
  if (!progressBarContainer) return;
  const isLevelMode = state.gameMode === 'normal';
  if (!isLevelMode) {
    progressBarContainer.classList.add('hidden');
    return;
  }
  progressBarContainer.classList.remove('hidden');
  const pct = ((state.currentLevel - 1) / (MAX_LEVEL - 1)) * 100;
  progressBarFill.style.width = `${pct}%`;

  // Render checkpoint markers
  if (progressBarMarkers) {
    progressBarMarkers.innerHTML = '';
    for (let cp = CHECKPOINT_INTERVAL + 1; cp <= MAX_LEVEL; cp += CHECKPOINT_INTERVAL) {
      const marker = document.createElement('div');
      marker.className = 'checkpoint-marker';
      if (state.currentLevel >= cp) marker.classList.add('reached');
      marker.style.left = `${((cp - 1) / (MAX_LEVEL - 1)) * 100}%`;
      progressBarMarkers.appendChild(marker);
    }
  }
}

export function updateCellsRemaining() {
  if (!cellsRemainingEl) return;
  if (state.status === 'playing') {
    const totalSafe = state.rows * state.cols - state.totalMines;
    const remaining = totalSafe - state.revealedCount;
    if (remaining > 0) {
      cellsRemainingEl.textContent = `${remaining} left`;
      cellsRemainingEl.classList.remove('hidden');
    } else {
      cellsRemainingEl.classList.add('hidden');
    }
  } else {
    cellsRemainingEl.classList.add('hidden');
  }
}

export function updateStreakDisplay() {
  if (!streakDisplayEl) return;
  const stats = loadStats();
  const streak = stats.currentStreak || 0;
  if (streak >= 2) {
    streakDisplayEl.textContent = `🔥 ${streak}`;
    streakDisplayEl.classList.remove('hidden');
  } else {
    streakDisplayEl.classList.add('hidden');
  }
}

export function updateHeader() {
  const remaining = state.totalMines - state.flagCount;
  if (remaining < 0) {
    mineCounterEl.textContent = '-' + String(Math.abs(remaining)).padStart(2, '0');
  } else {
    mineCounterEl.textContent = String(remaining).padStart(3, '0');
  }
  updateTimerDisplayInHeader();

  // Level display
  if (state.gameMode === 'daily') {
    levelDisplay.textContent = '📅 Daily';
  } else if (state.gameMode === 'timed') {
    const tdiff = getTimedDifficulty(state.currentLevel);
    levelDisplay.textContent = tdiff.label || `Level ${state.currentLevel}`;
  } else {
    levelDisplay.textContent = `Level ${state.currentLevel}`;
  }

  updateCheckpointDisplay();
  updateProgressBar();
  updateCellsRemaining();
  updateStreakDisplay();

  // Show best time for timed/normal mode (with speed rating for timed)
  const stats = loadStats();
  if (bestTimeDisplay) {
    const bestKey = `level${state.currentLevel}`;
    const best = stats.bestTimes[bestKey];
    if (best != null && (state.gameMode === 'timed' || state.gameMode === 'normal')) {
      if (state.gameMode === 'timed') {
        const rating = getSpeedRating(state.currentLevel, best);
        bestTimeDisplay.textContent = `Best: ${best}s ${rating.icon}`;
      } else {
        bestTimeDisplay.textContent = `Best: ${best}s`;
      }
      bestTimeDisplay.classList.remove('hidden');
    } else {
      bestTimeDisplay.classList.add('hidden');
    }
  }

  // Show max level reached in normal mode
  if (maxLevelDisplay) {
    const maxLevel = stats.maxLevelReached || 1;
    if (state.gameMode === 'normal' && maxLevel > 1) {
      maxLevelDisplay.textContent = `Peak: ${maxLevel}`;
      maxLevelDisplay.classList.remove('hidden');
    } else {
      maxLevelDisplay.classList.add('hidden');
    }
  }

  if (state.status === 'won') resetBtn.textContent = getThemeEmoji('smileyWin');
  else if (state.status === 'lost') resetBtn.textContent = getThemeEmoji('smileyLoss');
  else resetBtn.textContent = getThemeEmoji('smiley');
}

// ── Streak Fire Effect ─────────────────────────────────

export function updateStreakBorder() {
  if (!streakBorder) return;
  const stats = loadStats();
  const streak = stats.currentStreak || 0;
  const prevStreak = streakBorder.dataset.prevStreak ? parseInt(streakBorder.dataset.prevStreak) : 0;

  streakBorder.classList.remove('active', 'streak-1', 'streak-2', 'streak-3');

  if (streak >= 5) {
    streakBorder.classList.add('active', 'streak-3');
  } else if (streak >= 3) {
    streakBorder.classList.add('active', 'streak-2');
  } else if (streak >= 2) {
    streakBorder.classList.add('active', 'streak-1');
  }

  // Streak shake animation when streak increases
  if (streak > prevStreak && streak >= 2) {
    streakBorder.classList.remove('streak-shake');
    void streakBorder.offsetWidth;
    streakBorder.classList.add('streak-shake');
    setTimeout(() => streakBorder.classList.remove('streak-shake'), 500);
  }
  streakBorder.dataset.prevStreak = streak;
}

// ── Flag Mode Toggle ──────────────────────────────────

export function updateFlagModeBar() {
  if (!flagModeBar) return;
  // Only show on touch devices during gameplay
  const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (isTouchDevice && state.status !== 'won' && state.status !== 'lost') {
    flagModeBar.classList.remove('hidden');
  } else {
    flagModeBar.classList.add('hidden');
  }
  if (flagModeToggle) {
    flagModeToggle.classList.toggle('flag-active', state.flagMode);
  }
  if (flagModeIcon) {
    flagModeIcon.textContent = state.flagMode ? '🚩' : '👆';
  }
  if (flagModeLabel) {
    flagModeLabel.textContent = state.flagMode ? 'Tap to Flag' : 'Tap to Reveal';
  }
}

// Internal: updateHeader calls updateTimerDisplay for the timer section
// Import from timerManager would be circular, so we inline the display logic
function updateTimerDisplayInHeader() {
  const timerEl = document.getElementById('timer-display');
  if (!timerEl) return;
  const display = Math.min(state.elapsedTime, 999);
  timerEl.textContent = String(display).padStart(3, '0');
  timerEl.classList.remove('timer-critical', 'timer-warning');
}
