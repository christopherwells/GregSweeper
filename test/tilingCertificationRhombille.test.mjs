// ── Project Coastline, tiling #5: the rhombille gate ───────────────────────
//
// The 4.8.8 gate (tilingCertification.test.mjs) proved the no-guess contract
// survives on a MIXED-valence Archimedean tiling; the hex gate
// (tilingCertificationHex.test.mjs) proved it on a constant-valence one. Both
// asked the question with a cell that sees at most what a square-grid cell sees
// — 4.8.8 tops out at 8, a hexagon at 6.
//
// This file asks it from the other side, and that is the thing rhombille proves
// which neither shipped tiling can:
//
//   - Its interior valence is 10, ABOVE the rectangle's 8. Every earlier gate
//     showed the certifier reasoning over a differently-SHAPED neighborhood;
//     this one shows it reasoning over a strictly LARGER one.
//   - It is the first lattice on which corner-inclusive adjacency is not a
//     no-op. On 4.8.8 and on the honeycomb every vertex is degree 3, so the rule
//     adds nothing; here it more than doubles the graph, and most of every
//     neighborhood exists only because of it.
//   - Its deduction ladder has a MISSING RUNG. Pass B is structurally dead on
//     this lattice, so the board certifies at techniqueLevel 2 by going from
//     Pass A straight to Pass C. That makes this the gate that proves the
//     certifier's tank/gauss layer can carry the whole load on its own.
//
// Nothing here may reach into the solver. `isBoardSolvable` is imported and
// called exactly as gameplay calls it. The only thing the board does
// differently is carry an explicit `_cellNeighbors` topology instead of letting
// adjacency be derived from rows and cols. If this test ever needs a change
// inside boardSolver.js to pass, that is a finding about the arc, not a thing
// to patch around.
//
// The companion assertions guard the two ways this test could be a lie:
//   - a topology that is not actually rhombille (valence, split and symmetry
//     checks, plus a pin on the reading order the frozen indices depend on)
//   - a test that passes for a reason unrelated to the tiling (the RECTANGULAR
//     control, which must NOT reproduce the tiling's result)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isBoardSolvable } from '../src/logic/boardSolver.js';
import { buildNeighborCache } from '../src/logic/adjacency.js';
import { buildRhombilleTiling, buildFixtureBoard, FIXTURE } from './fixtures/tilingRhombille.mjs';

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

/** How many vertices two cells share: 2 = a shared side, 1 = a corner touch. */
function sharedVertices(topology, a, b) {
  const va = new Set(topology.cellVerts[a]);
  return topology.cellVerts[b].filter(v => va.has(v)).length;
}

// ── The topology is really rhombille ───────────────────────────────────────

test('rhombille topology: three rhombi per hexagon, and a neighborhood BIGGER than a square grid\'s', () => {
  const T = buildRhombilleTiling(5, 6);
  assert.equal(T.total, 90, '3 rhombi per hexagon over a 5x6 hexagon lattice');
  assert.equal(T.type, 'rhombille');

  const histogram = {};
  for (const list of T.adj) histogram[list.length] = (histogram[list.length] || 0) + 1;

  // 43 interior rhombi see 10; the rest are patch-edge cells seeing 8, 6, 4 or 2.
  // The point is the CEILING, and it runs the opposite way from every earlier
  // gate: 4.8.8 tops out at 8 and a hexagon at 6, so both sit at or under a
  // square grid's interior valence. Here a cell sees TWO MORE than a rectangular
  // cell does, which is what makes clues above the classic 8 possible at all.
  assert.deepEqual(histogram, { 2: 1, 4: 7, 6: 20, 8: 19, 10: 43 });
  assert.equal(Math.max(...T.adj.map(l => l.length)), 10,
    'interior valence 10, against the rectangle\'s 8');

  // Not an artifact of this one patch size.
  const small = buildRhombilleTiling(4, 4);
  assert.equal(small.total, 48);
  assert.equal(Math.max(...small.adj.map(l => l.length)), 10);
});

test('rhombille topology: corner-inclusive adjacency is doing real work (it is a no-op on both shipped tilings)', () => {
  const T = buildRhombilleTiling(5, 6);

  // Christopher's rule (2026-07-27): cells touching at a single VERTEX are
  // neighbors, exactly as diagonal cells are on a square grid. On 4.8.8 and on
  // the honeycomb every vertex is degree 3, so all incident cells already share
  // edges and the rule adds literally nothing. Rhombille has degree-6 vertices
  // at every hexagon center's ring, so it is the first lattice where the rule
  // changes the answer — and it does not change it slightly.
  let edgeLinks = 0, cornerLinks = 0;
  for (let i = 0; i < T.total; i++) {
    for (const n of T.adj[i]) {
      const shared = sharedVertices(T, i, n);
      assert.ok(shared === 1 || shared === 2,
        `cells ${i} and ${n} are neighbors but share ${shared} vertices`);
      if (shared === 2) edgeLinks++; else cornerLinks++;
    }
  }
  assert.equal(edgeLinks / 2, 159, 'links through a shared side');
  assert.equal(cornerLinks / 2, 207, 'links that exist ONLY because corners count');

  // An interior rhombus: 4 through its own sides, 6 through its corners. Drop
  // the corner rule and this lattice would read as valence 4, sparser than a
  // hexagon rather than denser than a rectangle.
  const interior = T.adj.findIndex(l => l.length === 10);
  const split = T.adj[interior].map(n => sharedVertices(T, interior, n));
  assert.equal(split.filter(s => s === 2).length, 4, 'four edge neighbors');
  assert.equal(split.filter(s => s === 1).length, 6, 'six corner-only neighbors');
});

test('rhombille topology: symmetric, no self-loops, no duplicates', () => {
  const T = buildRhombilleTiling(4, 5);
  for (let i = 0; i < T.total; i++) {
    assert.ok(!T.adj[i].includes(i), `cell ${i} is not its own neighbor`);
    assert.equal(new Set(T.adj[i]).size, T.adj[i].length, `cell ${i} has no duplicate neighbors`);
    for (const n of T.adj[i]) {
      assert.ok(T.adj[n].includes(i), `edge ${i}-${n} is symmetric`);
    }
  }
});

test('rhombille topology: the reading order the frozen fixture is indexed against', () => {
  // The fixture's mine list is a list of INDICES and means nothing except
  // against the builder's reading order. A histogram cannot catch a reordering
  // (it is permutation-invariant) and the gate below would catch one only as an
  // inscrutable counter mismatch, so pin the order itself here where the failure
  // message says what actually happened.
  const T = buildRhombilleTiling(5, 6);
  assert.equal(T.centerIndex, firstClick, 'the opener is the patch\'s own center cell');
  assert.deepEqual(T.adj[firstClick], [28, 29, 38, 39, 47, 49, 56, 57, 65, 66],
    'reading order moved — every index in the frozen fixture now means a different cell');
});

test('buildNeighborCache returns the rhombille topology verbatim, ignoring rows and cols', () => {
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

test('GATE: the shipped certifier certifies a rhombille tiling, unmodified', () => {
  const { board } = buildFixtureBoard();
  const nbrCache = buildNeighborCache(board, rows, cols);
  stampAdjacency(board, nbrCache);

  const fr = (firstClick / cols) | 0;
  const fc = firstClick % cols;
  const result = isBoardSolvable(board, rows, cols, fr, fc, nbrCache);

  assert.equal(result.solvable, true,
    'the no-guess contract must transfer to a neighborhood LARGER than a rectangle\'s');
  assert.equal(result.remainingUnknowns, 0, 'a full clear, not a partial one');

  // Pinned exactly: if a solver change shifts the move mix on a rhombille board,
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
  // cascading layout.
  assert.ok(result.techniqueLevel >= 2,
    'fixture should require tank/gauss enumeration, not just counting');
  assert.ok(result.advancedLogicMoves >= 1);

  // WHY THIS GATE DIFFERS FROM THE HEX GATE, which asserts genericSubsetMoves
  // >= 1 at exactly this point: Pass B is structurally dead on rhombille. It
  // finds subset pairs and they almost never resolve, so no deduction follows
  // and the ladder runs Pass A straight to Pass C. Measured three times
  // independently — 0 Pass B moves across 1500 constructively generated
  // certified boards, 0 across 103 certified boards in a random sweep, and 0
  // across 678 certified boards in a third sweep run while building this gate.
  // So the honest assertion is the ABSENCE, not a weaker presence check: this
  // fixture reaches techniqueLevel 2 with nothing on the middle rung, which
  // means the tank/gauss layer carried every non-trivial deduction by itself.
  // If a Pass B move ever appears here, that is a real finding about the
  // solver or the lattice and should be investigated, not accommodated.
  assert.equal(result.canonicalSubsetMoves, 0, 'Pass B does not resolve on rhombille');
  assert.equal(result.genericSubsetMoves, 0, 'Pass B does not resolve on rhombille');
  assert.equal(result.passAMoves + result.advancedLogicMoves + 1, result.totalClicks,
    'the whole solve is Pass A plus Pass C, with nothing between them');

  // The move-type invariant the par model rests on must hold here too.
  const sum = result.passAMoves + result.canonicalSubsetMoves + result.genericSubsetMoves
            + result.advancedLogicMoves + result.disjunctiveMoves + 1;
  assert.equal(sum, result.totalClicks, 'move-type invariant holds on rhombille');
});

test('GATE: the deduction trace is coherent on rhombille (every proof cites real neighbors)', () => {
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
  // the tiling — a proof citing a non-neighbor would mean the solver read a
  // rectangle somewhere. This is a sharper check here than on the earlier gates:
  // most of a rhombille neighborhood is corner-only links, so a solver that
  // quietly fell back to edge adjacency would still find SOME valid proofs and
  // only this assertion would notice.
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

// ── The control: prove the gate is reading rhombille ───────────────────────

test('CONTROL: the same mine layout under RECTANGULAR adjacency does not reproduce the result', () => {
  // Without _cellNeighbors the board falls back to the implicit 8-neighborhood
  // of its 9x10 container. Same cells, same mines, different topology. If this
  // produced rhombille's answer, the gate above would be proving nothing.
  const { board } = buildFixtureBoard({ topology: 'rectangular' });
  assert.equal(board._cellNeighbors, undefined, 'control carries no explicit topology');

  const nbrCache = buildNeighborCache(board, rows, cols);
  assert.equal(nbrCache[firstClick].length, 8,
    'rectangular fallback gives an interior cell 8 neighbors, not the rhombus 10');

  stampAdjacency(board, nbrCache);
  const fr = (firstClick / cols) | 0;
  const fc = firstClick % cols;
  const rectResult = isBoardSolvable(board, rows, cols, fr, fc, nbrCache);

  // Pin the control's actual shape, not merely "something differs" — while
  // being honest that neither half is expensive here. At this fixture's density
  // a rectangular read of a random layout is unsolvable ~96% of the time and
  // stalls on the first click roughly half the time, so the control is cheap to
  // satisfy. What actually makes this gate non-vacuous is on the tiling side:
  // handing the control the rhombille topology fails it outright, and the
  // `expected` deepEqual is the only guard against a corrupted mine list. Both
  // assertions stay because they pin the control's real shape.
  assert.equal(rectResult.solvable, false,
    'the rhombille layout is NOT solvable as a rectangle — the topology is doing the work');
  assert.equal(rectResult.totalClicks, 1, 'the rectangular read stalls on the first click');
  assert.equal(rectResult.remainingUnknowns, 66);

  assert.notDeepEqual(
    { c: rectResult.totalClicks, a: rectResult.passAMoves, t: rectResult.techniqueLevel },
    { c: expected.totalClicks, a: expected.passAMoves, t: expected.techniqueLevel },
    'rectangular adjacency must give a different solve — otherwise the gate is vacuous');
});

test('CONTROL: mines are the only difference — an all-safe rhombille clears in one click', () => {
  // Sanity on the harness itself: with no mines, the first click must cascade
  // across the whole tiling. If the topology were disconnected or the flood did
  // not follow it, this would fail.
  const { board } = buildFixtureBoard();
  for (const row of board) for (const cell of row) { cell.isMine = false; cell.adjacentMines = 0; }
  const nbrCache = buildNeighborCache(board, rows, cols);

  const result = isBoardSolvable(board, rows, cols, 0, 0, nbrCache);
  assert.equal(result.solvable, true);
  assert.equal(result.totalClicks, 1, 'one click clears an empty connected rhombille patch');
});

test('the fixture really carries the mines it claims (guard against a stale freeze)', () => {
  // The rectangular control cannot catch a corrupted mine list — a scrambled
  // list at this density is still ~96% unsolvable as a rectangle, so it would
  // sail past the control and only fail the gate's counter deepEqual. This is
  // the assertion that says WHY.
  const { board } = buildFixtureBoard();
  const found = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (board[r][c].isMine) found.push(r * cols + c);
  assert.deepEqual(found, mines.slice().sort((a, b) => a - b));
  assert.equal(found.length, 23, 'twenty-three mines on 90 rhombi');
  assert.ok(!board[(firstClick / cols) | 0][firstClick % cols].isMine, 'the opener is not a mine');
});
