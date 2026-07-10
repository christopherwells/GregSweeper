// calculateAdjacency (boardGenerator) and recalcAllAdjacency (gimmicks) are
// two near-identical wall-aware neighbor counters. They must agree on EVERY
// cell — including mines. They historically disagreed only on the mine
// branch: recalcAllAdjacency zeroes mine cells, while calculateAdjacency
// skipped them, leaving whatever count the cell held before it became a mine.
// swapMines promotes a formerly-safe cell (which carried a real neighbor
// count) to a mine and then re-runs calculateAdjacency, so the stale count
// survived into the serialized canonical and the nightly "Verify canonical
// boards" sweep flagged it as inconsistent adjacentMines.
//
// REGRESSION: verify-canonical-boards 2026-07-16 stale mine adjacency
// (dailyBoard/2026-07-16, cells (0,5)=1 and (5,6)=4 vs recompute 0; caught
// 2026-07-10). calculateAdjacency must zero mine cells so the two counters
// produce byte-identical grids.
//
// Run: node --test test/calculateAdjacency.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { calculateAdjacency, createEmptyBoard } from '../src/logic/boardGenerator.js';
import { recalcAllAdjacency } from '../src/logic/gimmicks.js';

// Place mines on a fresh board and return it (adjacency uncomputed).
function boardWithMines(rows, cols, mineCoords) {
  const board = createEmptyBoard(rows, cols);
  for (const [r, c] of mineCoords) board[r][c].isMine = true;
  return board;
}

test('REGRESSION: calculateAdjacency zeroes a mine cell that carried a stale count', () => {
  // Reproduce the swapMines mechanism directly: a cell holds a real neighbor
  // count while safe, then becomes a mine. calculateAdjacency must overwrite
  // its count to 0, not skip it.
  const board = boardWithMines(3, 3, [[0, 0]]);
  calculateAdjacency(board); // (1,1) now reads 1 (the corner mine)
  assert.equal(board[1][1].adjacentMines, 1, 'sanity: safe cell counts the mine');

  board[1][1].isMine = true; // promote the counted cell to a mine (the swap)
  calculateAdjacency(board);
  assert.equal(board[1][1].adjacentMines, 0, 'a promoted mine must not keep its old count');
});

test('REGRESSION: calculateAdjacency and recalcAllAdjacency produce identical grids (incl. mines)', () => {
  // The exact invariant the verify sweep enforces: the generator's counter
  // and the sweep's counter must never disagree on any cell.
  const rows = 6, cols = 7;
  // (2,2) sits adjacent to the swap target (3,3), so (3,3) carries a real
  // count while safe — the value that would go stale under a skip-only counter.
  const target = [3, 3];
  const mines = [[0, 0], [0, 5], [5, 6], [1, 1], [2, 2], [4, 0], [5, 2], target];

  const board = boardWithMines(rows, cols, mines.filter(([r, c]) => !(r === target[0] && c === target[1])));
  calculateAdjacency(board);
  const staleBefore = board[target[0]][target[1]].adjacentMines;
  assert.ok(staleBefore > 0, 'sanity: the cell had a nonzero count before becoming a mine');
  board[target[0]][target[1]].isMine = true;

  // Two independent recomputes of the same layout must match cell-for-cell.
  const a = board.map((row) => row.map((cell) => ({ ...cell })));
  const b = board.map((row) => row.map((cell) => ({ ...cell })));
  calculateAdjacency(a);
  recalcAllAdjacency(b, rows, cols);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      assert.equal(
        a[r][c].adjacentMines, b[r][c].adjacentMines,
        `adjacency mismatch at (${r},${c}): calculateAdjacency=${a[r][c].adjacentMines} recalcAllAdjacency=${b[r][c].adjacentMines}`,
      );
    }
  }
  // And specifically: every mine reads 0 under calculateAdjacency.
  for (const [r, c] of mines) {
    assert.equal(a[r][c].adjacentMines, 0, `mine (${r},${c}) must read 0`);
  }
});
