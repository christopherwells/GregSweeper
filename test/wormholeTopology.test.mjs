// ── Wormhole pair separation follows the board's own topology ──────────────
//
// REGRESSION (2026-08-01): applyWormholes separated a pair by MANHATTAN
// DISTANCE ON THE CONTAINER (`|dr| + |dc| >= 2 or 3`). On a Coastline tiling
// the container is pure storage — a cell's (row, col) says nothing about what
// it touches — so two cells "3 apart" by container arithmetic can be direct
// lattice neighbors, and the anti-adjacency rule the distance check exists
// for silently stopped meaning anything.
//
// On an explicit topology the separation is now GRAPH distance >= 3 (the
// partner sits outside the first endpoint's 2-step ball). Deliberately no
// small-board Manhattan-2 tier there: graph distance 2 means a SHARED
// NEIGHBOR, and buildStaticGimmickConstraints skips a pair whose
// neighborhoods overlap — a distance-2 pair would display a sum the certifier
// can never use, decorative by construction. Distance >= 3 makes the union
// constraint always emit.
//
// The RECTANGULAR branch is preserved VERBATIM, pinned by golden fingerprints
// captured from main: pair placement consumes the shared RNG stream, so any
// drift in that branch moves every shipped canonical board that carries a
// wormhole (verified equal across a 1440-board branch-vs-main applyGimmicks
// differential: 15 combos x 24 seeds x 4 shapes, control-tested by perturbing
// the Manhattan threshold, which moves the hash).
//
// The six-lattice gate below is the CI face of the 2026-08-01 sweep: 30 seeds
// x six lattices x (wormhole | wormhole+walls | wormhole+mystery) = 540/540
// certified with wormhole present, every pair at graph distance >= 3, one
// certifier constraint per pair; decorative 4-28% with the load-bearing
// budget off, 0% with it on.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { applyGimmicks, recalcAllAdjacency } from '../src/logic/gimmicks.js';
import { createEmptyBoard, cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import { createDailyRNG } from '../src/logic/seededRandom.js';
import { generateTilingBoard, TILING_SAFE_GIMMICKS } from '../src/logic/tilingGenerator.js';
import { buildTiling, containerFor, TILING_TYPES } from '../src/logic/tilingGeometry.js';
import { coastlineBoardFor } from '../src/logic/coastlineLink.js';
import { isBoardSolvable, buildStaticGimmickConstraints } from '../src/logic/boardSolver.js';

function graphDistance(adj, a, b, cap = 5) {
  if (a === b) return 0;
  const seen = new Set([a]);
  let frontier = [a];
  for (let d = 1; d <= cap; d++) {
    const next = [];
    for (const i of frontier) {
      for (const n of adj[i]) {
        if (n === b) return d;
        if (!seen.has(n)) { seen.add(n); next.push(n); }
      }
    }
    frontier = next;
  }
  return Infinity;
}

function wormholePairs(res) {
  return Array.isArray(res.applied.wormhole) ? res.applied.wormhole : [];
}

test('the bug\'s signature: container Manhattan >= 3 admits DIRECT lattice neighbors', () => {
  // Pure topology fact, no generation needed: on the rhombille practice board
  // there exist adjacent cells whose container coordinates are 3+ apart, so
  // the old rule would have accepted them as a "separated" wormhole pair.
  const { M, N } = coastlineBoardFor('rhombille');
  const T = buildTiling('rhombille', M, N);
  const { cols } = containerFor(T.total);
  let adjacentButFar = 0;
  for (let i = 0; i < T.total; i++) {
    for (const j of T.adj[i]) {
      if (j < i) continue;
      const manhattan = Math.abs(((i / cols) | 0) - ((j / cols) | 0)) + Math.abs((i % cols) - (j % cols));
      if (manhattan >= 3) adjacentButFar++;
    }
  }
  assert.ok(adjacentButFar > 0,
    'no adjacent pair sits 3+ apart in the container — the old Manhattan rule would have been accidentally sound here');
});

test('REGRESSION: tiling pairs sit at graph distance >= 3 and each emits its certifier constraint', () => {
  // Hex (cheap) + rhombille (the highest-valence lattice, where the container
  // lies hardest about adjacency). Placement is candidate-dependent, so search
  // a few seeds for boards where pairs actually landed.
  for (const type of ['hex', 'rhombille']) {
    const { M, N, mines } = coastlineBoardFor(type);
    let checked = 0;
    for (let s = 0; s < 6 && checked < 2; s++) {
      const res = generateTilingBoard({
        type, M, N, mines, seed: `wh-topo-${type}-${s}`, gimmicks: ['wormhole'],
      });
      if (!res) continue;
      const pairs = wormholePairs(res);
      if (pairs.length === 0) continue;
      checked++;

      const adj = res.board._cellNeighbors;
      for (const p of pairs) {
        const ai = p.a.row * res.cols + p.a.col;
        const bi = p.b.row * res.cols + p.b.col;
        const d = graphDistance(adj, ai, bi);
        assert.ok(d >= 3,
          `${type} seed ${s}: pair at graph distance ${d} — the separation rule is not being applied to the topology`);
      }

      // Distance >= 3 means disjoint neighborhoods, so the certifier's
      // overlap-skip can never fire: every pair must emit its union
      // constraint, or the modifier is invisible to certification.
      const gcs = buildStaticGimmickConstraints(res.board, res.rows, res.cols, adj)
        .filter((g) => g.partner != null);
      assert.equal(gcs.length, pairs.length,
        `${type} seed ${s}: ${pairs.length} pairs but ${gcs.length} certifier constraints`);
    }
    assert.ok(checked >= 1, `${type}: no board with wormhole pairs found across 6 seeds`);
  }
});

test('every lattice generates a certified wormhole board (the six-lattice gate)', () => {
  // One certified board per lattice in CI; the 540-run sweep in the header is
  // the full measurement. TILING_SAFE_GIMMICKS must list wormhole or the
  // coastlineLink/tilingGenerator coverage silently drops it.
  assert.ok(TILING_SAFE_GIMMICKS.includes('wormhole'), 'wormhole must be tiling-safe');
  for (const type of TILING_TYPES) {
    const { M, N, mines } = coastlineBoardFor(type);
    let res = null, placed = 0;
    for (let s = 0; s < 4 && !placed; s++) {
      const r = generateTilingBoard({
        type, M, N, mines, seed: `wh-gate-${type}-${s}`, gimmicks: ['wormhole'],
      });
      if (!r) continue;
      res = r;
      placed = wormholePairs(r).length;
    }
    assert.ok(res, `${type}: no certified wormhole board across 4 seeds`);
    assert.ok(placed > 0, `${type}: wormhole never placed a pair — it is a no-op on this lattice`);

    const fr = Math.floor(res.firstClick / res.cols), fc = res.firstClick % res.cols;
    const check = isBoardSolvable(res.board, res.rows, res.cols, fr, fc, res.board._cellNeighbors);
    cleanSolverArtifacts(res.board);
    assert.ok(check.solvable && check.remainingUnknowns === 0, `${type}: wormhole board does not re-certify`);
  }
});

// ── Rectangles: byte-identical, pinned forward ─────────────────────────────

function rectFingerprint(rows, cols, combo, level, seed) {
  const rng = createDailyRNG(seed);
  const board = createEmptyBoard(rows, cols);
  const mines = Math.round(rows * cols * 0.2);
  const pool = [];
  for (let i = 0; i < rows * cols; i++) pool.push(i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  for (let k = 0; k < mines; k++) board[(pool[k] / cols) | 0][pool[k] % cols].isMine = true;
  recalcAllAdjacency(board);
  const applied = applyGimmicks(board, level, combo, rng);
  const parts = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      parts.push([
        cell.isMine ? 1 : 0, cell.adjacentMines,
        cell.displayedMines === undefined ? '' : cell.displayedMines,
        cell.isWormhole ? `W${cell.wormholePairIndex}:${cell.wormholePair.row},${cell.wormholePair.col}` : '',
        cell.isLiar ? `L${cell.liarOffset}` : '',
      ].join('|'));
    }
  }
  parts.push(JSON.stringify(applied));
  parts.push(board._wallEdges ? Array.from(board._wallEdges).sort().join(';') : '');
  return createHash('sha256').update(parts.join('#')).digest('hex').slice(0, 16);
}

test('REGRESSION: rectangular wormhole placement is byte-identical (golden fingerprints from main)', () => {
  // Captured from the pre-split generator on main. They move if anyone touches
  // the rectangular branch's RNG consumption or its Manhattan rule — including
  // "cleaning it up" to graph distance, which would silently reshuffle every
  // canonical board that carries a wormhole.
  const GOLDEN = [
    // 8x8: the Manhattan minDist=2 tier (min dimension <= 8).
    { rows: 8, cols: 8, combo: ['wormhole'], level: 1, seed: 'wh-golden-a', fp: 'f846a9a2c851168a' },
    // 14x14: the minDist=3 tier, post-intro intensity, liar stacked on top.
    { rows: 14, cols: 14, combo: ['wormhole', 'liar'], level: 75, seed: 'wh-golden-b', fp: 'e160a63aaaec0fea' },
    // 10x14: non-square, walls first in ORDER so the RNG stream crosses gimmicks.
    { rows: 10, cols: 14, combo: ['wormhole', 'walls'], level: 1, seed: 'wh-golden-c', fp: '4643d6f0a67af084' },
    // 9x9: the first size on the minDist=3 side of the tier boundary. The
    // seed was SEARCHED for (0..49) to be one where the tiers actually pick
    // different partners — most seeds' first candidate pair satisfies both
    // tiers, and a golden that cannot feel the `<= 8` threshold pins nothing.
    { rows: 9, cols: 9, combo: ['wormhole'], level: 1, seed: 'wh-golden-9x9-0', fp: 'f22fdb8ff7659bf0' },
  ];
  for (const g of GOLDEN) {
    assert.equal(rectFingerprint(g.rows, g.cols, g.combo, g.level, g.seed), g.fp,
      `${g.seed}: rectangular wormhole placement changed — the topology split must be a no-op on rectangles`);
  }
});

test('rectangular pairs still obey the container-Manhattan rule verbatim', () => {
  // The rule's letter, cheap to assert: >= 2 when the min dimension is <= 8,
  // >= 3 otherwise. (Manhattan 2 includes diagonal adjacency — that is the
  // shipped behavior on small boards, not a bug to fix here.)
  for (const [rows, cols, minDist] of [[8, 8, 2], [14, 14, 3]]) {
    for (let s = 0; s < 6; s++) {
      const rng = createDailyRNG(`wh-rect-rule-${rows}-${s}`);
      const board = createEmptyBoard(rows, cols);
      const pool = [];
      for (let i = 0; i < rows * cols; i++) pool.push(i);
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      for (let k = 0; k < Math.round(rows * cols * 0.2); k++) {
        board[(pool[k] / cols) | 0][pool[k] % cols].isMine = true;
      }
      recalcAllAdjacency(board);
      const applied = applyGimmicks(board, 1, ['wormhole'], rng);
      for (const p of applied.wormhole || []) {
        const manhattan = Math.abs(p.a.row - p.b.row) + Math.abs(p.a.col - p.b.col);
        assert.ok(manhattan >= minDist,
          `${rows}x${cols} seed ${s}: pair at Manhattan ${manhattan}, rule demands >= ${minDist}`);
      }
    }
  }
});
