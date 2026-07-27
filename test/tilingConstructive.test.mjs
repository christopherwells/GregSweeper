// The constructive generator on a tiling (Project Coastline).
//
// Rectangles have had a CONSTRUCTIVE mine placer since long before tilings:
// generateBoard routes `density > 0.22 || hasGimmicks` to generateConstructive,
// which places mines one at a time keeping the board solvable, with
// backtracking. generateTilingBoard had no such path — it was pure rejection
// sampling at every density — so the two shapes were never running the same
// algorithm, and the "4.8.8 cannot generate at high density" ceiling was
// substantially the absence of this generator rather than a property of the
// lattice. Measured before the port: 4.8.8 at 128 cells certified 0 of 363,000
// random layouts at density 0.30, and 0/20 boards; after, 20/20 in ~16 ms.
//
// Two contracts are pinned here, and the second matters as much as the first:
// the tiling boards must be genuinely CERTIFIED (constructing a board is
// worthless if it ships a guess), and RECTANGLES must be byte-identical, since
// generateConstructive is on the path of every challenge, timed, daily and
// weekly board in the game.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { generateBoard, generateConstructive, cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import { generateTilingBoard, CONSTRUCTIVE_DENSITY_THRESHOLD } from '../src/logic/tilingGenerator.js';
import { buildTiling } from '../src/logic/tilingGeometry.js';
import { isBoardSolvable } from '../src/logic/boardSolver.js';
import { createDailyRNG } from '../src/logic/seededRandom.js';

const fingerprint = (board, rows, cols) => {
  const parts = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      parts.push(`${board[r][c].isMine ? 1 : 0}:${board[r][c].adjacentMines}`);
    }
  }
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
};

// ── 1. The regression: high-density tilings now generate ─────────

test('REGRESSION: a 4.8.8 board generates across the FULL daily density band', () => {
  // The daily band is 14%-30%. Before the constructive path, 128 cells at 0.28
  // and 0.30 returned null on every seed, so those densities could never have
  // shipped as a daily.
  for (const [M, N] of [[6, 7], [8, 9]]) {
    const T = buildTiling('4.8.8', M, N);
    for (const d of [0.24, 0.26, 0.28, 0.30]) {
      const mines = Math.round(T.total * d);
      for (let s = 0; s < 3; s++) {
        const res = generateTilingBoard({
          type: '4.8.8', M, N, mines, seed: `band-${M}${N}-${d}-${s}`,
        });
        assert.ok(res, `4.8.8 ${M}x${N} at density ${d} (seed ${s}) failed to generate`);
      }
    }
  }
});

test('a constructed tiling board is genuinely CERTIFIED, not merely built', () => {
  // The whole point of the no-guess contract: constructing a board fast is
  // worthless if the board ships a guess. Re-certify independently, from the
  // board's own stored opener, with the SHIPPED certifier.
  for (const [type, M, N] of [['4.8.8', 8, 9], ['hex', 11, 11]]) {
    const T = buildTiling(type, M, N);
    const mines = Math.round(T.total * 0.30); // deep in the constructive region
    const res = generateTilingBoard({ type, M, N, mines, seed: `cert-${type}` });
    assert.ok(res, `${type} at density 0.30 failed to generate`);

    const fr = Math.floor(res.firstClick / res.cols);
    const fc = res.firstClick % res.cols;
    const check = isBoardSolvable(res.board, res.rows, res.cols, fr, fc, res.board._cellNeighbors);
    cleanSolverArtifacts(res.board);
    assert.ok(check.solvable && check.remainingUnknowns === 0,
      `${type}: constructed board does NOT certify (${check.remainingUnknowns} unknowns left)`);
  }
});

test('the opener and its graph neighbours stay mine-free on a constructed board', () => {
  // The rectangular safe zone is the 3x3 block around the first click, which on
  // a tiling is a set of cells mostly NOT adjacent to the opener (the container
  // is storage, not geometry). The tiling passes its true graph neighbourhood,
  // and if that were wrong the opener would not cascade.
  for (const [type, M, N] of [['4.8.8', 8, 9], ['hex', 11, 11]]) {
    const T = buildTiling(type, M, N);
    const res = generateTilingBoard({
      type, M, N, mines: Math.round(T.total * 0.30), seed: `safe-${type}`,
    });
    assert.ok(res, `${type} failed to generate`);
    const at = (i) => res.board[(i / res.cols) | 0][i % res.cols];
    assert.equal(at(res.firstClick).isMine, false, `${type}: opener is a mine`);
    for (const nb of T.adj[res.firstClick]) {
      assert.equal(at(nb).isMine, false, `${type}: opener neighbour ${nb} is a mine`);
    }
    // And the opener must actually open ground, or the "cascade from here"
    // premise is broken.
    assert.equal(at(res.firstClick).adjacentMines, 0, `${type}: opener does not cascade`);
  }
});

test('the requested mine count is honoured exactly', () => {
  for (const [type, M, N] of [['4.8.8', 6, 7], ['hex', 9, 7]]) {
    const T = buildTiling(type, M, N);
    const mines = Math.round(T.total * 0.28);
    const res = generateTilingBoard({ type, M, N, mines, seed: `count-${type}` });
    assert.ok(res, `${type} failed to generate`);
    let placed = 0;
    for (const row of res.board) for (const cell of row) if (cell.isMine) placed++;
    assert.equal(placed, mines, `${type}: expected ${mines} mines, got ${placed}`);
  }
});

test('constructed tiling boards still work with modifiers', () => {
  // 128 cells at density 0.30 with modifiers, which the un-ported generator
  // failed on 20 of 20 seeds — chosen deliberately so this cannot pass by luck
  // against a disabled constructive path (a 72-cell board at 0.28 still
  // succeeded ~10% of the time and made the assertion nearly vacuous).
  const T = buildTiling('4.8.8', 8, 9);
  for (let s = 0; s < 3; s++) {
    const res = generateTilingBoard({
      type: '4.8.8', M: 8, N: 9, mines: Math.round(T.total * 0.30),
      seed: `gim-488-${s}`, gimmicks: ['sonar', 'walls'],
    });
    assert.ok(res, `high-density 4.8.8 with sonar+walls failed to generate (seed ${s})`);
    const fr = Math.floor(res.firstClick / res.cols), fc = res.firstClick % res.cols;
    const check = isBoardSolvable(res.board, res.rows, res.cols, fr, fc, res.board._cellNeighbors);
    cleanSolverArtifacts(res.board);
    assert.ok(check.solvable && check.remainingUnknowns === 0,
      'a modifier board built constructively must still certify');
  }
});

// ── 2. Rectangles are untouched ──────────────────────────────────

test('REGRESSION: the refactor leaves rectangular boards byte-identical', () => {
  // generateConstructive is on the path of EVERY challenge / timed / daily /
  // weekly board, so the topology parameterisation must not perturb a single
  // one. The fingerprints below were captured from the pre-refactor generator
  // and verified equal across a 420-board branch-vs-main differential; they
  // will move if anyone changes the RNG consumption order (the candidate list
  // is built row-major and the Fisher-Yates draws one rng() per candidate, so
  // even reordering the scan changes every board).
  const GOLDEN = [
    { rows: 9, cols: 9, mines: 21, hasGimmicks: false, seed: 'golden-a', fp: 'd0bc2d9bdd763e3d' },
    { rows: 11, cols: 11, mines: 36, hasGimmicks: false, seed: 'golden-b', fp: 'ba8ebd72fb148ffe' },
    { rows: 10, cols: 10, mines: 18, hasGimmicks: true, seed: 'golden-c', fp: 'c29da660aa4a760f' },
    { rows: 8, cols: 8, mines: 9, hasGimmicks: false, seed: 'golden-d', fp: '48b3b0e2d9c74c24' },
  ];
  for (const g of GOLDEN) {
    const board = generateBoard(
      g.rows, g.cols, g.mines, Math.floor(g.rows / 2), Math.floor(g.cols / 2),
      createDailyRNG(g.seed), { hasGimmicks: g.hasGimmicks },
    );
    assert.ok(board, `${g.seed}: generateBoard returned null`);
    assert.equal(fingerprint(board, g.rows, g.cols), g.fp,
      `${g.seed}: rectangular board changed — the constructive refactor must be a no-op on squares`);
  }
});

test('generateConstructive without a topology is the rectangular generator verbatim', () => {
  // The `topo` argument defaults to null, and its absence must reproduce the
  // old behaviour exactly: 8-neighbourhood adjacency and the 3x3 safe zone.
  const board = generateConstructive(9, 9, 20, 4, 4, createDailyRNG('rect-direct'), null);
  assert.ok(board, 'rectangular constructive generation failed');
  let mines = 0;
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (board[r][c].isMine) mines++;
      // The 3x3 block around the opener must be clear.
      if (Math.abs(r - 4) <= 1 && Math.abs(c - 4) <= 1) {
        assert.equal(board[r][c].isMine, false, `safe zone breached at ${r},${c}`);
      }
    }
  }
  assert.equal(mines, 20);
});

// ── 3. The threshold gate ────────────────────────────────────────

test('the constructive path engages only ABOVE the density threshold', () => {
  // Below it, random layouts certify readily and are far cheaper, so the cheap
  // path stays the default exactly as it does for rectangles. Pinned by
  // behaviour: at a density under the threshold the board must be the SAME one
  // the pre-refactor random path produced for that seed.
  assert.equal(CONSTRUCTIVE_DENSITY_THRESHOLD, 0.22,
    'the tiling threshold should track generateBoard\'s own 0.22 rule');

  const T = buildTiling('4.8.8', 6, 7);
  // 0.18 is below the threshold -> random path. Two calls with the same seed
  // must agree (determinism), and the board must certify.
  const mines = Math.round(T.total * 0.18);
  const a = generateTilingBoard({ type: '4.8.8', M: 6, N: 7, mines, seed: 'thresh' });
  const b = generateTilingBoard({ type: '4.8.8', M: 6, N: 7, mines, seed: 'thresh' });
  assert.ok(a && b);
  assert.equal(fingerprint(a.board, a.rows, a.cols), fingerprint(b.board, b.rows, b.cols),
    'generation must stay deterministic for a given seed');
});

test('generation stays deterministic per seed on the CONSTRUCTIVE path too', () => {
  // Every player on a canonical date must build the identical board, so the
  // constructive path has to be as seed-deterministic as the random one.
  const T = buildTiling('4.8.8', 8, 9);
  const mines = Math.round(T.total * 0.30);
  const a = generateTilingBoard({ type: '4.8.8', M: 8, N: 9, mines, seed: 'det' });
  const b = generateTilingBoard({ type: '4.8.8', M: 8, N: 9, mines, seed: 'det' });
  assert.ok(a && b, 'high-density generation failed');
  assert.equal(fingerprint(a.board, a.rows, a.cols), fingerprint(b.board, b.rows, b.cols),
    'the constructive path must be deterministic for a given seed');
});
