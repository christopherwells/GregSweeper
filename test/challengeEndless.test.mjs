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
  ENDLESS_SPECS, endlessPpcFloor, endlessPpcAdmission, ENDLESS_START_LEVEL, ENDLESS_GEN_BUDGET_MS,
  ENDLESS_PAR_CEILING_SECONDS, GEN_CAP_MS, endlessPpcRange,
  ENDLESS_GEN_HEADROOM, endlessParCeiling, endlessGenCap, endlessGenBudget, ENDLESS_PPC_FLOOR,
  challengeSpecForLevel, endlessSpecForLevel, blockStartLevel,
} from '../src/logic/challenge250.js';
import { TILING_TYPES, buildTiling, containerIsStorable } from '../src/logic/tilingGeometry.js';

const SUMMIT = TIER_PPC[12];

// ── The pool ─────────────────────────────────────────────────────────────

const specKey = (s) => `${s.shape}|${s.rows != null ? `${s.rows}x${s.cols}` : `${s.M}x${s.N}`}|${s.mines}|${[...s.gimmicks].sort().join('+')}`;

test('every pool entry is a legal ladder spec at or above the summit', () => {
  assert.ok(ENDLESS_SPECS.length >= 20, `the pool is only ${ENDLESS_SPECS.length} entries deep`);
  for (const s of ENDLESS_SPECS) {
    // ABOVE THE POOL FLOOR, WITH MARGIN. The floor (3.5) sits deliberately
    // below the summit the escalation aims at (3.6): his ruling 2026-08-04,
    // drop it so more boards fit without making the first endless block
    // easier than the crown before it. A shape may carry its own floor where
    // it cannot reach the shared one on a board a phone can hold
    // (ENDLESS_PPC_FLOOR_BY_SHAPE, his 2026-08-07 ruling that every tiling
    // must be reachable in the endless zone).
    //
    // The margin exists because an entry stored at exactly the floor reads
    // under it on a smaller sample, and it is READ rather than restated. It
    // was a 1.02 literal here against the emitter's 1.03 and the nightly
    // re-price's bare floor, and two cairo entries in that band were admitted
    // by one, kept by another and refused by this on the same commit.
    const floor = endlessPpcFloor(s.shape);
    assert.ok(s.ppc >= endlessPpcAdmission(s.shape),
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

test('the pool carries all SEVEN shapes, Classic restored with the pre-generated endless', () => {
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
  // CLASSIC left on 2026-08-10 (the re-harden after that night's refit
  // dropped every rect entry on a worst-of-60 generation bar) and RETURNED
  // on 2026-08-11 with the pre-generated endless library — the exact
  // condition his parking ruling named. Two things changed, and the second
  // is the honest one: the endless play path deals pre-generated boards, so
  // runtime generation is only the fallback; and the harden was aligned
  // with the NORM reading of the generation cap (34bb136, already applied
  // by the validator and documented in challengeRules.js as the reading
  // whose absence was the mistake), under which six rect entries qualify on
  // medians of 165-523ms with no allowance granted. This pin is the flip
  // the 2026-08-10 comment said to make: all seven, deliberately.
  const shapes = new Set(ENDLESS_SPECS.map((s) => s.shape));
  for (const t of TILING_TYPES) {
    assert.ok(shapes.has(t), `the endless pool has no ${t} entry`);
  }
  assert.ok(shapes.has('rect'),
    'Classic left the endless pool again; if a refit dropped it, re-harden rect candidates (see challengePool.js\'s restore note)');
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



// ── The draw ─────────────────────────────────────────────────────────────

test('THE ZONE DOES NOT SCALE, and the whole pool is in play at every level', () => {
  // His ruling, 2026-08-07: "endless shouldn't need to scale. its just supposed
  // to be hard boards and variety and some can be terribly hard."
  //
  // It used to compound the summit rate per block and clamp to the pool's
  // ceiling, which made the zone LESS varied the longer it ran: measured over
  // L500-750, 250 levels drew 15 distinct specs and the worst repeated 50
  // times. That is his L65-70 complaint at sixteen times the severity. The
  // tests that pinned the climb were removed with it, deliberately and by
  // ruling rather than to get to green.
  const seen = new Set();
  for (let lv = ENDLESS_START_LEVEL; lv < ENDLESS_START_LEVEL + 400; lv++) {
    seen.add(specKey(endlessSpecForLevel(lv)));
  }
  const poolKeys = new Set(ENDLESS_SPECS.map(specKey));
  // Every proven spec must be reachable. A draw that could never offer part of
  // the pool is the thin-tail failure in another form.
  const unreachable = [...poolKeys].filter((k) => !seen.has(k));
  assert.deepEqual(unreachable, [],
    `${unreachable.length} pool entr(ies) are never drawn in 400 levels`);
});

test('the zone spans easy-for-a-summit to terribly hard, which is the point', () => {
  // "some can be terribly hard" is a property of the POOL's range now, not of
  // how far a player has climbed.
  const { lo, hi } = endlessPpcRange();
  assert.ok(hi / lo >= 1.5,
    `the pool spans only ${lo.toFixed(2)}-${hi.toFixed(2)} s/cell, which is not a range`);
  assert.ok(hi >= 5, `nothing in the pool is terribly hard (hardest ${hi.toFixed(2)} s/cell)`);
});

test('a long run does not grind the same few boards', () => {
  // The measurement that motivated the ruling, kept as a guard. The bar is set
  // against the pool's own size rather than a magic number: with no scaling,
  // every entry is drawable, so a 400-level run should touch most of them and
  // no single one should dominate.
  const counts = new Map();
  for (let lv = ENDLESS_START_LEVEL + 200; lv < ENDLESS_START_LEVEL + 600; lv++) {
    const k = specKey(endlessSpecForLevel(lv));
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const worst = Math.max(...counts.values());
  const fair = 400 / ENDLESS_SPECS.length;
  assert.ok(counts.size >= ENDLESS_SPECS.length * 0.8,
    `only ${counts.size} of ${ENDLESS_SPECS.length} specs appear in a 400-level stretch`);
  assert.ok(worst <= fair * 3,
    `one spec appears ${worst} times in 400 levels (fair share is ${fair.toFixed(1)})`);
});

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
  // Moved again on 2026-08-07 by his no-scaling ruling: with no difficulty
  // target there is no candidate window to rank against, so the draw reaches
  // the WHOLE pool and a different five come out.
  // Moved again on 2026-08-09 by the nightly re-price: the refit moved cairo's
  // equation 13.5%, seven of its entries crossed the 480s ceiling, and the
  // rebuild that followed changed which specs the deck deals. That is the
  // system working — a golden that moves when the model does is the point.
  // Moved on 2026-08-08 by the pool rewrite: the endless zone now draws
  // from the same stratified search the ladder does (a per-shape cap, so no
  // shape holds a third of it), and the per-level hash pick became a DEALT
  // DECK. Whole different pool, whole different draw.
  // Moved on 2026-08-10 by the refit-drift repair. The 2026-08-09 refit moved
  // DELTOIDAL's equation -26.6%, which put six of its endless entries under
  // the 3.5 floor along with a hex one; the re-price refuses to write while
  // any entry breaks a ruling, so the pool had been sitting on pre-refit
  // prices and main was red. Dropping the eight that left the rulings and
  // re-pricing is what let it write, and a smaller pool deals a different
  // five. Deltoidal keeps five endless entries, so the seven-shape rule still
  // holds — it is simply priced as an easier lattice than it was.
  // Moved again later on 2026-08-10 by the full re-harden after the same
  // night's refit landed on this branch: 27 of 47 entries survive the
  // worst-of-60 measurement under the new equations, and every rect entry
  // left on the generation-tail bar. He ruled Classic out of the live pool
  // until the pre-generated endless lands (see the shape test above); a
  // 20-entry-smaller pool deals a different five.
  // Moved on 2026-08-11 by Classic's restore: the pre-generated endless
  // landed and six rect entries re-entered under the norm-read harden (see
  // the shape test above), so the deck grew a rect queue and the fair
  // scheduler deals one into the first block.
  // Moved on 2026-08-13 by the slice-quota fix (#322) finally being applied:
  // a shape whose whole price range sits inside one slice could never reach
  // its per-shape allowance, so rhombille and deltoidal came out of the
  // emitter holding one entry each against hex's and floret's sixteen. The
  // top-up pass takes all six lattices to sixteen, which is a 32-entry pool
  // becoming a 95-entry one: whole different pool, whole different draw.
  //
  // Classic falls to two entries in the same pass, and that is the honest
  // reading rather than a regression to fix here: five of the six rect
  // entries the old pool shipped are marked ok:false in the search cache and
  // fail generation on re-measurement, surviving only because a harden pass
  // admitted them before that. Restoring Classic's depth is a targeted
  // search, not a re-shipped failure. The zone's PLAY path is unaffected
  // either way — it deals the pre-generated library, where rect holds 81
  // boards; this pool is the fallback braid behind it.
  assert.deepEqual(got, [
    '4.8.8:98c:34m:[liar+mirror+sonar]',
    'deltoidal:36c:13m:[locked]',
    'floret:96c:31m:[mystery+worm]',
    'rhombille:30c:10m:[locked+mirror+sonar]',
    'hex:110c:38m:[walls+sonar]',
  ]);


});

test('a block mixes its board shapes rather than repeating one', () => {
  // His ruling: mixed board lengths. The pool carries all six tilings
  // (Classic is parked out until the pre-generated endless), very
  // unevenly — rhombille reaches the admission floor on two boards where
  // cairo, floret and deltoidal reach it on sixteen each — so this is a real
  // bar rather than a formality. It is met by the DECK (proportional fair
  // scheduling, so every shape is spaced evenly across the whole cycle, and
  // the cycle is padded to a whole number of blocks so the windows never
  // drift on a wrap) plus the emitter's per-shape cap. Every greedy deck rule
  // tried before that left a two-shape block within 400 blocks.
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


test('every drawn spec is an actual pool entry', () => {
  // The draw must never synthesise a spec: an unproven board is the one
  // thing the pool architecture exists to prevent.
  const key = (s) => `${s.shape}:${s.cells}:${s.mines}:${s.gimmicks.join('+')}:${s.gimmickLevel || ''}`;
  const pool = new Set(ENDLESS_SPECS.map(key));
  for (let lv = ENDLESS_START_LEVEL; lv <= ENDLESS_START_LEVEL + 400; lv += 7) {
    assert.ok(pool.has(key(endlessSpecForLevel(lv))), `L${lv} drew a spec that is not in the pool`);
  }
});
