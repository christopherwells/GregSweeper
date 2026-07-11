// The header's "N left" count (2026-07-11 audit): only locked SAFE cells
// subtract from the revealable total. A locked MINE is already excluded via
// totalMines — the old count subtracted it twice, so the counter read low
// on any locked board whose lock sat on a mine.

import './domShim.mjs';
import { makeStateBoard } from './domShim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { computeRemainingSafe } = await import('../src/ui/headerRenderer.js');

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
