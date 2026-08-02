// The modifier load-bearing filter on a tiling (Project Coastline).
//
// Beyond solvability, every generation path the daily uses requires that each
// non-exempt modifier contributes at least one deduction the player needs to
// make — a modifier that changes nothing is a promise the board does not keep.
// generateTilingBoard never applied that bar, so a tiling daily would have
// shipped decorative modifiers at a high rate: measured over 40 seeds each
// before this gate, sonar was decorative on 45-60% of boards and compass on
// 40-88%.
//
// The topology needs no special handling. findDecorativeGimmicks threads its
// cache into isBoardSolvable, and buildNeighborCache reads
// `board._cellNeighbors` when present, so the tiling's own adjacency is used
// either way — verified below, because "it happens to work" is worth pinning.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateTilingBoard, TILING_LOAD_BEARING_BUDGET, TILING_SAFE_GIMMICKS,
} from '../src/logic/tilingGenerator.js';
import { buildTiling } from '../src/logic/tilingGeometry.js';
import {
  findDecorativeGimmicks, isBoardSolvable, TESTABLE_GIMMICK_TYPES,
} from '../src/logic/boardSolver.js';
import { cleanSolverArtifacts } from '../src/logic/boardGenerator.js';

// Modifiers that are BOTH tiling-safe and testable by the filter. Deliberately
// derived rather than hand-listed — if either list moves, the coverage moves
// with it, which is exactly what happened on 2026-08-01 when wormhole gained
// its tiling story (graph-distance pair separation) and joined this set
// without an edit here.
const TILING_TESTABLE = TILING_SAFE_GIMMICKS.filter((g) => TESTABLE_GIMMICK_TYPES.includes(g));

function decorativeOn(res) {
  const fr = Math.floor(res.firstClick / res.cols), fc = res.firstClick % res.cols;
  const out = findDecorativeGimmicks(
    res.board, res.rows, res.cols, fr, fc, res.activeGimmicks, res.board._cellNeighbors);
  cleanSolverArtifacts(res.board);
  return out;
}

function gen(type, M, N, d, gimmicks, seed, extra = {}) {
  const T = buildTiling(type, M, N);
  return generateTilingBoard({
    type, M, N, mines: Math.round(T.total * d), seed, gimmicks, ...extra,
  });
}

test('the tiling-testable modifier set is non-empty (or every test here is vacuous)', () => {
  assert.ok(TILING_TESTABLE.length > 0);
  // All five testable gimmick types now have tiling stories — wormhole was
  // the last holdout (joined 2026-08-01). Its absence here would mean the
  // load-bearing coverage silently stopped seeing it.
  for (const g of ['sonar', 'compass', 'liar', 'mirror', 'wormhole']) {
    assert.ok(TILING_TESTABLE.includes(g), `${g} should be tiling-safe and testable`);
  }
});

test('REGRESSION: a shipped tiling board carries no decorative modifier', () => {
  // The gate. Without it, roughly half of these boards carry a modifier that
  // contributes nothing to the solve.
  for (const [type, M, N] of [['4.8.8', 6, 7], ['hex', 9, 7]]) {
    for (const g of TILING_TESTABLE) {
      for (let s = 0; s < 4; s++) {
        const res = gen(type, M, N, 0.24, [g], `lb-${type}-${g}-${s}`);
        assert.ok(res, `${type}/${g}: failed to generate`);
        const applied = res.applied || {};
        const placed = Array.isArray(applied[g]) ? applied[g].length > 0 : !!applied[g];
        if (!placed) continue; // nothing placed is a different outcome, not a failure here
        assert.deepEqual(decorativeOn(res), [],
          `${type}/${g} seed ${s}: shipped a DECORATIVE modifier`);
      }
    }
  }
});

test('the control: with the budget disabled, decorative boards do get through', () => {
  // Proves the gate is doing work rather than the boards being naturally clean.
  // Searches seeds for a single counterexample; if the filter were a no-op this
  // would find one immediately, and if the boards were naturally clean the
  // REGRESSION test above would be vacuous.
  let foundDecorative = false;
  outer:
  for (const [type, M, N] of [['4.8.8', 6, 7], ['hex', 9, 7]]) {
    for (const g of ['sonar', 'compass']) {
      for (let s = 0; s < 25; s++) {
        const raw = gen(type, M, N, 0.18, [g], `ctl-${type}-${g}-${s}`, { loadBearingBudget: 0 });
        if (raw && decorativeOn(raw).length > 0) { foundDecorative = true; break outer; }
      }
    }
  }
  assert.ok(foundDecorative,
    'no decorative board found with the filter OFF — the regression test would be vacuous');
});

test('the filter never trades away the no-guess contract', () => {
  // Load-bearing is a PREFERENCE with a bound; certification is absolute. Every
  // returned board must still certify from its own opener, budget or no budget.
  for (const [type, M, N] of [['4.8.8', 6, 7], ['hex', 9, 7]]) {
    for (const g of TILING_TESTABLE) {
      const res = gen(type, M, N, 0.24, [g], `cert-${type}-${g}`);
      assert.ok(res, `${type}/${g}: failed to generate`);
      const fr = Math.floor(res.firstClick / res.cols), fc = res.firstClick % res.cols;
      const check = isBoardSolvable(res.board, res.rows, res.cols, fr, fc, res.board._cellNeighbors);
      cleanSolverArtifacts(res.board);
      assert.ok(check.solvable && check.remainingUnknowns === 0,
        `${type}/${g}: returned an UNCERTIFIED board`);
    }
  }
});

test('generation still succeeds on every tiling-safe modifier, including the exempt ones', () => {
  // mystery and worm are exempt because they only remove or delay information;
  // locked and walls are structural. The filter must not reject them — and must
  // not cost them a baseline solve either (it is skipped when nothing on the
  // board is testable).
  for (const g of TILING_SAFE_GIMMICKS) {
    const res = gen('4.8.8', 6, 7, 0.22, [g], `exempt-${g}`);
    assert.ok(res, `4.8.8 with ${g} failed to generate`);
    assert.deepEqual(decorativeOn(res), [], `${g} should never be reported decorative`);
  }
});

test('a gimmick-free board is unaffected by the filter', () => {
  const a = gen('4.8.8', 6, 7, 0.24, [], 'bare');
  const b = gen('4.8.8', 6, 7, 0.24, [], 'bare', { loadBearingBudget: 0 });
  assert.ok(a && b);
  // Identical, because with no modifiers the filter is never consulted.
  const fp = (r) => r.board.flat().map((c) => (c.isMine ? 1 : 0)).join('');
  assert.equal(fp(a), fp(b), 'a bare board must not depend on the load-bearing budget');
});

test('generation stays deterministic per seed with the filter engaged', () => {
  // Every player on a canonical date must build the identical board.
  const a = gen('hex', 9, 7, 0.24, ['sonar'], 'det-lb');
  const b = gen('hex', 9, 7, 0.24, ['sonar'], 'det-lb');
  assert.ok(a && b);
  const fp = (r) => r.board.flat().map((c) => `${c.isMine ? 1 : 0}${c.isSonar ? 'S' : ''}`).join('');
  assert.equal(fp(a), fp(b));
});

test('the budget mirrors the daily play path', () => {
  // The tiling bar should not drift from the rectangular one it is copying.
  assert.equal(TILING_LOAD_BEARING_BUDGET, 25);
});
