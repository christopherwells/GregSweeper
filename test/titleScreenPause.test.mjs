// Tapping Home must pause the game clock (issue #197 — the second
// consequence of the #192 root "showTitleScreen never changes state.status").
// showTitleScreen persisted the save and cleared plate timers but never
// called pauseTimer, so the 1s tick kept incrementing elapsedTime behind the
// title screen, the 5s auto-persist wrote the inflated time into the save,
// the worm heartbeat kept burning movesLeft (the REALIZED dose the refit
// fits on — moves the player never saw), and a resumed daily folded
// title-screen minutes into the preciseTime submitted to the write-once
// daily/{date} row and the par fit. The naive fix (pauseTimer alone) is
// defeated by the document-level interaction listeners: recordInteraction
// fires on ANY pointerdown/keydown, and visibilitychange→visible calls
// resumeTimer on any tab return — either would silently restart the hidden
// game's clock. So resumeTimer refuses while #app carries .hidden (the
// structural "player left the board" condition; no flag to forget to clear).
//
// domShim call-test: #app / #title-screen / #idle-pause-overlay get REAL
// class tracking (the gate reads #app's hidden class; the overlay pin reads
// its visibility); every other DOM lookup keeps the shim's chainable stub.

import './domShim.mjs';
import { makeStateBoard, stubEl } from './domShim.mjs';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

function trackedEl() {
  const classes = new Set();
  return {
    classes,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
      contains: (c) => classes.has(c),
      replace: () => {},
    },
  };
}

const appEl = trackedEl();
const titleEl = trackedEl();
const overlayEl = trackedEl();

// Route the three load-bearing elements; everything else stays a stub.
// Installed BEFORE the imports so call-time lookups ($ and getElementById
// both read the live document) resolve against the tracked elements.
const routed = { app: appEl, 'title-screen': titleEl, 'idle-pause-overlay': overlayEl };
globalThis.document.getElementById = (id) => routed[id] || stubEl();
globalThis.document.querySelector = (sel) => {
  const key = String(sel).startsWith('#') ? String(sel).slice(1) : String(sel);
  return routed[key] || stubEl();
};

const { state } = await import('../src/state/gameState.js');
const { setMuted } = await import('../src/audio/sounds.js');
const timers = await import('../src/game/timerManager.js');
const { showTitleScreen, hideTitleScreen } = await import('../src/ui/titleScreen.js');
const { hatchWorm } = await import('../src/logic/worms.js');
const { getLocalDateString } = await import('../src/logic/seededRandom.js');
const { saveDailyPar } = await import('../src/storage/statsStorage.js');

setMuted(true); // no AudioContext in node

// Reset game state + the module-level timer accumulators to "mid-game".
// Call AFTER mock.timers.enable so the pre-cached par features key on the
// mocked clock's date — the cache is what keeps refreshTitleDailyPar off
// the Firebase / local-generation fallback (neither exists under the shim,
// and the fallback would run the full seed-selection solver in a unit test).
function freshGame() {
  appEl.classes.clear();                                    // #app visible (in-game)
  titleEl.classes.clear(); titleEl.classList.add('hidden'); // title hidden
  overlayEl.classes.clear(); overlayEl.classList.add('hidden');
  state.status = 'playing';
  state.gameMode = 'normal';
  state.currentLevel = 5;
  state.elapsedTime = 40;
  state.board = makeStateBoard(3, 3);
  state.rows = 3; state.cols = 3;
  state.totalMines = 0;
  state.worms = [];
  state.wormEvents = [];
  state.idlePaused = false;
  state.modalPaused = false;
  state.isArchivePlay = false;
  state.isLevelPractice = false;
  state.timerId = null;
  state.wormTimerId = null;
  state.mineShiftTimerId = null;
  timers.stopMineShift();            // clear the remembered chaos interval
  timers.seedPreciseAccumulated(0);  // reset the module-level accumulator
  saveDailyPar(getLocalDateString(), 30, 10, { cellCount: 81, totalMines: 12 });
}

function revealAll() {
  for (const row of state.board) for (const cell of row) cell.isRevealed = true;
}

const MOCK_APIS = { apis: ['setTimeout', 'setInterval', 'Date'] };

// The mock clock starts at epoch 0, and startTimer records
// lastInteractionTime = Date.now() — a FALSY 0 that disarms the idle check
// (`if (state.lastInteractionTime && ...)`). Start the clock at a real
// instant so the idle-pause machinery behaves as it does live.
function enableMockClock() {
  mock.timers.enable(MOCK_APIS);
  mock.timers.setTime(1_000_000);
}

test('control: the clock, mine-shift, and worm heartbeat all tick while playing', () => {
  enableMockClock();
  try {
    freshGame();
    revealAll();
    state.worms = [hatchWorm(1, 1, 'test-seed')];
    const movesBefore = state.worms[0].movesLeft;
    timers.startTimer();
    timers.startMineShift(300); // chaos-style interval; long enough never to fire here
    timers.startWormCrawl();
    mock.timers.tick(10000);
    assert.equal(state.elapsedTime, 50, 'clock ticks while playing');
    assert.ok(state.worms[0].movesLeft < movesBefore, 'worm burns moves while playing');
    assert.ok(state.mineShiftTimerId, 'mine-shift interval armed');
  } finally { mock.timers.reset(); }
});

test('REGRESSION: Home (showTitleScreen) freezes elapsedTime and tears down every game interval', () => {
  enableMockClock();
  try {
    freshGame();
    revealAll();
    state.worms = [hatchWorm(1, 1, 'test-seed')];
    timers.startTimer();
    timers.startMineShift(300);
    timers.startWormCrawl();
    mock.timers.tick(2000); // 40 → 42 before Home
    showTitleScreen();
    assert.equal(state.timerId, null, 'timer interval torn down');
    assert.equal(state.mineShiftTimerId, null, 'mine-shift interval torn down');
    assert.equal(state.wormTimerId, null, 'worm heartbeat torn down');
    const frozenTime = state.elapsedTime;
    const frozenMoves = state.worms[0].movesLeft;
    mock.timers.tick(120000); // a two-minute leaderboard visit
    assert.equal(state.elapsedTime, frozenTime,
      'elapsedTime must not grow on the title screen (it rides the auto-persist into the submitted daily time)');
    assert.equal(state.worms[0].movesLeft, frozenMoves,
      'worm move budget must not burn on the title screen (realized dose the refit fits on)');
  } finally { mock.timers.reset(); }
});

test('REGRESSION: title-screen interaction cannot restart the hidden game\'s clock', () => {
  enableMockClock();
  try {
    freshGame();
    timers.startTimer();
    mock.timers.tick(2000);
    showTitleScreen();
    const frozen = state.elapsedTime;
    // What the document-level pointerdown/keydown listeners call on ANY tap:
    timers.recordInteraction();
    // What the visibilitychange→visible handler calls on ANY tab return
    // (status is still 'playing' and idlePaused is false, so pre-gate this
    // restarted the clock unconditionally):
    timers.resumeTimer();
    assert.equal(state.timerId, null, 'resumeTimer must refuse while #app is hidden');
    mock.timers.tick(60000);
    assert.equal(state.elapsedTime, frozen, 'clock stays frozen through title-screen interaction');
  } finally { mock.timers.reset(); }
});

// Not a REGRESSION pin: this path was already safe pre-fix (the idle pause
// had stopped the clock and showTitleScreen's idlePaused reset kept
// recordInteraction from resuming). It pins the COMBINED contract so neither
// layer (the reset, the #app gate) can be dropped without a failure here.
test('an idle-paused game taken Home stays paused through title taps', () => {
  enableMockClock();
  try {
    freshGame();
    timers.startTimer();
    mock.timers.tick(61000); // no interaction → the 60s idle pause fires in-game
    assert.equal(state.idlePaused, true, 'precondition: idle pause engaged on the game surface');
    showTitleScreen();
    assert.equal(state.idlePaused, false, 'showTitleScreen clears the idle-pause state');
    assert.ok(overlayEl.classList.contains('hidden'), 'overlay hidden with the title screen up');
    const frozen = state.elapsedTime;
    timers.recordInteraction(); // first tap on the title screen
    assert.equal(state.timerId, null, 'the tap must not restart the hidden clock');
    mock.timers.tick(60000);
    assert.equal(state.elapsedTime, frozen);
  } finally { mock.timers.reset(); }
});

test('REGRESSION: the idle-pause overlay can no longer appear over the title screen', () => {
  enableMockClock();
  try {
    freshGame();
    timers.startTimer();
    mock.timers.tick(2000);
    showTitleScreen();
    mock.timers.tick(10 * 60000); // ten minutes reading the Journal
    assert.equal(state.idlePaused, false,
      'no interval survives Home, so _pauseForIdle has nothing to fire from');
    assert.ok(overlayEl.classList.contains('hidden'),
      'the full-screen Paused card must never land on top of the title screen');
  } finally { mock.timers.reset(); }
});

test('returning to the game restarts the clock, the worm crawl, and the mine shift', () => {
  enableMockClock();
  try {
    freshGame();
    revealAll();
    state.worms = [hatchWorm(1, 1, 'test-seed')];
    timers.startTimer();
    timers.startMineShift(300);
    timers.startWormCrawl();
    mock.timers.tick(2000);
    showTitleScreen();
    assert.equal(state.timerId, null);
    // The return path: hideTitleScreen un-hides #app FIRST, then the resume
    // site restarts the clock (tryResumeGame → startTimer + startWormCrawl;
    // in-game popup dismissals go through resumeTimer). Both must work
    // post-gate — a gate keyed on anything but live #app visibility would
    // leave the resumed game's clock dead.
    hideTitleScreen();
    timers.resumeTimer();
    assert.ok(state.timerId, 'clock restarted once #app is visible again');
    assert.ok(state.wormTimerId, 'worm heartbeat restarted');
    assert.ok(state.mineShiftTimerId, 'mine-shift interval restarted');
    const t = state.elapsedTime;
    mock.timers.tick(3000);
    assert.equal(state.elapsedTime, t + 3, 'clock ticks again after the return');
  } finally { mock.timers.reset(); }
});
