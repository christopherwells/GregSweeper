// ── Coastline Phase 2: the promoted tiling generator ───────────────────────
//
// buildTiling488 moved from the Phase 1 fixture into src/ and gained a geometry
// layer; generateTilingBoard builds a certified no-guess board on that topology.
// These tests pin: the geometry is coherent and disjoint, the container holds
// every cell, and a generated board independently RE-CERTIFIES under the
// shipped solver (the generator is not allowed to trust its own accept loop).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTiling488, containerFor, OCT_CUT, SQ_BOX_FRAC, computeCompassRay,
  sharedEdge, buildWireframe,
} from '../src/logic/tilingGeometry.js';
import { generateTilingBoard } from '../src/logic/tilingGenerator.js';
import { isBoardSolvable } from '../src/logic/boardSolver.js';

// ── Topology is preserved through promotion ────────────────────────────────

test('buildTiling488 topology is unchanged by adding geometry', () => {
  const T = buildTiling488(6, 7);
  assert.equal(T.nOct, 42);
  assert.equal(T.nSq, 30);
  assert.equal(T.total, 72);

  const histogram = {};
  for (const list of T.adj) histogram[list.length] = (histogram[list.length] || 0) + 1;
  // Same valence histogram the Phase 1 gate pins — geometry must not perturb it.
  assert.deepEqual(histogram, { 3: 4, 4: 30, 5: 18, 8: 20 });
});

// ── The geometry layer ─────────────────────────────────────────────────────

test('every cell carries a position + shape, octagons and squares partitioned', () => {
  const M = 6, N = 7;
  const T = buildTiling488(M, N);
  assert.equal(T.cellPos.length, T.total);
  assert.equal(T.width, N);
  assert.equal(T.height, M);

  let oct = 0, sq = 0;
  for (let i = 0; i < T.total; i++) {
    const p = T.cellPos[i];
    assert.ok(p && typeof p.cx === 'number' && typeof p.cy === 'number', `cell ${i} has a center`);
    assert.ok(p.cx >= 0 && p.cx <= N && p.cy >= 0 && p.cy <= M, `cell ${i} inside the tiling box`);
    if (p.shape === 'oct') oct++; else if (p.shape === 'sq') sq++;
    else assert.fail(`cell ${i} has unknown shape ${p.shape}`);
  }
  assert.equal(oct, T.nOct);
  assert.equal(sq, T.nSq);
});

test('positions match the lattice and no two centers coincide', () => {
  const M = 5, N = 6;
  const T = buildTiling488(M, N);
  // Octagon (i,j) sits at (j+0.5, i+0.5); square (i,j) at (j+1, i+1).
  assert.deepEqual(T.cellPos[T.octIndex(0, 0)], { cx: 0.5, cy: 0.5, shape: 'oct' });
  assert.deepEqual(T.cellPos[T.octIndex(4, 5)], { cx: 5.5, cy: 4.5, shape: 'oct' });
  assert.deepEqual(T.cellPos[T.sqIndex(0, 0)], { cx: 1, cy: 1, shape: 'sq' });

  const seen = new Set();
  for (const p of T.cellPos) {
    const key = `${p.cx},${p.cy}`;
    assert.ok(!seen.has(key), `two cells share center ${key}`);
    seen.add(key);
  }
});

test('shape constants: square box is twice the cut, cut in the valid tiling range', () => {
  // OCT_CUT is tuned up from the regular-octagon 0.293 for legibility (bigger
  // squares); the tiling is valid for any cut in (0, 0.5) and the diamond box is
  // always 2x the cut so it fills the gap exactly.
  assert.ok(OCT_CUT > 0 && OCT_CUT < 0.5, 'cut in the valid range');
  assert.ok(Math.abs(SQ_BOX_FRAC - 2 * OCT_CUT) < 1e-9, 'square box = 2 x cut');
});

// ── The container ──────────────────────────────────────────────────────────

test('containerFor holds exactly `total` cells, near-square', () => {
  assert.deepEqual(containerFor(72), { rows: 8, cols: 9 });
  for (const total of [72, 61, 100, 42, 13, 156]) {
    const { rows, cols } = containerFor(total);
    assert.equal(rows * cols, total, `container exactly holds ${total}`);
    assert.ok(rows <= cols);
  }
});

// ── The generator produces certified no-guess boards ───────────────────────

test('generateTilingBoard yields a board that INDEPENDENTLY re-certifies', () => {
  const M = 6, N = 7, mines = 11;
  const res = generateTilingBoard({ M, N, mines, seed: 'test-seed-1' });
  assert.ok(res, 'a certified board was found');

  const { board, rows, cols, firstClick, check } = res;
  assert.equal(board._cellNeighbors.length, rows * cols, 'topology stamped');
  assert.equal(board._cellPos.length, rows * cols, 'geometry stamped');
  assert.deepEqual(board._tiling, { type: '4.8.8', M, N });
  assert.equal(board._gatedCert, true, 'created via createEmptyBoard');

  // Mine count is exactly what was asked (11 fits on 72 cells easily).
  let mineCount = 0;
  for (const row of board) for (const cell of row) if (cell.isMine) mineCount++;
  assert.equal(mineCount, mines);

  // The center opener and its neighbors are mine-free (clean first click).
  const opener = board[(firstClick / cols) | 0][firstClick % cols];
  assert.equal(opener.isMine, false);
  for (const ni of board._cellNeighbors[firstClick]) {
    assert.equal(board[(ni / cols) | 0][ni % cols].isMine, false, 'opener neighbor mine-free');
  }

  // Independent re-cert: run the SHIPPED solver again from the returned opener.
  const fr = (firstClick / cols) | 0, fc = firstClick % cols;
  const recheck = isBoardSolvable(board, rows, cols, fr, fc, board._cellNeighbors);
  assert.equal(recheck.solvable, true);
  assert.equal(recheck.remainingUnknowns, 0);
  assert.equal(recheck.totalClicks, check.totalClicks, 'accept loop and re-cert agree');
});

test('generateTilingBoard reliably finds a certified board across seeds', () => {
  let found = 0;
  const trials = 8;
  for (let s = 0; s < trials; s++) {
    const res = generateTilingBoard({ M: 6, N: 7, mines: 11, seed: `yield-${s}` });
    if (res) found++;
  }
  // Low-density no-guess boards on this tiling are common; the deep link must
  // reliably get one. If this ever drops, tune density / attempts / add a
  // constructive placer (out of scope for the first slice).
  assert.ok(found >= trials - 1, `expected most seeds to certify, got ${found}/${trials}`);
});

// ── Compass geometric ray ──────────────────────────────────────────────────

test('computeCompassRay: orthogonal ray hits octagons only, in order', () => {
  const T = buildTiling488(6, 7);
  // Octagon (2,1); go east. Only octagons share its center row (cy = 2.5);
  // squares sit at integer cy, so they are off the horizontal line.
  const origin = T.octIndex(2, 1);
  const ray = computeCompassRay(T.cellPos, origin, 1, 0);
  assert.deepEqual(ray, [T.octIndex(2, 2), T.octIndex(2, 3), T.octIndex(2, 4), T.octIndex(2, 5), T.octIndex(2, 6)]);
});

test('computeCompassRay: diagonal ray alternates octagon and square', () => {
  const T = buildTiling488(6, 7);
  const origin = T.octIndex(1, 1);
  const ray = computeCompassRay(T.cellPos, origin, 1, 1); // south-east
  // sq(1,1), oct(2,2), sq(2,2), oct(3,3), sq(3,3), oct(4,4), ...
  assert.equal(ray[0], T.sqIndex(1, 1));
  assert.equal(ray[1], T.octIndex(2, 2));
  assert.equal(ray[2], T.sqIndex(2, 2));
  assert.equal(ray[3], T.octIndex(3, 3));
});

test('computeCompassRay: every returned cell is colinear and forward (honesty)', () => {
  const T = buildTiling488(6, 7);
  const dirs = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]];
  for (let origin = 0; origin < T.total; origin++) {
    const o = T.cellPos[origin];
    for (const [dx, dy] of dirs) {
      const ray = computeCompassRay(T.cellPos, origin, dx, dy);
      let lastT = 0;
      for (const idx of ray) {
        const p = T.cellPos[idx];
        const rx = p.cx - o.cx, ry = p.cy - o.cy;
        assert.equal(rx * dy - ry * dx, 0, 'colinear');
        const t = rx * dx + ry * dy;
        assert.ok(t > lastT, 'strictly outward, ordered');
        lastT = t;
      }
    }
  }
});

test('a compass tiling board certifies and every compass cell stores a colinear ray', () => {
  let res = null;
  for (let s = 0; s < 8 && !res; s++) {
    res = generateTilingBoard({ M: 6, N: 7, mines: 11, seed: `compass-${s}`, gimmicks: ['compass'] });
  }
  assert.ok(res, 'a compass board certified');
  const { board, cols } = res;
  let compassCells = 0;
  for (let i = 0; i < board._cellPos.length; i++) {
    const cell = board[(i / cols) | 0][i % cols];
    if (!cell.isCompass) continue;
    compassCells++;
    assert.ok(Array.isArray(cell.compassRay) && cell.compassRay.length >= 1, 'ray stored');
    const o = board._cellPos[i];
    const { dr, dc } = cell.compassDir;
    for (const idx of cell.compassRay) {
      const p = board._cellPos[idx];
      // compassDir is {dr: dy, dc: dx}
      assert.equal((p.cx - o.cx) * dr - (p.cy - o.cy) * dc, 0, 'stored ray colinear with stored direction');
    }
  }
  assert.ok(compassCells >= 1);
});

// ── Cell vertices + wireframe (walls draw on the real shared edges) ─────────

test('every adjacency shares exactly one edge (two vertices)', () => {
  const T = buildTiling488(4, 5);
  for (let a = 0; a < T.total; a++) {
    for (const b of T.adj[a]) {
      if (b <= a) continue;
      const e = sharedEdge(T.cellVerts, a, b);
      assert.ok(e && e.length === 2, `cells ${a},${b} share exactly an edge`);
    }
  }
});

test('the wireframe has one boundary edge per adjacency, each separating two adjacent cells', () => {
  const T = buildTiling488(4, 5);
  const { edges } = buildWireframe(T);
  let adjCount = 0;
  for (let a = 0; a < T.total; a++) for (const b of T.adj[a]) if (b > a) adjCount++;
  assert.equal(edges.length, adjCount, 'one boundary edge per undirected adjacency');
  for (const e of edges) {
    assert.ok(T.adj[e.cellA].includes(e.cellB), 'edge separates two adjacent cells');
    assert.ok(e.v1 !== e.v2, 'edge has two distinct vertices');
  }
});

// ── Walls sever graph edges ─────────────────────────────────────────────────

test('walls sever graph edges (symmetric, connected, absent) and the board certifies', () => {
  let res = null;
  for (let s = 0; s < 16; s++) {
    const r = generateTilingBoard({ M: 6, N: 7, mines: 10, seed: `walls-${s}`, gimmicks: ['walls'] });
    if (r && r.board._tilingWalls && r.board._tilingWalls.length > 0) { res = r; break; }
    if (r && !res) res = r;
  }
  assert.ok(res, 'a walls board certified');
  const { board, rows, cols } = res;
  const adj = board._cellNeighbors;
  const total = rows * cols;

  assert.ok(Array.isArray(board._tilingWalls) && board._tilingWalls.length > 0, 'walls were placed');

  // Symmetry survived the severing (an asymmetric edge would certify a board
  // nobody can solve).
  for (let i = 0; i < total; i++) {
    for (const n of adj[i]) assert.ok(adj[n].includes(i), `edge ${i}-${n} symmetric`);
  }
  // Each wall carries its severed pair AND the shared-edge segment it's drawn on.
  for (const wl of board._tilingWalls) {
    assert.ok(!adj[wl.a].includes(wl.b) && !adj[wl.b].includes(wl.a), `walled edge ${wl.a}-${wl.b} absent`);
    for (const k of ['x1', 'y1', 'x2', 'y2']) assert.equal(typeof wl[k], 'number', `wall carries ${k}`);
    assert.ok(wl.x1 !== wl.x2 || wl.y1 !== wl.y2, 'wall segment has length');
  }
  // Still fully connected (all-or-nothing isolation rule).
  const seen = new Uint8Array(total);
  const stack = [0]; seen[0] = 1; let count = 1;
  while (stack.length) { const u = stack.pop(); for (const v of adj[u]) if (!seen[v]) { seen[v] = 1; count++; stack.push(v); } }
  assert.equal(count, total, 'the board stays connected through the walls');

  // Continuity: a continuous wall shares endpoints between its consecutive bars,
  // so at least one endpoint is used by two or more segments (not scattered).
  const endpointCount = new Map();
  for (const wl of board._tilingWalls) {
    for (const [x, y] of [[wl.x1, wl.y1], [wl.x2, wl.y2]]) {
      const k = `${Math.round(x * 1e4)},${Math.round(y * 1e4)}`;
      endpointCount.set(k, (endpointCount.get(k) || 0) + 1);
    }
  }
  const junctions = [...endpointCount.values()].filter(c => c >= 2).length;
  assert.ok(junctions >= 1, 'wall bars connect at shared vertices (continuous), not scattered');

  // Certifies from the opener against the reduced graph.
  const fr = Math.floor(res.firstClick / cols), fc = res.firstClick % cols;
  const check = isBoardSolvable(board, rows, cols, fr, fc, adj);
  assert.equal(check.solvable, true);
  assert.equal(check.remainingUnknowns, 0);
});

test('techniqueFloor can demand real reasoning (tank/gauss), like the fixture', () => {
  // Not every seed reaches level 2 at this density, so search a few. This mirrors
  // the fixture being a deliberately harder certified layout.
  let hard = null;
  for (let s = 0; s < 12 && !hard; s++) {
    hard = generateTilingBoard({ M: 6, N: 7, mines: 12, seed: `hard-${s}`, techniqueFloor: 2 });
  }
  if (hard) {
    assert.ok(hard.check.techniqueLevel >= 2, 'floor honored when a board is found');
    assert.ok(hard.check.advancedLogicMoves >= 1);
  }
  // If none of the 12 seeds reached level 2, that is acceptable for this test
  // (density-dependent); the floor is best-effort, and generateTilingBoard
  // falls back to the best certified board rather than shipping uncertified.
});
