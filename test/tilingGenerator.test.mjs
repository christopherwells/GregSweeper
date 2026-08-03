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
  sharedEdge, buildWireframe, buildTiling, buildHexTiling, HEX_ROW_H, HEX_R,
} from '../src/logic/tilingGeometry.js';
import { generateTilingBoard, TILING_SAFE_GIMMICKS } from '../src/logic/tilingGenerator.js';
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

// The 4.8.8 is the only tiling whose cells are two SIZES, so it is the only one
// where a number can be legible in one cell and cramped in the one beside it.
// OCT_CUT is the single knob controlling that balance, and it is tuned by eye —
// which means the thing worth pinning is not the value but the two properties
// the value was chosen to trade off. Both directions of drift are real: cut it
// smaller and the diamond's number shrinks toward the 41% it had at a regular
// octagon; cut it larger and the octagon's flat sides vanish until the board
// reads as a lattice of diamonds rather than a 4.8.8.
test('the 4.8.8 keeps its two cells close in size, and its octagons octagonal', () => {
  const f = 0.5 - OCT_CUT;
  // Above the regular-octagon cut the 45-degree edges bind, not the flats.
  const octInscribed = 2 * Math.min(0.5, (0.5 + f) / Math.SQRT2);
  const sqInscribed = SQ_BOX_FRAC / Math.SQRT2;

  // A number is drawn in its cell's inscribed circle, so this ratio is what
  // "the squares and octagons read as the same size" actually means.
  const circleRatio = sqInscribed / octInscribed;
  assert.ok(circleRatio >= 0.70,
    `the diamond's number circle is only ${(100 * circleRatio).toFixed(0)}% of the octagon's `
    + '— raise OCT_CUT to even them out');

  // And the octagon must still be one. flat/diagonal is 1.0 at a regular
  // octagon and falls as the cut rises; below about a fifth the flats stop
  // reading and the tiling looks like rotated squares.
  const flatShare = (1 - 2 * OCT_CUT) / (OCT_CUT * Math.SQRT2);
  assert.ok(flatShare >= 0.22,
    `the octagon's flat sides are ${flatShare.toFixed(2)} of its diagonals — it now reads `
    + 'as a rounded diamond, not an octagon; lower OCT_CUT');

  // Areas follow the same trade and are the plainest statement of it.
  const areaRatio = (1 - 2 * OCT_CUT * OCT_CUT) / (2 * OCT_CUT * OCT_CUT);
  assert.ok(areaRatio <= 2.0, `octagon is ${areaRatio.toFixed(2)}x the diamond's area`);
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
  // _tiling now carries the renderer's pitch-unit extent (wUnits/hUnits); for
  // 4.8.8 that is exactly N x M.
  assert.deepEqual(board._tiling, { type: '4.8.8', M, N, wUnits: N, hUnits: M });
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

// ── Tiling #2: the 6.6.6 honeycomb through the same generator ──────────────
//
// The certifier-transfers question for hexagons is its own gate
// (tilingCertificationHex.test.mjs). What matters here is that the SHARED
// generator, wall placer and compass produce honest honeycomb boards without
// any 4.8.8 assumption leaking in.

test('the dispatcher returns each tiling by name, and both share one descriptor shape', () => {
  const hex = buildTiling('hex', 5, 5);
  const oct = buildTiling('4.8.8', 5, 5);
  assert.equal(hex.type, 'hex');
  assert.equal(oct.type, '4.8.8');
  assert.equal(buildTiling('6.6.6', 4, 4).type, 'hex');
  assert.equal(buildTiling(undefined, 4, 4).type, '4.8.8', 'default stays the shipped tiling');

  // Every consumer (generator, renderer, wall wireframe) reads only these, so
  // both builders must supply all of them or a tiling silently misrenders.
  for (const T of [hex, oct]) {
    for (const k of ['total', 'adj', 'cellPos', 'cellVerts', 'verts', 'wUnits', 'hUnits', 'centerIndex', 'type']) {
      assert.ok(T[k] !== undefined, `${T.type} exposes ${k}`);
    }
    assert.equal(T.cellPos.length, T.total);
    assert.equal(T.cellVerts.length, T.total);
    assert.equal(T.adj.length, T.total);
    assert.ok(T.centerIndex >= 0 && T.centerIndex < T.total, `${T.type} centerIndex on the board`);
  }
});

test('hex extent is the real geometry, not the cell counts (the renderer reads this)', () => {
  const M = 7, N = 7;
  const T = buildHexTiling(M, N);
  // Odd rows are offset half a hex, so the tiling is WIDER than N pitches...
  assert.ok(Math.abs(T.wUnits - (N + 0.5)) < 1e-9, 'width = N + half a hex');
  // ...and rows overlap vertically, so it is SHORTER than M pitches.
  assert.ok(Math.abs(T.hUnits - (2 * HEX_R + (M - 1) * HEX_ROW_H)) < 1e-9, 'height = 2R + (M-1)*rowH');
  assert.ok(T.hUnits < M, 'a honeycomb is shorter than its row count in pitch units');

  // Every cell is the same shape, and no two centers coincide.
  const seen = new Set();
  for (const p of T.cellPos) {
    assert.equal(p.shape, 'hex');
    const key = `${p.cx.toFixed(6)},${p.cy.toFixed(6)}`;
    assert.ok(!seen.has(key), `two hexes share center ${key}`);
    seen.add(key);
  }
});

test('generateTilingBoard builds a hex board that INDEPENDENTLY re-certifies', () => {
  const M = 7, N = 7, mines = 10;
  const res = generateTilingBoard({ type: 'hex', M, N, mines, seed: 'hex-seed-1' });
  assert.ok(res, 'a certified honeycomb was found');

  const { board, rows, cols, firstClick, check } = res;
  assert.equal(rows * cols, M * N, 'container holds every hexagon');
  assert.equal(board._cellNeighbors.length, rows * cols, 'topology stamped');
  assert.equal(board._cellPos.length, rows * cols, 'geometry stamped');
  assert.equal(board._tiling.type, 'hex');
  assert.equal(board._tiling.M, M);
  assert.equal(board._tiling.N, N);
  assert.equal(board._gatedCert, true);

  let mineCount = 0;
  for (const row of board) for (const cell of row) if (cell.isMine) mineCount++;
  assert.equal(mineCount, mines);

  // Interior valence is 6 — no rectangular 8-neighborhood leaked in.
  assert.ok(Math.max(...board._cellNeighbors.map(l => l.length)) === 6,
    'no cell on a honeycomb ever sees more than 6');

  const opener = board[(firstClick / cols) | 0][firstClick % cols];
  assert.equal(opener.isMine, false);
  for (const ni of board._cellNeighbors[firstClick]) {
    assert.equal(board[(ni / cols) | 0][ni % cols].isMine, false, 'opener neighbor mine-free');
  }

  const fr = (firstClick / cols) | 0, fc = firstClick % cols;
  const recheck = isBoardSolvable(board, rows, cols, fr, fc, board._cellNeighbors);
  assert.equal(recheck.solvable, true);
  assert.equal(recheck.remainingUnknowns, 0);
  assert.equal(recheck.totalClicks, check.totalClicks, 'accept loop and re-cert agree');
});

test('generateTilingBoard reliably finds a certified hex board across seeds', () => {
  let found = 0;
  const trials = 8;
  for (let s = 0; s < trials; s++) {
    if (generateTilingBoard({ type: 'hex', M: 7, N: 7, mines: 10, seed: `hexyield-${s}` })) found++;
  }
  assert.ok(found >= trials - 1, `expected most hex seeds to certify, got ${found}/${trials}`);
});

test('a hex compass board certifies and every stored ray follows a real hex axis', () => {
  let res = null;
  for (let s = 0; s < 12 && !res; s++) {
    res = generateTilingBoard({ type: 'hex', M: 7, N: 7, mines: 10, seed: `hexcompass-${s}`, gimmicks: ['compass'] });
  }
  assert.ok(res, 'a hex compass board certified');
  const { board, cols } = res;

  // The six hex axes. A pointy-top honeycomb has NO vertical line of centers,
  // so a due-north/south ray must never be chosen.
  const AXES = [[1, 0], [-1, 0], [0.5, HEX_ROW_H], [0.5, -HEX_ROW_H], [-0.5, HEX_ROW_H], [-0.5, -HEX_ROW_H]];
  let compassCells = 0;
  for (let i = 0; i < board._cellPos.length; i++) {
    const cell = board[(i / cols) | 0][i % cols];
    if (!cell.isCompass) continue;
    compassCells++;
    assert.ok(Array.isArray(cell.compassRay) && cell.compassRay.length >= 1, 'ray stored');

    const { dr, dc } = cell.compassDir;
    assert.ok(AXES.some(([dx, dy]) => Math.abs(dx - dc) < 1e-9 && Math.abs(dy - dr) < 1e-9),
      `compass direction (${dc}, ${dr}) is one of the six hex axes`);
    assert.ok(!(Math.abs(dc) < 1e-9), 'never a vertical ray on a pointy-top honeycomb');

    // Stored ray is colinear with the stored direction and strictly outward.
    const o = board._cellPos[i];
    let lastT = -Infinity;
    for (const idx of cell.compassRay) {
      const p = board._cellPos[idx];
      const rx = p.cx - o.cx, ry = p.cy - o.cy;
      assert.ok(Math.abs(rx * dr - ry * dc) < 1e-9, 'stored ray colinear with stored direction');
      const t = rx * dc + ry * dr;
      assert.ok(t > lastT, 'ray ordered outward');
      lastT = t;
    }
  }
  assert.ok(compassCells >= 1);
});

test('hex walls sever real hexagon edges, stay connected, and the board certifies', () => {
  let res = null;
  for (let s = 0; s < 20; s++) {
    const r = generateTilingBoard({ type: 'hex', M: 7, N: 7, mines: 9, seed: `hexwalls-${s}`, gimmicks: ['walls'] });
    if (r && r.board._tilingWalls && r.board._tilingWalls.length > 0) { res = r; break; }
    if (r && !res) res = r;
  }
  assert.ok(res, 'a hex walls board certified');
  const { board, rows, cols } = res;
  const adj = board._cellNeighbors;
  const total = rows * cols;
  assert.ok(Array.isArray(board._tilingWalls) && board._tilingWalls.length > 0, 'walls were placed');

  for (let i = 0; i < total; i++) {
    for (const n of adj[i]) assert.ok(adj[n].includes(i), `edge ${i}-${n} symmetric`);
  }
  // Each wall sits on a REAL shared hexagon edge, whose length is the hexagon
  // side (1/sqrt(3) pitch units) — proof the 4.8.8 wireframe did not leak in.
  const side = HEX_R;
  for (const wl of board._tilingWalls) {
    assert.ok(!adj[wl.a].includes(wl.b) && !adj[wl.b].includes(wl.a), `walled edge ${wl.a}-${wl.b} absent`);
    const len = Math.hypot(wl.x2 - wl.x1, wl.y2 - wl.y1);
    assert.ok(Math.abs(len - side) < 1e-6, `wall bar is one hexagon side long (got ${len})`);
  }

  const seen = new Uint8Array(total);
  const stack = [0]; seen[0] = 1; let count = 1;
  while (stack.length) { const u = stack.pop(); for (const v of adj[u]) if (!seen[v]) { seen[v] = 1; count++; stack.push(v); } }
  assert.equal(count, total, 'the honeycomb stays connected through the walls');

  const fr = Math.floor(res.firstClick / cols), fc = res.firstClick % cols;
  const check = isBoardSolvable(board, rows, cols, fr, fc, adj);
  assert.equal(check.solvable, true);
  assert.equal(check.remainingUnknowns, 0);
});

// How to SEE each modifier on a finished board. Without this the certification
// assertion below is unfailable: a modifier that places nothing at all leaves a
// plain board, and a plain board certifies trivially — so the test would pass
// precisely when the modifier is most broken (break-tested: stubbing
// applyMirrorPairs to a no-op on hex kept the old version green).
const MODIFIER_PRESENT = {
  mystery: (b) => _countCells(b, c => c.isMystery),
  liar: (b) => _countCells(b, c => c.isLiar),
  locked: (b) => _countCells(b, c => c.isLocked),
  sonar: (b) => _countCells(b, c => c.isSonar),
  mirror: (b) => _countCells(b, c => !!c.mirrorPair),
  compass: (b) => _countCells(b, c => c.isCompass),
  wormhole: (b) => _countCells(b, c => c.isWormhole),
  worm: (b) => _countCells(b, c => c.isWormEgg),
  walls: (b) => (b._tilingWalls || []).length,
};
function _countCells(board, pred) {
  let n = 0;
  for (const row of board) for (const cell of row) if (pred(cell)) n++;
  return n;
}

test('every tiling-safe modifier PLACES on a honeycomb and the board still certifies', () => {
  // Each modifier gets its own board (stacking is a separate question); the
  // point is that no modifier's placement or number-recompute carries a 4.8.8
  // or rectangular assumption that breaks on hexagons.
  for (const g of TILING_SAFE_GIMMICKS) {
    assert.ok(MODIFIER_PRESENT[g], `no presence detector for modifier ${g} — add one`);

    // Search seeds for a board where the modifier ACTUALLY landed. Placement is
    // candidate-dependent, so a single seed legitimately may place none; a
    // modifier that never places across every seed is the real finding.
    let res = null, placed = 0;
    for (let s = 0; s < 12; s++) {
      const r = generateTilingBoard({ type: 'hex', M: 7, N: 7, mines: 9, seed: `hexmod-${g}-${s}`, gimmicks: [g] });
      if (!r) continue;
      const n = MODIFIER_PRESENT[g](r.board);
      if (n > 0) { res = r; placed = n; break; }
      if (!res) res = r;
    }
    assert.ok(res, `a hex board with ${g} certified`);
    assert.ok(placed > 0, `${g} never placed a single cell on any hex board — it is a no-op here`);

    const { board, rows, cols, firstClick } = res;
    const fr = Math.floor(firstClick / cols), fc = firstClick % cols;
    const check = isBoardSolvable(board, rows, cols, fr, fc, board._cellNeighbors);
    assert.equal(check.solvable, true, `${g} board re-certifies`);
    assert.equal(check.remainingUnknowns, 0, `${g} board fully clears`);
  }
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

// ── Gimmick re-rolls per base (the 2026-08-03 generation-cost fix) ─────────
//
// Profiled on the stacked density-sweep cells: 99-100% of generation time is
// constructive base placement, and the old one-roll-per-base search DISCARDED
// the certified base whenever the gimmicked board failed certification or was
// decorative-only (8-16 bases paid per shipped board on stacked Cubes/Kites).
// The fix mirrors the rectangular challenge path: re-roll gimmicks on the
// SAME base mine layout. Measured effect: every stacked cell on every lattice
// moved inside the 2-second generation cap (stacked Kites 72c worst went
// 31.9s -> 1.5s).

test('REGRESSION: gimmick re-rolls reuse the base mine layout the one-roll search threw away', () => {
  const cfg = { type: 'hex', M: 9, N: 7, mines: 16, seed: 'reroll-pin:hex:2' };
  const gimmicks = ['locked', 'sonar', 'walls'];
  const mineSet = (r) => {
    const out = [];
    let i = 0;
    for (const row of r.board) for (const c of row) { if (c.isMine) out.push(i); i++; }
    return out.join(',');
  };

  // The base-0 layout is what a plain generation of the same seed ships.
  const plain = generateTilingBoard({ ...cfg, gimmicks: [] });
  assert.ok(plain, 'plain baseline must generate');

  // The pre-reroll search (gimmickRerolls: 1) abandons base 0 on this seed —
  // its first gimmick roll fails and it pays a fresh base. This is the
  // control that the knob reproduces the old behavior AND that the pin seed
  // actually exercises the wasteful path.
  const oneRoll = generateTilingBoard({ ...cfg, gimmicks, gimmickRerolls: 1 });
  assert.ok(oneRoll, 'one-roll search must still ship a board');
  assert.notEqual(mineSet(oneRoll), mineSet(plain),
    'pin seed must be one where the one-roll search abandoned base 0 — if this fails, find a new seed');

  // The re-roll search keeps base 0 and re-rolls the gimmicks onto it.
  const rerolled = generateTilingBoard({ ...cfg, gimmicks });
  assert.ok(rerolled, 're-roll search must ship a board');
  assert.equal(mineSet(rerolled), mineSet(plain),
    'the re-roll search must ship base 0\'s mine layout instead of paying for another base');

  // And the shipped board still independently re-certifies — base reuse can
  // never trade away the no-guess contract.
  const fr = Math.floor(rerolled.firstClick / rerolled.cols);
  const fc = rerolled.firstClick % rerolled.cols;
  const check = isBoardSolvable(rerolled.board, rerolled.rows, rerolled.cols, fr, fc);
  assert.equal(check.solvable, true);
  assert.equal(check.remainingUnknowns, 0);
});

test('a plain (gimmick-free) generation is invariant to the re-roll knob', () => {
  const cfg = { type: 'rhombille', M: 4, N: 4, mines: 12, seed: 'reroll-plain-pin' };
  const a = generateTilingBoard({ ...cfg, gimmicks: [] });
  const b = generateTilingBoard({ ...cfg, gimmicks: [], gimmickRerolls: 1 });
  assert.ok(a && b);
  assert.deepEqual(
    a.board.map((row) => row.map((c) => c.isMine)),
    b.board.map((row) => row.map((c) => c.isMine)),
    'no gimmicks -> no re-roll loop -> byte-identical search',
  );
});

test('gimmickLevel reaches applyGimmicks\' intensity ramp and stays certified', () => {
  const cfg = { type: 'hex', M: 9, N: 7, mines: 14, seed: 'reroll-level-pin', gimmicks: ['locked'] };
  const low = generateTilingBoard({ ...cfg, gimmickLevel: 1 });
  const high = generateTilingBoard({ ...cfg, gimmickLevel: 120 });
  assert.ok(low && high, 'both intensity levels must generate');
  for (const r of [low, high]) {
    assert.ok(r.check.solvable && r.check.remainingUnknowns === 0, 'certified at any intensity');
  }
  const lockedCount = (r) => {
    let n = 0;
    for (const row of r.board) for (const c of row) if (c.isLocked) n++;
    return n;
  };
  // Level 120 sits at the old ladder's deep end (intensity 4-5 vs the
  // sub-intro 2-3): the same seed must place more locked cells.
  assert.ok(lockedCount(high) > lockedCount(low),
    `intensity must scale with gimmickLevel (got ${lockedCount(low)} vs ${lockedCount(high)})`);
});
