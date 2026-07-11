// The liar ±1 contract on gimmick-stacked cells (2026-07-11 audit, Q4).
//
// applyLiar runs LAST in applyGimmicks, and its base-≥2 candidate guard used
// a hand-rolled closure that read cell.sonarCount / cell.compassCount —
// fields ONLY recomputeDisplayedMines populates, which hadn't run yet. The
// guard therefore evaluated raw adjacentMines for sonar/compass cells: a
// compass with a 0-mine ray but ≥2 adjacent mines slipped in, took offset
// −1, and the final recompute clamped Math.max(0, 0 − 1) = 0 — the TRUE
// compass value. A liar that tells the truth breaks the player-facing rule
// ("a liar's number is off by exactly one") that every deduction on the
// cell rests on: a player reading display 0 provably concludes the real
// count is 1, and that certainty is false. Reachable on challenge L91+
// (compass + liar stacks). applyLiar now runs recomputeDisplayedMines
// first (no cell is liar yet, so it yields exactly the pre-lie bases).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyBoard } from '../src/logic/boardGenerator.js';
import { applyLiar, recomputeDisplayedMines, recalcAllAdjacency } from '../src/logic/gimmicks.js';

// 5x5, mines at (0,0) and (0,2). Cell (1,1) touches both (adjacentMines 2)
// and carries a compass whose ray points DOWN through empty rows — its true
// base (compassCount) is 0. Cell (0,1) is the only plain cell with base >= 2.
function buildBoard() {
  const board = createEmptyBoard(5, 5);
  board[0][0].isMine = true;
  board[0][2].isMine = true;
  recalcAllAdjacency(board);
  board[1][1].isCompass = true;
  board[1][1].compassDir = { dr: 1, dc: 0 }; // ray (2,1),(3,1),(4,1) — no mines
  return board;
}

// The pre-lie base the recompute derives for a cell (fields are populated
// once recomputeDisplayedMines has run).
function baseOf(cell) {
  if (cell.isCompass) return cell.compassCount;
  if (cell.isSonar) return cell.sonarCount;
  return cell.adjacentMines;
}

test('REGRESSION: a liar never displays the true value — 0-ray compass cells are not candidates', () => {
  const board = buildBoard();
  const rng = () => 0.4; // deterministic shuffle + offset −1 every time
  const applied = applyLiar(board, 5, 5, 2, rng);
  recomputeDisplayedMines(board);

  assert.ok(applied.length >= 1, 'control: at least one liar was applied (the plain base-2 cell qualifies)');
  assert.ok(!board[1][1].isLiar,
    'the compass cell with a 0-mine ray must be excluded (base 0 < 2), not admitted on its raw adjacency');

  for (const row of board) {
    for (const cell of row) {
      if (!cell.isLiar) continue;
      const base = baseOf(cell);
      assert.equal(Math.abs(cell.displayedMines - base), 1,
        `liar at ${cell.row},${cell.col} must display base ±1 (base ${base}, shown ${cell.displayedMines}) — never the truth`);
    }
  }
});

test('control: a plain cell with base >= 2 still gets lied on by exactly one', () => {
  const board = buildBoard();
  const applied = applyLiar(board, 5, 5, 1, () => 0.4);
  recomputeDisplayedMines(board);
  assert.equal(applied.length, 1);
  const cell = board[applied[0].row][applied[0].col];
  assert.ok(!cell.isCompass, 'the one qualifying candidate is the plain (0,1) cell');
  assert.equal(Math.abs(cell.displayedMines - cell.adjacentMines), 1);
});
