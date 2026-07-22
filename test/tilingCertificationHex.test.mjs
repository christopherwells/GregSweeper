// ── Project Coastline, tiling #2: the hexagonal gate ───────────────────────
//
// The 4.8.8 gate (tilingCertification.test.mjs) proved the no-guess contract
// survives on a MIXED-valence Archimedean tiling. This file asks the same
// question of the other major lattice symmetry — a 6.6.6 honeycomb — and it is
// a different question, because the two tilings disagree about the most basic
// thing a minesweeper board can say: 4.8.8 is a square lattice with its corners
// cut, while a hexagon has NO diagonals at all and a constant interior valence
// of 6.
//
// Nothing here may reach into the solver. `isBoardSolvable` is imported and
// called exactly as gameplay calls it. The only thing the board does
// differently is carry an explicit `_cellNeighbors` topology instead of letting
// adjacency be derived from rows and cols. If this test ever needs a change
// inside boardSolver.js to pass, that is a finding about the arc, not a thing
// to patch around.
//
// The companion assertions guard the two ways this test could be a lie:
//   - a topology that is not actually the honeycomb (valence + symmetry checks)
//   - a test that passes for a reason unrelated to the tiling (the RECTANGULAR
//     control, which must NOT reproduce the tiling's result)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isBoardSolvable } from '../src/logic/boardSolver.js';
import { buildNeighborCache } from '../src/logic/adjacency.js';
import { buildHexTiling, buildFixtureBoard, FIXTURE } from './fixtures/tilingHex.mjs';

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

// ── The topology is really the honeycomb ───────────────────────────────────

test('6.6.6 topology: one shape, constant interior valence 6', () => {
  const T = buildHexTiling(7, 7);
  assert.equal(T.total, 49, '7x7 hexagons');
  assert.equal(T.type, 'hex');

  const histogram = {};
  for (const list of T.adj) histogram[list.length] = (histogram[list.length] || 0) + 1;

  // 25 interior hexagons see 6; the rest are grid-edge cells seeing 5, 4, 3 or 2.
  // The point is the CEILING: nothing sees more than 6, where a square grid's
  // interior cell sees 8. This is the shape no rectangular assumption produces.
  assert.deepEqual(histogram, { 2: 2, 3: 7, 4: 10, 5: 5, 6: 25 });
  assert.equal(Math.max(...T.adj.map(l => l.length)), 6, 'no cell ever sees more than 6');

  const idx = (i, j) => i * 7 + j;
  assert.equal(T.adj[idx(3, 3)].length, 6, 'interior hexagon sees exactly 6');
});

test('6.6.6 topology: a hexagon has NO diagonals (the honeycomb surprise)', () => {
  const T = buildHexTiling(7, 7);
  const idx = (i, j) => i * 7 + j;
  const nbrs = T.adj[idx(3, 3)].slice().sort((a, b) => a - b);

  // Row 3 is an odd (shifted) row, so the six edge-neighbors are the two in-row
  // cells plus (2,3),(2,4) above and (4,3),(4,4) below.
  assert.deepEqual(nbrs, [idx(2, 3), idx(2, 4), idx(3, 2), idx(3, 4), idx(4, 3), idx(4, 4)].sort((a, b) => a - b));

  // On a square grid (3,3) would ALSO touch (2,2) and (4,2) as diagonals. Here
  // there is no such relationship at all — every neighbor is an edge neighbor.
  assert.ok(!T.adj[idx(3, 3)].includes(idx(2, 2)), 'no diagonal neighbor (2,2)');
  assert.ok(!T.adj[idx(3, 3)].includes(idx(4, 2)), 'no diagonal neighbor (4,2)');
});

test('6.6.6 topology: symmetric, no self-loops, no duplicates', () => {
  const T = buildHexTiling(6, 5);
  for (let i = 0; i < T.total; i++) {
    assert.ok(!T.adj[i].includes(i), `cell ${i} is not its own neighbor`);
    assert.equal(new Set(T.adj[i]).size, T.adj[i].length, `cell ${i} has no duplicate neighbors`);
    for (const n of T.adj[i]) {
      assert.ok(T.adj[n].includes(i), `edge ${i}-${n} is symmetric`);
    }
  }
});

test('buildNeighborCache returns the hexagonal topology verbatim, ignoring rows and cols', () => {
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

test('GATE: the shipped certifier certifies a 6.6.6 hexagonal tiling, unmodified', () => {
  const { board } = buildFixtureBoard();
  const nbrCache = buildNeighborCache(board, rows, cols);
  stampAdjacency(board, nbrCache);

  const fr = (firstClick / cols) | 0;
  const fc = firstClick % cols;
  const result = isBoardSolvable(board, rows, cols, fr, fc, nbrCache);

  assert.equal(result.solvable, true,
    'the no-guess contract must transfer to hexagonal adjacency');
  assert.equal(result.remainingUnknowns, 0, 'a full clear, not a partial one');

  // Pinned exactly: if a solver change shifts the move mix on a hex board, that
  // should surface here rather than silently.
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
  // cascading layout — it drives Pass B subsets AND Pass C enumeration.
  assert.ok(result.techniqueLevel >= 2,
    'fixture should require tank/gauss enumeration, not just counting');
  assert.ok(result.advancedLogicMoves >= 1);
  assert.ok(result.genericSubsetMoves >= 1);

  // The move-type invariant the par model rests on must hold here too.
  const sum = result.passAMoves + result.canonicalSubsetMoves + result.genericSubsetMoves
            + result.advancedLogicMoves + result.disjunctiveMoves + 1;
  assert.equal(sum, result.totalClicks, 'move-type invariant holds on a honeycomb');
});

test('GATE: the deduction trace is coherent on a honeycomb (every proof cites real neighbors)', () => {
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
  // the honeycomb — a proof citing a non-neighbor would mean the solver read a
  // rectangle somewhere.
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

// ── The control: prove the gate is reading the honeycomb ───────────────────

test('CONTROL: the same mine layout under RECTANGULAR adjacency does not reproduce the result', () => {
  // Without _cellNeighbors the board falls back to the implicit 8-neighborhood
  // of its 7x7 container. Same cells, same mines, different topology. If this
  // produced the honeycomb's answer, the gate above would be proving nothing.
  const { board } = buildFixtureBoard({ topology: 'rectangular' });
  assert.equal(board._cellNeighbors, undefined, 'control carries no explicit topology');

  const nbrCache = buildNeighborCache(board, rows, cols);
  assert.equal(nbrCache[FIXTURE.M * 3 + 3].length, 8,
    'rectangular fallback gives an interior cell 8 neighbors, not the hexagon 6');

  stampAdjacency(board, nbrCache);
  const fr = (firstClick / cols) | 0;
  const fc = firstClick % cols;
  const rectResult = isBoardSolvable(board, rows, cols, fr, fc, nbrCache);

  // Pin the control's actual shape, not merely "something differs". Under
  // rectangular adjacency this layout does not even solve — it stalls
  // immediately — so a future change that degraded the control into a near-miss
  // would surface here instead of quietly weakening the gate.
  assert.equal(rectResult.solvable, false,
    'the hex layout is NOT solvable as a rectangle — the topology is doing the work');
  assert.equal(rectResult.totalClicks, 1, 'the rectangular read stalls on the first click');
  assert.ok(rectResult.remainingUnknowns > 0);

  assert.notDeepEqual(
    { c: rectResult.totalClicks, a: rectResult.passAMoves, t: rectResult.techniqueLevel },
    { c: expected.totalClicks, a: expected.passAMoves, t: expected.techniqueLevel },
    'rectangular adjacency must give a different solve — otherwise the gate is vacuous');
});

test('CONTROL: mines are the only difference — an all-safe honeycomb clears in one click', () => {
  // Sanity on the harness itself: with no mines, the first click must cascade
  // across the whole tiling. If the topology were disconnected or the flood did
  // not follow it, this would fail.
  const { board } = buildFixtureBoard();
  for (const row of board) for (const cell of row) { cell.isMine = false; cell.adjacentMines = 0; }
  const nbrCache = buildNeighborCache(board, rows, cols);

  const result = isBoardSolvable(board, rows, cols, 0, 0, nbrCache);
  assert.equal(result.solvable, true);
  assert.equal(result.totalClicks, 1, 'one click clears an empty connected honeycomb');
});

test('the fixture really carries the mines it claims (guard against a stale freeze)', () => {
  const { board } = buildFixtureBoard();
  const found = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (board[r][c].isMine) found.push(r * cols + c);
  assert.deepEqual(found, mines.slice().sort((a, b) => a - b));
  assert.equal(found.length, 9, 'nine mines on 49 hexagons');
  assert.ok(!board[(firstClick / cols) | 0][firstClick % cols].isMine, 'the opener is not a mine');
});
