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
  ENDLESS_SPECS, endlessPpcFloor, ENDLESS_START_LEVEL, ENDLESS_PPC_GROWTH, ENDLESS_GEN_BUDGET_MS,
  ENDLESS_PAR_CEILING_SECONDS, GEN_CAP_MS, ENDLESS_VARIETY_MAX_RATIO,
  ENDLESS_GEN_HEADROOM, endlessParCeiling, endlessGenCap, endlessGenBudget, ENDLESS_PPC_FLOOR,
  challengeSpecForLevel, endlessSpecForLevel, endlessTargetPpc, blockStartLevel,
} from '../src/logic/challenge250.js';
import { TILING_TYPES, buildTiling, containerIsStorable } from '../src/logic/tilingGeometry.js';

const SUMMIT = TIER_PPC[12];

// ── The pool ─────────────────────────────────────────────────────────────

test('every pool entry is a legal ladder spec at or above the summit', () => {
  assert.ok(ENDLESS_SPECS.length >= 20, `the pool is only ${ENDLESS_SPECS.length} entries deep`);
  for (const s of ENDLESS_SPECS) {
    // Above the floor WITH MARGIN. The summit is a floor by ruling, and an
    // entry stored at exactly 3.60 reads under it on a smaller sample — the
    // validator caught two rect entries doing exactly that at 5 seeds.
    // Above the POOL FLOOR with margin. The floor (3.5) is deliberately below
    // the summit the escalation aims at (3.6): his ruling 2026-08-04, drop it
    // so more boards fit, without making the first endless block easier than
    // the crown before it. The margin is because an entry stored at exactly
    // the floor reads under it on a smaller sample.
    // A shape may carry its own floor where it cannot reach the shared one on
    // a board a phone can hold (ENDLESS_PPC_FLOOR_BY_SHAPE — his 2026-08-07
    // ruling that every tiling must be reachable in the endless zone).
    const floor = endlessPpcFloor(s.shape);
    assert.ok(s.ppc >= floor * 1.02,
      `${s.shape}: ppc ${s.ppc} sits on its ${floor} floor with no margin`);
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

test('the pool carries all seven board shapes', () => {
  // "Mixed board lengths" is his wording, and a pool missing a shape would
  // quietly retire it from the back half of the game. Three shapes needed a
  // per-shape allowance to get here, each for a measured reason:
  //
  //   - CLASSIC and PAVING STONES price so gently that reaching 3.6 s/cell
  //     takes ~150 cells, and 150 cells at that rate IS ten minutes. Their
  //     boards measured 557-601s against a 600s ceiling, so they cleared the
  //     summit ruling and not the headroom. His ruling: +2 minutes each.
  //   - 3D CUBES was never about the ceiling — its qualifying boards price
  //     222-464s, comfortably under. Its certifier has no Pass B and leans on
  //     Pass C for every board, so it measured 2.1-9.8s against the 2-second
  //     generation cap. His ruling: 3.5 seconds for that shape.
  //   - PAVING STONES is the one shape carrying its own admission floor. The
  //     phone cap's proportion rule caps it at 112 cells, where its hardest
  //     stack reaches ppc 3.52 — over the shared floor, but on one stack
  //     only. His ruling 2026-08-07: EVERY tiling must be available here, and
  //     its top decile is enough to earn that. See
  //     ENDLESS_PPC_FLOOR_BY_SHAPE.
  //
  // Every shape must be present. This is the assertion his ruling turns into
  // a hard requirement rather than a preference.
  const shapes = new Set(ENDLESS_SPECS.map((s) => s.shape));
  for (const t of ['rect', ...TILING_TYPES]) {
    assert.ok(shapes.has(t), `the endless pool has no ${t} entry`);
  }
});

test('the per-shape allowances are the ruled ones, and apply only where ruled', () => {
  // Each allowance is a deliberate exception to a ruling, so it must not
  // spread by accident to a shape that never needed it.
  assert.equal(endlessParCeiling('rect'), 720, 'Classic: +2 minutes');
  assert.equal(endlessParCeiling('cairo'), 720, 'Paving Stones: +2 minutes');
  assert.equal(endlessParCeiling('floret'), 660, 'Petals: +1 minute (his 2026-08-04 call)');
  for (const t of ['hex', '4.8.8', 'deltoidal', 'rhombille']) {
    assert.equal(endlessParCeiling(t), ENDLESS_PAR_CEILING_SECONDS,
      `${t} keeps the standard ten-minute ceiling`);
  }

  assert.equal(endlessGenCap('rhombille'), 3500, '3D Cubes: 3.5 seconds');
  // Paving Stones joined on 2026-08-06, his ruling that the budget "can be 3
  // if it means we get diversity": the phone cap moved its endless boards to
  // 13x7, the only legal patch that reaches the summit rate, and those cost
  // 1709-2184ms to generate.
  assert.equal(endlessGenCap('cairo'), 3000, 'Paving Stones: 3 seconds');
  for (const t of ['rect', 'hex', '4.8.8', 'floret', 'deltoidal']) {
    assert.equal(endlessGenCap(t), GEN_CAP_MS, `${t} keeps the standard generation cap`);
  }

  // And the admission budget tracks whatever cap applies, rather than being
  // a second constant that can drift away from it.
  for (const t of ['rect', 'rhombille']) {
    assert.equal(endlessGenBudget(t), endlessGenCap(t) * ENDLESS_GEN_HEADROOM);
  }
});

test('the admission budget keeps real margin under the generation cap', () => {
  // The cap is his ruling; the budget is judgement. It must actually be a
  // margin, or the pool has none of the headroom the comment claims.
  assert.ok(ENDLESS_GEN_BUDGET_MS < GEN_CAP_MS,
    'the pool budget must sit under the ladder cap');
  assert.ok(ENDLESS_GEN_HEADROOM <= 0.8,
    `${ENDLESS_GEN_HEADROOM} is not a meaningful margin`);
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
  // Moved wholesale on 2026-08-06 by the phone cap (boardFit): six 9x9 cairo
  // entries left the pool for two 13x7 ones higher up the climb, two deltoidal
  // 4x2 entries became 3x3, and every 7x8 4.8.8 turned into an 8x7. The draw
  // reads a different pool, so a different five come out.
  // Moved again on 2026-08-07: the phone cap grew a proportion rule (no tall
  // ribbons), which retired the 4.8.8's 150-cell and cairo's 162-cell boards,
  // and Paving Stones came back on its own admission floor. Different pool,
  // different five.
  assert.deepEqual(got, [
    'cairo:110c:26m:[locked+sonar+walls]',
    'deltoidal:36c:10m:[sonar+walls]',
    '4.8.8:72c:29m:[wormhole+locked]',
    'rect:144c:58m:[locked+liar]',
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
    // At least four distinct, and five whenever the candidate window holds
    // five. The bar dropped from "always five" when a refit re-priced the
    // pool and thinned Classic and 3D Cubes to one entry each: a shape with
    // a single entry can only join a block whose window happens to reach it.
    // Measured on the shipped pool: 5 shapes in 22 of 80 blocks, 4 in the
    // rest, never fewer.
    assert.ok(new Set(shapes).size >= 4,
      `block at L${start} used ${new Set(shapes).size} shapes: ${shapes.join(', ')}`);
    assert.ok(poolShapes >= 4, 'the pool must carry at least four shapes');
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
