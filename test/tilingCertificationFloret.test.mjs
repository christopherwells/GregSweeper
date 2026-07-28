// ── Project Coastline, tiling #3: the floret gate ──────────────────────────
//
// The 4.8.8 gate proved the no-guess contract survives on a mixed-valence
// Archimedean tiling; the hexagonal gate proved it survives on the other major
// lattice symmetry. Both of those boards announce themselves: 4.8.8's interior
// valence runs 3/4/5/8 and a hexagon's is a constant 6, so a certifier that had
// quietly read a rectangle would have been caught by the SIZE of a clue.
//
// This gate is the one where that tell is gone, and it is the reason the floret
// is worth a third gate rather than a third variation. A floret pentagon's
// interior valence is EIGHT, exactly what a square grid gives, so every clue on
// this board is a number a rectangle could also have produced. What differs is
// the SET: the opener's eight tiling neighbors and its eight rectangular
// neighbors overlap in a single cell. There is nothing left for the solver to
// pass on except the edge list itself.
//
// It is also the first gate whose adjacency the two shipped tilings cannot
// express. Corner-inclusive adjacency (Christopher's rule, 2026-07-27) is a
// strict no-op on 4.8.8 and on the honeycomb, which are trivalent; here 108 of
// the patch's 249 links are cells meeting at a point and nowhere else.
//
// Nothing here may reach into the solver. `isBoardSolvable` is imported and
// called exactly as gameplay calls it. The only thing the board does
// differently is carry an explicit `_cellNeighbors` topology instead of letting
// adjacency be derived from rows and cols. If this test ever needs a change
// inside boardSolver.js to pass, that is a finding about the arc, not a thing to
// patch around.
//
// The companion assertions guard the two ways this test could be a lie:
//   - a topology that is not actually the floret (valence, clique and ordering
//     checks; a frozen mine list is a list of INDICES, so a reordering of the
//     builder's reading order silently describes a different board)
//   - a test that passes for a reason unrelated to the tiling (the RECTANGULAR
//     control, which must NOT reproduce the tiling's result)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isBoardSolvable } from '../src/logic/boardSolver.js';
import { buildNeighborCache } from '../src/logic/adjacency.js';
import { sharedEdge } from '../src/logic/tilingGeometry.js';
import { buildFloretTiling, buildFixtureBoard, FIXTURE } from './fixtures/tilingFloret.mjs';

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

// ── The topology is really the floret ──────────────────────────────────────

test('floret topology: one pentagon, interior valence 8 — the count a square grid gives', () => {
  const T = buildFloretTiling(3, 4);
  assert.equal(T.total, 72, 'six pentagons per rosette over a 3x4 rosette lattice');
  assert.equal(T.type, 'floret');
  assert.deepEqual([...new Set(T.cellVerts.map(cv => cv.length))], [5],
    'isohedral: every cell is the same pentagon');

  const histogram = {};
  for (const list of T.adj) histogram[list.length] = (histogram[list.length] || 0) + 1;

  // 36 interior pentagons see 8; the rest are patch-edge cells seeing 7, 6 or 5.
  // The point is that the ceiling is EIGHT, the same as a square grid's interior
  // cell. Unlike 4.8.8 (mixed 3/4/5/8) and the honeycomb (capped at 6), this
  // lattice cannot be told from a rectangle by counting.
  assert.deepEqual(histogram, { 5: 16, 6: 10, 7: 10, 8: 36 });
  assert.equal(Math.max(...T.adj.map(l => l.length)), 8, 'nothing sees more than 8');
  assert.equal(T.adj[T.centerIndex].length, 8, 'interior pentagon sees exactly 8');
});

test('floret topology: five sides but eight neighbors — corner-inclusive adjacency is load-bearing', () => {
  const T = buildFloretTiling(3, 4);

  // A pentagon can share a side with at most five cells, so the other three of an
  // interior cell's eight links are cells it meets at a single POINT. Those exist
  // only under the corner-inclusive rule, which on 4.8.8 and on the honeycomb
  // adds nothing at all (both are trivalent, so at every vertex the incident
  // cells already share sides). This is the first gate that certifies against
  // links the two shipped tilings have no way to produce.
  const c = T.centerIndex;
  let edgeLinks = 0, cornerLinks = 0;
  for (const n of T.adj[c]) (sharedEdge(T.cellVerts, c, n) ? edgeLinks++ : cornerLinks++);
  assert.equal(edgeLinks, 5, 'five side-sharing neighbors, one per side of the pentagon');
  assert.equal(cornerLinks, 3, 'three neighbors touching at a point only');

  let all = 0, sides = 0;
  for (let i = 0; i < T.total; i++) {
    for (const n of T.adj[i]) {
      if (n <= i) continue;
      all++;
      if (sharedEdge(T.cellVerts, i, n)) sides++;
    }
  }
  assert.deepEqual({ all, sides, corners: all - sides }, { all: 249, sides: 141, corners: 108 },
    '43% of this patch\'s adjacency is corner-only; drop the rule and the board is a different board');
});

test('floret topology: a rosette is a 6-clique, an overlap no rectangle can present', () => {
  const T = buildFloretTiling(3, 4);

  // All six pentagons of a rosette meet at its hub, so every pair of them is
  // adjacent. A square grid's largest clique is the 2x2 block (four cells), so a
  // six-way mutual overlap is something the constraint system can only ever see
  // off the square grid.
  const rosette = [35, 39, 40, 48, 49, 51];
  for (const a of rosette) {
    for (const b of rosette) {
      if (a === b) continue;
      assert.ok(T.adj[a].includes(b), `rosette cells ${a} and ${b} must be mutually adjacent`);
    }
  }
  assert.ok(rosette.includes(T.centerIndex), 'the opener sits in this rosette');

  // Twelve hubs for a 3x4 rosette lattice. A hub is the only place six cells meet
  // at one vertex, so counting them counts the rosettes.
  const cellsPerVertex = new Map();
  T.cellVerts.forEach((cv, ci) => {
    for (const v of cv) {
      let users = cellsPerVertex.get(v);
      if (!users) { users = []; cellsPerVertex.set(v, users); }
      users.push(ci);
    }
  });
  assert.equal([...cellsPerVertex.values()].filter(u => u.length === 6).length, 12);
});

test('floret topology: symmetric, no self-loops, no duplicates', () => {
  const T = buildFloretTiling(4, 3);
  for (let i = 0; i < T.total; i++) {
    assert.ok(!T.adj[i].includes(i), `cell ${i} is not its own neighbor`);
    assert.equal(new Set(T.adj[i]).size, T.adj[i].length, `cell ${i} has no duplicate neighbors`);
    for (const n of T.adj[i]) {
      assert.ok(T.adj[n].includes(i), `edge ${i}-${n} is symmetric`);
    }
  }
});

test('floret topology: the opener\'s neighbors are pinned, so a reordering fails loudly here', () => {
  // The fixture's mine list is a list of INDICES and means nothing except against
  // the builder's reading order. A reordering does not throw and does not change
  // the valence histogram; it just quietly relabels the board, and the frozen
  // `expected` would then describe a layout nobody chose. Pin the actual list.
  const T = buildFloretTiling(3, 4);
  assert.equal(T.centerIndex, firstClick, 'the opener is the patch-center pentagon');
  assert.deepEqual(T.adj[firstClick].slice().sort((a, b) => a - b), [31, 35, 36, 39, 45, 48, 49, 51]);
});

test('buildNeighborCache returns the floret topology verbatim, ignoring rows and cols', () => {
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

test('GATE: the shipped certifier certifies a floret pentagonal tiling, unmodified', () => {
  const { board } = buildFixtureBoard();
  const nbrCache = buildNeighborCache(board, rows, cols);
  stampAdjacency(board, nbrCache);

  const fr = (firstClick / cols) | 0;
  const fc = firstClick % cols;
  const result = isBoardSolvable(board, rows, cols, fr, fc, nbrCache);

  assert.equal(result.solvable, true,
    'the no-guess contract must transfer to corner-inclusive pentagonal adjacency');
  assert.equal(result.remainingUnknowns, 0, 'a full clear, not a partial one');

  // Pinned exactly: if a solver change shifts the move mix on a floret board,
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

  // This fixture is the first that drives ALL FOUR reasoning tiers. Neither
  // shipped gate reaches the canonical subset bucket (the 1-1 / 1-2 shapes the
  // par model prices as "pattern"), since 4.8.8 and hex both certify with it at
  // zero. This is where that bucket is first shown to fire off the square grid.
  assert.ok(result.techniqueLevel >= 2,
    'fixture should require tank/gauss enumeration, not just counting');
  assert.ok(result.passAMoves >= 1);
  assert.ok(result.canonicalSubsetMoves >= 1);
  assert.ok(result.genericSubsetMoves >= 1);
  assert.ok(result.advancedLogicMoves >= 1);

  // The move-type invariant the par model rests on must hold here too.
  const sum = result.passAMoves + result.canonicalSubsetMoves + result.genericSubsetMoves
            + result.advancedLogicMoves + result.disjunctiveMoves + 1;
  assert.equal(sum, result.totalClicks, 'move-type invariant holds on a floret');
});

test('GATE: the deduction trace is coherent on a floret (every proof cites real neighbors)', () => {
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
  // the floret, including the corner-only links, which is the whole reason this
  // check is worth repeating here. A proof citing a non-neighbor would mean the
  // solver read a rectangle somewhere, and on this lattice the clue values alone
  // would never have given that away.
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

// ── The control: prove the gate is reading the floret ──────────────────────

test('CONTROL: the same mine layout under RECTANGULAR adjacency does not reproduce the result', () => {
  // Without _cellNeighbors the board falls back to the implicit 8-neighborhood
  // of its 8x9 container. Same cells, same mines, different topology. If this
  // produced the floret's answer, the gate above would be proving nothing.
  const { board, topology } = buildFixtureBoard({ topology: 'rectangular' });
  assert.equal(board._cellNeighbors, undefined, 'control carries no explicit topology');

  const nbrCache = buildNeighborCache(board, rows, cols);

  // The other two gates separate control from tiling by VALENCE. That is not
  // available here: the opener sees 8 either way, which is exactly what makes
  // this lattice worth gating. So separate them by SET: two eight-cell
  // neighborhoods that agree on only half their members.
  const rectNbrs = nbrCache[firstClick].slice().sort((a, b) => a - b);
  const tileNbrs = topology.adj[firstClick].slice().sort((a, b) => a - b);
  assert.deepEqual(rectNbrs, [30, 31, 32, 39, 41, 48, 49, 50]);
  assert.equal(rectNbrs.length, tileNbrs.length, 'both read the opener as an 8-neighbor cell');
  assert.deepEqual(rectNbrs.filter(n => tileNbrs.includes(n)), [31, 39, 48, 49],
    'and yet they agree on only four of the eight');

  stampAdjacency(board, nbrCache);
  const fr = (firstClick / cols) | 0;
  const fc = firstClick % cols;
  const rectResult = isBoardSolvable(board, rows, cols, fr, fc, nbrCache);

  // Pin the control's actual shape, not merely "something differs". Under
  // rectangular adjacency this layout does not even solve — it stalls
  // immediately, learning nothing past the opener — so a future change that
  // degraded the control into a near-miss would surface here instead of quietly
  // weakening the gate. That stall is the genuinely selected property: at this
  // density (19 mines on 72 cells) a scrambled layout is unsolvable as a
  // rectangle almost every time, so "unsolvable" alone would be a near-free
  // assertion and the click-1 pin is what carries it.
  assert.equal(rectResult.solvable, false,
    'the floret layout is NOT solvable as a rectangle — the topology is doing the work');
  assert.equal(rectResult.totalClicks, 1, 'the rectangular read stalls on the first click');
  assert.equal(rectResult.remainingUnknowns, 52,
    '53 safe cells, one opened, nothing deduced: every other safe cell is still unknown');

  assert.notDeepEqual(
    { c: rectResult.totalClicks, a: rectResult.passAMoves, t: rectResult.techniqueLevel },
    { c: expected.totalClicks, a: expected.passAMoves, t: expected.techniqueLevel },
    'rectangular adjacency must give a different solve — otherwise the gate is vacuous');
});

test('CONTROL: mines are the only difference — an all-safe floret clears in one click', () => {
  // Sanity on the harness itself: with no mines, the first click must cascade
  // across the whole tiling. If the topology were disconnected or the flood did
  // not follow it, this would fail.
  const { board } = buildFixtureBoard();
  for (const row of board) for (const cell of row) { cell.isMine = false; cell.adjacentMines = 0; }
  const nbrCache = buildNeighborCache(board, rows, cols);

  const result = isBoardSolvable(board, rows, cols, 0, 0, nbrCache);
  assert.equal(result.solvable, true);
  assert.equal(result.totalClicks, 1, 'one click clears an empty connected floret');
});

test('the fixture really carries the mines it claims (guard against a stale freeze)', () => {
  // The control cannot catch a corrupted mine list (a scrambled layout at this
  // density is still unsolvable as a rectangle), so this is the assertion that
  // protects the freeze.
  const { board } = buildFixtureBoard();
  const found = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (board[r][c].isMine) found.push(r * cols + c);
  assert.deepEqual(found, mines.slice().sort((a, b) => a - b));
  assert.equal(found.length, 19, 'nineteen mines on 72 pentagons');
  assert.ok(!board[(firstClick / cols) | 0][firstClick % cols].isMine, 'the opener is not a mine');
});
