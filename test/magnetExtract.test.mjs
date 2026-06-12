// Magnet = EXTRACTION, not relocation (no-guess contract fix,
// 2026-06-11). The old relocation moved mines onto undisclosed cells —
// including proven-safe ones — and could certify a safe cell as a
// provable mine via the liar display clamp. Extraction is information-
// monotone: mines only leave, numbers only drop. These tests pin that
// no mine is ever ADDED anywhere by a magnet pull.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { magnetPull } from '../src/logic/powerUps.js';

function makeBoard(rows, cols, mines) {
  const board = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      row.push({ isMine: false, isRevealed: false, isFlagged: false, adjacentMines: 0, displayedMines: null });
    }
    board.push(row);
  }
  for (const [r, c] of mines) board[r][c].isMine = true;
  // adjacency
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

const countMines = (b) => b.flat().filter(c => c.isMine).length;

test('extraction removes mines from the board — none relocated anywhere', () => {
  const board = makeBoard(5, 5, [[1, 1], [2, 2], [4, 4]]);
  const before = countMines(board);
  const { extractedMines } = magnetPull(board, 2, 2);
  // 3x3 around (2,2) holds (1,1) and (2,2).
  assert.equal(extractedMines.length, 2);
  assert.equal(countMines(board), before - 2, 'mines must LEAVE, not move');
  assert.equal(board[4][4].isMine, true, 'outside mine untouched');
});

test('extracted cells reveal as defused markers', () => {
  const board = makeBoard(5, 5, [[2, 2]]);
  magnetPull(board, 2, 2);
  const cell = board[2][2];
  assert.equal(cell.isMine, false);
  assert.equal(cell.isDefused, true);
  assert.equal(cell.isRevealed, true);
});

test('adjacency recomputes after extraction (numbers only drop)', () => {
  const board = makeBoard(5, 5, [[2, 2], [0, 0]]);
  assert.equal(board[1][1].adjacentMines, 2);
  magnetPull(board, 2, 2); // extracts only (2,2); (0,0) is outside
  assert.equal(board[1][1].adjacentMines, 1);
  assert.equal(board[3][3].adjacentMines, 0);
});

test('flagged and revealed mines are not extracted', () => {
  const board = makeBoard(5, 5, [[1, 1], [2, 3]]);
  board[1][1].isFlagged = true;
  board[2][3].isRevealed = true;
  const { extractedMines } = magnetPull(board, 2, 2);
  assert.equal(extractedMines.length, 0);
  assert.equal(board[1][1].isMine, true);
  assert.equal(board[2][3].isMine, true);
});

test('empty 3x3 is a clean no-op', () => {
  const board = makeBoard(5, 5, [[4, 4]]);
  const { extractedMines, affectedArea } = magnetPull(board, 1, 1);
  assert.deepEqual(extractedMines, []);
  assert.deepEqual(affectedArea, []);
  assert.equal(countMines(board), 1);
});
