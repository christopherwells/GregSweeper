// Pressure-plate interval lifecycle (issue #192, 2026-07-30).
//
// An armed plate's setInterval had exactly two teardowns: newGame(), and the
// tick's own `state.status !== 'playing'` check. Neither fired when the
// player LEFT the board any other way — the Home button (showTitleScreen
// never touches state.status) or switchMode into a mode that RESUMES
// (tryResumeGame sets status right back to 'playing'). The deadline is raw
// wall-clock (`Date.now() - startTime`), so pause never slowed it, and on
// expiry it called the mode-blind handleLoss: a challenge run silently lost
// behind the title screen (the gameover modal lives inside the hidden #app
// and cannot render, while the save is cleared and the level rolls back), or
// an in-progress DAILY ended as a loss — a mode with no loss state at all.
//
// Three-part fix, pinned here at the layers node can reach:
//   1. an IDENTITY GUARD in the tick — the interval self-destructs the
//      moment the live board no longer holds its cell (call-tested below
//      with mock timers);
//   2. teardown in the two leaving-the-board paths, showTitleScreen and
//      switchMode (source-pinned below — both are too DOM/IO-coupled to
//      call whole in node);
//   3. rearm-after-resume in switchMode, matching main.js's init sites.

import './domShim.mjs';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { state } = await import('../src/state/gameState.js');
const { rearmPlateTimers, clearAllPlateTimers, countActivePlateTimers } =
  await import('../src/game/gameActions.js');

function plateBoard() {
  // 3x3, one mine top-left, a revealed undisarmed plate at the center.
  const board = [];
  for (let r = 0; r < 3; r++) {
    const row = [];
    for (let c = 0; c < 3; c++) {
      row.push({
        row: r, col: c,
        isMine: r === 0 && c === 0,
        adjacentMines: 0, isRevealed: false, isFlagged: false,
        isPressurePlate: false, plateDisarmed: false, plateTimer: 0,
      });
    }
    board.push(row);
  }
  const plate = board[1][1];
  plate.isPressurePlate = true;
  plate.isRevealed = true;
  return { board, plate };
}

function armOne() {
  const { board, plate } = plateBoard();
  state.rows = 3; state.cols = 3;
  state.board = board;
  state.status = 'playing';
  rearmPlateTimers();
  return { board, plate };
}

test('control: rearm arms exactly the revealed undisarmed plates, idempotently', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    clearAllPlateTimers();
    armOne();
    assert.equal(countActivePlateTimers(), 1, 'one revealed plate → one interval');
    rearmPlateTimers();
    assert.equal(countActivePlateTimers(), 1, 'rearm is idempotent — no stacked interval');
    clearAllPlateTimers();
    assert.equal(countActivePlateTimers(), 0, 'teardown empties the map');
  } finally {
    mock.timers.reset();
  }
});

test('REGRESSION: an orphaned plate self-destructs instead of ticking another board', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    clearAllPlateTimers();
    armOne();
    assert.equal(countActivePlateTimers(), 1);
    // Simulate the #192 shape: a different game is now live — fresh board,
    // status back to 'playing' (a resumed daily), so the old status guard
    // sees nothing wrong.
    const { board: fresh } = plateBoard();
    state.board = fresh;
    state.status = 'playing';
    mock.timers.tick(250); // one 200ms tick
    assert.equal(countActivePlateTimers(), 0,
      'the orphan must clear itself on its first tick after the board swap');
    assert.equal(state.status, 'playing',
      'and it must never reach handleLoss on the new game');
  } finally {
    mock.timers.reset();
    clearAllPlateTimers();
  }
});

test('the tick still acts on its OWN board (guard is identity, not paranoia)', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    clearAllPlateTimers();
    armOne();
    mock.timers.tick(250);
    assert.equal(countActivePlateTimers(), 1,
      'an undisturbed plate keeps its interval through a tick');
  } finally {
    mock.timers.reset();
    clearAllPlateTimers();
  }
});

test('both leaving-the-board paths tear down, and switchMode re-arms after resume', () => {
  // showTitleScreen and switchMode are too DOM/IO-coupled to call whole in
  // node; pin the wiring at source level so a refactor that drops either
  // call fails loudly.
  const title = readFileSync(new URL('../src/ui/titleScreen.js', import.meta.url), 'utf8');
  const titleBody = title.slice(title.indexOf('export function showTitleScreen'));
  assert.ok(/clearAllPlateTimers\(\)/.test(titleBody.slice(0, titleBody.indexOf('\n}'))),
    'showTitleScreen must clear plate timers — Home leaves status at playing');

  const mode = readFileSync(new URL('../src/game/modeManager.js', import.meta.url), 'utf8');
  const switchBody = mode.slice(mode.indexOf('export function switchMode'));
  assert.ok(switchBody.includes('clearAllPlateTimers()'),
    'switchMode must clear the outgoing game\'s plate timers');
  const resumeCalls = switchBody.match(/rearmPlateTimers\(\)/g) || [];
  assert.ok(resumeCalls.length >= 2,
    'both switchMode resume branches (weekly + general) must re-arm the resumed game\'s plates');
});
