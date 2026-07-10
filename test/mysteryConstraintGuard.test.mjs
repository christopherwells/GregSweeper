// A mystery ("?") cell hides its number, and a pressure-plate cell shows a
// timer instead. The player can never read either, so the certifier must
// never build a constraint from one — otherwise a board could be certified
// no-guess using information the player does not have, which is exactly the
// 50/50 hole the no-guess contract forbids.
//
// buildStaticGimmickConstraints used to gate only on `isMine ||
// displayedMines == null`. A mystery cell normally has displayedMines
// undefined (recomputeDisplayedMines' plain branch), so the null-check
// covered it INCIDENTALLY. But if mystery ever stacked on a base-value
// gimmick (wormhole / mirror / sonar / compass), recomputeDisplayedMines
// takes the gimmick branch and assigns a real displayedMines — the cell
// would then emit a full gimmick constraint the certifier consumes while
// the player sees only "?".
//
// That state is unreachable today (applyGimmicks places mystery first and
// base-value gimmicks skip display-blocked cells), but the invariant lived
// three files from the guard. These tests pin the guard directly, so the
// solver is safe on its own terms rather than by an accident of ordering.
//
// REGRESSION: mystery no-guess audit, 2026-07-10.
//
// Run: node --test test/mysteryConstraintGuard.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyBoard } from '../src/logic/boardGenerator.js';
import { buildNeighborCache, buildStaticGimmickConstraints } from '../src/logic/boardSolver.js';
import { recalcAllAdjacency, recomputeDisplayedMines } from '../src/logic/gimmicks.js';

const ROWS = 5, COLS = 5;

// A wormhole pair at opposite corners: their neighborhoods are disjoint, so
// buildStaticGimmickConstraints emits the pair-sum constraint (the lower
// index owns it). Returns the board.
function wormholeBoard() {
  const board = createEmptyBoard(ROWS, COLS);
  const a = board[0][0], b = board[4][4];
  a.isWormhole = true; a.wormholePair = { row: 4, col: 4 }; a.displayedMines = 2;
  b.isWormhole = true; b.wormholePair = { row: 0, col: 0 }; b.displayedMines = 2;
  return board;
}

const build = (board) =>
  buildStaticGimmickConstraints(board, ROWS, COLS, buildNeighborCache(board, ROWS, COLS), null);

test('CONTROL: a plain wormhole pair still emits its constraint', () => {
  // Guards the guard: if this ever goes quiet, the mystery skip is over-blocking
  // and real gimmick constraints are being silently dropped.
  const out = build(wormholeBoard());
  assert.equal(out.length, 1, 'the lower-index wormhole cell owns exactly one constraint');
  assert.equal(out[0].origin, 0, 'origin is (0,0)');
  assert.equal(out[0].expected, 2, 'expected value is the displayed pair sum');
});

test('REGRESSION: a mystery-masked wormhole cell emits NO constraint', () => {
  const board = wormholeBoard();
  board[0][0].isMystery = true; // the poison state: number masked, but still set
  const out = build(board);
  assert.equal(out.length, 0, 'a "?" cell must not feed the certifier its hidden number');
});

test('REGRESSION: a mystery-masked sonar cell emits NO constraint', () => {
  const board = createEmptyBoard(ROWS, COLS);
  const s = board[2][2];
  s.isSonar = true; s.displayedMines = 3;
  assert.equal(build(board).length, 1, 'sanity: an unmasked sonar cell does emit');

  s.isMystery = true;
  assert.equal(build(board).length, 0, 'a masked sonar cell must not emit');
});

test('a pressure-plate cell is display-blocked too and emits NO constraint', () => {
  const board = createEmptyBoard(ROWS, COLS);
  const s = board[2][2];
  s.isSonar = true; s.displayedMines = 3;
  s.isPressurePlate = true; // shows a timer, not a count
  assert.equal(build(board).length, 0, 'a plate cell must not emit');
});

test('INVARIANT: recomputeDisplayedMines leaves a plain mystery cell undefined', () => {
  // This is why the poison state above is unreachable today. If this ever
  // changes, the guard in buildStaticGimmickConstraints is what keeps the
  // no-guess contract intact.
  const board = createEmptyBoard(ROWS, COLS);
  board[1][1].isMine = true;
  board[2][2].isMystery = true;
  recalcAllAdjacency(board);
  recomputeDisplayedMines(board);

  assert.equal(board[2][2].adjacentMines, 1, 'the mystery cell still knows its true count');
  assert.equal(board[2][2].displayedMines, undefined, 'but it displays nothing readable');
});
