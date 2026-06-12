// Locked-cell certification oracle (closed 2026-06-12). The certifier
// used to auto-reveal a freed locked cell via isMine ground truth; in
// gameplay the player must CLICK it, and without a proof that click is
// a guess. These tests pin the honest behavior with the counterexample
// the old code certified wrongly: a locked cell in a perfect 50/50.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBoardSolvable } from '../src/logic/boardSolver.js';

function makeBoard(rows, cols, { mines = [], locked = [] } = {}) {
  const board = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      row.push({
        isMine: false, isLocked: false, isRevealed: false, isFlagged: false,
        adjacentMines: 0, displayedMines: null,
      });
    }
    board.push(row);
  }
  for (const [r, c] of mines) board[r][c].isMine = true;
  for (const [r, c] of locked) board[r][c].isLocked = true;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (board[r][c].isMine) continue;
    let n = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < rows && cc >= 0 && cc < cols && board[rr][cc].isMine) n++;
    }
    board[r][c].adjacentMines = n;
  }
  return board;
}

test('THE COUNTEREXAMPLE: a freed locked cell in a 50/50 must NOT certify', () => {
  // 3x2. Top row: locked SAFE cell at (0,0), mine at (0,1). First click
  // (2,0) cascades the bottom two rows. The two informants (1,0) and
  // (1,1) then both read "1 mine among {(0,0),(0,1)}" - identical
  // constraints, a perfect 50/50. The lock at (0,0) opens (mines do not
  // block unlocking), but no deduction can prove it safe. The old
  // oracle revealed it anyway via ground truth and certified the board.
  const board = makeBoard(3, 2, { mines: [[0, 1]], locked: [[0, 0]] });
  const res = isBoardSolvable(board, 3, 2, 2, 0);
  assert.equal(res.solvable, false, 'a 50/50 behind a lock is a guess, not a solve');
  assert.equal(res.remainingUnknowns, 1);
  // Counter integrity: the guards must not count or spin on the
  // unclickable cell - only the first click happened.
  assert.equal(res.totalClicks, 1);
});

test('a PROVABLE freed locked cell still certifies (and is counted)', () => {
  // Zero mines: the cascade reveals everything unlocked, the lock
  // opens, and the adjacent ZEROS prove the freed cell safe (zeros are
  // real constraints when a lock blocked the flood). Solvable, with
  // the reveal counted as a click.
  const board = makeBoard(3, 3, { mines: [], locked: [[0, 0]] });
  const res = isBoardSolvable(board, 3, 3, 2, 2);
  assert.equal(res.solvable, true);
  assert.equal(res.totalClicks, 2, 'first click + the proven locked reveal');
});

test('locked MINE: provably a mine, never needs a click - certifies', () => {
  // Lone mine at (0,0), locked. The flood reveals every safe cell
  // including all three informants reading 1 over the single unknown
  // {(0,0)} - provably a mine, flag knowledge, no click required.
  const board = makeBoard(3, 3, { mines: [[0, 0]], locked: [[0, 0]] });
  const res = isBoardSolvable(board, 3, 3, 2, 2);
  assert.equal(res.solvable, true);
});
