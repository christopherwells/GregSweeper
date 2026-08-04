// The endless zone (Challenge blocks 51+).
//
// His ruling: past L250 the ladder is endless and UNBOUNDED above the T12
// summit (3.6 s/cell) — any certified spec at or past it, mixed board
// lengths, checkpoints every five banked forever, max level as the brag
// stat, par ceiling lifted to ten minutes, 2-second generation cap standing.
//
// The zone is a PROVEN POOL plus a deterministic per-level draw. This file
// pins the parts that are decisions rather than measurements: the pool's own
// legality, the escalation's shape, the draw's determinism, and the boundary
// with the authored ladder. The measurements themselves (does each entry
// certify, in budget, under the ceiling) belong to
// scripts/validate-challenge250-specs.mjs, which re-times every entry.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHALLENGE_MAX_LEVEL, CHALLENGE_BLOCK_SIZE, TIER_PPC,
  ENDLESS_SPECS, ENDLESS_START_LEVEL, ENDLESS_PPC_GROWTH, ENDLESS_GEN_BUDGET_MS,
  ENDLESS_PAR_CEILING_SECONDS, GEN_CAP_MS, ENDLESS_VARIETY_MAX_RATIO,
  challengeSpecForLevel, endlessSpecForLevel, endlessTargetPpc, blockStartLevel,
} from '../src/logic/challenge250.js';
import { TILING_TYPES, buildTiling, containerIsStorable } from '../src/logic/tilingGeometry.js';

const SUMMIT = TIER_PPC[12];

// ── The pool ─────────────────────────────────────────────────────────────

test('every pool entry is a legal ladder spec at or above the summit', () => {
  assert.ok(ENDLESS_SPECS.length >= 20, `the pool is only ${ENDLESS_SPECS.length} entries deep`);
  for (const s of ENDLESS_SPECS) {
    assert.ok(s.ppc >= SUMMIT, `${s.shape}: ppc ${s.ppc} is below the ${SUMMIT} summit floor`);
    assert.ok(Number.isInteger(s.mines) && s.mines > 0, `${s.shape}: bad mine count`);
    assert.ok(Number.isInteger(s.cells) && s.cells > 0, `${s.shape}: bad cell count`);

    // Pressure plates and mineShift are Chaos-only and retire from the
    // ladder; the endless zone is still the ladder.
    for (const g of s.gimmicks) {
      assert.ok(g !== 'pressurePlate' && g !== 'mineShift',
        `${s.shape}: '${g}' is chaos-only and must never reach the ladder`);
    }

    if (s.shape === 'rect') {
      assert.equal(s.rows * s.cols, s.cells, 'a rect spec must agree with its own dimensions');
    } else {
      assert.ok(TILING_TYPES.includes(s.shape), `unknown shape '${s.shape}'`);
      // The declared cell count must be the lattice's real one: buildTiling
      // falls through to the 4.8.8 on an unknown type, so a wrong count is
      // how a spec silently describes a different board.
      assert.equal(buildTiling(s.shape, s.M, s.N).total, s.cells,
        `${s.shape} ${s.M}x${s.N}: declared ${s.cells} cells`);
    }
    // A prime cell count forces a 1xN container the canonical rules reject.
    // Challenge boards are never stored, but a spec that cannot be stored is
    // one that cannot be reused for a daily or a lab board later.
    assert.ok(containerIsStorable(s.cells), `${s.shape}: ${s.cells} cells is not a storable container`);
  }
});

test('the pool carries four shapes, and the other three are measured exclusions', () => {
  // "Mixed board lengths" is his wording, and four of the seven shapes carry
  // it. The other three are absent for MEASURED reasons rather than
  // oversight, and all three are the same squeeze between two of his rulings
  // — "unbounded above 3.6 s/cell" and "the par ceiling lifts to ten
  // minutes" — which for a gently-priced shape intersect in a sliver:
  //
  //   - CLASSIC and PAVING STONES price so gently that reaching 3.6 s/cell
  //     takes ~150 cells, and 150 cells at that rate IS ten minutes. Their
  //     qualifying boards measure 564-596s against a 600s ceiling, so they
  //     clear the ruling but not the headroom admission needs (see the pool's
  //     own note: a median par moves about +/-30s between seed samples, so an
  //     entry measured at 595s fails validation on different seeds).
  //   - 3D CUBES is squeezed the other way: big enough to reach the summit
  //     rate and its generation blows the budget (2.1s to 9.8s measured),
  //     small enough to generate fast and it cannot reach the rate at all
  //     (0 of 96 candidates from 36 to 75 cells cleared 3.6, while only 5 of
  //     those failed on time). Its certifier has no Pass B and leans on Pass
  //     C enumeration for every board, which CLAUDE.md already prices at two
  //     orders of magnitude above the 4.8.8.
  //
  // The consequence is real and is Christopher's to weigh rather than mine:
  // a player past L250 sees Octagons, Honeycomb, Petals and Kites, and never
  // a Classic board again. Widening it means moving one of the two rulings.
  const shapes = new Set(ENDLESS_SPECS.map((s) => s.shape));
  for (const t of ['hex', '4.8.8', 'floret', 'deltoidal']) {
    assert.ok(shapes.has(t), `the endless pool has no ${t} entry`);
  }
  // Asserted absences, so a shape sneaking back in is a decision rather than
  // a surprise: if one now qualifies, delete its line AND the note above.
  for (const t of ['rect', 'cairo', 'rhombille']) {
    assert.ok(!shapes.has(t), `${t} entered the endless pool — update the note above`);
  }
});

test('the admission budget keeps real margin under the generation cap', () => {
  // The cap is his ruling; the budget is judgement. It must actually be a
  // margin, or the pool has none of the headroom the comment claims.
  assert.ok(ENDLESS_GEN_BUDGET_MS < GEN_CAP_MS,
    'the pool budget must sit under the ladder cap');
  assert.ok(ENDLESS_GEN_BUDGET_MS <= GEN_CAP_MS * 0.8,
    `${ENDLESS_GEN_BUDGET_MS}ms is not a meaningful margin under ${GEN_CAP_MS}ms`);
  assert.ok(ENDLESS_PAR_CEILING_SECONDS === 600, 'his ruling: ten minutes in the endless zone');
});

// ── The boundary with the authored ladder ────────────────────────────────

test('the crown is authored and the level after it is endless', () => {
  assert.equal(ENDLESS_START_LEVEL, CHALLENGE_MAX_LEVEL + 1);

  const crown = challengeSpecForLevel(CHALLENGE_MAX_LEVEL);
  assert.ok(!crown.endless, 'L250 is the authored crown, not an endless draw');
  assert.equal(crown.block, 50);

  const first = challengeSpecForLevel(ENDLESS_START_LEVEL);
  assert.equal(first.endless, true, 'L251 must come from the endless pool');
  assert.equal(first.block, 51);
});

test('REGRESSION: nothing clamps at the crown any more', () => {
  // Before the endless zone landed, challengeSpecForLevel and blockStartLevel
  // both clamped to CHALLENGE_MAX_LEVEL, so L300 played the L250 crown and
  // banked the L246 checkpoint. Both must now be unbounded.
  assert.notDeepEqual(challengeSpecForLevel(300), challengeSpecForLevel(CHALLENGE_MAX_LEVEL));
  assert.equal(blockStartLevel(300), 296);
  assert.equal(blockStartLevel(1000), 996);
  assert.equal(blockStartLevel(251), 251);
  // And checkpoints keep landing every five, forever.
  for (const lv of [251, 255, 256, 300, 999, 1000, 5000]) {
    assert.equal((blockStartLevel(lv) - 1) % CHALLENGE_BLOCK_SIZE, 0,
      `checkpoint for L${lv} is not on a five-boundary`);
  }
});

test('levels below 1 still clamp to 1', () => {
  assert.equal(challengeSpecForLevel(0).level, 1);
  assert.equal(challengeSpecForLevel(-5).level, 1);
  assert.equal(blockStartLevel(0), 1);
});

// ── Escalation ───────────────────────────────────────────────────────────

test('the target climbs from the summit and clamps at what the pool holds', () => {
  const poolMax = Math.max(...ENDLESS_SPECS.map((s) => s.ppc));
  assert.equal(endlessTargetPpc(ENDLESS_START_LEVEL), SUMMIT,
    'the first endless block starts exactly at the summit');

  let prev = 0;
  for (let lv = ENDLESS_START_LEVEL; lv <= 3000; lv += CHALLENGE_BLOCK_SIZE) {
    const t = endlessTargetPpc(lv);
    assert.ok(t >= prev - 1e-9, `target fell from ${prev} to ${t} at L${lv}`);
    assert.ok(t <= poolMax + 1e-9, `target ${t} at L${lv} exceeds the pool's ${poolMax}`);
    prev = t;
  }
  assert.equal(prev, poolMax, 'the climb must eventually reach the pool ceiling');

  // The whole block shares one target — the block is the difficulty step.
  const start = 296;
  for (let i = 0; i < CHALLENGE_BLOCK_SIZE; i++) {
    assert.equal(endlessTargetPpc(start + i), endlessTargetPpc(start));
  }
  assert.ok(ENDLESS_PPC_GROWTH > 1, 'the zone must actually escalate');
});

test('the climb is gradual rather than jumping to the ceiling', () => {
  // A growth rate that reached the top in two blocks would make the pool's
  // whole low end dead weight. Ten blocks past the crown must still be
  // meaningfully below the ceiling.
  const poolMax = Math.max(...ENDLESS_SPECS.map((s) => s.ppc));
  const tenBlocksIn = endlessTargetPpc(ENDLESS_START_LEVEL + 10 * CHALLENGE_BLOCK_SIZE);
  assert.ok(tenBlocksIn < poolMax * 0.85,
    `ten blocks in the target is already ${tenBlocksIn.toFixed(2)} of ${poolMax}`);
});

// ── The draw ─────────────────────────────────────────────────────────────

test('the spec for a level is deterministic, which is what makes max level a brag stat', () => {
  // The BOARD varies per attempt (challengeBoardSeed carries per-draw
  // entropy). The SPEC must not, or two players at level 400 are not
  // comparable and the number stops meaning anything.
  for (const lv of [251, 260, 313, 500, 977, 2500]) {
    const a = endlessSpecForLevel(lv);
    const b = endlessSpecForLevel(lv);
    assert.deepEqual(a, b, `L${lv} drew differently on a second call`);
    assert.deepEqual(challengeSpecForLevel(lv), a, `challengeSpecForLevel disagrees at L${lv}`);
    assert.equal(a.level, lv);
  }
});

test('GOLDEN: the first endless block is fixed', () => {
  // Break-tested: changing the hash, the candidate window, or the pool's
  // order moves these. They are here so such a change is a decision rather
  // than a surprise.
  const got = [];
  for (let i = 0; i < CHALLENGE_BLOCK_SIZE; i++) {
    const s = endlessSpecForLevel(ENDLESS_START_LEVEL + i);
    got.push(`${s.shape}:${s.cells}c:${s.mines}m:[${s.gimmicks.join('+')}]`);
  }
  assert.deepEqual(got, [
    'hex:72c:31m:[compass+walls]',
    'floret:54c:20m:[sonar+liar+walls]',
    'deltoidal:36c:12m:[mystery+locked]',
    '4.8.8:98c:30m:[wormhole+compass+locked]',
    'hex:110c:37m:[worm+walls]',
  ]);
});

test('a block mixes its board shapes rather than repeating one', () => {
  // His ruling: mixed board lengths. The pool carries four shapes, and every
  // block of five uses all four — measured on 80 consecutive blocks. That is
  // a real bar rather than a formality: the pool is not uniform across
  // difficulty (only floret and deltoidal reach past about 6 s/cell), so a
  // draw ranked on price alone collapses to two shapes at the top of the
  // climb, which is what ENDLESS_VARIETY_MAX_RATIO exists to prevent.
  const poolShapes = new Set(ENDLESS_SPECS.map((s) => s.shape)).size;
  for (let b = 0; b < 80; b++) {
    const start = ENDLESS_START_LEVEL + b * CHALLENGE_BLOCK_SIZE;
    const shapes = [];
    for (let i = 0; i < CHALLENGE_BLOCK_SIZE; i++) shapes.push(endlessSpecForLevel(start + i).shape);
    assert.equal(new Set(shapes).size, Math.min(poolShapes, CHALLENGE_BLOCK_SIZE),
      `block at L${start} used ${new Set(shapes).size} shapes: ${shapes.join(', ')}`);
  }
});

test('a drawn spec stays near its block target', () => {
  // The draw picks among the nearest-priced entries, and reaches further only
  // to satisfy the variety rule — bounded, so a block at the top of the climb
  // can never reach back down to the summit for the sake of a new shape.
  // Measured worst on the shipped pool: 1.89x, either direction.
  for (let lv = ENDLESS_START_LEVEL; lv <= ENDLESS_START_LEVEL + 400; lv++) {
    const s = endlessSpecForLevel(lv);
    const ratio = Math.max(s.ppc / s.targetPpc, s.targetPpc / s.ppc);
    assert.ok(ratio <= ENDLESS_VARIETY_MAX_RATIO + 1e-9,
      `L${lv}: ppc ${s.ppc} against target ${s.targetPpc.toFixed(2)} (ratio ${ratio.toFixed(2)})`);
  }
});

test('every drawn spec is an actual pool entry', () => {
  // The draw must never synthesise a spec: an unproven board is the one
  // thing the pool architecture exists to prevent.
  const key = (s) => `${s.shape}:${s.cells}:${s.mines}:${s.gimmicks.join('+')}:${s.gimmickLevel || ''}`;
  const pool = new Set(ENDLESS_SPECS.map(key));
  for (let lv = ENDLESS_START_LEVEL; lv <= ENDLESS_START_LEVEL + 400; lv += 7) {
    assert.ok(pool.has(key(endlessSpecForLevel(lv))), `L${lv} drew a spec that is not in the pool`);
  }
});
