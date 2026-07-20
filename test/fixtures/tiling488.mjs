// ── The 4.8.8 truncated-square tiling, as a board ─────────────────────────
//
// Project Coastline, Phase 1. This is the hand-authored Archimedean tiling the
// no-guess certifier is run against, to answer the one question that would
// kill the arc: does the contract survive off the square grid?
//
// It lives in test/fixtures rather than src/ deliberately. Phase 1 ships
// nothing to players — there is no tiling renderer and no tiling generator yet
// — so a src/ module would be dead weight in the repo and in the precache.
// When Phase 2 builds those, this topology builder is what gets promoted.
//
// ── The tiling ─────────────────────────────────────────────────────────────
//
// 4.8.8 is the truncated square tiling: regular octagons on a square lattice
// with a small square filling each interstice. Its vertex configuration is
// two octagons and one square meeting at every vertex.
//
//        ___     ___
//       /   \___/   \      O = octagon (8 sides)
//       \___/ s \___/      s = square  (4 sides)
//       /   \___/   \
//       \___/   \___/
//
//   - An octagon shares 4 of its sides with the octagons directly above,
//     below, left and right of it, and its other 4 sides with the small
//     squares at its corners.
//   - A square shares each of its 4 sides with one of the four octagons
//     surrounding it.
//
// The load-bearing consequence, and the reason this is a real test rather than
// a relabelled grid: **two diagonally-positioned octagons do NOT touch.** A
// square sits between them. So a cell's neighborhood here is not the 8-cell
// block that every rectangular assumption in the codebase is built around, and
// valence is not even constant across the board — it runs 3, 4, 5 and 8.
//
// ── Board representation ───────────────────────────────────────────────────
//
// The board stays a `rows × cols` array of cells, exactly as everywhere else,
// but that array is pure STORAGE: it is the flat cell list reshaped, and a
// cell's (row, col) says nothing about what it touches. Adjacency comes only
// from `_cellNeighbors`, stamped by `defineCellNeighbors`. This is why the
// certifier needed no changes — it already consumed nothing but flat indices
// and a neighbor list.

import { defineCellNeighbors } from '../../src/logic/adjacency.js';

/**
 * Build the 4.8.8 topology over an M×N lattice of octagons.
 *
 * Cell indices are laid out octagons-first, then squares:
 *   octagon (i, j) -> i * N + j                    for 0 <= i < M, 0 <= j < N
 *   square  (i, j) -> M*N + i * (N-1) + j          for 0 <= i < M-1, 0 <= j < N-1
 * where square (i, j) is the one bounded by octagons (i,j), (i,j+1),
 * (i+1,j) and (i+1,j+1).
 *
 * @returns {{total:number, nOct:number, nSq:number, adj:Array<number[]>,
 *            octIndex:(i:number,j:number)=>number,
 *            sqIndex:(i:number,j:number)=>number}}
 */
export function buildTiling488(M, N) {
  const nOct = M * N;
  const nSq = (M - 1) * (N - 1);
  const total = nOct + nSq;
  const octIndex = (i, j) => i * N + j;
  const sqIndex = (i, j) => nOct + i * (N - 1) + j;

  const adj = Array.from({ length: total }, () => []);
  const link = (a, b) => { adj[a].push(b); adj[b].push(a); };

  // Octagon to octagon: the four orthogonal sides.
  for (let i = 0; i < M; i++) {
    for (let j = 0; j < N; j++) {
      if (j + 1 < N) link(octIndex(i, j), octIndex(i, j + 1));
      if (i + 1 < M) link(octIndex(i, j), octIndex(i + 1, j));
    }
  }
  // Square to its four surrounding octagons.
  for (let i = 0; i < M - 1; i++) {
    for (let j = 0; j < N - 1; j++) {
      const s = sqIndex(i, j);
      link(s, octIndex(i, j));
      link(s, octIndex(i, j + 1));
      link(s, octIndex(i + 1, j));
      link(s, octIndex(i + 1, j + 1));
    }
  }

  return { total, nOct, nSq, adj, octIndex, sqIndex };
}

// ── The frozen fixture board ───────────────────────────────────────────────
//
// A 6×7 octagon lattice: 42 octagons + 30 squares = 72 cells, stored in an
// 8×9 container (72 cells, the size of a small daily board).
//
// The mine layout below was found by searching seeded layouts with the SHIPPED
// certifier as the oracle — the same way generation finds a board today — and
// then frozen here as literal indices, so the test is a fixture and not a
// search. It is deliberately one of the harder certified layouts: it needs
// tank/gauss enumeration (techniqueLevel 2), not just counting, so the fixture
// exercises the deepest part of the solver on non-rectangular adjacency.

export const FIXTURE = {
  M: 6,
  N: 7,
  rows: 8,
  cols: 9,
  /** Flat indices of the mines. */
  mines: [1, 7, 16, 19, 22, 38, 40, 61, 64, 66, 68],
  /** Flat index of the certified first click — octagon (3, 3). */
  firstClick: 24,
  /** What the shipped certifier returns for this board. */
  expected: {
    solvable: true,
    remainingUnknowns: 0,
    totalClicks: 27,
    techniqueLevel: 2,
    passAMoves: 20,
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
 *   implicit 8-neighborhood. That is the control: it proves the tiling test
 *   is actually reading the tiling, rather than passing because a rectangle
 *   happens to certify too.
 */
export function buildFixtureBoard(opts = {}) {
  const { rows, cols, M, N, mines } = FIXTURE;
  const T = buildTiling488(M, N);
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
