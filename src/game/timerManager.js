import { state, getActiveBombPenaltyTotal, getDisplayTime } from '../state/gameState.js';
import { timerEl, boardEl } from '../ui/domHelpers.js';
import { updateAllCells } from '../ui/boardRenderer.js';
import { performMineShift } from '../logic/gimmicks.js';
import { hatchWorm, tickWorms, wormHatchEvent, markWormBurrowed, finalizeWormEvents } from '../logic/worms.js';
import { renderWormOverlays } from '../ui/wormRenderer.js';
import { playWormBurrow, playWormHatch } from '../audio/sounds.js';

// ── Timer ──────────────────────────────────────────────
// The displayed value comes from gameState.getDisplayTime() — the
// penalty-inclusive single source of truth shared with headerRenderer's
// updateHeader, so the two timer writers can never disagree.

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
    // generous (60s, IDLE_PAUSE_MS) — short enough that AFK doesn't
    // bleed seconds but long enough that hard thinking on a sticky
    // board doesn't false-trigger.
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
  stopWormCrawl();
  // stopTimer only runs at true teardown (win/loss/newGame/expiry — pauses
  // go through pauseTimer), so live worms end here and the overlay clears
  // before receipts paint the board. Hatch events are finalized FIRST
  // (exact realized moves need the live worms' movesLeft) so the score
  // submission that follows a win carries the completed log.
  if (state.worms && state.worms.length > 0) {
    state.wormEvents = finalizeWormEvents(state.wormEvents, state.worms);
    state.worms = [];
    renderWormOverlays();
  }
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
  // Worm clocks only advance inside the heartbeat, so clearing it freezes
  // every worm mid-countdown; resume picks up exactly where they paused.
  if (state.wormTimerId) {
    clearInterval(state.wormTimerId);
    state.wormTimerId = null;
  }
}

export function resumeTimer() {
  if (state.status !== 'playing') return;
  // A blocking popup owns the pause. Don't let visibilitychange / idle
  // interaction restart the clock behind it — the popup clears this
  // flag itself right before its own resumeTimer call.
  if (state.modalPaused) return;
  // The game surface being off screen IS the "player left the board"
  // condition (issue #197): showTitleScreen pauses the clock, and this gate
  // is what keeps it paused — the document-level interaction listeners call
  // recordInteraction on any title-screen tap and visibilitychange fires on
  // any tab return, and either would silently restart the hidden game's
  // clock (title-screen minutes then rode the auto-persist into the save
  // and the submitted daily/{date} time). Read from #app rather than
  // tracked as a flag so no entry path has to remember to clear it: every
  // return to the game un-hides #app before restarting the clock, and the
  // resume-from-save sites call startTimer directly, which this never
  // gates. The status guard above cannot carry this: status stays
  // 'playing' behind the title screen (persistGameState only saves
  // playing/idle games, so flipping it would drop the Home-path save —
  // the wider status question is deferred in #197).
  const app = document.getElementById('app');
  if (app && app.classList && app.classList.contains('hidden')) return;
  // Restart game timer if not already running
  if (!state.timerId) {
    _preciseStartTime = Date.now(); // resume precise tracking
    startTimer();
  }
  // Restart mine shift if it was active
  if (!state.mineShiftTimerId && _mineShiftInterval) {
    startMineShift(_mineShiftInterval);
  }
  // Restart the worm heartbeat if any worms are alive (state.worms is the
  // presence signal — no stored interval needed, the cadence is per-worm)
  if (!state.wormTimerId && state.worms && state.worms.length > 0) {
    startWormCrawl();
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

// ── Worm Crawl Heartbeat ──────────────────────────────
// One 250ms heartbeat drives every live worm; each worm carries its own
// 0.5-3s move countdown (see logic/worms.js), so the heartbeat just advances
// clocks and steps the worms that are due. Started on the first hatch
// (gameActions) and on resume; torn down by stopTimer alongside mineShift.

const WORM_TICK_MS = 250;

export function startWormCrawl() {
  if (state.wormTimerId) return;
  if (!state.worms || state.worms.length === 0) return;
  state.wormTimerId = setInterval(() => {
    // modalPaused: a blocking popup (modifier intro, strike verdict) owns
    // the pause — the game clock stops, so worm clocks stop with it.
    if (state.status !== 'playing' || state.modalPaused) return;
    // Walkable cells report their TRUE adjacent-mine count (the worm smells
    // actual mines, not liar-displayed values); null = not walkable. The
    // mine-aversion weighting in stepWorm steers on this.
    const numberAt = (r, c) => {
      if (r < 0 || r >= state.rows || c < 0 || c >= state.cols) return null;
      const cell = state.board[r] && state.board[r][c];
      if (!cell || !cell.isRevealed) return null;
      return cell.adjacentMines || 0;
    };
    // On a tiling the worm walks the neighbor graph with geometric momentum, so
    // hand tickWorms the board's topology (neighbors + positions). Null on an
    // ordinary rectangular board, where stepWorm keeps its dr/dc walk verbatim.
    const cols = state.cols;
    const topology = state.board && state.board._cellNeighbors ? {
      neighborsOf: (r, c) => state.board._cellNeighbors[r * cols + c]
        .map(idx => ({ r: Math.floor(idx / cols), c: idx % cols })),
      posOf: (r, c) => { const p = state.board._cellPos[r * cols + c]; return { x: p.cx, y: p.cy }; },
    } : null;
    const { moved, burrowed } = tickWorms(state.worms, WORM_TICK_MS, numberAt, undefined, topology);
    if (burrowed.length > 0) {
      playWormBurrow();
      for (const w of burrowed) markWormBurrowed(state.wormEvents, w, state.elapsedTime);
    }
    if (moved.length > 0 || burrowed.length > 0) renderWormOverlays();
    if (state.worms.length === 0) stopWormCrawl();
  }, WORM_TICK_MS);
}

export function stopWormCrawl() {
  if (state.wormTimerId) {
    clearInterval(state.wormTimerId);
    state.wormTimerId = null;
  }
}

// Hatch any just-revealed worm eggs in a reveal batch. Called from every
// player-path reveal site (reveal cascade, chord, Reveal Safe) AFTER
// revealWormholePairs has folded pair/cascade reveals into the batch.
// Reveal batches only ever contain newly revealed cells, so an egg can't
// double-hatch. Worm length is seeded from the board identity (same
// canonical board ⇒ same lengths for every player); the walk is luck.
export function hatchWormEggs(revealedCells) {
  if (!revealedCells || revealedCells.length === 0) return;
  const seedIdentity = state.dailyRngSeed || state.weeklyRngSeed || `L${state.currentLevel}`;
  let hatched = 0;
  for (const cell of revealedCells) {
    if (!cell || !cell.isWormEgg || cell.isMine || !cell.isRevealed) continue;
    state.worms.push(hatchWorm(cell.row, cell.col, seedIdentity));
    // Instrumentation: WHEN the worm appeared decides how much of its
    // scheduled load a run actually experiences — the refit fits on the
    // realized dose, never the schedule (see wormHatchEvent in worms.js).
    state.wormEvents.push(wormHatchEvent(state.elapsedTime, cell.row, cell.col, seedIdentity));
    hatched++;
  }
  if (hatched > 0) {
    playWormHatch();
    renderWormOverlays();
    startWormCrawl();
  }
}
