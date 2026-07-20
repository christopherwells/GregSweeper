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

const { sonarScanCells, compassRayCells, defineCellNeighbors, wallKey, plateDisarmCells } =
  await import('../src/logic/adjacency.js');
const { estimatePlateMovesToDisarm } = await import('../src/logic/boardSolver.js');
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

// ── Locked + mirror placement follow the topology (Coastline) ─────────
//
// applyLocked, isLockedCell and applyMirrorPairs each walked the 8
// neighborhood by coordinate. On a tiling that polls cells the board does not
// touch, so a locked cell unlocks early or never, and a "mirror pair" can be
// two cells with no shared edge. All three now read the board's own topology.
//
// isLockedCell in particular must agree with the certifier's unlock model
// (canUnlock in boardSolver.js, which has always read the neighbor cache): if
// they disagree, the solver certifies an unlock order the live game refuses.

const { isLockedCell, applyGimmicks } = await import('../src/logic/gimmicks.js');
const { buildFixtureBoard, FIXTURE } = await import('./fixtures/tiling488.mjs');
const { createDailyRNG } = await import('../src/logic/seededRandom.js');

const cellOf = (board, cols, i) => board[Math.floor(i / cols)][i % cols];

test('REGRESSION: a locked cell on a tiling polls the cells it actually touches', () => {
  const { board, topology } = buildFixtureBoard();
  const { cols } = FIXTURE;
  recalcAllAdjacency(board);

  const target = topology.octIndex(3, 3);
  const tr = Math.floor(target / cols), tc = target % cols;
  board[tr][tc].isLocked = true;

  // Reveal every cell the TOPOLOGY says touches it (skipping mines, which
  // never block an unlock). That must be sufficient to unlock.
  for (const ni of topology.adj[target]) {
    const n = cellOf(board, cols, ni);
    if (!n.isMine) n.isRevealed = true;
  }
  assert.equal(isLockedCell(board, tr, tc), false,
    'revealing its true neighbors must unlock it');

  // Re-fog one genuine topological neighbor: it must lock again.
  const someNbr = topology.adj[target].find((ni) => !cellOf(board, cols, ni).isMine);
  cellOf(board, cols, someNbr).isRevealed = false;
  assert.equal(isLockedCell(board, tr, tc), true,
    'a hidden true neighbor must keep it locked');
});

test('REGRESSION: a container neighbor that is NOT a topological one cannot hold a lock shut', () => {
  // The sharp case. In an 8x9 container the coordinate 8-neighborhood of a
  // cell and its 4.8.8 neighborhood genuinely disagree; the old reader polled
  // the former. The test asserts they disagree before relying on it, so it
  // cannot pass vacuously.
  const { board, topology } = buildFixtureBoard();
  const { rows, cols } = FIXTURE;
  recalcAllAdjacency(board);

  const target = topology.octIndex(3, 3);
  const tr = Math.floor(target / cols), tc = target % cols;
  board[tr][tc].isLocked = true;

  const containerNbrs = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nr = tr + dr, nc = tc + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      containerNbrs.push(nr * cols + nc);
    }
  }
  const strangers = containerNbrs.filter((i) => !topology.adj[target].includes(i));
  assert.ok(strangers.length > 0,
    'the container and the tiling must genuinely disagree here, or this proves nothing');

  // Reveal the true neighbors only; every stranger stays fogged.
  for (const ni of topology.adj[target]) {
    const n = cellOf(board, cols, ni);
    if (!n.isMine) n.isRevealed = true;
  }
  assert.equal(isLockedCell(board, tr, tc), false,
    'fogged non-neighbors must not hold the lock shut');
});

test('REGRESSION: locked placement on a tiling ignores the CONTAINER border', () => {
  // The interior-only candidate rule is a statement about a rectangle. Left in
  // place on a topology board it filters by the container's border, which is
  // an arbitrary set of cells with respect to the graph — perfectly ordinary
  // tiling cells become unplaceable for no reason the board can express.
  //
  // Sweeping seeds rather than asserting on one: placement is random, so the
  // honest claim is that border cells are ELIGIBLE, which shows up as some
  // seed eventually placing one there. Under the old rule this is unreachable,
  // no matter how many seeds are tried.
  const { rows, cols } = FIXTURE;
  const onBorder = (r, c) => r === 0 || r === rows - 1 || c === 0 || c === cols - 1;

  let placedAnywhere = 0;
  let placedOnBorder = 0;
  for (let s = 0; s < 40; s++) {
    const { board } = buildFixtureBoard();
    recalcAllAdjacency(board);
    const applied = applyGimmicks(board, 75, ['locked'], createDailyRNG(`coastline:locked:${s}`));
    for (const p of applied.locked || []) {
      placedAnywhere++;
      if (onBorder(p.row, p.col)) placedOnBorder++;
    }
  }

  assert.ok(placedAnywhere > 0, 'the fixture must place locked cells at all');
  assert.ok(placedOnBorder > 0,
    'a tiling cell sitting on the container border must be eligible for a lock');
});

// ── Pressure plates (Coastline) ───────────────────────────────────────
//
// The plate's demand region and the par estimator's target set were two copies
// of one rule. Drift between them prices the countdown for a different job
// than the player actually has to finish, which is a mis-timed board rather
// than a broken one — but silently so.

test('a plate demand region on a rectangle is the plain 8-neighborhood', () => {
  const b = plain(7, 7);
  assert.equal(plateDisarmCells(b, 7, 7, 3, 3).length, 8);
  assert.equal(plateDisarmCells(b, 7, 7, 0, 0).length, 3, 'a corner has three');
});

test('a plate demand region deliberately IGNORES walls on a rectangle', () => {
  // The asymmetry with the estimator's deduction and cascade loops, which DO
  // respect walls. It is coherent rather than a bug: the plate states what must
  // end up revealed, walls constrain the reasoning that gets you there, and a
  // severed cell is still reachable from its own side. Pinned because a
  // well-meaning refactor would "fix" it and quietly re-time every plate.
  const b = plain(7, 7);
  b._wallEdges = new Set([wallKey(3, 3, 3, 4)]);
  assert.equal(plateDisarmCells(b, 7, 7, 3, 3).length, 8,
    'the walled neighbor is still demanded');
  assert.ok(plateDisarmCells(b, 7, 7, 3, 3).includes(3 * 7 + 4));
});

test('REGRESSION: a plate on a tiling demands the cells it actually touches', () => {
  const { board, topology } = buildFixtureBoard();
  const { rows, cols } = FIXTURE;
  const target = topology.octIndex(3, 3);

  const got = plateDisarmCells(board, rows, cols, Math.floor(target / cols), target % cols);
  assert.deepEqual([...got].sort((x, y) => x - y),
    [...topology.adj[target]].sort((x, y) => x - y));

  // And it genuinely differs from the container reading, or this proves nothing.
  const rectangular = buildFixtureBoard({ topology: 'rectangular' }).board;
  const viaContainer = plateDisarmCells(rectangular, rows, cols,
    Math.floor(target / cols), target % cols);
  assert.notDeepEqual([...got].sort((x, y) => x - y),
    [...viaContainer].sort((x, y) => x - y));
});

test('REGRESSION: the plate price is estimated for the region the game polls', () => {
  // The estimator's target set and the live disarm condition must agree. If
  // the estimator counted a different set, the countdown would be priced for
  // work the player is not being asked to do.
  const { board, topology } = buildFixtureBoard();
  const { rows, cols } = FIXTURE;
  recalcAllAdjacency(board);

  const target = topology.octIndex(3, 3);
  const pr = Math.floor(target / cols), pc = target % cols;

  // Fogged: every non-mine neighbor is outstanding, so the estimate must have
  // real work in it.
  const est = estimatePlateMovesToDisarm(board, pr, pc);
  assert.ok(est.moves + est.unsolved > 0, 'a fogged plate must cost something');

  // Reveal exactly the topological neighbors and the work drops to nothing.
  for (const ni of topology.adj[target]) {
    const n = cellOf(board, cols, ni);
    if (!n.isMine) n.isRevealed = true;
  }
  const after = estimatePlateMovesToDisarm(board, pr, pc);
  assert.deepEqual(after, { moves: 0, steps: 0, unsolved: 0 },
    'revealing the true neighbors must leave nothing to price');
});

test('REGRESSION: every mirror pair on a tiling is genuinely adjacent', () => {
  const { board, topology } = buildFixtureBoard();
  const { cols } = FIXTURE;
  recalcAllAdjacency(board);
  const applied = applyGimmicks(board, 75, ['mirror'], createDailyRNG('coastline:mirror'));
  assert.ok(applied.mirror && applied.mirror.length > 0, 'the fixture must produce pairs');

  for (const p of applied.mirror) {
    const ai = p.a.row * cols + p.a.col;
    const bi = p.b.row * cols + p.b.col;
    assert.ok(topology.adj[ai].includes(bi),
      `mirror pair ${ai}/${bi} must share an edge in the tiling, not just in the container`);
    assert.ok(topology.adj[bi].includes(ai), 'and symmetrically');
  }
});
