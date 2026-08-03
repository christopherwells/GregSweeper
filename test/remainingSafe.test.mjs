// headerRenderer's pure counter exports.
//
// computeRemainingSafe — the "N left" count (2026-07-11 audit): only locked
// SAFE cells subtract from the revealable total. A locked MINE is already
// excluded via totalMines — the old count subtracted it twice, so the
// counter read low on any locked board whose lock sat on a mine.
//
// mineCounterRemaining — the LCD mine counter (Christopher's report,
// 2026-08-02, from the Par Lab battery): a strike is a free flag, but the
// old counter subtracted strikes from per-mode bombHits state behind a
// daily/weekly gate, so a Par Lab strike (gameMode 'normal', practice lane)
// never reached the display and the LCD sat stuck at the original count —
// useless as an endgame mine-counting clue. Strikes now count from the
// BOARD (cell.isStrike), mode-blind.

import './domShim.mjs';
import { makeStateBoard } from './domShim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { computeRemainingSafe, mineCounterRemaining } = await import('../src/ui/headerRenderer.js');

test('REGRESSION: a locked MINE is not double-subtracted from the remaining count', () => {
  // 3x3, two mines. One mine is locked, one safe cell is locked, two safe
  // cells are revealed. Revealable-safe = 9 - 2 mines - 1 locked safe
  // - 2 revealed = 4. The old count also subtracted the locked mine → 3.
  const board = makeStateBoard(3, 3, [[0, 0], [2, 2]]);
  board[0][0].isLocked = true; // locked MINE — already excluded via totalMines
  board[1][1].isLocked = true; // locked safe cell — legitimately barred
  board[0][1].isRevealed = true;
  board[0][2].isRevealed = true;
  assert.equal(computeRemainingSafe(board, 3, 3, 2, 2), 4);
});

test('an unlocked / revealed lock stops subtracting', () => {
  const board = makeStateBoard(2, 2, [[0, 0]]);
  board[1][1].isLocked = true;
  board[1][1].isRevealed = true; // opened — no longer barred
  assert.equal(computeRemainingSafe(board, 2, 2, 1, 1), 2);
});

test('a plain board is total minus mines minus revealed', () => {
  const board = makeStateBoard(2, 2, [[0, 0]]);
  board[0][1].isRevealed = true;
  assert.equal(computeRemainingSafe(board, 2, 2, 1, 1), 2);
});

test('REGRESSION: strike cells subtract from the mine counter — from the board, in every mode', () => {
  // The old gate read state.dailyBombHits/weeklyBombHits only when gameMode
  // was daily/weekly; a Par Lab strike incremented those but rendered as
  // gameMode 'normal', so the counter never moved. The pure function has no
  // mode input at all — that absence IS the fix.
  const board = makeStateBoard(3, 3, [[0, 0], [1, 1], [2, 2]]);
  board[0][0].isRevealed = true;
  board[0][0].isStrike = true; // struck mine: revealed, confirmed, accounted
  assert.equal(mineCounterRemaining(board, 3, 0), 2, 'one strike accounts one mine');
  board[2][2].isFlagged = true;
  assert.equal(mineCounterRemaining(board, 3, 1), 1, 'flags and strikes account independently');
  board[1][1].isRevealed = true;
  board[1][1].isStrike = true;
  assert.equal(mineCounterRemaining(board, 3, 1), 0, 'a second strike in the same run keeps counting');
});

test('the mine counter survives a missing board (boot) and can go negative on over-flagging', () => {
  assert.equal(mineCounterRemaining(null, 10, 3), 7, 'pre-board boot renders totalMines - flags');
  const board = makeStateBoard(2, 2, [[0, 0]]);
  board[0][1].isFlagged = true;
  board[1][0].isFlagged = true;
  assert.equal(mineCounterRemaining(board, 1, 2), -1, 'over-flagging still reads negative, as before');
});
