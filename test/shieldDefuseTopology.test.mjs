// A shield break must leave the board's numbers describing its mines.
//
// REGRESSION (issue #274): recalcAreaAdjacency repaired the container 3x3
// around the removed mine. On a rectangle that block IS the neighborhood; on a
// tiling (row, col) is pure container storage and the real neighborhood is the
// explicit edge list, so a shield break left 2 to 8 cells still counting a mine
// that was no longer on the board — with the board's own ✓ Certified chip
// still on screen, on 198 of the 250 ladder levels.
//
// The guard is the one the issue asked for: remove a mine on each shipped
// lattice and require the board to equal a full recompute, with a rectangular
// control. Two things keep it from passing vacuously — the control must be
// clean (so the harness is not reporting differences that are not there), and
// each lattice board must actually CONTAIN cells whose neighborhood escapes
// the container 3x3, which is the geometry the defect lived in. Without that
// second check a future patch size could quietly stop exercising the bug: the
// honeycomb's own escape rate is 38.5% of cells, which is why its clean result
// in the original report was the sample rather than the lattice.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateTilingBoard } from '../src/logic/tilingGenerator.js';
import { generateBoard } from '../src/logic/boardGenerator.js';
import { shieldDefuse } from '../src/logic/powerUps.js';
import { recalcAllAdjacency } from '../src/logic/gimmicks.js';
import { TILING_TYPES, buildTiling } from '../src/logic/tilingGeometry.js';
import { buildNeighborCache } from '../src/logic/adjacency.js';
import { createDailyRNG } from '../src/logic/seededRandom.js';

// Board arrays carry their topology as properties, which a naive map() drops.
function cloneBoard(board) {
  const copy = board.map((row) => row.map((cell) => ({ ...cell })));
  for (const k of ['_cellNeighbors', '_cellPos', '_tiling', '_wallEdges', '_tilingWalls', '_gatedCert']) {
    if (board[k] !== undefined) copy[k] = board[k];
  }
  return copy;
}

// What a player reads off a cell: the gimmick-adjusted number when there is
// one, the raw count otherwise. recomputeDisplayedMines only DERIVES from
// adjacentMines, so a stale count reaches the screen either way.
const shown = (cell) => (cell.displayedMines !== undefined ? cell.displayedMines : cell.adjacentMines);

// How many cells on this board have a neighbor the container 3x3 cannot see.
// This is the defect's own geometry, so it is what makes the test non-vacuous.
function cellsEscapingContainerBlock(board) {
  const rows = board.length, cols = board[0].length;
  const cache = buildNeighborCache(board, rows, cols);
  let escaping = 0;
  for (let i = 0; i < rows * cols; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    if (cache[i].some((n) => Math.abs(Math.floor(n / cols) - r) > 1 || Math.abs((n % cols) - c) > 1)) escaping++;
  }
  return escaping;
}

// Defuse every mine in turn and compare against the same removal repaired by
// the full-board recompute, which is the definition of correct here.
function auditEveryDefuse(board) {
  const rows = board.length, cols = board[0].length;
  const sites = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (board[r][c].isMine) sites.push([r, c]);

  const wrong = [];
  for (const [mr, mc] of sites) {
    const actual = cloneBoard(board);
    shieldDefuse(actual, mr, mc);

    const truth = cloneBoard(board);
    truth[mr][mc].isMine = false;
    truth[mr][mc].isDefused = true;
    recalcAllAdjacency(truth);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (actual[r][c].adjacentMines !== truth[r][c].adjacentMines
          || shown(actual[r][c]) !== shown(truth[r][c])) {
          wrong.push(`defusing (${mr},${mc}) left (${r},${c}) reading ${shown(actual[r][c])} instead of ${shown(truth[r][c])}`);
        }
      }
    }
  }
  return { sites: sites.length, wrong };
}

// Per-shape patches chosen so the container block is NOT the neighborhood.
// The honeycomb is the one that has to be picked deliberately: at 4x4 its 12
// cells land in a 3x4 container where every neighbor happens to fall inside
// the 3x3 block, so that patch cannot see the defect at all — which is the
// same coincidence that made the original report record hex as unaffected.
// The escape assertion below is what caught it, and is why it is there.
const PATCHES = {
  '4.8.8': [4, 4], hex: [5, 4], cairo: [4, 4],
  floret: [3, 3], rhombille: [3, 3], deltoidal: [3, 3],
};

// One test per shape so a failure names the lattice rather than the first one
// that broke. 0.25 is the density COASTLINE_BOARDS uses for the Laves tilings
// and the one every shape generates reliably at these patch sizes.
for (const type of TILING_TYPES) {
  test(`REGRESSION: shield break keeps the numbers honest on ${type}`, () => {
    const [M, N] = PATCHES[type];
    assert.ok(M && N, `${type} has no patch in PATCHES — a new lattice needs one`);
    const total = buildTiling(type, M, N).total;
    const built = generateTilingBoard({
      type, M, N, seed: `shield274:${type}`, mines: Math.round(total * 0.25),
    });
    assert.ok(built && built.board, `${type}: generation failed, so the gate would pass vacuously`);

    const escaping = cellsEscapingContainerBlock(built.board);
    assert.ok(escaping > 0,
      `${type}: no cell on this board has a neighbour outside the container 3x3, so it cannot exercise the defect`);

    const { sites, wrong } = auditEveryDefuse(built.board);
    assert.ok(sites > 0, `${type}: the board carries no mines to defuse`);
    assert.deepEqual(wrong, [],
      `${type}: ${wrong.length} stale numbers across ${sites} defuse sites\n  ${wrong.slice(0, 6).join('\n  ')}`);
  });
}

test('the rectangular control is clean, and the fix did not change it', () => {
  // A rectangle's container 3x3 IS its neighborhood, so this passed before the
  // fix too. That is the point: it proves the harness reports differences only
  // where they exist, and pins that the new visit set did not disturb the
  // shape every non-Coastline board still uses.
  const board = generateBoard(9, 9, 18, 4, 4, createDailyRNG('shield274:rect'));
  const { sites, wrong } = auditEveryDefuse(board);
  assert.ok(sites >= 10, 'the control needs mines to defuse');
  assert.deepEqual(wrong, [], `the rectangular control drifted:\n  ${wrong.slice(0, 6).join('\n  ')}`);
  assert.equal(cellsEscapingContainerBlock(board), 0,
    'a rectangle must have NO cell reaching outside its container 3x3 — that is why it was never affected');
});

test('a walled rectangle stays clean too (the cache is wall-aware, the 3x3 was not)', () => {
  // The old walk visited wall-severed cells and recomputed them to the same
  // value; the new one skips them. Same outcome, and worth pinning because
  // walls are the one case where the two visit sets genuinely differ.
  const board = generateBoard(9, 9, 15, 4, 4, createDailyRNG('shield274:walls'));
  board._wallEdges = new Set(['3,3-3,4', '4,3-4,4', '5,3-5,4', '3,4-4,4']);
  recalcAllAdjacency(board);
  const { sites, wrong } = auditEveryDefuse(board);
  assert.ok(sites >= 10);
  assert.deepEqual(wrong, [], `the walled control drifted:\n  ${wrong.slice(0, 6).join('\n  ')}`);
});
