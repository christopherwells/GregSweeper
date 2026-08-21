// The chord ripple's timing, and the input lock that rides on it.
//
// REGRESSION: shape-mode reveal lag (his report 2026-08-21, "an odd reveal
// the cells lag which doesn't happen with classic", then "This doesn't seem
// to be a ms problem. It is taking closer to a full second to render").
//
// The chord's animation delays AND its input-lock duration were both computed
// as Manhattan distance over CONTAINER indices. On a rectangle (row, col) is
// the real geometry, so that was correct and gave a flat 480ms lock. On a
// tiling rows/cols are an arbitrary factorization of the cell list, so cells
// that touch on the lattice can sit many container rows apart: measured on a
// plain 98-cell 4.8.8 stored as 7x14, every chordable cell locked input for
// at least 500ms, median 840ms, worst 1040ms.
//
// The player could not act for most of a second and NO FRAME WAS SLOW, which
// is why frame probes, timeline traces and paint measurements all reported the
// board as perfectly healthy. The main thread was idle; the game was ignoring
// them.
//
// Run: node --test test/chordRipple.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  chordRippleSchedule, chordRippleDistances,
  CHORD_BASE_MS, CHORD_STEP_MS, CHORD_UNLOCK_BUFFER_MS, CHORD_STAGGER_MAX_MS,
} from '../src/logic/chordRipple.js';
import { createEmptyBoard } from '../src/logic/boardGenerator.js';
import { defineCellNeighbors } from '../src/logic/adjacency.js';
const { buildTiling488 } = await import('./fixtures/tiling488.mjs');

/** The formula exactly as it shipped, so the fixture's defect is provable. */
function oldLockMs(cells, r, c) {
  const maxDist = Math.max(...cells.map((x) => Math.abs(x.row - r) + Math.abs(x.col - c)));
  return 350 + maxDist * 40 + 50;
}

/** A tiling board in a REALISTIC container: rows x cols merely holds the cells. */
function tilingBoard(M, N, rows, cols) {
  const T = buildTiling488(M, N);
  assert.ok(rows * cols >= T.total, 'container must hold every cell');
  const b = createEmptyBoard(rows, cols);
  const adj = [];
  for (let i = 0; i < rows * cols; i++) adj[i] = (i < T.total ? T.adj[i] : []).slice();
  defineCellNeighbors(b, rows, cols, adj);
  return { board: b, T, rows, cols };
}

const cellsOf = (rows, cols, idxs) =>
  idxs.map((i) => ({ row: (i / cols) | 0, col: i % cols, isMine: false }));

test('REGRESSION: a chord on a tiling must not lock input for most of a second', () => {
  // The live board from his report: a plain 98-cell 4.8.8, which the match
  // library stores in a 7x14 container. Those exact dimensions are what make
  // an octagon's neighbours land far apart in container indices.
  const { board, T, rows, cols } = tilingBoard(8, 7, 7, 14);
  assert.equal(T.total, 98, 'the fixture must be the board that was measured');
  const centre = T.octIndex(4, 3);
  const r = (centre / cols) | 0, c = centre % cols;
  const revealed = cellsOf(rows, cols, [centre, ...T.adj[centre]]);

  // NON-VACUITY FIRST: this fixture must actually carry the defect, or the
  // assertion below proves nothing. The neighbours of one octagon land far
  // apart in container indices, which is the whole bug.
  const before = oldLockMs(revealed, r, c);
  assert.ok(before >= 700,
    `fixture cannot show the bug: old formula gives only ${before}ms`);

  const { lockMs } = chordRippleSchedule(board, rows, cols, r, c, revealed);
  assert.ok(lockMs <= 500,
    `a chord still locks input for ${lockMs}ms (was ${before}ms)`);
  // Every cell a chord reveals TOUCHES the chorded cell, so on the real graph
  // it is one hop and the schedule is the classic one.
  assert.equal(lockMs, CHORD_BASE_MS + CHORD_STEP_MS + CHORD_UNLOCK_BUFFER_MS);
});

test('the rectangular schedule is byte-identical to the shipped formula', () => {
  const board = createEmptyBoard(9, 9);   // no _cellNeighbors: the rect branch
  const r = 4, c = 4;
  const idxs = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) idxs.push((r + dr) * 9 + (c + dc));
  const revealed = cellsOf(9, 9, idxs);

  const { delays, lockMs } = chordRippleSchedule(board, 9, 9, r, c, revealed);
  assert.equal(lockMs, oldLockMs(revealed, r, c), 'classic must not move');
  // And each cell keeps its own historic delay, diagonals included.
  for (const cell of revealed) {
    const d = Math.abs(cell.row - r) + Math.abs(cell.col - c);
    assert.equal(delays.get(cell.row * 9 + cell.col), d * CHORD_STEP_MS);
  }
});

test('a deep chord compresses rather than running away', () => {
  // A path graph: every cell touches only the next, so hops grow without
  // bound. This is the shape that would re-create the freeze on some future
  // lattice, and the bound is what makes that impossible.
  const n = 40;
  const board = createEmptyBoard(n, 1);
  const adj = [];
  for (let i = 0; i < n; i++) {
    adj[i] = [];
    if (i > 0) adj[i].push(i - 1);
    if (i < n - 1) adj[i].push(i + 1);
  }
  defineCellNeighbors(board, n, 1, adj);
  const revealed = cellsOf(n, 1, [...Array(n).keys()]);

  const { delays, lockMs, maxHops } = chordRippleSchedule(board, n, 1, 0, 0, revealed);
  assert.ok(maxHops >= 20, `fixture must actually run deep, got ${maxHops}`);
  assert.ok(lockMs <= CHORD_BASE_MS + CHORD_STAGGER_MAX_MS + CHORD_UNLOCK_BUFFER_MS,
    `deep chord locks ${lockMs}ms, past the bound`);
  // Still a ripple: the far end waits longer than the near end.
  assert.ok(delays.get(n - 1) > delays.get(1), 'the stagger must survive the bound');
});

test('distances read the graph, never the container', () => {
  const { board, T, rows, cols } = tilingBoard(8, 7, 7, 14);
  const centre = T.octIndex(4, 3);
  const r = (centre / cols) | 0, c = centre % cols;
  const revealed = cellsOf(rows, cols, [centre, ...T.adj[centre]]);
  const hops = chordRippleDistances(board, rows, cols, r, c, revealed);

  assert.equal(hops.get(centre), 0, 'the chorded cell is its own origin');
  for (const n of T.adj[centre]) {
    assert.equal(hops.get(n), 1, `neighbour ${n} must be one hop, not a container gap`);
  }
});
