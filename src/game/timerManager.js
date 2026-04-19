import { state } from '../state/gameState.js';
import { timerEl, boardEl } from '../ui/domHelpers.js';
import { updateAllCells } from '../ui/boardRenderer.js';
import { performMineShift } from '../logic/gimmicks.js';

// ── Timer ──────────────────────────────────────────────

export function getDisplayTime() {
  // Timed mode always counts up now (no countdown)
  return Math.min(Math.floor(state.elapsedTime), 999);
}

export function updateTimerDisplay() {
  const display = getDisplayTime();
  timerEl.textContent = String(display).padStart(3, '0');
  // No urgency classes — timed mode counts up
  timerEl.classList.remove('timer-critical', 'timer-warning');
}

let _preciseStartTime = null;
let _preciseAccumulated = 0; // accumulated ms from previous pause/resume cycles

// Resuming a persisted game restores state.elapsedTime (whole seconds) but
// _preciseAccumulated lives in module scope and resets to 0. Without seeding
// it from the restored time, leaderboard submissions for resumed Daily
// games would submit only the time elapsed AFTER resume.
export function seedPreciseAccumulated(seconds) {
  _preciseAccumulated = (seconds || 0) * 1000;
  _preciseStartTime = null;
}

export function startTimer() {
  if (!_preciseStartTime) _preciseStartTime = Date.now();
  if (state.timerId) return;
  let tickActive = false;
  state.timerId = setInterval(() => {
    state.elapsedTime++;
    updateTimerDisplay();
    // Timer tick pulse (no forced reflow — use class toggle)
    if (!tickActive) {
      tickActive = true;
      timerEl.classList.add('timer-tick');
      setTimeout(() => {
        timerEl.classList.remove('timer-tick');
        tickActive = false;
      }, 300);
    }
  }, 1000);
}

export function stopTimer() {
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  // Compute precise elapsed time in tenths of a second
  if (_preciseStartTime) {
    const totalMs = _preciseAccumulated + (Date.now() - _preciseStartTime);
    state.preciseTime = Math.round(totalMs / 100) / 10; // round to tenths
    _preciseStartTime = null;
    _preciseAccumulated = 0;
  }
  timerEl.classList.remove('timer-critical', 'timer-warning');
  stopMineShift();
}

// ── Pause / Resume (visibility change) ────────────────

let _mineShiftInterval = null; // stored so we can restart on resume

export function pauseTimer() {
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  // Accumulate precise time on pause
  if (_preciseStartTime) {
    _preciseAccumulated += Date.now() - _preciseStartTime;
    _preciseStartTime = null;
  }
  if (state.mineShiftTimerId) {
    clearInterval(state.mineShiftTimerId);
    state.mineShiftTimerId = null;
  }
}

export function resumeTimer() {
  if (state.status !== 'playing') return;
  // Restart game timer if not already running
  if (!state.timerId) {
    _preciseStartTime = Date.now(); // resume precise tracking
    startTimer();
  }
  // Restart mine shift if it was active
  if (!state.mineShiftTimerId && _mineShiftInterval) {
    startMineShift(_mineShiftInterval);
  }
}

// ── Mine Shift Timer ──────────────────────────────────

export function startMineShift(intervalSeconds) {
  _mineShiftInterval = intervalSeconds; // remember for resume
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
    }
  }, intervalSeconds * 1000);
}

export function stopMineShift() {
  if (state.mineShiftTimerId) {
    clearInterval(state.mineShiftTimerId);
    state.mineShiftTimerId = null;
  }
  _mineShiftInterval = null;
}
