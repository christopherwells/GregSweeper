// Project Coastline — the par model on a non-rectangular board.
//
// Three things are pinned here, in the order they can go wrong:
//
//  1. Every feature computeDailyFeatures emits on a tiling describes the
//     board's OWN topology. Two of them did not before 2026-07-23:
//     `wallEdgeCount` read `board._wallEdges` while applyWallsTiling writes
//     `board._tilingWalls`, so a walled tiling reported ZERO walls; and
//     `zeroClusterCount` flooded a hardcoded 8-neighborhood over (row, col),
//     which on a tiling is pure storage (`containerFor` returns any exact
//     factorization, so 63 hexagons ship as a 7x9 container and a prime cell
//     count ships as 1xN). Both produced a plausible number, never an error.
//
//  2. Par on a RECTANGULAR board is byte-identical to before the shape terms
//     existed. That is the whole safety property of pricing tilings with the
//     shipped model plus an offset: rectangles are the omitted reference, so
//     every board shipped to date must be untouched.
//
//  3. `tilingType` is ABSENT on a rectangle, never `'rect'`. The nightly
//     verify sweep's vintage escape hatch is
//     `stored === undefined && recomputed === 0`, so a new key that recomputed
//     to a non-zero value on a historical board would hard-fail every past
//     date in scripts/verify-canonical-boards.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeDailyFeatures, predictPar, applyParModel, clueShares } from '../src/logic/dailyFeatures.js';
import { PAR_MODEL } from '../src/logic/difficulty.js';
import { generateTilingBoard } from '../src/logic/tilingGenerator.js';
import { buildTiling, containerFor } from '../src/logic/tilingGeometry.js';
import { buildNeighborCache, defineCellNeighbors } from '../src/logic/adjacency.js';
import { generateBoard, createEmptyBoard } from '../src/logic/boardGenerator.js';
import { recalcAllAdjacency } from '../src/logic/gimmicks.js';
import { isBoardSolvable } from '../src/logic/boardSolver.js';

// A tiling board plus the state shim computeDailyFeatures expects.
function tilingFixture(type, M, N, gimmicks = [], seed = 'tiling-features') {
  const T = buildTiling(type, M, N);
  const res = generateTilingBoard({
    type, M, N,
    mines: Math.round(T.total * 0.2),
    seed: `${seed}:${type}:${gimmicks.join('+')}`,
    gimmicks,
  });
  assert.ok(res, `expected a certified ${type} board (M=${M} N=${N}, gimmicks=${gimmicks})`);
  let totalMines = 0;
  for (const row of res.board) for (const cell of row) if (cell.isMine) totalMines++;
  const state = {
    board: res.board, rows: res.rows, cols: res.cols,
    totalMines, activeGimmicks: gimmicks,
  };
  return { res, state, T, features: computeDailyFeatures(state, res.check) };
}

// The honest answer, flooding the board's own adjacency.
function topologyZeroClusters(board, rows, cols) {
  const adj = buildNeighborCache(board, rows, cols);
  const at = (i) => board[(i / cols) | 0][i % cols];
  const zeroSafe = (c) => !c.isMine && (c.adjacentMines || 0) === 0;
  const seen = new Uint8Array(rows * cols);
  let n = 0;
  for (let i = 0; i < rows * cols; i++) {
    if (seen[i] || !zeroSafe(at(i))) continue;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      for (const nb of adj[stack.pop()]) {
        if (seen[nb] || !zeroSafe(at(nb))) continue;
        seen[nb] = 1;
        stack.push(nb);
      }
    }
    n++;
  }
  return n;
}

// ── 1. The two features that were wrong ──────────────────────────

test('REGRESSION: wallEdgeCount counts severed edges on a tiling (read _wallEdges, always 0)', () => {
  for (const [type, M, N] of [['hex', 9, 7], ['4.8.8', 6, 7]]) {
    const { res, features } = tilingFixture(type, M, N, ['walls']);
    const severed = res.board._tilingWalls ? res.board._tilingWalls.length : 0;

    // The fixture is only meaningful if walls actually landed — otherwise the
    // assertion below passes vacuously against 0 === 0.
    assert.ok(severed > 0, `${type}: expected applyWallsTiling to sever at least one edge`);
    assert.equal(
      features.wallEdgeCount, severed,
      `${type}: wallEdgeCount should equal the severed-edge count, not the absent _wallEdges set`,
    );
  }
});

test('a tiling board with no walls reports zero wall edges', () => {
  for (const [type, M, N] of [['hex', 9, 7], ['4.8.8', 6, 7]]) {
    const { features } = tilingFixture(type, M, N, []);
    assert.equal(features.wallEdgeCount, 0, `${type}: unwalled board should report no wall edges`);
  }
});

test('REGRESSION: zeroClusterCount floods the board topology, not the storage container', () => {
  // Both tilings, with and without walls. Before the fix these disagreed in
  // BOTH directions (over-counting 4.8.8 because the rectangular walk misses
  // true octagon-square links, under-counting hex because the 8-neighborhood
  // is a strict superset of the 6 hex neighbors and merges separate clusters).
  for (const [type, M, N] of [['hex', 9, 7], ['4.8.8', 6, 7]]) {
    for (const gimmicks of [[], ['walls']]) {
      const { res, features } = tilingFixture(type, M, N, gimmicks);
      assert.equal(
        features.zeroClusterCount,
        topologyZeroClusters(res.board, res.rows, res.cols),
        `${type}${gimmicks.length ? ' + walls' : ''}: zeroClusterCount must follow _cellNeighbors`,
      );
    }
  }
});

test('REGRESSION: zeroClusterCount is wall-AWARE on a rectangle (was wall-blind)', () => {
  // The rectangular half of the same bug: the old walk never consulted
  // _wallEdges, so it merged clusters that walls genuinely separate. Build a
  // board whose only zero-region is cut in two by a wall.
  const rows = 1, cols = 4;
  const board = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => ({ row: r, col: c, isMine: false, adjacentMines: 0 })));
  // Sever the edge between (0,1) and (0,2) — one zero-region becomes two.
  board._wallEdges = new Set(['0,1-0,2']);

  const features = computeDailyFeatures(
    { board, rows, cols, totalMines: 0, activeGimmicks: ['walls'] },
    { passAMoves: 0, totalClicks: 1 },
  );
  assert.equal(features.zeroClusterCount, 2,
    'a wall through a zero-region splits it into two cascade entry points');

  // Control: without the wall it is a single cluster, so the assertion above
  // is measuring the wall and not the board shape.
  const open = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => ({ row: r, col: c, isMine: false, adjacentMines: 0 })));
  const openFeatures = computeDailyFeatures(
    { board: open, rows, cols, totalMines: 0, activeGimmicks: [] },
    { passAMoves: 0, totalClicks: 1 },
  );
  assert.equal(openFeatures.zeroClusterCount, 1, 'unwalled control must be one cluster');
});

// ── 2. Shape identity ────────────────────────────────────────────

test('tilingType is derived from the board and ABSENT on a rectangle', () => {
  for (const [type, M, N, expected] of [['hex', 9, 7, 'hex'], ['4.8.8', 6, 7, '4.8.8']]) {
    const { features } = tilingFixture(type, M, N);
    assert.equal(features.tilingType, expected);
  }

  const rectBoard = generateBoard(8, 8, 10, 4, 4);
  const check = isBoardSolvable(rectBoard, 8, 8, 4, 4);
  const rectFeatures = computeDailyFeatures(
    { board: rectBoard, rows: 8, cols: 8, totalMines: 10, activeGimmicks: [] }, check);

  // ABSENT, not 'rect' and not 0 — the verify sweep only forgives a missing
  // stored key when the recompute is 0, so any truthy value on a rectangle
  // would hard-fail every historical dailyMeta row.
  assert.equal('tilingType' in rectFeatures, false,
    'a rectangular board must not emit tilingType at all');
});

// ── 3. Rectangles are untouched ──────────────────────────────────

test('the shape terms leave par byte-identical on every rectangular board', () => {
  const rectBoard = generateBoard(9, 9, 12, 4, 4);
  const check = isBoardSolvable(rectBoard, 9, 9, 4, 4);
  const features = computeDailyFeatures(
    { board: rectBoard, rows: 9, cols: 9, totalMines: 12, activeGimmicks: [] }, check);

  // A model without the shape coefficients at all — i.e. the shipped block as
  // it stood before Coastline. Par must be unchanged, which is what makes
  // "rectangles are the omitted reference" a property rather than an intention.
  const preCoastline = { ...PAR_MODEL };
  delete preCoastline.secPerShape488;
  delete preCoastline.secPerShapeHex;

  assert.equal(applyParModel(features, PAR_MODEL), applyParModel(features, preCoastline));
  assert.equal(predictPar(features), applyParModel(features, preCoastline));
});

test('a shape coefficient moves par ONLY on its own shape', () => {
  const base = { cellCount: 100, totalMines: 20, canonicalSubsetMoves: 2, advancedLogicMoves: 1 };
  const model = { ...PAR_MODEL, secPerShape488: 0.2, secPerShapeHex: 0.5 };

  const rect = applyParModel(base, model);
  const oct = applyParModel({ ...base, tilingType: '4.8.8' }, model);
  const hex = applyParModel({ ...base, tilingType: 'hex' }, model);

  // Log scale: an offset is a multiplier, so each shape lifts par by exp(coef).
  //
  // The tolerance is DERIVED, not picked. applyParModel quantizes par to 0.1s,
  // so `rect` is already rounded and `rect * exp(coef)` amplifies that rounding
  // by exp(coef) while `oct`/`hex` carry a rounding of their own: the honest
  // error budget is 0.05 * (1 + exp(coef)), not a flat 0.05. The flat version
  // sat right on the quantum and so passed or failed according to where the
  // CURRENT PAR_MODEL happened to put `rect` — which the nightly refit rewrites
  // every day, making this a coin-flip on main (it went red on the 2026-07-26
  // refit at rect = 61.9). Sizing the budget from the quantum keeps the
  // assertion tight — ~0.13s against a ~40s effect — and stops the shipped
  // model's value from deciding whether CI is green.
  const parQuantum = 0.05;   // half of applyParModel's 0.1s step
  const budget = (coef) => parQuantum * (1 + Math.exp(coef));
  assert.ok(Math.abs(oct - rect * Math.exp(0.2)) < budget(0.2),
    `4.8.8 offset: ${oct} vs ${rect * Math.exp(0.2)} (rect=${rect})`);
  assert.ok(Math.abs(hex - rect * Math.exp(0.5)) < budget(0.5),
    `hex offset: ${hex} vs ${rect * Math.exp(0.5)} (rect=${rect})`);

  // An unknown shape falls back to the rectangular reference rather than
  // silently picking up another tiling's offset — a third tiling that ships
  // its feature before its coefficient must price as a plain board.
  assert.equal(applyParModel({ ...base, tilingType: '3.12.12' }, model), rect);
});

// ── 4. The whole chain on a real tiling ──────────────────────────

test('a tiling board produces a complete, sane feature vector and a positive par', () => {
  for (const [type, M, N] of [['hex', 9, 7], ['4.8.8', 6, 7]]) {
    const { T, features } = tilingFixture(type, M, N, ['sonar', 'liar']);

    // cellCount is only honest because containerFor factorizes EXACTLY; a
    // future builder that pads a ragged boundary would over-count silently and
    // drag the size baseline with it.
    assert.equal(features.cellCount, T.total, `${type}: cellCount must equal the tiling's cell count`);
    assert.equal(features.rows * features.cols, T.total, `${type}: container must hold exactly the cells`);

    for (const key of ['passAMoves', 'canonicalSubsetMoves', 'genericSubsetMoves',
      'advancedLogicMoves', 'totalClicks', 'zeroClusterCount', 'wallEdgeCount']) {
      assert.equal(typeof features[key], 'number', `${type}: ${key} should be a number`);
      assert.ok(Number.isFinite(features[key]) && features[key] >= 0, `${type}: ${key} = ${features[key]}`);
    }

    // The solver invariant, on a graph rather than a grid.
    const buckets = features.passAMoves + features.canonicalSubsetMoves
      + features.genericSubsetMoves + features.advancedLogicMoves + features.disjunctiveMoves;
    assert.equal(buckets + 1, features.totalClicks, `${type}: move-type buckets must sum to totalClicks - 1`);

    const par = predictPar(features);
    assert.ok(par > 0 && Number.isFinite(par), `${type}: par should be a positive number, got ${par}`);
  }
});

test('clue-digit shares stay within the digit range each lattice can produce', () => {
  // A hexagon tops out at 6 neighbors and a 4.8.8 interstitial square at 4, so
  // the shares are computed over a narrower support than a rectangle's 0-8.
  for (const [type, M, N, maxValence] of [['hex', 9, 7, 6], ['4.8.8', 6, 7, 8]]) {
    const T = buildTiling(type, M, N);
    const observed = Math.max(...T.adj.map(n => n.length));
    assert.ok(observed <= maxValence, `${type}: valence ${observed} exceeds expected ${maxValence}`);

    const { features } = tilingFixture(type, M, N);
    const total = features.clueShare2 + features.clueShare3
      + features.clueShare4 + features.clueShare5plus;
    // Shares are scaled x10 and 1s are the omitted reference, so the four
    // reported shares sum to at most 10.
    assert.ok(total >= 0 && total <= 10 + 1e-9, `${type}: shares sum to ${total}`);
  }
});

// REGRESSION (2026-07-27): clueShares sized its histogram at digit 8 and DROPPED
// anything larger from the numerator AND the denominator, so a clue of 9 or 10
// did not merely miss its own bucket, it shifted all four reported shares. That
// was harmless while every lattice topped out at 8, and CLAUDE.md carried it as a
// latent rectangular assumption for exactly that reason. Corner-inclusive
// adjacency ended the reprieve: rhombille's interior valence is 10 and
// deltoidal's is 9.
//
// The four frozen gate fixtures cannot cover this — every one of them tops out
// at a clue of 5 — so the boards here are built to order, with mines on EVERY
// neighbor of one interior cell, which is the only way to force the maximum
// clue a lattice can print.
test('REGRESSION: a clue above 8 counts, rather than skewing every clue share', () => {
  for (const [type, M, N, expectedMax] of [['rhombille', 6, 6, 10], ['deltoidal', 5, 5, 9]]) {
    const T = buildTiling(type, M, N);
    const { rows, cols } = containerFor(T.total);

    // Pick an interior cell with the lattice's full valence and surround it.
    const hub = T.adj.findIndex(n => n.length === expectedMax);
    assert.ok(hub >= 0, `${type}: expected an interior cell of valence ${expectedMax}`);

    const board = createEmptyBoard(rows, cols);
    defineCellNeighbors(board, rows, cols, T.adj);
    const at = (i) => board[(i / cols) | 0][i % cols];
    for (const n of T.adj[hub]) at(n).isMine = true;
    recalcAllAdjacency(board);

    assert.equal(at(hub).adjacentMines, expectedMax,
      `${type}: the hub must actually read ${expectedMax}, or this proves nothing`);

    const shares = clueShares(board, rows, cols);
    const total = shares.clueShare2 + shares.clueShare3
      + shares.clueShare4 + shares.clueShare5plus;

    // The hub's clue is above 8 and belongs in the 5plus bucket. Under the old
    // cap it vanished from both sides of every ratio; the tell is that 5plus
    // reads zero on a board that demonstrably carries a 9 or a 10.
    assert.ok(shares.clueShare5plus > 0,
      `${type}: a clue of ${expectedMax} must land in clueShare5plus, got ${shares.clueShare5plus}`);
    assert.ok(total >= 0 && total <= 10 + 1e-9, `${type}: shares sum to ${total}`);
  }
});
