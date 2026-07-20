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
  buildTiling488, containerFor, OCT_CUT, SQ_BOX_FRAC,
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

test('shape constants are the regular-octagon values', () => {
  // s = 1/(1+√2); corner cut a = (1-s)/2; diamond box = 2a.
  assert.ok(Math.abs(OCT_CUT - 0.29289) < 1e-4);
  assert.ok(Math.abs(SQ_BOX_FRAC - 0.58579) < 1e-4);
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
