import { state } from '../state/gameState.js?v=0.9';
import { timerEl, boardEl } from '../ui/domHelpers.js?v=0.9';
import {
  getRefogTimeout, computeRefogCells, computeVisibleCells,
} from '../logic/fogOfWar.js?v=0.9';
import { getRevealedCells } from '../state/gameState.js?v=0.9';
import { updateAllCells } from '../ui/boardRenderer.js?v=0.9';
import { updateHeader } from '../ui/headerRenderer.js?v=0.9';
import { performMineShift } from '../logic/gimmicks.js?v=0.9';

// ── Timer ──────────────────────────────────────────────

export function getDisplayTime() {
  // Timed mode always counts up now (no countdown)
  return Math.min(state.elapsedTime, 999);
}

export function updateTimerDisplay() {
  const display = getDisplayTime();
  timerEl.textContent = String(display).padStart(3, '0');
  // No urgency classes — timed mode counts up
  timerEl.classList.remove('timer-critical', 'timer-warning');
}

export function startTimer() {
  if (state.timerId) return;
  state.timerId = setInterval(() => {
    state.elapsedTime++;
    updateTimerDisplay();
    // Timer tick pulse
    timerEl.classList.remove('timer-tick');
    void timerEl.offsetWidth;
    timerEl.classList.add('timer-tick');
    setTimeout(() => timerEl.classList.remove('timer-tick'), 300);
  }, 1000);
}

export function stopTimer() {
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  timerEl.classList.remove('timer-critical', 'timer-warning');
  stopCreepingFog();
  stopMineShift();
}

// ── Creeping Fog ──────────────────────────────────────

export function startCreepingFog() {
  if (state.refogTimerId) return;
  state.refogTimerId = setInterval(() => {
    if (state.status !== 'playing' || !state.fogOfWarEnabled) return;

    const timeout = getRefogTimeout(state.currentLevel);
    const now = Date.now();
    const toRefog = computeRefogCells(state.board, state.cellTimestamps, now, timeout);

    if (toRefog.length > 0) {
      for (const cell of toRefog) {
        cell.isRevealed = false;
        state.revealedCount = Math.max(0, state.revealedCount - 1);
        delete state.cellTimestamps[`${cell.row},${cell.col}`];
      }
      // Recompute fog visibility
      const allRevealed = getRevealedCells();
      state.visibleCells = computeVisibleCells(allRevealed, state.fogRadius, state.rows, state.cols);
      updateAllCells();
      updateHeader();
    }
  }, 2000); // Check every 2 seconds
}

export function stopCreepingFog() {
  if (state.refogTimerId) {
    clearInterval(state.refogTimerId);
    state.refogTimerId = null;
  }
}

// ── Mine Shift Timer ──────────────────────────────────

export function startMineShift(intervalSeconds) {
  if (state.mineShiftTimerId) return;
  state.mineShiftTimerId = setInterval(() => {
    if (state.status !== 'playing') return;
    const shifted = performMineShift(state.board);
    if (shifted.length > 0) {
      // Brief shimmer on all unrevealed cells
      for (const child of boardEl.children) {
        if (child.classList.contains('unrevealed')) {
          child.classList.add('mine-shift-shimmer');
          setTimeout(() => child.classList.remove('mine-shift-shimmer'), 600);
        }
      }
      updateAllCells();
      updateHeader();
    }
  }, intervalSeconds * 1000);
}

export function stopMineShift() {
  if (state.mineShiftTimerId) {
    clearInterval(state.mineShiftTimerId);
    state.mineShiftTimerId = null;
  }
}
