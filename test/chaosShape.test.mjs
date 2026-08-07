// Chaos board shapes.
//
// Chaos is the one mode outside the no-guess contract, so giving it the board
// shapes is renderer reach rather than a change to certification. What this
// file pins is the part that IS a decision: which shapes chaos may use, how a
// round's rectangular size translates onto a lattice, and the one hard
// constraint the mode imposes — chaos generates ON THE FIRST CLICK, with a
// clock about to start, so a multi-second stall is the failure mode.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveChaosShape, chaosTilingDims, chaosTilingPlan,
  CHAOS_SHAPES, CHAOS_TILING_PROB, CHAOS_MAX_TILING_CELLS,
} from '../src/logic/chaosShape.js';
import { getChaosDifficulty } from '../src/logic/difficulty.js';
import { buildTiling, containerIsStorable, TILING_TYPES } from '../src/logic/tilingGeometry.js';
import { boardFitsPhone } from '../src/logic/boardFit.js';
import { generateTilingBoard } from '../src/logic/tilingGenerator.js';
import { createDailyRNG } from '../src/logic/seededRandom.js';

const ROUNDS = [1, 2, 3, 5, 7, 9, 12, 15, 20, 30];

// ── Which shapes ─────────────────────────────────────────────────────────

test('the two dearest lattices are excluded, and the exclusion is measured not assumed', () => {
  // Rhombille and deltoidal are absent because chaos generates under a click.
  // The assertion is on the ABSENCE so a future re-inclusion is a decision:
  // if either becomes cheap enough, delete its line and the note in the
  // module rather than leaving a stale claim.
  assert.ok(!CHAOS_SHAPES.includes('rhombille'), 'rhombille generates too slowly for a first click');
  assert.ok(!CHAOS_SHAPES.includes('deltoidal'), 'deltoidal generates too slowly for a first click');
  for (const t of TILING_TYPES) {
    if (t === 'rhombille' || t === 'deltoidal') continue;
    assert.ok(CHAOS_SHAPES.includes(t), `${t} should be available to chaos`);
  }
  assert.ok(CHAOS_SHAPES.length >= 4, `only ${CHAOS_SHAPES.length} shapes available`);
});

test('the roll lands near the ruled split and reaches every available shape', () => {
  const counts = { rect: 0 };
  for (const t of CHAOS_SHAPES) counts[t] = 0;
  const N = 4000;
  const rng = createDailyRNG('chaos-roll');
  for (let i = 0; i < N; i++) {
    const shape = resolveChaosShape(3, rng);
    counts[shape === null ? 'rect' : shape]++;
  }
  const rectShare = counts.rect / N;
  assert.ok(Math.abs(rectShare - (1 - CHAOS_TILING_PROB)) < 0.05,
    `rectangles took ${(rectShare * 100).toFixed(1)}% of rounds`);
  for (const t of CHAOS_SHAPES) {
    assert.ok(counts[t] > N * 0.05, `${t} appeared only ${counts[t]} times in ${N} rounds`);
  }
  // A nonsense round is a rectangle rather than a throw.
  assert.equal(resolveChaosShape(0, rng), null);
  assert.equal(resolveChaosShape(undefined, rng), null);
});

// ── How big ──────────────────────────────────────────────────────────────

test('a lattice round lands near the square round it replaces, and stays storable', () => {
  for (const round of ROUNDS) {
    const rect = getChaosDifficulty(round);
    const target = rect.rows * rect.cols;
    for (const type of CHAOS_SHAPES) {
      const plan = chaosTilingPlan(rect, type);
      assert.ok(plan, `${type} has no plan for round ${round}`);

      // The declared cell count is the lattice's real one.
      assert.equal(buildTiling(type, plan.M, plan.N).total, plan.cells,
        `${type} round ${round}: declared ${plan.cells} cells`);

      // Storable, because containerFor also drives the DOM grid: a prime cell
      // count would render the board as a single row.
      assert.ok(containerIsStorable(plan.cells),
        `${type} round ${round}: ${plan.cells} cells is not a storable container`);
      assert.ok(plan.cells <= CHAOS_MAX_TILING_CELLS,
        `${type} round ${round}: ${plan.cells} cells exceeds the chaos cap`);

      // Near the round's own size, in the only sense that transfers between a
      // rectangle and a lattice. Capped rounds are allowed to fall short.
      if (target <= CHAOS_MAX_TILING_CELLS) {
        const ratio = plan.cells / target;
        assert.ok(ratio > 0.7 && ratio < 1.35,
          `${type} round ${round}: ${plan.cells} cells against a ${target}-cell round`);
      }

      // And the round's DENSITY is preserved, which is what makes a lattice
      // round as hard as the square one rather than merely as large.
      const rectDensity = rect.mines / target;
      const planDensity = plan.mines / plan.cells;
      assert.ok(Math.abs(planDensity - rectDensity) < 0.04,
        `${type} round ${round}: density ${planDensity.toFixed(3)} vs ${rectDensity.toFixed(3)}`);
    }
  }
});

test('patches are not long ribbons', () => {
  // A pure nearest-cell-count search picks exact strips: the 4.8.8 hits 63
  // cells exactly at M=3, N=13. Something has to stop that.
  //
  // This used to score |M - N| in LATTICE indices, and that measured the wrong
  // space (2026-08-06). A step in M and a step in N cover different distances
  // on screen for four of the six lattices, so the ratio of the indices says
  // little about the shape a player sees: measured, the floret's 8x2 is 4.0:1
  // in indices and renders 314 x 471px — better proportioned than cairo's
  // 10x5, which is 2.0:1 in indices and renders 255 x 510px. The assertion is
  // therefore on the RENDERED extent, which is the thing the test was always
  // trying to talk about, and is strictly stronger: it also catches a patch
  // that is lopsided for reasons the indices cannot express.
  //
  // Bounds are measured over every reachable round: the shipped chooser lands
  // between 1.00 and 2.00, all portrait. The upper bound leaves a little room;
  // the lower bound is what fails on a wide strip.
  for (const round of ROUNDS) {
    const rect = getChaosDifficulty(round);
    for (const type of CHAOS_SHAPES) {
      const { M, N } = chaosTilingPlan(rect, type);
      const { wUnits, hUnits } = buildTiling(type, M, N);
      const aspect = hUnits / wUnits;
      assert.ok(aspect >= 0.8 && aspect <= 2.2,
        `${type} round ${round}: ${M}x${N} renders ${wUnits.toFixed(1)}x${hUnits.toFixed(1)} units, `
        + `aspect ${aspect.toFixed(2)} — a ribbon`);
    }
  }
});

test('the ribbon guard is not vacuous: the strip that motivated it still fails', () => {
  // The 4.8.8 at M=3, N=13 — 63 cells hit exactly, and the shape that made the
  // original guard necessary. It must fail BOTH the aspect bound above and, now
  // that the phone cap exists, the cap itself.
  const strip = buildTiling('4.8.8', 3, 13);
  const aspect = strip.hUnits / strip.wUnits;
  assert.ok(aspect < 0.8, `the motivating strip should read as a ribbon, got aspect ${aspect.toFixed(2)}`);
  assert.ok(!boardFitsPhone('4.8.8', 3, 13), 'the motivating strip should also fail the phone cap');
});

test('a rectangular round produces no plan, leaving the existing path alone', () => {
  assert.equal(chaosTilingPlan(getChaosDifficulty(5), null), null);
  assert.equal(chaosTilingPlan(null, 'hex'), null);
  assert.equal(chaosTilingDims('hex', 60).cells > 0, true);
});

// ── The constraint the mode imposes ──────────────────────────────────────

test('every chaos lattice round generates fast enough to sit under a click', () => {
  // The whole reason two lattices are excluded. This is a wall-clock reading,
  // so the bar is generous — it is here to catch a shape or size that has
  // become catastrophically slow, not to police milliseconds.
  const BUDGET_MS = 2500;
  let worst = 0;
  let worstWhat = '';
  for (const round of [1, 5, 12, 20]) {
    const rect = getChaosDifficulty(round);
    for (const type of CHAOS_SHAPES) {
      const plan = chaosTilingPlan(rect, type);
      for (let k = 0; k < 2; k++) {
        const t0 = Date.now();
        const res = generateTilingBoard({
          type: plan.type, M: plan.M, N: plan.N, mines: plan.mines,
          seed: `chaostest:${round}:${type}:${k}`, gimmicks: [],
          openerIndex: (k * 7) % plan.cells,
          forceConstructive: plan.constructive === true,
        });
        const ms = Date.now() - t0;
        assert.ok(res, `${type} round ${round} seed ${k}: generation failed outright`);
        if (ms > worst) { worst = ms; worstWhat = `${type} round ${round}`; }
      }
    }
  }
  assert.ok(worst <= BUDGET_MS,
    `worst chaos generation was ${worst}ms (${worstWhat}), over the ${BUDGET_MS}ms budget`);
});

test('the opener is honoured, so the first click is where the player clicked', () => {
  // Chaos opens on the ACTUAL click, unlike every other tiling path, which
  // opens on the patch centre. If openerIndex were ignored, a player's first
  // click could be a mine.
  const plan = chaosTilingPlan(getChaosDifficulty(5), 'hex');
  for (const idx of [0, 7, 33]) {
    const res = generateTilingBoard({
      type: plan.type, M: plan.M, N: plan.N, mines: plan.mines,
      seed: `opener:${idx}`, gimmicks: [], openerIndex: idx,
      forceConstructive: plan.constructive === true,
    });
    assert.ok(res, `generation failed for opener ${idx}`);
    assert.equal(res.firstClick, idx);
    const r = Math.floor(idx / res.cols), c = idx % res.cols;
    assert.ok(!res.board[r][c].isMine, `the opener at ${idx} is a mine`);
    // And its neighbours are clear, so the click opens ground rather than a
    // lone number.
    for (const n of res.board._cellNeighbors[idx]) {
      assert.ok(!res.board[Math.floor(n / res.cols)][n % res.cols].isMine,
        `a neighbour of the opener at ${idx} is a mine`);
    }
  }
});
