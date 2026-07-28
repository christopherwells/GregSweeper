// ── The rhombille tiling, as a board ───────────────────────────────────────
//
// Project Coastline, tiling #5. The first two gates asked whether the no-guess
// contract survives off the square grid — 4.8.8 for a MIXED-valence lattice
// (tiling488.mjs), the honeycomb for a constant-valence one (tilingHex.mjs).
// Both answered yes with a cell that sees at most as much as a square-grid cell
// does. This fixture is the first that asks the question from ABOVE.
//
// ── The tiling ─────────────────────────────────────────────────────────────
//
// Rhombille, Laves [3.6.3.6]: every hexagon of the underlying honeycomb cut
// from its center to three alternating vertices, giving three congruent 60/120
// rhombi. 3MN cells.
//
//         _______
//        /\      \        Tiled, it reads as a wall of stacked cubes (the
//       /  \      \       "tumbling blocks" illusion). Three rhombi meet at
//      /    \______\      every hexagon CENTER and six meet at every hexagon
//      \    /      /      VERTEX, so unlike the two shipped tilings its
//       \  /      /       vertices are not all degree 3.
//        \/______/
//
// Three load-bearing consequences, and together they are why this lattice is
// worth its own gate rather than being a third confirmation of the first two.
//
// 1. CORNER-INCLUSIVE ADJACENCY FINALLY DOES SOMETHING. Christopher's rule
//    (2026-07-27, "corners are adjacent in mine counts") makes two cells that
//    touch at a single VERTEX neighbors, exactly as diagonal cells are on a
//    square grid. On 4.8.8 and on the honeycomb the rule is a strict NO-OP —
//    both are trivalent, so at every vertex the incident cells already share
//    edges. Here the degree-6 hexagon vertices give it real work: the graph goes
//    from 159 edge-sharing links to 366, so more than half of every neighborhood
//    exists only because of the rule. An interior cell sees 4 edge neighbors and
//    6 corner-only ones.
//
// 2. INTERIOR VALENCE 10, AGAINST THE RECTANGLE'S 8. This is the densest
//    neighborhood in the arc (cairo 7, floret 8, deltoidal 9), and the first
//    that is not merely a DIFFERENT shape from a square grid's 8-block but a
//    BIGGER one. A rhombille clue can therefore read 9 or 10, past the ceiling
//    every classic minesweeper assumption is built against. (This particular
//    frozen layout is sparse enough that its own clues top out at 5 — the
//    ceiling is a property of the lattice, not something this fixture exercises,
//    and it should not be cited as though it were.)
//
// 3. PASS B IS STRUCTURALLY DEAD. Rhombille finds subset pairs and they almost
//    never resolve, so its ladder runs Pass A straight to Pass C with nothing in
//    between. Measured three times independently: 0 Pass B moves across 1500
//    constructively generated certified boards, 0 across 103 certified boards in
//    a random sweep, and 0 across 678 certified boards in a third sweep run
//    while building this gate. That is why the gate test cannot copy the hex
//    gate's `genericSubsetMoves >= 1` line — see the comment there.
//
// ── Board representation ───────────────────────────────────────────────────
//
// Identical to the two earlier fixtures: the board stays a `rows x cols` array,
// but that array is pure STORAGE (the flat cell list reshaped) and a cell's
// (row, col) says nothing about what it touches. Adjacency comes only from
// `_cellNeighbors`, stamped by `defineCellNeighbors`.

import { defineCellNeighbors } from '../../src/logic/adjacency.js';
import { buildRhombilleTiling } from '../../src/logic/tilingGeometry.js';
export { buildRhombilleTiling };

// ── The frozen fixture board ───────────────────────────────────────────────
//
// A 5x6 hexagon lattice cut into rhombi: 3 * 5 * 6 = 90 cells in a 9x10
// container.
//
// The mine layout was found by searching seeded layouts with the SHIPPED
// certifier as the oracle — the same way generation finds a board today — then
// frozen here as literal indices, so the test is a fixture and not a search. It
// was deliberately selected to reach techniqueLevel 2, so the fixture drives
// tank/gauss enumeration over rhombille adjacency, and additionally selected so
// the RECTANGULAR control below is UNSOLVABLE.
//
// One caveat about that control, measured rather than assumed: at this density
// (23 mines on 90 cells, 0.256) a rectangular read of a random layout is
// unsolvable about 96% of the time anyway, so "unsolvable" is close to free
// here. The property that was genuinely selected for is that the control stalls
// at `totalClicks === 1` (base rate 1.3%), which is why the gate pins the click
// count and not just the verdict.
//
// The indices are meaningless except against the builder's reading order
// (ascending centroid y, ties by centroid x, taken in lattice units before
// normalization). The topology tests pin that order, so a reordering fails
// there with a legible message instead of failing here as an inscrutable
// counter mismatch.

export const FIXTURE = {
  M: 5,
  N: 6,
  rows: 9,
  cols: 10,
  /** Flat indices of the mines. */
  mines: [0, 3, 5, 10, 16, 19, 30, 31, 34, 35, 41, 46, 50, 51, 55, 59, 60, 63, 78, 80, 82, 85, 89],
  /** Flat index of the certified first click — the patch's own center rhombus. */
  firstClick: 48,
  /** What the shipped certifier returns for this board. */
  expected: {
    solvable: true,
    remainingUnknowns: 0,
    totalClicks: 48,
    techniqueLevel: 2,
    passAMoves: 41,
    // Zero, and NOT a property of this layout — Pass B does not resolve on this
    // lattice at all. See point 3 in the header.
    canonicalSubsetMoves: 0,
    genericSubsetMoves: 0,
    advancedLogicMoves: 6,
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
 *   actually reading the rhombille topology, rather than passing because a
 *   rectangle happens to certify too.
 */
export function buildFixtureBoard(opts = {}) {
  const { rows, cols, M, N, mines } = FIXTURE;
  const T = buildRhombilleTiling(M, N);
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
