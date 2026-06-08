import { state, getActiveBombPenaltyTotal } from '../state/gameState.js';
import { timerEl, boardEl } from '../ui/domHelpers.js';
import { updateAllCells } from '../ui/boardRenderer.js';
import { performMineShift } from '../logic/gimmicks.js';

// ── Timer ──────────────────────────────────────────────

export function getDisplayTime() {
  // elapsedTime is PURE wall-clock (tick-driven). The daily/weekly bomb
  // penalty is held separately in the hit-event log and added here so the
  // live timer jumps by the penalty on a hit without mutating the
  // wall-clock counter (which would double-count on auto-save/restore).
  // Timed mode counts up; getActiveBombPenaltyTotal is 0 outside daily/weekly.
  return Math.min(Math.floor(state.elapsedTime + getActiveBombPenaltyTotal()), 999);
}

export function updateTimerDisplay() {
  const display = getDisplayTime();
  timerEl.textContent = String(display).padStart(3, '0');
  // No urgency classes — timed mode counts up
  timerEl.classList.remove('timer-critical', 'timer-warning');
}

let _preciseStartTime = null;
let _preciseAccumulated = 0; // accumulated ms from previous pause/resume cycles

// Idle-pause threshold. If the player goes this long without ANY input
// (pointer/key/throttled-move) while the game is playing, we pause the
// timer and surface a "Paused" overlay so they don't lose seconds to
// being AFK. Resume happens on the next input event.
const IDLE_PAUSE_MS = 60000;

function _pauseForIdle() {
  if (state.idlePaused) return;
  if (state.status !== 'playing') return;
  state.idlePaused = true;
  pauseTimer();
  const overlay = document.getElementById('idle-pause-overlay');
  if (overlay) overlay.classList.remove('hidden');
}

// Called from main.js's document-level pointer/key listeners. Refreshes
// the idle clock and, if we WERE paused, unpauses and dismisses the
// overlay. Safe to call on every interaction — cheap.
export function recordInteraction() {
  state.lastInteractionTime = Date.now();
  if (state.idlePaused) {
    state.idlePaused = false;
    const overlay = document.getElementById('idle-pause-overlay');
    if (overlay) overlay.classList.add('hidden');
    if (state.status === 'playing') resumeTimer();
  }
}

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
  // Initialize the idle-pause clock on every (re)start so a player who
  // had a long gap between hitting Play and looking at the board
  // doesn't immediately pause on the first tick.
  state.lastInteractionTime = Date.now();
  if (state.timerId) return;
  let tickActive = false;
  state.timerId = setInterval(() => {
    state.elapsedTime++;
    updateTimerDisplay();
    // Idle-pause check after the elapsedTime bump so we don't pause
    // mid-tick before incrementing. The threshold is intentionally
    // generous (30s) — short enough that AFK doesn't bleed seconds
    // but long enough that hard thinking on a sticky board doesn't
    // false-trigger.
    if (state.lastInteractionTime && Date.now() - state.lastInteractionTime > IDLE_PAUSE_MS) {
      _pauseForIdle();
      return; // pauseTimer already cleared the interval; don't run the pulse
    }
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
  // Compute precise elapsed time in tenths of a second. Three cases:
  // 1. Timer running normally — _preciseStartTime set; combine with any
  //    accumulated pause history.
  // 2. Timer was paused at stop (idle-pause or visibility hide) —
  //    _preciseStartTime is null but _preciseAccumulated still has the
  //    real elapsed up to the pause. Commit that.
  // 3. Already stopped — both null/zero; preserve the previous
  //    preciseTime so a defensive double-stopTimer call doesn't blow
  //    away the winning time.
  // The bomb penalty (daily/weekly) lives outside the wall-clock
  // accumulator, so fold it into preciseTime exactly when we commit the
  // wall-clock value. Doing it here (not in the win handler) keeps the
  // final time penalty-inclusive no matter which path stops the timer,
  // and the no-op third branch below preserves an already-penalised
  // preciseTime so a defensive double-stopTimer can't drop or double it.
  const bombPenalty = getActiveBombPenaltyTotal();
  if (_preciseStartTime !== null) {
    const totalMs = _preciseAccumulated + (Date.now() - _preciseStartTime);
    state.preciseTime = Math.round((totalMs / 1000 + bombPenalty) * 10) / 10;
    _preciseStartTime = null;
    _preciseAccumulated = 0;
  } else if (_preciseAccumulated > 0) {
    state.preciseTime = Math.round((_preciseAccumulated / 1000 + bombPenalty) * 10) / 10;
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
  // A blocking popup owns the pause. Don't let visibilitychange / idle
  // interaction restart the clock behind it — the popup clears this
  // flag itself right before its own resumeTimer call.
  if (state.modalPaused) return;
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
