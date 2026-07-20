// gimmicks.recalcAllAdjacency is THE wall-aware adjacent-mine counter, and
// gimmicks.countAdjacentMines is the single per-cell primitive under it.
// Four hand-rolled copies of that neighbor loop used to exist
// (boardGenerator.calculateAdjacency, recalcAllAdjacency, and two in
// powerUps), and they disagreed on the MINE branch: some skipped mine cells
// rather than zeroing them, so a cell swapMines promoted from safe to mine
// kept the neighbor count it held while safe. That stale value serialized
// into a canonical board and the nightly "Verify canonical boards" sweep
// flagged it.
//
// REGRESSION: verify-canonical-boards 2026-07-16 stale mine adjacency
// (dailyBoard/2026-07-16, mine cells (0,5)=1 and (5,6)=4 vs recompute 0;
// caught 2026-07-10). A mine carries no number, so it ALWAYS reads 0, and
// every recompute path must agree on that.
//
// Run: node --test test/adjacency.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyBoard } from '../src/logic/boardGenerator.js';
import { recalcAllAdjacency, countAdjacentMines } from '../src/logic/gimmicks.js';

function boardWithMines(rows, cols, mineCoords) {
  const board = createEmptyBoard(rows, cols);
  for (const [r, c] of mineCoords) board[r][c].isMine = true;
  return board;
}

test('REGRESSION: a cell promoted to a mine must not keep its old count', () => {
  // Reproduce the swapMines mechanism: a cell holds a real neighbor count
  // while safe, then becomes a mine. The recompute must overwrite it to 0.
  const board = boardWithMines(3, 3, [[0, 0]]);
  recalcAllAdjacency(board);
  assert.equal(board[1][1].adjacentMines, 1, 'sanity: safe cell counts the corner mine');

  board[1][1].isMine = true; // the swap
  recalcAllAdjacency(board);
  assert.equal(board[1][1].adjacentMines, 0, 'a promoted mine must read 0, not its stale count');
});

test('every mine reads 0 and every safe cell reads its true neighbor count', () => {
  const rows = 6, cols = 7;
  const mines = [[0, 0], [0, 5], [5, 6], [1, 1], [2, 2], [4, 0], [5, 2], [3, 3]];
  const board = boardWithMines(rows, cols, mines);
  recalcAllAdjacency(board);

  for (const [r, c] of mines) {
    assert.equal(board[r][c].adjacentMines, 0, `mine (${r},${c}) must read 0`);
  }
  // Independent brute-force oracle for the safe cells (wall-free board).
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (board[r][c].isMine) continue;
      let expect = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && board[nr][nc].isMine) expect++;
        }
      }
      assert.equal(board[r][c].adjacentMines, expect, `safe cell (${r},${c})`);
    }
  }
});

test('countAdjacentMines is wall-aware: a wall edge hides the mine behind it', () => {
  // (1,1) sees the mine at (1,2) until a wall is placed on the shared edge.
  const board = boardWithMines(3, 3, [[1, 2]]);
  assert.equal(countAdjacentMines(board, 1, 1), 1, 'no wall: the mine is counted');

  board._wallEdges = new Set(['1,1-1,2']);
  assert.equal(countAdjacentMines(board, 1, 1), 0, 'wall between: the mine is not counted');

  // And the full recompute honors the same wall.
  recalcAllAdjacency(board);
  assert.equal(board[1][1].adjacentMines, 0, 'recalcAllAdjacency must agree with the primitive');
});

test('recalcAllAdjacency is wall-aware across the whole board (concrete, hand-checked)', () => {
  // Independent of the primitive: hand-computed expected values, and the wall
  // demonstrably CHANGES a count (1 -> 0), so this can't pass on a no-op wall.
  const board = boardWithMines(3, 3, [[1, 0]]); // one mine, center-left edge
  recalcAllAdjacency(board);
  assert.equal(board[1][1].adjacentMines, 1, 'no wall yet: (1,1) sees the mine');

  board._wallEdges = new Set(['1,0-1,1']); // wall on the (1,0)-(1,1) shared edge
  recalcAllAdjacency(board);
  assert.equal(board[1][1].adjacentMines, 0, 'wall hides the mine from (1,1)');
  assert.equal(board[0][0].adjacentMines, 1, '(0,0) still sees the mine — no wall on its edge');
  assert.equal(board[2][0].adjacentMines, 1, '(2,0) still sees the mine');
  assert.equal(board[1][0].adjacentMines, 0, 'the mine itself reads 0');
});

// ── Sonar / compass region geometry (Coastline) ───────────────────────
//
// These regions used to be hand-copied loops in TWO places:
// recomputeDisplayedMines (what the player is shown) and
// buildStaticGimmickConstraints (what the certifier proves from). Drift
// between them is a silent no-guess hole — the certifier would deduce from a
// premise the board never displayed — so they now read one definition.

const { sonarScanCells, compassRayCells, defineCellNeighbors, wallKey } =
  await import('../src/logic/adjacency.js');
const { buildTiling488 } = await import('./fixtures/tiling488.mjs');
const { recomputeDisplayedMines } = await import('../src/logic/gimmicks.js');
const { buildStaticGimmickConstraints, buildNeighborCache } =
  await import('../src/logic/boardSolver.js');

function plain(rows, cols) {
  return boardWithMines(rows, cols, []);
}

test('sonar on a plain rectangle is the 5x5 block minus the origin', () => {
  const b = plain(7, 7);
  const got = sonarScanCells(b, 7, 7, 3, 3);
  assert.equal(got.length, 24, 'a 5x5 block is 25 cells, less the origin');
  // Every returned cell is within Chebyshev distance 2, and none is the origin.
  for (const i of got) {
    const r = Math.floor(i / 7), c = i % 7;
    assert.ok(Math.max(Math.abs(r - 3), Math.abs(c - 3)) <= 2);
    assert.notEqual(i, 3 * 7 + 3);
  }
});

test('sonar clips at the board edge', () => {
  const b = plain(7, 7);
  assert.equal(sonarScanCells(b, 7, 7, 0, 0).length, 8, 'a corner sees a 3x3 quadrant less itself');
});

test('a rectangular sonar scan is UNCHANGED by walls on the outer ring', () => {
  // The shipped rule, preserved verbatim: walls sever only the inner ring.
  // This is arguably an inconsistency (the outer ring reaches through a wall
  // the inner ring is blocked by) but it is the rule players have solved
  // against, so a refactor must not quietly "fix" it.
  const b = plain(7, 7);
  b._wallEdges = new Set([wallKey(3, 3, 3, 4)]);
  const got = sonarScanCells(b, 7, 7, 3, 3);
  assert.equal(got.length, 23, 'exactly one inner-ring neighbor is severed');
  assert.ok(!got.includes(3 * 7 + 4), 'the walled inner neighbor is gone');
  assert.ok(got.includes(3 * 7 + 5), 'the outer-ring cell BEHIND that wall still counts');
});

test('on an unwalled rectangle, graph distance 2 and the 5x5 block AGREE', () => {
  // This is what justifies reading sonar as "within two steps" on a tiling:
  // the graph definition generalizes the geometric one exactly, wherever both
  // are defined. If this ever fails, the generalization is the wrong one.
  const geometric = sonarScanCells(plain(7, 7), 7, 7, 3, 3);

  const b = plain(7, 7);
  const adj = [];
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const n = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < 7 && nc >= 0 && nc < 7) n.push(nr * 7 + nc);
        }
      }
      adj[r * 7 + c] = n;
    }
  }
  defineCellNeighbors(b, 7, 7, adj);
  const graph = sonarScanCells(b, 7, 7, 3, 3);

  assert.deepEqual([...graph].sort((x, y) => x - y), [...geometric].sort((x, y) => x - y));
});

test('sonar on a tiling reads the topology, not the container', () => {
  const T = buildTiling488(3, 3);
  const b = plain(T.total, 1);
  defineCellNeighbors(b, T.total, 1, T.adj);

  const centre = T.octIndex(1, 1);
  const got = sonarScanCells(b, T.total, 1, centre, 0);

  assert.ok(!got.includes(centre), 'never includes the origin');
  // Depth-2 closure: every direct neighbor, plus their neighbors.
  const expect = new Set();
  for (const n1 of T.adj[centre]) {
    expect.add(n1);
    for (const n2 of T.adj[n1]) expect.add(n2);
  }
  expect.delete(centre);
  assert.deepEqual([...got].sort((x, y) => x - y), [...expect].sort((x, y) => x - y));
  assert.ok(got.length > T.adj[centre].length, 'a two-step region is strictly wider than one step');
});

test('a compass ray runs straight to the edge on a rectangle', () => {
  const b = plain(7, 7);
  assert.deepEqual(compassRayCells(b, 7, 7, 3, 3, { dr: 0, dc: 1 }), [3 * 7 + 4, 3 * 7 + 5, 3 * 7 + 6]);
  assert.deepEqual(compassRayCells(b, 7, 7, 3, 3, { dr: -1, dc: 0 }), [2 * 7 + 3, 1 * 7 + 3, 0 * 7 + 3]);
  assert.deepEqual(compassRayCells(b, 7, 7, 0, 0, { dr: -1, dc: 0 }), [], 'a ray off the edge is empty');
});

test('REGRESSION: a compass REFUSES on an explicit topology rather than lying', () => {
  // A ray needs a direction; a neighbor graph carries no geometry to take one
  // from. Before this guard, the walk stepped (r + dr, c + dc) through the
  // CONTAINER — on a 13x1 strip that produced a plausible number describing no
  // region on the board, and the certifier emitted a matching constraint, so
  // display and proof agreed perfectly about something meaningless. It did not
  // crash, which is exactly what made it dangerous.
  const T = buildTiling488(3, 3);
  const b = plain(T.total, 1);
  defineCellNeighbors(b, T.total, 1, T.adj);
  assert.throws(
    () => compassRayCells(b, T.total, 1, T.octIndex(1, 1), 0, { dr: 1, dc: 0 }),
    /no meaning on an explicit topology/,
  );
});

test('the sonar region the player SEES is the region the certifier PROVES from', () => {
  // The whole point of the shared definition. If these two ever describe
  // different regions, the certifier deduces from a premise the board never
  // stated, and a board certifies no-guess that a player cannot actually
  // solve. Walls are included because that is where the two loops were most
  // likely to drift.
  const b = boardWithMines(7, 7, [[0, 0], [1, 4], [2, 2], [4, 5], [5, 1], [6, 6], [3, 0]]);
  b._wallEdges = new Set([wallKey(3, 3, 3, 4), wallKey(2, 3, 3, 3)]);
  recalcAllAdjacency(b);
  b[3][3].isSonar = true;
  recomputeDisplayedMines(b);

  const cs = buildStaticGimmickConstraints(b, 7, 7, buildNeighborCache(b, 7, 7), null);
  const sonarC = cs.find((x) => x.origin === 3 * 7 + 3);
  assert.ok(sonarC, 'the sonar cell must contribute a constraint');

  const region = sonarScanCells(b, 7, 7, 3, 3);
  assert.deepEqual(
    [...sonarC.cells].sort((x, y) => x - y),
    [...region].sort((x, y) => x - y),
    'certifier region must equal the displayed region',
  );

  const trueMines = region.filter((i) => b[Math.floor(i / 7)][i % 7].isMine).length;
  assert.equal(b[3][3].displayedMines, trueMines, 'the shown number counts that region');
  assert.equal(sonarC.expected, trueMines, 'the certifier expects the same number');
});
