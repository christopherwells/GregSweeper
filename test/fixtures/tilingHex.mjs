// ── The 6.6.6 regular hexagonal tiling, as a board ─────────────────────────
//
// Project Coastline, tiling #2. The 4.8.8 fixture (tiling488.mjs) answered the
// arc's original question — does the no-guess contract survive off the square
// grid? — for a MIXED-valence tiling. This fixture asks the same question of the
// other major lattice symmetry, and it is not a formality: 4.8.8 is a square
// lattice with its corners cut (4-fold), while a honeycomb is 6-fold, and the
// two disagree about the most basic thing a minesweeper board can say.
//
// ── The tiling ─────────────────────────────────────────────────────────────
//
// Pointy-top regular hexagons in offset rows (odd rows shifted right by half a
// hex). Vertex configuration 6.6.6 — three hexagons meet at every vertex.
//
//         __    __
//      __/  \__/  \__       every cell is the same shape and the same size
//     /  \__/  \__/  \
//     \__/  \__/  \__/
//     /  \__/  \__/  \
//     \__/  \__/  \__/
//
// The load-bearing consequence, and the reason this is a real test rather than
// a relabelled grid: **a hexagon has no diagonals.** Its six neighbors are all
// EDGE neighbors, so the corner-touch relationship that every rectangular
// assumption in the codebase is built around simply does not exist here. A
// square-grid cell sees 8; a hexagon sees 6, and interior valence is a constant
// 6 rather than 4.8.8's mixed 3/4/5/8.
//
// ── Board representation ───────────────────────────────────────────────────
//
// Identical to the 4.8.8 fixture: the board stays a `rows x cols` array, but
// that array is pure STORAGE (the flat cell list reshaped) and a cell's
// (row, col) says nothing about what it touches. Adjacency comes only from
// `_cellNeighbors`, stamped by `defineCellNeighbors`.

import { defineCellNeighbors } from '../../src/logic/adjacency.js';
import { buildHexTiling } from '../../src/logic/tilingGeometry.js';
export { buildHexTiling };

// ── The frozen fixture board ───────────────────────────────────────────────
//
// A 7x7 hexagon grid: 49 cells in a 7x7 container.
//
// The mine layout was found by searching seeded layouts with the SHIPPED
// certifier as the oracle — the same way generation finds a board today — then
// frozen here as literal indices, so the test is a fixture and not a search. It
// was deliberately selected to be one of the harder certified layouts: it needs
// Pass B subset reasoning AND Pass C tank/gauss enumeration (techniqueLevel 2),
// so the fixture drives the deepest part of the solver over hexagonal adjacency.
// It was additionally selected so the RECTANGULAR control below is UNSOLVABLE —
// see the gate test's control, which is what makes this non-vacuous.

export const FIXTURE = {
  M: 7,
  N: 7,
  rows: 7,
  cols: 7,
  /** Flat indices of the mines. */
  mines: [7, 9, 13, 16, 19, 20, 37, 40, 47],
  /** Flat index of the certified first click — the center hexagon (3, 3). */
  firstClick: 24,
  /** What the shipped certifier returns for this board. */
  expected: {
    solvable: true,
    remainingUnknowns: 0,
    totalClicks: 20,
    techniqueLevel: 2,
    passAMoves: 7,
    canonicalSubsetMoves: 0,
    genericSubsetMoves: 8,
    advancedLogicMoves: 4,
    disjunctiveMoves: 0,
  },
};

function emptyCell(r, c) {
  return {
    row: r, col: c,
    isMine: false, isRevealed: false, isFlagged: false,
    adjacentMines: 0, displayedMines: undefined,
    isMystery: false, isLiar: false, isLocked: false,
    isSonar: false, isCompass: false, isWormhole: false,
    isPressurePlate: false, isWormEgg: false,
  };
}

/**
 * Materialize the fixture as a board the shipped solver can consume.
 *
 * @param {{topology?: 'tiling'|'rectangular'}} [opts]
 *   topology 'rectangular' builds the SAME mine layout in the SAME container
 *   but leaves `_cellNeighbors` unstamped, so adjacency falls back to the
 *   implicit 8-neighborhood. That is the control: it proves the tiling test is
 *   actually reading the hexagonal topology, rather than passing because a
 *   rectangle happens to certify too.
 */
export function buildFixtureBoard(opts = {}) {
  const { rows, cols, M, N, mines } = FIXTURE;
  const T = buildHexTiling(M, N);
  if (T.total !== rows * cols) {
    throw new Error(`fixture container ${rows}x${cols} does not hold ${T.total} cells`);
  }

  const board = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) row.push(emptyCell(r, c));
    board.push(row);
  }

  const at = (i) => board[(i / cols) | 0][i % cols];
  for (const mi of mines) at(mi).isMine = true;

  if (opts.topology !== 'rectangular') {
    defineCellNeighbors(board, rows, cols, T.adj);
  }

  return { board, topology: T };
}
