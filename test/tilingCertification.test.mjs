// ── Project Coastline, Phase 1: the gate ───────────────────────────────────
//
// The whole point of Phase 1 is one question. The arc takes the no-guess board
// off the square grid onto Archimedean tilings; if the no-guess CONTRACT does
// not survive that move, everything after it is wasted. So this file runs the
// SHIPPED, UNMODIFIED certifier against a hand-authored 4.8.8 truncated-square
// tiling and asserts it certifies.
//
// Nothing here may reach into the solver. `isBoardSolvable` is imported and
// called exactly as gameplay calls it. The only thing the board does
// differently is carry an explicit `_cellNeighbors` topology instead of
// letting adjacency be derived from rows and cols. If this test ever needs a
// change inside boardSolver.js to pass, that is a finding about the arc, not a
// thing to patch around.
//
// The companion assertions guard the two ways this test could be a lie:
//   - a topology that is not actually the tiling (valence + symmetry checks)
//   - a test that passes for a reason unrelated to the tiling (the RECTANGULAR
//     control, which must NOT reproduce the tiling's result)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isBoardSolvable } from '../src/logic/boardSolver.js';
import { buildNeighborCache, defineCellNeighbors } from '../src/logic/adjacency.js';
import { buildTiling488, buildFixtureBoard, FIXTURE } from './fixtures/tiling488.mjs';

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

// ── The topology is really the tiling ──────────────────────────────────────

test('4.8.8 topology: octagons and squares, with the valences the tiling demands', () => {
  const T = buildTiling488(6, 7);
  assert.equal(T.nOct, 42, '6x7 octagon lattice');
  assert.equal(T.nSq, 30, 'one square per interstice');
  assert.equal(T.total, 72);

  const histogram = {};
  for (const list of T.adj) histogram[list.length] = (histogram[list.length] || 0) + 1;

  // Every small square touches exactly its 4 surrounding octagons.
  // Octagons: 8 in the interior (4 octagons + 4 squares), 5 along an edge,
  // 3 at a corner. This is the shape no rectangular assumption can produce —
  // a square grid has constant-8 interior valence, and here it is not even
  // constant.
  assert.deepEqual(histogram, { 3: 4, 4: 30, 5: 18, 8: 20 });

  const interior = T.adj[T.octIndex(2, 3)];
  assert.equal(interior.length, 8, 'interior octagon sees 8');
  assert.equal(T.adj[T.sqIndex(2, 3)].length, 4, 'square sees 4');
});

test('4.8.8 topology: diagonally-placed octagons do NOT touch (the square is between them)', () => {
  const T = buildTiling488(6, 7);
  const a = T.octIndex(2, 3);
  const diagonal = T.octIndex(3, 4);
  const between = T.sqIndex(2, 3);

  assert.ok(!T.adj[a].includes(diagonal),
    'a square sits between diagonal octagons, so they share no side');
  assert.ok(T.adj[a].includes(between) && T.adj[diagonal].includes(between),
    'both diagonal octagons touch the square between them');
  assert.ok(T.adj[a].includes(T.octIndex(2, 4)), 'orthogonal octagons do touch');
});

test('defineCellNeighbors rejects an asymmetric topology rather than certifying a lie', () => {
  const T = buildTiling488(4, 4);
  const board = [];
  for (let r = 0; r < 5; r++) board.push(Array.from({ length: 5 }, () => ({})));

  // Sever one direction only: A still lists B, B no longer lists A. A board
  // like this certifies happily and is unsolvable in the hand, because one
  // cell's clue counts a mine the mine's own neighborhood does not count back.
  const broken = T.adj.map(l => l.slice());
  const a = 0, b = broken[0][0];
  broken[b] = broken[b].filter(x => x !== a);

  assert.throws(() => defineCellNeighbors(board, 5, 5, broken), /not symmetric/);
  assert.throws(() => defineCellNeighbors(board, 5, 5, T.adj.map((l, i) => i === 0 ? [...l, 999] : l)), /out-of-range/);
  assert.throws(() => defineCellNeighbors(board, 5, 5, T.adj.map((l, i) => i === 0 ? [...l, 0] : l)), /itself/);
  assert.throws(() => defineCellNeighbors(board, 5, 5, T.adj.slice(0, 3)), /expected 25 entries/);
});

test('buildNeighborCache returns an explicit topology verbatim, ignoring rows and cols', () => {
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

test('GATE: the shipped certifier certifies a 4.8.8 Archimedean tiling, unmodified', () => {
  const { board } = buildFixtureBoard();
  const nbrCache = buildNeighborCache(board, rows, cols);
  stampAdjacency(board, nbrCache);

  const fr = (firstClick / cols) | 0;
  const fc = firstClick % cols;
  const result = isBoardSolvable(board, rows, cols, fr, fc, nbrCache);

  assert.equal(result.solvable, true,
    'the no-guess contract must transfer to a non-rectangular topology');
  assert.equal(result.remainingUnknowns, 0, 'a full clear, not a partial one');

  // Pinned exactly: if a solver change shifts the move mix on a tiling board,
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

  // The board demands real reasoning, so the gate is not passing on a
  // trivially-cascading layout.
  assert.ok(result.techniqueLevel >= 2,
    'fixture should require tank/gauss enumeration, not just counting');
  assert.ok(result.advancedLogicMoves >= 1);

  // The move-type invariant the par model rests on must hold here too.
  const sum = result.passAMoves + result.canonicalSubsetMoves + result.genericSubsetMoves
            + result.advancedLogicMoves + result.disjunctiveMoves + 1;
  assert.equal(sum, result.totalClicks, 'move-type invariant holds off the square grid');
});

test('GATE: the deduction trace is coherent on a tiling (every proof cites real neighbors)', () => {
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

  // Every deduced cell must actually be reachable through the tiling from
  // something that proved it — a proof citing a cell it does not touch would
  // mean the solver read a rectangle somewhere.
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

// ── The control: prove the gate is reading the tiling ──────────────────────

test('CONTROL: the same mine layout under RECTANGULAR adjacency does not reproduce the result', () => {
  // Without _cellNeighbors the board falls back to the implicit 8-neighborhood
  // of its 8x9 container. Same cells, same mines, different topology. If this
  // produced the tiling's answer, the gate above would be proving nothing.
  const { board } = buildFixtureBoard({ topology: 'rectangular' });
  assert.equal(board._cellNeighbors, undefined, 'control carries no explicit topology');

  const nbrCache = buildNeighborCache(board, rows, cols);
  assert.equal(nbrCache[FIXTURE.M * FIXTURE.N + 5].length > 4, true,
    'rectangular fallback gives a square cell more than its 4 tiling neighbors');

  stampAdjacency(board, nbrCache);
  const fr = (firstClick / cols) | 0;
  const fc = firstClick % cols;
  const rectResult = isBoardSolvable(board, rows, cols, fr, fc, nbrCache);

  // Pin the control's actual shape, not merely "something differs". Under
  // rectangular adjacency this layout does not even solve — it stalls
  // immediately — so a future change that degraded the control into a
  // near-miss would surface here instead of quietly weakening the gate.
  assert.equal(rectResult.solvable, false,
    'the tiling layout is NOT solvable as a rectangle — the topology is doing the work');
  assert.equal(rectResult.totalClicks, 1, 'the rectangular read stalls on the first click');
  assert.ok(rectResult.remainingUnknowns > 0);

  assert.notDeepEqual(
    { c: rectResult.totalClicks, a: rectResult.passAMoves, t: rectResult.techniqueLevel },
    { c: expected.totalClicks, a: expected.passAMoves, t: expected.techniqueLevel },
    'rectangular adjacency must give a different solve — otherwise the gate is vacuous');
});

test('CONTROL: mines are the only difference — an all-safe tiling clears in one click', () => {
  // Sanity on the harness itself: with no mines, the first click must cascade
  // across the whole tiling. If the topology were disconnected or the flood
  // did not follow it, this would fail.
  const { board } = buildFixtureBoard();
  for (const row of board) for (const cell of row) { cell.isMine = false; cell.adjacentMines = 0; }
  const nbrCache = buildNeighborCache(board, rows, cols);

  const result = isBoardSolvable(board, rows, cols, 0, 0, nbrCache);
  assert.equal(result.solvable, true);
  assert.equal(result.totalClicks, 1, 'one click clears an empty connected tiling');
});
