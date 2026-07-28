// ── The Cairo pentagonal tiling, as a board ────────────────────────────────
//
// Project Coastline, tiling #3. The first two fixtures asked whether the
// no-guess contract survives off the square grid — tiling488.mjs for a
// MIXED-valence Archimedean tiling, tilingHex.mjs for the other major lattice
// symmetry. Neither could ask the question this one asks, because both are
// TRIVALENT: three cells meet at every vertex, and at a degree-3 vertex the two
// faces flanking a third already share a side with each other. On those two,
// "cells touching at a corner are neighbors" adds literally nothing (measured:
// zero vertex-only pairs on either, at every patch size and every value of
// OCT_CUT short of the degenerate 0.5).
//
// Cairo carries degree-4 vertices, so here the rule bites for the first time,
// and the board can hold a link that no side is shared along.
//
// ── The tiling ─────────────────────────────────────────────────────────────
//
// Laves [3².4.3.4]: ONE irregular pentagon at one size, four of them pinwheeled
// around each site of a square lattice, handedness alternating with site parity
// (the p4g symmetry). Exactly one pentagon spans each lattice edge, so an M×N
// lattice carries 2MN − M − N cells.
//
//         \  B  /
//          \   /          Around a degree-4 site, CONSECUTIVE pentagons
//       A   \ /   C       share a side. The OPPOSITE pairs — A with C,
//        ____•____        B with D — meet at that single point and
//           / \           nowhere else. Those are the new links.
//          /   \
//         /  D  \
//
// The load-bearing consequence, and the reason this is a real test rather than
// a relabelled grid: **an interior pentagon has five sides but SEVEN
// neighbors.** The pentagon's five corners run degree 3, 3, 4, 3, 4, so at each
// of its two degree-4 corners it picks up the face directly opposite across
// that point — five side-neighbors plus two corner-only ones, uniformly, on
// every interior cell of the patch. Interior valence 7 is also the first ODD one
// the arc has produced: a square grid gives 8, a honeycomb 6, and 4.8.8 gives 8
// to an octagon and 4 to the interstitial square.
//
// A corner-only link has no shared boundary, so buildWireframe emits no edge for
// it and no wall can ever sever it. That is right — a wall is a line drawn along
// a shared border, and two cells meeting at a point have none — but it means the
// adjacency graph is strictly LARGER than the wall graph here, where on the two
// shipped tilings the two coincide.
//
// ── Board representation ───────────────────────────────────────────────────
//
// Identical to the first two fixtures: the board stays a `rows x cols` array,
// but that array is pure STORAGE (the flat cell list reshaped) and a cell's
// (row, col) says nothing about what it touches. Adjacency comes only from
// `_cellNeighbors`, stamped by `defineCellNeighbors`.

import { defineCellNeighbors } from '../../src/logic/adjacency.js';
import { buildCairoTiling } from '../../src/logic/tilingGeometry.js';
export { buildCairoTiling };

// ── The frozen fixture board ───────────────────────────────────────────────
//
// A 7x7 lattice: 2·49 − 7 − 7 = 84 pentagons, stored in a 7x12 container.
//
// The container is worth a second look, because it is the clearest case yet of
// `rows`/`cols` being storage and nothing else: `containerFor(84)` picks 7x12,
// which has no relationship to the 7x7 lattice the pentagons actually sit on.
// The opener below lands at container (4, 0) — the container's own EDGE — while
// being the cell at the dead center of the tiling.
//
// The mine layout was found by searching seeded layouts with the SHIPPED
// certifier as the oracle — the same way generation finds a board today — then
// frozen here as literal indices, so the test is a fixture and not a search. It
// was deliberately selected to be one of the harder certified layouts at a
// daily density (22 mines on 84 cells, 0.262, where random sampling certifies
// under 5% of the time): it needs Pass A propagation, Pass B subsets of BOTH
// kinds, AND Pass C tank/gauss enumeration, so the fixture drives the whole
// solver over corner-inclusive adjacency. It was additionally selected so the
// RECTANGULAR control stalls on its very first click — see the gate test's
// control, which is what makes this non-vacuous.

export const FIXTURE = {
  M: 7,
  N: 7,
  rows: 7,
  cols: 12,
  /** Flat indices of the mines. */
  mines: [4, 5, 6, 10, 13, 18, 19, 22, 23, 24, 31, 41, 44, 45, 47, 59, 60, 64, 67, 72, 79, 80],
  /**
   * Flat index of the certified first click — the patch's own center pentagon,
   * which is what `buildCairoTiling` reports as `centerIndex` and what
   * daily/weekly certify from.
   */
  firstClick: 48,
  /** What the shipped certifier returns for this board. */
  expected: {
    solvable: true,
    remainingUnknowns: 0,
    totalClicks: 39,
    techniqueLevel: 2,
    passAMoves: 24,
    canonicalSubsetMoves: 1,
    genericSubsetMoves: 5,
    advancedLogicMoves: 8,
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
 *   actually reading the Cairo topology, rather than passing because a
 *   rectangle happens to certify too.
 */
export function buildFixtureBoard(opts = {}) {
  const { rows, cols, M, N, mines } = FIXTURE;
  const T = buildCairoTiling(M, N);
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

/**
 * How many vertices two cells share: 2 for a side-neighbor, 1 for a corner-only
 * neighbor, 0 for cells that do not touch.
 *
 * The distinction has no analogue on the two shipped tilings (every one of their
 * links shares two vertices), so it lives here rather than in the shared helper
 * set. The gate uses it to prove the corner-inclusive rule is actually present
 * in the topology it certifies against, instead of inferring that from a valence
 * count that a different lattice could also produce.
 */
export function sharedVertexCount(topology, a, b) {
  const other = new Set(topology.cellVerts[b]);
  let n = 0;
  for (const v of topology.cellVerts[a]) if (other.has(v)) n++;
  return n;
}
