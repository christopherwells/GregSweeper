// Boot background-resume must land PAUSED behind the title screen (issue
// #200 — the #197 leak through the boot door). Three main.js routing
// branches show the title and then warm the saved game up behind it so
// entering is instant (returning user, completed-daily deep link, weekly
// already-played); tryResumeGame ends in the deliberately UNGATED
// startTimer (every other resume site runs with #app visible and must tick
// immediately), so the boot resume left the LCD counting behind the title
// from boot until the player entered the game — title minutes charged to
// the challenge clock (the only slot reachable there, gameMode 'normal'),
// and the worm heartbeat burning movesLeft the player never saw (the
// realized dose the refit fits on). The fix is resumeSaveBehindTitle in
// main.js: pause right AFTER the background resume, landing exactly the
// state Home produces (#197), so entering the game wakes it through the
// entry path's own resume (hideTitleScreen → switchMode → tryResumeGame →
// startTimer + rearmPlateTimers). Plates stay un-armed behind the title —
// a wall-clock plate over a hidden game is the #192 incident shape.
//
// main.js is the entry orchestrator and cannot be imported headless (the
// modeManager lesson: importing it boots the whole app), so the pin is
// two-layered: (1) a SOURCE CONTRACT scan — a routing site's resume must
// match its title surface: behind showTitleScreen only the paused helper,
// the bare ungated pattern only after hideTitleScreen — which FAILS on the
// pre-fix tree (all three boot sites paired showTitleScreen with the bare
// pattern); (2) the helper's BODY is extracted from main.js source and
// executed against the REAL modules (a reverted or rewritten helper fails
// here too, not just in the scan), driving the boot sequence, the #197
// interaction/visibility defeaters, the worm budget freeze, and the entry
// wake. Harness idiom shared with test/titleScreenPause.test.mjs.

import './domShim.mjs';
import { makeStateBoard, stubEl } from './domShim.mjs';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Stats consistent with the save the harness is about to write, so
// challengeSaveIsCurrent lets it resume (see persistMidGameSave).
function seedChallengeProgress(maxLevelReached) {
  // Built FROM loadStats so the record keeps its full shape (bestTimes,
  // modeStats, the rest) — a hand-rolled partial would resume into an
  // updateHeader that reads fields the real store always has.
  invalidateStatsCache?.();
  const stats = loadStats();
  stats.maxLevelReached = maxLevelReached;
  stats.modeStats.challenge.maxLevelReached = maxLevelReached;
  localStorage.setItem('minesweeper_stats', JSON.stringify(stats));
  invalidateStatsCache?.();
}

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

// Route the load-bearing elements; everything else stays a stub. Installed
// BEFORE the imports so call-time lookups resolve against the tracked
// elements (the resumeTimer gate reads #app's hidden class at call time).
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
const { persistGameState, tryResumeGame } = await import('../src/game/gamePersistence.js');
const { newGame } = await import('../src/game/gameActions.js');
const { switchMode } = await import('../src/game/modeManager.js');
const { hatchWorm } = await import('../src/logic/worms.js');
const { getLocalDateString } = await import('../src/logic/seededRandom.js');
const { saveDailyPar, invalidateStatsCache, loadStats } = await import('../src/storage/statsStorage.js');

setMuted(true); // no AudioContext in node

// ── The shipped main.js code under test ────────────────────────────────
const mainSrc = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const helperMatch = mainSrc.match(/async function resumeSaveBehindTitle\(\)\s*\{([\s\S]*?)\n\}/);
// Execute the helper's OWN body with the real modules injected, so the
// behavioral tests below drive the code main.js ships rather than a
// re-typed copy of it. A helper edited to reference anything else throws a
// ReferenceError here, which is the loud failure we want.
const AsyncFunction = (async () => {}).constructor;
const runShippedHelper = helperMatch
  ? new AsyncFunction('tryResumeGame', 'newGame', 'pauseTimer', helperMatch[1])
  : null;
const resumeSaveBehindTitle = () => runShippedHelper(tryResumeGame, newGame, timers.pauseTimer);

// Nearest preceding title-surface call before a source index. Each routing
// branch places its show/hide immediately before its resume, so "nearest"
// is the branch's own surface. Matches the literal call form `xxx();` —
// prose mentions in comments carry no `();`.
function titleSurfaceBefore(idx) {
  const show = mainSrc.lastIndexOf('showTitleScreen();', idx);
  const hide = mainSrc.lastIndexOf('hideTitleScreen();', idx);
  if (show < 0 && hide < 0) return 'none';
  return show > hide ? 'show' : 'hide';
}

function matchIndices(re) {
  const out = [];
  for (const m of mainSrc.matchAll(re)) out.push(m.index);
  return out;
}

const BARE_RESUME = /if \(!tryResumeGame\(\)\) await newGame\(\); else rearmPlateTimers\(\);/g;
const HELPER_CALL = /await resumeSaveBehindTitle\(\);/g;

test('REGRESSION: #200 — no routing site background-resumes a save UNGATED behind showTitleScreen', () => {
  assert.ok(helperMatch, 'main.js must define resumeSaveBehindTitle (the paused boot resume)');
  const body = helperMatch[1];
  assert.match(body, /tryResumeGame\(\)/, 'the helper must attempt the resume');
  assert.match(body, /pauseTimer\(\)/,
    'a successful background resume must land paused — the state Home produces');
  assert.doesNotMatch(body, /rearmPlateTimers/,
    'plates must NOT re-arm behind the title (wall-clock deadline over a hidden game — the #192 shape)');

  const bareSites = matchIndices(BARE_RESUME);
  const helperSites = matchIndices(HELPER_CALL);
  assert.ok(helperSites.length >= 3,
    'the three boot branches (returning user, completed-daily deep link, weekly already-played) must use the paused helper');
  assert.ok(bareSites.length >= 1,
    'the ungated resume must survive for the hideTitleScreen entry paths (control — scan not vacuous)');

  // The contract: the resume a branch runs must match the surface it shows.
  for (const idx of bareSites) {
    assert.equal(titleSurfaceBefore(idx), 'hide',
      'an UNGATED resume (startTimer live) may only follow hideTitleScreen — behind ' +
      'showTitleScreen it ticks the challenge clock and worm budget from boot (issue #200)');
  }
  for (const idx of helperSites) {
    assert.equal(titleSurfaceBefore(idx), 'show',
      'the paused helper belongs behind showTitleScreen — after hideTitleScreen it would hand the player a visibly frozen clock');
  }
});

// ── Behavioral half — the shipped helper against the real modules ───────

// Build a mid-game challenge save and persist it, then wipe the live state
// down to what a fresh boot holds so tryResumeGame's restore does the work.
// The pre-cached daily par keeps showTitleScreen's refreshTitleDailyPar off
// the Firebase / local-generation fallback (titleScreenPause's idiom); call
// AFTER mock.timers.enable so the cache keys on the mocked clock's date.
function persistMidGameSave() {
  localStorage.clear();
  // A challenge save is only resumable at a level this progression can hold
  // (issue #239: the pre-C250 save the epoch reset never reached sat at its
  // old-ladder level while the stats said Level 1). The harness writes a
  // level-5 game, so it has to say the player won level 4 — otherwise the
  // save is correctly refused and the helper falls through to a fresh
  // newGame, which is not what these tests are pinning.
  seedChallengeProgress(4);
  appEl.classes.clear();
  titleEl.classes.clear(); titleEl.classList.add('hidden');
  overlayEl.classes.clear(); overlayEl.classList.add('hidden');
  state.status = 'playing';
  state.gameMode = 'normal';
  state.isDailyPractice = false;
  state.isArchivePlay = false;
  state.isLevelPractice = false;
  state.currentLevel = 5;
  state.elapsedTime = 40;
  state.board = makeStateBoard(3, 3);
  for (const row of state.board) for (const cell of row) cell.isRevealed = true; // walkable for worms
  state.rows = 3; state.cols = 3;
  state.totalMines = 0;
  state.flagCount = 0;
  state.revealedCount = 9;
  state.worms = [hatchWorm(1, 1, 'test-seed')];
  state.wormEvents = [];
  state.activeGimmicks = [];
  state.gimmickData = {};
  state.idlePaused = false;
  state.modalPaused = false;
  state.timerId = null;
  state.wormTimerId = null;
  state.mineShiftTimerId = null;
  timers.stopMineShift();
  timers.seedPreciseAccumulated(0);
  saveDailyPar(getLocalDateString(), 30, 10, { cellCount: 81, totalMines: 12 });
  persistGameState();
  const movesPersisted = state.worms[0].movesLeft;
  // Fresh-boot live state: nothing loaded yet, gameMode at its default.
  state.status = 'idle';
  state.board = [];
  state.worms = [];
  state.elapsedTime = 0;
  return movesPersisted;
}

const MOCK_APIS = { apis: ['setTimeout', 'setInterval', 'Date'] };

// Mock clock starts at a real instant, not epoch 0 — startTimer records
// lastInteractionTime = Date.now(), and a falsy 0 disarms the idle check.
function enableMockClock() {
  mock.timers.enable(MOCK_APIS);
  mock.timers.setTime(1_000_000);
}

test('REGRESSION: #200 — the boot background-resume lands frozen behind the title, through the #197 defeaters', async () => {
  enableMockClock();
  try {
    const movesPersisted = persistMidGameSave();
    // The boot routing sequence at all three sites: title first, then the
    // background resume through the shipped helper.
    showTitleScreen();
    await resumeSaveBehindTitle();
    // The save was adopted (a fresh newGame would report elapsedTime 0 and
    // an empty worm list — this precondition keeps the freeze pin honest)…
    assert.equal(state.elapsedTime, 40, 'the persisted challenge game must be the one resumed');
    assert.equal(state.worms.length, 1, 'the live worm must rehydrate with the save');
    assert.equal(state.status, 'playing', 'the warm game keeps its status (the #197 pause is interval teardown, not status)');
    // …and it is PAUSED, not ticking (pre-fix: timerId + wormTimerId armed).
    assert.equal(state.timerId, null, 'the challenge clock must not run behind the title screen');
    assert.equal(state.wormTimerId, null, 'the worm heartbeat must not run behind the title screen');
    // The #197 defeaters, aimed at the boot door this time: any title tap
    // fires recordInteraction, any tab return fires resumeTimer.
    timers.recordInteraction();
    timers.resumeTimer();
    assert.equal(state.timerId, null, 'title-screen interaction must not wake the background-resumed game');
    mock.timers.tick(120000); // two minutes deciding what to play
    assert.equal(state.elapsedTime, 40,
      'elapsedTime must stay frozen from boot until the player enters the game');
    assert.equal(state.worms[0].movesLeft, movesPersisted,
      'the worm move budget must not burn behind the title (realized dose the refit fits on)');
  } finally { mock.timers.reset(); }
});

test('entering the game wakes the boot-resumed save from its frozen value (the entry path, not a special case)', async () => {
  enableMockClock();
  try {
    persistMidGameSave();
    showTitleScreen();
    await resumeSaveBehindTitle();
    assert.equal(state.timerId, null, 'precondition: paused behind the title');
    // The Resume button's path: hideTitleScreen un-hides #app, then
    // switchMode re-runs the resume — whose ungated startTimer is exactly
    // what wakes the clock. No boot-specific wake plumbing to maintain.
    hideTitleScreen();
    switchMode('normal');
    assert.ok(state.timerId, 'the entry resume restarts the clock');
    assert.ok(state.wormTimerId, 'the entry resume restarts the worm heartbeat');
    assert.equal(state.elapsedTime, 40, 'the clock wakes from the frozen value, no title time charged');
    mock.timers.tick(3000);
    assert.equal(state.elapsedTime, 43, 'ticking resumes at one second per second');
  } finally { mock.timers.reset(); }
});

test('control: an ordinary in-game resume (#app visible) still ticks immediately — startTimer stays ungated', async () => {
  enableMockClock();
  try {
    persistMidGameSave();
    // #app visible: the mid-game resume shape (mode switch, reload straight
    // into a deep-linked game) that must NOT inherit the boot pause.
    appEl.classes.clear();
    state.gameMode = 'normal';
    assert.ok(tryResumeGame(), 'the save must resume');
    assert.ok(state.timerId, 'the visible-game resume starts the clock at once');
    mock.timers.tick(5000);
    assert.equal(state.elapsedTime, 45, 'clock ticks immediately after an in-game resume');
  } finally { mock.timers.reset(); }
});
