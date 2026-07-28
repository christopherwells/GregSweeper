// ── Project Coastline, tiling #3: the Cairo gate ───────────────────────────
//
// The 4.8.8 gate proved the no-guess contract survives a MIXED-valence tiling
// with two cell shapes; the hexagonal gate proved it on the other major lattice
// symmetry, one shape and no diagonals at all. Both of those tilings are
// TRIVALENT, and that is what this file is here to get past.
//
// What Cairo proves that neither of them can: **two cells can be neighbors
// without sharing a side.** At a degree-3 vertex the faces meeting there already
// share edges pairwise, so on 4.8.8 and on the honeycomb the rule that corners
// count is a strict no-op (measured: zero vertex-only pairs on either). Cairo's
// square-lattice sites are degree-4, so each interior pentagon's SEVEN neighbors
// are five it shares a side with plus two it touches at a single point — a link
// with no shared boundary, therefore no wireframe edge, therefore one no wall
// can sever. If the certifier only really understood "shares a border", a board
// certified across those two links would be unsolvable in the hand and nothing
// else in the suite would say so.
//
// Nothing here may reach into the solver. `isBoardSolvable` is imported and
// called exactly as gameplay calls it. The only thing the board does
// differently is carry an explicit `_cellNeighbors` topology instead of letting
// adjacency be derived from rows and cols. If this test ever needs a change
// inside boardSolver.js to pass, that is a finding about the arc, not a thing to
// patch around.
//
// The companion assertions guard the two ways this test could be a lie:
//   - a topology that is not actually the Cairo tiling (valence, corner-link and
//     symmetry checks — and the valence histogram doubles as the guard on CELL
//     ORDERING, since the frozen mine list below is a list of INDICES and means
//     nothing except against the builder's reading order)
//   - a test that passes for a reason unrelated to the tiling (the RECTANGULAR
//     control, which must NOT reproduce the tiling's result)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isBoardSolvable } from '../src/logic/boardSolver.js';
import { buildNeighborCache } from '../src/logic/adjacency.js';
import { buildCairoTiling, buildFixtureBoard, sharedVertexCount, FIXTURE } from './fixtures/tilingCairo.mjs';

const { rows, cols, mines, firstClick, expected } = FIXTURE;

// Adjacency counts come from the board's own topology, exactly as
// recalcAllAdjacency does for a rectangular board.
function stampAdjacency(board, nbrCache) {
  const total = rows * cols;
  for (let i = 0; i < total; i++) {
    const cell = board[(i / cols) | 0][i % cols];
    if (cell.isMine) { cell.adjacentMines = 0; continue; }
    let n = 0;
    for (const ni of nbrCache[i]) {
      if (board[(ni / cols) | 0][ni % cols].isMine) n++;
    }
    cell.adjacentMines = n;
  }
}

// ── The topology is really the Cairo tiling ────────────────────────────────

test('cairo topology: one pentagon everywhere, interior valence 7', () => {
  const T = buildCairoTiling(7, 7);
  assert.equal(T.total, 84, '2MN - M - N pentagons on a 7x7 lattice');
  assert.equal(T.type, 'cairo');
  assert.ok(T.cellVerts.every(cv => cv.length === 5), 'every cell is a pentagon');

  const histogram = {};
  for (const list of T.adj) histogram[list.length] = (histogram[list.length] || 0) + 1;

  // 40 interior pentagons see 7; the rest are patch-boundary cells seeing 6, 5,
  // 4 or 3. Two things ride on this being pinned exactly. The first is the shape
  // itself: 7 is not a number any rectangular assumption produces, and it is odd,
  // where a square grid gives a constant 8 and a honeycomb a constant 6. The
  // second is CELL ORDERING — the histogram moves the instant the builder's
  // reading order changes, and the fixture's frozen mine list is meaningless
  // against any other order, so a silent reordering fails loudly here rather
  // than as a mysterious certification failure.
  assert.deepEqual(histogram, { 3: 4, 4: 12, 5: 8, 6: 20, 7: 40 });
  assert.equal(Math.max(...T.adj.map(l => l.length)), 7, 'no cell ever sees more than 7');
  assert.equal(T.adj[T.centerIndex].length, 7, 'the opener is an interior pentagon');
});

test('cairo topology: corners are neighbors — five sides, seven neighbors', () => {
  const T = buildCairoTiling(7, 7);

  // The rule under test, stated as the topology itself rather than as a count:
  // every interior pentagon's 7 neighbors split into 5 it shares a SIDE with (two
  // shared vertices) and 2 it meets at a single POINT. If corner-inclusive
  // adjacency were ever quietly dropped, valence would fall to a uniform 5 and
  // this split would go to 5/0.
  let interiorChecked = 0;
  for (let i = 0; i < T.total; i++) {
    if (T.adj[i].length !== 7) continue;
    const side = T.adj[i].filter(j => sharedVertexCount(T, i, j) === 2).length;
    const corner = T.adj[i].filter(j => sharedVertexCount(T, i, j) === 1).length;
    assert.equal(side, 5, `cell ${i} shares a side with 5 neighbors`);
    assert.equal(corner, 2, `cell ${i} touches 2 neighbors at a corner only`);
    interiorChecked++;
  }
  assert.equal(interiorChecked, 40);

  // Across the whole patch: 180 links share a side, 70 share only a point. The
  // 70 are the ones that do not exist on either shipped tiling, and no pair ever
  // shares more than 2 vertices (a T-junction would make "shares >= 1 vertex"
  // silently MISS real contacts, which is the failure mode this counts out).
  const shares = {};
  for (let i = 0; i < T.total; i++) {
    for (const j of T.adj[i]) {
      if (j < i) continue;
      const s = sharedVertexCount(T, i, j);
      shares[s] = (shares[s] || 0) + 1;
    }
  }
  assert.deepEqual(shares, { 1: 70, 2: 180 });

  // The opener specifically, since it is where the certified solve starts: two
  // of the seven cells its clue counts are ones it touches at a point only.
  assert.deepEqual(T.adj[firstClick], [35, 40, 43, 49, 53, 56, 61]);
  assert.deepEqual(T.adj[firstClick].filter(j => sharedVertexCount(T, firstClick, j) === 1), [35, 61]);
});

test('cairo topology: symmetric, no self-loops, no duplicates', () => {
  const T = buildCairoTiling(6, 5);
  for (let i = 0; i < T.total; i++) {
    assert.ok(!T.adj[i].includes(i), `cell ${i} is not its own neighbor`);
    assert.equal(new Set(T.adj[i]).size, T.adj[i].length, `cell ${i} has no duplicate neighbors`);
    for (const n of T.adj[i]) {
      assert.ok(T.adj[n].includes(i), `edge ${i}-${n} is symmetric`);
    }
  }
});

test('buildNeighborCache returns the Cairo topology verbatim, ignoring rows and cols', () => {
  const { board, topology } = buildFixtureBoard();
  const cache = buildNeighborCache(board, rows, cols);
  assert.equal(cache.length, rows * cols);
  for (let i = 0; i < topology.total; i++) {
    assert.deepEqual(cache[i].slice().sort((x, y) => x - y),
                     topology.adj[i].slice().sort((x, y) => x - y),
                     `cell ${i} neighbors`);
  }
});

// ── THE GATE ───────────────────────────────────────────────────────────────

test('GATE: the shipped certifier certifies a Cairo pentagonal tiling, unmodified', () => {
  const { board } = buildFixtureBoard();
  const nbrCache = buildNeighborCache(board, rows, cols);
  stampAdjacency(board, nbrCache);

  const fr = (firstClick / cols) | 0;
  const fc = firstClick % cols;
  const result = isBoardSolvable(board, rows, cols, fr, fc, nbrCache);

  assert.equal(result.solvable, true,
    'the no-guess contract must transfer to corner-inclusive adjacency');
  assert.equal(result.remainingUnknowns, 0, 'a full clear, not a partial one');

  // Pinned exactly: if a solver change shifts the move mix on a Cairo board,
  // that should surface here rather than silently.
  assert.deepEqual({
    solvable: result.solvable,
    remainingUnknowns: result.remainingUnknowns,
    totalClicks: result.totalClicks,
    techniqueLevel: result.techniqueLevel,
    passAMoves: result.passAMoves,
    canonicalSubsetMoves: result.canonicalSubsetMoves,
    genericSubsetMoves: result.genericSubsetMoves,
    advancedLogicMoves: result.advancedLogicMoves,
    disjunctiveMoves: result.disjunctiveMoves,
  }, expected);

  // The board demands real reasoning, so the gate is not passing on a trivially
  // cascading layout. This is the first tiling fixture to drive every rung of
  // the ladder at once: counting, BOTH kinds of Pass B subset, and Pass C
  // enumeration.
  assert.ok(result.techniqueLevel >= 2,
    'fixture should require tank/gauss enumeration, not just counting');
  assert.ok(result.advancedLogicMoves >= 1);
  assert.ok(result.canonicalSubsetMoves >= 1);
  assert.ok(result.genericSubsetMoves >= 1);

  // The move-type invariant the par model rests on must hold here too.
  const sum = result.passAMoves + result.canonicalSubsetMoves + result.genericSubsetMoves
            + result.advancedLogicMoves + result.disjunctiveMoves + 1;
  assert.equal(sum, result.totalClicks, 'move-type invariant holds on a pentagonal lattice');
});

test('GATE: the deduction trace is coherent on a Cairo tiling (every proof cites real neighbors)', () => {
  const { board, topology } = buildFixtureBoard();
  const nbrCache = buildNeighborCache(board, rows, cols);
  stampAdjacency(board, nbrCache);

  const fr = (firstClick / cols) | 0;
  const fc = firstClick % cols;
  const result = isBoardSolvable(board, rows, cols, fr, fc, nbrCache, { trace: true });

  assert.equal(result.trace.length + 1, result.totalClicks,
    'trace invariant: one entry per deduced reveal');

  const total = rows * cols;
  for (const step of result.trace) {
    assert.ok(step.cell >= 0 && step.cell < total, 'traced cell is on the board');
    assert.ok(!board[(step.cell / cols) | 0][step.cell % cols].isMine,
      'the solver never deduces a mine as a safe reveal');
    for (const src of step.sources || []) {
      assert.ok(src >= 0 && src < total, 'proving source is on the board');
    }
  }

  // Every Pass A deduction must be proved by a cell it actually touches through
  // the tiling. Note what `reachable` is built from here: the corner-inclusive
  // adjacency, INCLUDING the 70 links with no shared side. A certifier that
  // silently reduced adjacency to shared borders would fail the gate above by
  // arithmetic; one that widened it past the topology fails here.
  const reachable = new Set(topology.adj.flatMap((list, i) => list.map(n => `${Math.min(i, n)}-${Math.max(i, n)}`)));
  for (const step of result.trace) {
    for (const src of step.sources || []) {
      const key = `${Math.min(src, step.cell)}-${Math.max(src, step.cell)}`;
      // Pass C cites a whole union-find component, so a source need not be a
      // direct neighbor; but a Pass A proof always is.
      if (step.tier === 0) {
        assert.ok(reachable.has(key),
          `Pass A cell ${step.cell} cited non-neighbor ${src} — solver read the wrong topology`);
      }
    }
  }
});

// ── The control: prove the gate is reading the Cairo tiling ────────────────

test('CONTROL: the same mine layout under RECTANGULAR adjacency does not reproduce the result', () => {
  // Without _cellNeighbors the board falls back to the implicit 8-neighborhood
  // of its 7x12 container. Same cells, same mines, different topology. If this
  // produced the tiling's answer, the gate above would be proving nothing.
  const { board } = buildFixtureBoard({ topology: 'rectangular' });
  assert.equal(board._cellNeighbors, undefined, 'control carries no explicit topology');

  const nbrCache = buildNeighborCache(board, rows, cols);
  assert.equal(nbrCache[3 * cols + 5].length, 8,
    'rectangular fallback gives a container-interior cell 8 neighbors, not the pentagon 7');
  // The opener is the sharpest single case: the same cell is a full interior
  // pentagon seeing 7 on the tiling, and a container-EDGE cell seeing 5 under
  // the rectangular read. That gap is the whole reason `rows`/`cols` may never
  // be allowed to express adjacency on a tiling.
  assert.equal(nbrCache[firstClick].length, 5, 'the opener sits on the container edge');

  stampAdjacency(board, nbrCache);
  const fr = (firstClick / cols) | 0;
  const fc = firstClick % cols;
  const rectResult = isBoardSolvable(board, rows, cols, fr, fc, nbrCache);

  // Pin the control's actual shape, not merely "something differs". Be honest
  // about how much this half proves, though: at this fixture's density a random
  // layout is unsolvable as a rectangle about 98% of the time AND stalls on the
  // first click about 70% of the time, so NEITHER assertion here is expensive.
  // The gate's discriminating power lives on the tiling side — certifying at
  // density 0.26, which random sampling reaches under 5% of the time — and in
  // the `expected` deepEqual, which is the only thing that catches a corrupted
  // mine list. Both control assertions stay because they cost nothing and pin
  // the control's real shape, not because either one is hard to satisfy.
  assert.equal(rectResult.solvable, false,
    'the Cairo layout is NOT solvable as a rectangle — the topology is doing the work');
  assert.equal(rectResult.totalClicks, 1, 'the rectangular read stalls on the first click');
  assert.ok(rectResult.remainingUnknowns > 0);

  assert.notDeepEqual(
    { c: rectResult.totalClicks, a: rectResult.passAMoves, t: rectResult.techniqueLevel },
    { c: expected.totalClicks, a: expected.passAMoves, t: expected.techniqueLevel },
    'rectangular adjacency must give a different solve — otherwise the gate is vacuous');
});

test('CONTROL: mines are the only difference — an all-safe Cairo tiling clears in one click', () => {
  // Sanity on the harness itself: with no mines, the first click must cascade
  // across the whole tiling. If the topology were disconnected or the flood did
  // not follow it, this would fail.
  const { board } = buildFixtureBoard();
  for (const row of board) for (const cell of row) { cell.isMine = false; cell.adjacentMines = 0; }
  const nbrCache = buildNeighborCache(board, rows, cols);

  const result = isBoardSolvable(board, rows, cols, 0, 0, nbrCache);
  assert.equal(result.solvable, true);
  assert.equal(result.totalClicks, 1, 'one click clears an empty connected Cairo tiling');
});

test('the fixture really carries the mines it claims (guard against a stale freeze)', () => {
  // What this catches is the fixture BUILDER drifting from its own declaration:
  // a changed container, or a changed index-to-(row, col) mapping, would put the
  // mines somewhere other than where the frozen list says and nothing else here
  // would name the reason. The control cannot help with any of it — at this
  // density a rearranged layout is still unsolvable as a rectangle about 98% of
  // the time — so a rewritten mine list is caught only by the exact `expected`
  // deepEqual in the gate above. Both guards are load-bearing.
  const { board } = buildFixtureBoard();
  const found = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (board[r][c].isMine) found.push(r * cols + c);
  assert.deepEqual(found, mines.slice().sort((a, b) => a - b));
  assert.equal(found.length, 22, 'twenty-two mines on 84 pentagons');
  assert.ok(!board[(firstClick / cols) | 0][firstClick % cols].isMine, 'the opener is not a mine');
  assert.equal(firstClick, buildCairoTiling(FIXTURE.M, FIXTURE.N).centerIndex,
    'the frozen opener is the builder\'s own center cell, as daily/weekly certify from');
});
