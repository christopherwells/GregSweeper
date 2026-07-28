// ── The deltoidal trihexagonal tiling, as a board ──────────────────────────
//
// Project Coastline, tiling #6. The 4.8.8 fixture answered the arc's original
// question — does the no-guess contract survive off the square grid? — and the
// honeycomb answered it again for the other major lattice symmetry. Both of
// those are Archimedean and TRIVALENT: exactly three cells meet at every
// vertex, and all three of them already share edges. This fixture is the first
// one where that stops being true, which is the whole reason it exists.
//
// ── The tiling ─────────────────────────────────────────────────────────────
//
// Laves [3.4.6.4]: take the honeycomb and cut each hexagon into six congruent
// kites, one per hexagon side — hub, edge midpoint, hexagon vertex, next edge
// midpoint. One shape, one size, six rotations.
//
//         ______
//        /\  |  /\        * = the hexagon's hub, where six kites meet at a
//       /  \ | /  \           SINGLE POINT
//      /____\*/____\
//      \    /|\    /       consecutive kites share a whole side; the other
//       \  / | \  /        nine pairs around the hub share only the hub
//        \/__|__\/
//
// ── What this fixture proves that the shipped two cannot ───────────────────
//
// CORNER-INCLUSIVE ADJACENCY (Christopher's rule, 2026-07-27: "corners are
// adjacent in mine counts"). Two cells touching at only a vertex are neighbors,
// exactly as diagonal cells are on a square grid. On 4.8.8 and on the honeycomb
// that rule adds nothing at all — measured zero vertex-only pairs on either,
// because at a trivalent vertex the incident cells already share edges — so no
// gate has ever exercised it. Here the hub is a degree-SIX vertex: all six
// kites around it are neighbors, and nine of those fifteen pairs meet at that
// one point and nowhere else.
//
// The consequence is a neighborhood no rectangular assumption produces and the
// two shipped tilings never reach. Interior valence is 9, of which only 4 are
// edge neighbors — so this lattice is DENSER to reason on than the square grid
// (8), where 4.8.8 tops out at 8 and a hexagon at 6. It is also the first
// tiling whose clues can read above the classic ceiling of 8.
//
// ── Board representation ───────────────────────────────────────────────────
//
// Identical to the two shipped fixtures: the board stays a `rows x cols` array,
// but that array is pure STORAGE (the flat cell list reshaped) and a cell's
// (row, col) says nothing about what it touches. Adjacency comes only from
// `_cellNeighbors`, stamped by `defineCellNeighbors`.

import { defineCellNeighbors } from '../../src/logic/adjacency.js';
import { buildDeltoidalTiling } from '../../src/logic/tilingGeometry.js';
export { buildDeltoidalTiling };

// ── The frozen fixture board ───────────────────────────────────────────────
//
// A 3x4 hexagon lattice cut into kites: 6 x 3 x 4 = 72 cells in an 8x9
// container, the same size as the 4.8.8 fixture's board.
//
// The mine layout was found by searching seeded layouts with the SHIPPED
// certifier as the oracle — the same way generation finds a board today — then
// frozen here as literal indices, so the test is a fixture and not a search. It
// was deliberately selected to be one of the harder certified layouts: at
// density 0.264 random sampling certifies well under 1% of the time, and this
// one drives 20 Pass C enumerations, the deepest part of the solver, over
// corner-inclusive adjacency. It was additionally selected so the RECTANGULAR
// control below is UNSOLVABLE and stalls on the very first click — see the gate
// test's control, which is what makes this non-vacuous.
//
// The indices only mean something against the builder's own reading order
// (ascending centroid y, ties by centroid x, taken in lattice units before
// normalization). The gate asserts the topology it expects, so a reordering
// fails there loudly rather than here silently.

export const FIXTURE = {
  M: 3,
  N: 4,
  rows: 8,
  cols: 9,
  /** Flat indices of the mines. */
  mines: [2, 8, 10, 13, 15, 19, 20, 21, 26, 27, 28, 29, 46, 51, 54, 57, 58, 62, 66],
  /** Flat index of the certified first click — the patch's own center kite. */
  firstClick: 39,
  /** What the shipped certifier returns for this board. */
  expected: {
    solvable: true,
    remainingUnknowns: 0,
    totalClicks: 35,
    techniqueLevel: 2,
    passAMoves: 11,
    canonicalSubsetMoves: 1,
    genericSubsetMoves: 2,
    advancedLogicMoves: 20,
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
 *   actually reading the kite topology, rather than passing because a rectangle
 *   happens to certify too.
 */
export function buildFixtureBoard(opts = {}) {
  const { rows, cols, M, N, mines } = FIXTURE;
  const T = buildDeltoidalTiling(M, N);
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
