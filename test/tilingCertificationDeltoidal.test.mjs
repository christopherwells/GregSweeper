// ── Project Coastline, tiling #6: the deltoidal trihexagonal gate ──────────
//
// The 4.8.8 gate proved the no-guess contract survives on a mixed-valence
// Archimedean tiling; the hex gate proved it again on the other major lattice
// symmetry. Both of those tilings are TRIVALENT — three cells at every vertex,
// and all three already sharing edges — so both certify against an adjacency
// graph that happens to be exactly the edge graph.
//
// This file asks the question the shipped two structurally cannot. Under
// Christopher's rule (2026-07-27, "corners are adjacent in mine counts") two
// cells touching at only a VERTEX are neighbors, as diagonal cells are on a
// square grid. That rule is a measured no-op on 4.8.8 and on the honeycomb, and
// so no gate has ever run the certifier against a board where it does anything.
// A deltoidal patch is built around degree-SIX vertices: six kites meet at each
// hexagon hub, nine of their fifteen pairs meet at that point and nowhere else,
// and interior valence comes out at 9 — DENSER than the square grid's 8, where
// 4.8.8 tops out at 8 and a hexagon at 6. So this is the gate that proves the
// contract holds when the neighborhood is not the edge graph, and it is also
// the first tiling whose clues can read above the classic ceiling of 8.
//
// Nothing here may reach into the solver. `isBoardSolvable` is imported and
// called exactly as gameplay calls it. The only thing the board does
// differently is carry an explicit `_cellNeighbors` topology instead of letting
// adjacency be derived from rows and cols. If this test ever needs a change
// inside boardSolver.js to pass, that is a finding about the arc, not a thing
// to patch around.
//
// The companion assertions guard the two ways this test could be a lie:
//   - a topology that is not actually the kite lattice (valence + corner-rule +
//     symmetry checks; the frozen mine list is a list of INDICES and means
//     nothing except against the builder's reading order, so a reordering has
//     to fail loudly here rather than quietly move the board)
//   - a test that passes for a reason unrelated to the tiling (the RECTANGULAR
//     control, which must NOT reproduce the tiling's result)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isBoardSolvable } from '../src/logic/boardSolver.js';
import { buildNeighborCache } from '../src/logic/adjacency.js';
import { buildDeltoidalTiling, buildFixtureBoard, FIXTURE } from './fixtures/tilingDeltoidal.mjs';

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

/** The vertices two cells hold in common, by index into the tiling's vert list. */
function sharedVerts(T, a, b) {
  return T.cellVerts[a].filter(v => T.cellVerts[b].includes(v));
}

// ── The topology is really the kite lattice ────────────────────────────────

test('deltoidal topology: one kite shape, corner-inclusive interior valence 9', () => {
  const T = buildDeltoidalTiling(3, 4);
  assert.equal(T.total, 72, '6 kites per hexagon over a 3x4 hexagon lattice');
  assert.equal(T.type, 'deltoidal');

  const histogram = {};
  for (const list of T.adj) histogram[list.length] = (histogram[list.length] || 0) + 1;

  // 36 interior kites see 9; the patch's border cells see 7 or 5. The number
  // that matters is the CEILING, and it is the first one in this arc that goes
  // UP: a square grid's interior cell sees 8, a 4.8.8 octagon 8, a hexagon 6,
  // and a kite here sees 9. That also makes this the first tiling on which a
  // clue can legitimately read 9. That is what forced the clueShares histogram
  // to stop capping at digit 8, which CLAUDE.md had carried as a latent
  // rectangular assumption until this lattice reached it; the widened counting
  // is pinned in test/tilingFeatures.test.mjs, not here, because this fixture's
  // densest clue is a 5.
  assert.deepEqual(histogram, { 5: 16, 7: 20, 9: 36 });
  assert.equal(Math.max(...T.adj.map(l => l.length)), 9, 'a kite can see 9, one more than a square');

  assert.equal(T.adj[firstClick].length, 9, 'the opener is an interior kite');
});

test('deltoidal topology: cells that touch at only a POINT are neighbors (the corner rule)', () => {
  const T = buildDeltoidalTiling(3, 4);

  // The hexagon hub the opener is cut from: a degree-6 vertex, shared by the six
  // kites of one hexagon. On 4.8.8 and on the honeycomb no such vertex exists —
  // both are trivalent — which is exactly why the corner rule is a no-op there
  // and load-bearing here.
  const hubs = T.cellVerts[firstClick].filter(v => T.cellVerts.filter(cv => cv.includes(v)).length === 6);
  assert.equal(hubs.length, 1, 'a kite belongs to exactly one hexagon hub');
  const around = T.cellVerts.flatMap((cv, ci) => (cv.includes(hubs[0]) ? [ci] : []));

  // Pinned as literal indices: this doubles as the reading-order guard. The
  // frozen mine list below only means something against the builder's ordering,
  // so if that ever moves, it fails HERE with a legible message rather than as
  // a mysterious certification failure in the gate.
  assert.deepEqual(around, [25, 30, 31, 38, 39, 45], 'the six kites of the opener hexagon');

  let cornerOnly = 0;
  for (let a = 0; a < around.length; a++) {
    for (let b = a + 1; b < around.length; b++) {
      assert.ok(T.adj[around[a]].includes(around[b]),
        `kites ${around[a]} and ${around[b]} share the hub, so they are neighbors`);
      if (sharedVerts(T, around[a], around[b]).length === 1) cornerOnly++;
    }
  }
  // Six consecutive pairs around the hub share a whole side; the other nine
  // meet at the hub alone. Under an edge-only reading those nine links would
  // not exist and interior valence would be 4, not 9.
  assert.equal(cornerOnly, 9, 'nine of the fifteen hub pairs touch at a point only');

  // The same fact stated on the opener itself: 4 of its 9 neighbors share a
  // side with it, 5 share only a corner.
  const byShare = T.adj[firstClick].map(n => sharedVerts(T, firstClick, n).length);
  assert.equal(byShare.filter(s => s === 2).length, 4, 'four edge neighbors');
  assert.equal(byShare.filter(s => s === 1).length, 5, 'five corner-only neighbors');
});

test('deltoidal topology: symmetric, no self-loops, no duplicates', () => {
  const T = buildDeltoidalTiling(4, 3);
  for (let i = 0; i < T.total; i++) {
    assert.ok(!T.adj[i].includes(i), `cell ${i} is not its own neighbor`);
    assert.equal(new Set(T.adj[i]).size, T.adj[i].length, `cell ${i} has no duplicate neighbors`);
    for (const n of T.adj[i]) {
      assert.ok(T.adj[n].includes(i), `edge ${i}-${n} is symmetric`);
    }
  }
});

test('buildNeighborCache returns the kite topology verbatim, ignoring rows and cols', () => {
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

test('GATE: the shipped certifier certifies a deltoidal trihexagonal tiling, unmodified', () => {
  const { board } = buildFixtureBoard();
  const nbrCache = buildNeighborCache(board, rows, cols);
  stampAdjacency(board, nbrCache);

  const fr = (firstClick / cols) | 0;
  const fc = firstClick % cols;
  const result = isBoardSolvable(board, rows, cols, fr, fc, nbrCache);

  assert.equal(result.solvable, true,
    'the no-guess contract must transfer to corner-inclusive adjacency');
  assert.equal(result.remainingUnknowns, 0, 'a full clear, not a partial one');

  // Pinned exactly: if a solver change shifts the move mix on a kite board,
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
  // cascading layout — it drives Pass B subsets AND Pass C enumeration. This is
  // the deepest-searching of the four Laves lattices: 20 of its 34 deductions
  // are tank/gauss, where the hex fixture needed 4 and the 4.8.8 fixture 6.
  assert.ok(result.techniqueLevel >= 2,
    'fixture should require tank/gauss enumeration, not just counting');
  assert.ok(result.advancedLogicMoves >= 1);
  assert.ok(result.genericSubsetMoves >= 1);

  // The move-type invariant the par model rests on must hold here too.
  const sum = result.passAMoves + result.canonicalSubsetMoves + result.genericSubsetMoves
            + result.advancedLogicMoves + result.disjunctiveMoves + 1;
  assert.equal(sum, result.totalClicks, 'move-type invariant holds on corner-inclusive adjacency');
});

test('GATE: the deduction trace is coherent on a kite lattice (every proof cites real neighbors)', () => {
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
  // the kite lattice — a proof citing a non-neighbor would mean the solver read
  // a rectangle somewhere. Here that check reaches further than it did on the
  // shipped two: five of an interior kite's nine neighbors are corner-only, so
  // a solver that had quietly kept the edge graph would fail this.
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

// ── The control: prove the gate is reading the kite lattice ────────────────

test('CONTROL: the same mine layout under RECTANGULAR adjacency does not reproduce the result', () => {
  // Without _cellNeighbors the board falls back to the implicit 8-neighborhood
  // of its 8x9 container. Same cells, same mines, different topology. If this
  // produced the tiling's answer, the gate above would be proving nothing.
  const { board } = buildFixtureBoard({ topology: 'rectangular' });
  assert.equal(board._cellNeighbors, undefined, 'control carries no explicit topology');

  const nbrCache = buildNeighborCache(board, rows, cols);
  assert.equal(nbrCache[firstClick].length, 8,
    'rectangular fallback gives the opener 8 neighbors, one FEWER than its 9 kites');

  stampAdjacency(board, nbrCache);
  const fr = (firstClick / cols) | 0;
  const fc = firstClick % cols;
  const rectResult = isBoardSolvable(board, rows, cols, fr, fc, nbrCache);

  // Pin the control's actual shape, not merely "something differs". At this
  // board's density (19 mines on 72 cells) a rectangular read is unsolvable
  // most of the time anyway, and it also stalls on the first click most of the
  // time, so BOTH halves are close to free. That is worth saying plainly rather
  // than implying the click pin is doing heavy lifting. The gate is non-vacuous
  // because of what happens on the tiling side — handing the control the kite
  // topology fails it — and because the `expected` deepEqual pins all nine
  // counters. Both halves are still asserted, so a change that degraded the
  // control into a near-miss surfaces here rather than quietly.
  assert.equal(rectResult.solvable, false,
    'the kite layout is NOT solvable as a rectangle — the topology is doing the work');
  assert.equal(rectResult.totalClicks, 1, 'the rectangular read stalls on the first click');
  assert.equal(rectResult.remainingUnknowns, 52);

  assert.notDeepEqual(
    { c: rectResult.totalClicks, a: rectResult.passAMoves, t: rectResult.techniqueLevel },
    { c: expected.totalClicks, a: expected.passAMoves, t: expected.techniqueLevel },
    'rectangular adjacency must give a different solve — otherwise the gate is vacuous');
});

test('CONTROL: mines are the only difference — an all-safe kite lattice clears in one click', () => {
  // Sanity on the harness itself: with no mines, the first click must cascade
  // across the whole tiling. If the topology were disconnected or the flood did
  // not follow it, this would fail.
  const { board } = buildFixtureBoard();
  for (const row of board) for (const cell of row) { cell.isMine = false; cell.adjacentMines = 0; }
  const nbrCache = buildNeighborCache(board, rows, cols);

  const result = isBoardSolvable(board, rows, cols, 0, 0, nbrCache);
  assert.equal(result.solvable, true);
  assert.equal(result.totalClicks, 1, 'one click clears an empty connected kite lattice');
});

test('the fixture really carries the mines it claims (guard against a stale freeze)', () => {
  // The control cannot catch a corrupted mine list — a scrambled layout at this
  // density is still unsolvable as a rectangle about 95% of the time — so this
  // guard and the exact `expected` above are what protect the freeze.
  const { board } = buildFixtureBoard();
  const found = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (board[r][c].isMine) found.push(r * cols + c);
  assert.deepEqual(found, mines.slice().sort((a, b) => a - b));
  assert.equal(found.length, 19, 'nineteen mines on 72 kites');
  assert.ok(!board[(firstClick / cols) | 0][firstClick % cols].isMine, 'the opener is not a mine');
});
