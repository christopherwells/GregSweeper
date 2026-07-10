// gimmicks.recalcAllAdjacency is THE wall-aware adjacent-mine counter, and
// gimmicks.countAdjacentMines is the single per-cell primitive under it.
// Four hand-rolled copies of that neighbor loop used to exist
// (boardGenerator.calculateAdjacency, recalcAllAdjacency, and two in
// powerUps), and they disagreed on the MINE branch: some skipped mine cells
// rather than zeroing them, so a cell swapMines promoted from safe to mine
// kept the neighbor count it held while safe. That stale value serialized
// into a canonical board and the nightly "Verify canonical boards" sweep
// flagged it.
//
// REGRESSION: verify-canonical-boards 2026-07-16 stale mine adjacency
// (dailyBoard/2026-07-16, mine cells (0,5)=1 and (5,6)=4 vs recompute 0;
// caught 2026-07-10). A mine carries no number, so it ALWAYS reads 0, and
// every recompute path must agree on that.
//
// Run: node --test test/adjacency.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyBoard } from '../src/logic/boardGenerator.js';
import { recalcAllAdjacency, countAdjacentMines } from '../src/logic/gimmicks.js';

function boardWithMines(rows, cols, mineCoords) {
  const board = createEmptyBoard(rows, cols);
  for (const [r, c] of mineCoords) board[r][c].isMine = true;
  return board;
}

test('REGRESSION: a cell promoted to a mine must not keep its old count', () => {
  // Reproduce the swapMines mechanism: a cell holds a real neighbor count
  // while safe, then becomes a mine. The recompute must overwrite it to 0.
  const board = boardWithMines(3, 3, [[0, 0]]);
  recalcAllAdjacency(board);
  assert.equal(board[1][1].adjacentMines, 1, 'sanity: safe cell counts the corner mine');

  board[1][1].isMine = true; // the swap
  recalcAllAdjacency(board);
  assert.equal(board[1][1].adjacentMines, 0, 'a promoted mine must read 0, not its stale count');
});

test('every mine reads 0 and every safe cell reads its true neighbor count', () => {
  const rows = 6, cols = 7;
  const mines = [[0, 0], [0, 5], [5, 6], [1, 1], [2, 2], [4, 0], [5, 2], [3, 3]];
  const board = boardWithMines(rows, cols, mines);
  recalcAllAdjacency(board);

  for (const [r, c] of mines) {
    assert.equal(board[r][c].adjacentMines, 0, `mine (${r},${c}) must read 0`);
  }
  // Independent brute-force oracle for the safe cells (wall-free board).
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (board[r][c].isMine) continue;
      let expect = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && board[nr][nc].isMine) expect++;
        }
      }
      assert.equal(board[r][c].adjacentMines, expect, `safe cell (${r},${c})`);
    }
  }
});

test('countAdjacentMines is wall-aware: a wall edge hides the mine behind it', () => {
  // (1,1) sees the mine at (1,2) until a wall is placed on the shared edge.
  const board = boardWithMines(3, 3, [[1, 2]]);
  assert.equal(countAdjacentMines(board, 1, 1), 1, 'no wall: the mine is counted');

  board._wallEdges = new Set(['1,1-1,2']);
  assert.equal(countAdjacentMines(board, 1, 1), 0, 'wall between: the mine is not counted');

  // And the full recompute honors the same wall.
  recalcAllAdjacency(board);
  assert.equal(board[1][1].adjacentMines, 0, 'recalcAllAdjacency must agree with the primitive');
});

test('recalcAllAdjacency agrees with countAdjacentMines on every cell (one convention)', () => {
  // The invariant the canonical-board verify sweep enforces: the full
  // recompute is exactly the primitive applied cell-by-cell, mines zeroed.
  const rows = 6, cols = 7;
  const board = boardWithMines(rows, cols, [[0, 0], [0, 5], [5, 6], [1, 1], [2, 2], [4, 0], [5, 2], [3, 3]]);
  board._wallEdges = new Set(['2,3-2,4', '3,1-4,1']);
  recalcAllAdjacency(board);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const expect = board[r][c].isMine ? 0 : countAdjacentMines(board, r, c);
      assert.equal(board[r][c].adjacentMines, expect, `mismatch at (${r},${c})`);
    }
  }
});
