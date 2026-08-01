// ── The floret pentagonal tiling, as a board ───────────────────────────────
//
// Project Coastline, tiling #3. The two shipped fixtures answered the arc's
// question for a mixed-valence Archimedean tiling (tiling488.mjs) and for the
// other major lattice symmetry (tilingHex.mjs). Both of those differ from a
// square grid in the most visible way a minesweeper board can: 4.8.8's interior
// valence runs 3/4/5/8 and a hexagon's is a constant 6, so a solver that quietly
// read a rectangle somewhere would be caught by the ARITY of a clue alone.
//
// This is the first fixture where that tell is gone. A floret pentagon's
// interior valence is EIGHT, the same count a square grid gives, and the opener
// here is container-interior, so the rectangular control reads eight neighbors
// too. The two sets nonetheless agree on only half their members. Nothing about
// how big the numbers get separates this board from a rectangle, so the gate can
// only pass by reading the actual edge list.
//
// ── The tiling ─────────────────────────────────────────────────────────────
//
// Laves [3⁴.6], the dual of the snub hexagonal tiling: six congruent pentagons
// pinwheeled around one 6-valent center vertex, and those ROSETTES tile the
// plane. Every cell is the same pentagon at the same size, in one of six
// rotations. Schematically, a single rosette (* is the hub where all six meet):
//
//              \  1  |  2  /
//               \    |    /          the six pieces are pentagons, not
//            6   \___|___/   3       wedges, and each is rotated 60° from
//                ____*____           the last, so the rosette's outer
//               /    |    \          boundary is a pinwheel (18 vertices),
//              /  5  |  4  \         not a hexagon
//
// The load-bearing consequence, and the reason this is a real test rather than
// a relabelled grid: **the pentagon has five sides but eight neighbors.** Three
// of every interior cell's links are CORNER-ONLY, cells meeting at a single
// point and adjacent under Christopher's rule (2026-07-27, "corners are adjacent
// in mine counts") exactly as diagonal cells are on a square grid. 78 of this
// patch's 233 links exist only under that rule. On 4.8.8 and on the honeycomb
// the same rule is a strict no-op, because both are trivalent and at every
// vertex the incident cells already share sides, so this is the first fixture
// that certifies against an adjacency the two shipped tilings cannot express.
//
// The rosette carries the second consequence: its six pentagons all meet at the
// hub, so they are MUTUALLY adjacent, a 6-clique. A square grid's largest clique
// is the 2×2 block, four cells. The constraint system here presents an overlap
// no rectangular board can.
//
// ── Board representation ───────────────────────────────────────────────────
//
// Identical to the two shipped fixtures: the board stays a `rows x cols` array,
// but that array is pure STORAGE (the flat cell list reshaped) and a cell's
// (row, col) says nothing about what it touches. Adjacency comes only from
// `_cellNeighbors`, stamped by `defineCellNeighbors`.

import { defineCellNeighbors } from '../../src/logic/adjacency.js';
import { buildFloretTiling } from '../../src/logic/tilingGeometry.js';
export { buildFloretTiling };

// ── The frozen fixture board ───────────────────────────────────────────────
//
// A 3x4 lattice of rosettes: 6MN = 72 pentagons, stored in an 8x9 container.
//
// The mine layout was found by searching seeded layouts with the SHIPPED
// certifier as the oracle — the same way generation finds a board today — then
// frozen here as literal indices, so the test is a fixture and not a search. It
// was deliberately selected to be one of the harder certified layouts, and it is
// the first gate fixture that drives ALL FOUR reasoning tiers: Pass A, the
// canonical subset bucket the par model prices as "pattern", the generic subset
// bucket, and Pass C tank/gauss enumeration. Neither shipped fixture reaches the
// canonical bucket at all. It was additionally selected so the RECTANGULAR
// control is UNSOLVABLE — see the gate test's control, which is what makes this
// non-vacuous.
//
// The indices mean nothing except against `assembleTiling`'s reading order
// (ascending centroid y, ties by centroid x, taken in lattice units before
// normalization). Reorder the builder and this fixture describes a different
// board while still looking like a valid one, so the gate pins that order
// explicitly rather than trusting it. The edge list this layout was frozen
// against hashes to c5bae2edbce28d4d (sha256 of `JSON.stringify(adj)`, first 16
// hex).

export const FIXTURE = {
  M: 3,
  N: 4,
  rows: 8,
  cols: 9,
  /** Flat indices of the mines. */
  mines: [1, 4, 7, 9, 11, 13, 19, 20, 34, 42, 48, 49, 55, 56, 58, 60, 61, 65, 68],
  /** Flat index of the certified first click — the pentagon nearest the patch center. */
  firstClick: 32,
  /** What the shipped certifier returns for this board. */
  expected: {
    solvable: true,
    remainingUnknowns: 0,
    totalClicks: 35,
    techniqueLevel: 2,
    passAMoves: 27,
    canonicalSubsetMoves: 1,
    genericSubsetMoves: 4,
    advancedLogicMoves: 2,
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
 *   actually reading the floret topology, rather than passing because a
 *   rectangle happens to certify too. Here the control has to be read as a SET
 *   rather than a count, because a rectangle's interior valence is 8 and so is
 *   the floret's.
 */
export function buildFixtureBoard(opts = {}) {
  const { rows, cols, M, N, mines } = FIXTURE;
  const T = buildFloretTiling(M, N);
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
