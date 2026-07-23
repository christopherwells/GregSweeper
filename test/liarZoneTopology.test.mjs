// ── Liar zone follows the board's own topology ─────────────────────────────
//
// REGRESSION (2026-07-22): computeLiarZone marked a liar cell's visual "zone"
// by walking (row±1, col±1) of the CONTAINER. On a Coastline tiling the
// container is pure storage — a cell's (row, col) says nothing about what it
// touches — so the tint landed on cells that are not the liar's neighbours and
// missed ones that are. Visual only (the certifier reads liarOffset, not the
// zone), so this was never a no-guess hole.
//
// The rectangular walk is deliberately preserved VERBATIM, including that it is
// wall-BLIND: the zone is a spatial cue, not an adjacency claim, and a liar's
// tint has always spilled across a wall. That is asserted here so a future
// "cleanup" through the wall-aware cache can't silently restyle every walled
// square board.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeLiarZone } from '../src/logic/gimmicks.js';
import { defineCellNeighbors, wallKey } from '../src/logic/adjacency.js';
import { buildHexTiling } from '../src/logic/tilingGeometry.js';

function blankBoard(rows, cols) {
  const board = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) row.push({ row: r, col: c, isLiar: false, inLiarZone: false });
    board.push(row);
  }
  return board;
}
const zoneSet = (board, rows, cols) => {
  const out = new Set();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (board[r][c].inLiarZone) out.add(r * cols + c);
  return out;
};

test('on a HEX tiling the zone is exactly the liar plus its graph neighbours', () => {
  const M = 7, N = 7, rows = 7, cols = 7;
  const T = buildHexTiling(M, N);
  const board = blankBoard(rows, cols);
  defineCellNeighbors(board, rows, cols, T.adj);

  // An interior hexagon (3,3) — six edge neighbours, no diagonals.
  const liar = 24;
  board[(liar / cols) | 0][liar % cols].isLiar = true;
  computeLiarZone(board, rows, cols);

  const expected = new Set([liar, ...T.adj[liar]]);
  assert.deepEqual([...zoneSet(board, rows, cols)].sort((a, b) => a - b),
                   [...expected].sort((a, b) => a - b));
  assert.equal(expected.size, 7, 'an interior hexagon tints itself + its six neighbours');

  // The bug's signature: the container's row±1/col±1 block contains cells that
  // are NOT hex neighbours. Those must be untinted.
  const containerBlock = [];
  const lr = (liar / cols) | 0, lc = liar % cols;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    const nr = lr + dr, nc = lc + dc;
    if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) containerBlock.push(nr * cols + nc);
  }
  const strangers = containerBlock.filter(i => !expected.has(i));
  assert.ok(strangers.length > 0, 'the container block really does differ from the hex neighbourhood');
  for (const s of strangers) {
    assert.equal(board[(s / cols) | 0][s % cols].inLiarZone, false,
      `cell ${s} is in the container block but is NOT a hex neighbour — it must not be tinted`);
  }
});

test('a hex liar on the board edge tints only its real neighbours', () => {
  const M = 7, N = 7, rows = 7, cols = 7;
  const T = buildHexTiling(M, N);
  const board = blankBoard(rows, cols);
  defineCellNeighbors(board, rows, cols, T.adj);

  const liar = 0; // corner hexagon
  board[0][0].isLiar = true;
  computeLiarZone(board, rows, cols);

  assert.deepEqual([...zoneSet(board, rows, cols)].sort((a, b) => a - b),
                   [liar, ...T.adj[liar]].sort((a, b) => a - b));
});

test('RECTANGULAR boards keep the literal 8-neighbourhood, wall-blind (unchanged)', () => {
  const rows = 5, cols = 5;
  const board = blankBoard(rows, cols);
  board[2][2].isLiar = true;
  computeLiarZone(board, rows, cols);

  // The full 3x3 block around (2,2).
  const expected = new Set();
  for (let r = 1; r <= 3; r++) for (let c = 1; c <= 3; c++) expected.add(r * cols + c);
  assert.deepEqual([...zoneSet(board, rows, cols)].sort((a, b) => a - b),
                   [...expected].sort((a, b) => a - b));
  assert.equal(expected.size, 9, 'liar + all 8 neighbours');
});

test('RECTANGULAR zone still spills ACROSS a wall (deliberate, not an oversight)', () => {
  const rows = 5, cols = 5;
  const board = blankBoard(rows, cols);
  // Wall between (2,2) and (2,3): the zone is a spatial cue, so the tint is
  // expected to cross it exactly as it always has.
  board._wallEdges = new Set([wallKey(2, 2, 2, 3)]);
  board[2][2].isLiar = true;
  computeLiarZone(board, rows, cols);

  assert.equal(board[2][3].inLiarZone, true,
    'the walled neighbour is still tinted — routing this through the wall-aware cache would change it');
});
