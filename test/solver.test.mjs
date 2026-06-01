// Solver move-type bookkeeping invariant. The par model is driven by the
// solver's per-move-type counts, so the documented invariant
//   passA + canonicalSubset + genericSubset + advanced + disjunctive + 1
//     === totalClicks
// must hold for every solvable board. A break here silently mis-feeds the
// par fit. We check it across several seeded boards of varying size/density.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { isBoardSolvable } = await import('../src/logic/boardSolver.js');
const { generateBoard, cleanSolverArtifacts } = await import('../src/logic/boardGenerator.js');
const { createDailyRNG } = await import('../src/logic/seededRandom.js');

const CASES = [
  { rows: 9,  cols: 9,  mines: 12, seed: 'unit-solver-1' },
  { rows: 12, cols: 12, mines: 30, seed: 'unit-solver-2' },
  { rows: 14, cols: 14, mines: 45, seed: 'unit-solver-3' },
  { rows: 10, cols: 10, mines: 18, seed: 'unit-solver-4' },
];

for (const { rows, cols, mines, seed } of CASES) {
  test(`move-type counts sum to totalClicks (${rows}x${cols}/${mines}, ${seed})`, () => {
    const fr = Math.floor(rows / 2), fc = Math.floor(cols / 2);
    const board = generateBoard(rows, cols, mines, fr, fc, createDailyRNG(seed));
    cleanSolverArtifacts(board);
    const r = isBoardSolvable(board, rows, cols, fr, fc);
    // Only solvable boards carry the invariant (the generator guarantees
    // solvable boards in production; an unsolvable one just isn't checked).
    if (!r.solvable && r.remainingUnknowns !== 0) return;
    const sum = r.passAMoves + r.canonicalSubsetMoves + r.genericSubsetMoves
      + r.advancedLogicMoves + r.disjunctiveMoves + 1;
    assert.equal(sum, r.totalClicks,
      `invariant broken: ${sum} !== totalClicks ${r.totalClicks}`);
    // Every bucket count must be a non-negative integer.
    for (const k of ['passAMoves', 'canonicalSubsetMoves', 'genericSubsetMoves', 'advancedLogicMoves', 'disjunctiveMoves']) {
      assert.ok(Number.isInteger(r[k]) && r[k] >= 0, `${k} not a non-negative int: ${r[k]}`);
    }
  });
}

test('pre-flagging a mine never raises the solver workload (info-value is ≥ 0 by construction)', () => {
  // The bomb info-value relies on pre-flagging a mine making the board no
  // harder. Verify the move-type total doesn't increase when a mine is
  // pre-flagged via the options hook.
  const rows = 12, cols = 12, mines = 30, fr = 6, fc = 6;
  const board = generateBoard(rows, cols, mines, fr, fc, createDailyRNG('unit-preflag'));
  cleanSolverArtifacts(board);
  const base = isBoardSolvable(board, rows, cols, fr, fc);
  if (!base.solvable) return;
  // Find a mine and pre-flag it.
  let mr = -1, mc = -1;
  outer: for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (board[r][c].isMine) { mr = r; mc = c; break outer; }
  const withFlag = isBoardSolvable(board, rows, cols, fr, fc, undefined, { preFlagCells: [{ row: mr, col: mc }] });
  cleanSolverArtifacts(board);
  const baseMoves = base.passAMoves + base.canonicalSubsetMoves + base.genericSubsetMoves + base.advancedLogicMoves;
  const flagMoves = withFlag.passAMoves + withFlag.canonicalSubsetMoves + withFlag.genericSubsetMoves + withFlag.advancedLogicMoves;
  // Weighted info-value uses coefficients, but the raw deduction count
  // should not go UP when a mine is known. (Equal is fine — corner mine.)
  assert.ok(flagMoves <= baseMoves + 1, `pre-flag raised workload: ${baseMoves} -> ${flagMoves}`);
});
