// Challenge 250 spec-table pins — the 50-block map (CHALLENGE_250_MAP.md,
// Christopher's 2026-08-03 rulings) frozen as structure tests, so a table
// edit that drifts from the map fails loudly. Generation/pricing proof
// lives in scripts/validate-challenge250-specs.mjs (the 2s cap is a
// measurement, not a unit test); this file pins what the table CLAIMS.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHALLENGE_MAX_LEVEL, CHALLENGE_BLOCK_SIZE, CHALLENGE_BLOCK_COUNT,
  CHALLENGE_BLOCKS, TIER_PPC, challengeSpecForLevel, blockStartLevel,
  ppcBandFor, specFingerprint, OPENER_MIN_DEDUCTIONS,
  MOD_INTRO_BLOCKS, SHAPE_INTRO_BLOCKS,
} from '../src/logic/challenge250.js';
import { buildTiling } from '../src/logic/tilingGeometry.js';
import { generateTilingBoard, TILING_SAFE_GIMMICKS } from '../src/logic/tilingGenerator.js';
import { buildChallenge250Board, challengeBoardSeed } from '../src/logic/challenge250Builder.js';

const LADDER_MODIFIERS = ['walls', 'liar', 'mystery', 'locked', 'wormhole', 'mirror', 'sonar', 'compass', 'worm'];
const LAVES = ['cairo', 'floret', 'rhombille', 'deltoidal'];

const allSpecs = [];
for (let lv = 1; lv <= CHALLENGE_MAX_LEVEL; lv++) allSpecs.push(challengeSpecForLevel(lv));

test('ladder structure: 250 levels, 50 blocks of 5, clamped accessors', () => {
  assert.equal(CHALLENGE_MAX_LEVEL, 250);
  assert.equal(CHALLENGE_BLOCK_SIZE, 5);
  assert.equal(CHALLENGE_BLOCK_COUNT, 50);
  assert.equal(CHALLENGE_BLOCKS.length, 50);
  for (let lv = 1; lv <= 250; lv++) {
    const spec = challengeSpecForLevel(lv);
    assert.equal(spec.level, lv);
    assert.equal(spec.block, Math.floor((lv - 1) / 5) + 1);
  }
  // Clamps mirror the old ladder's past-MAX behavior until endless lands.
  assert.equal(challengeSpecForLevel(0).level, 1);
  assert.equal(challengeSpecForLevel(999).level, 250);
  assert.equal(blockStartLevel(1), 1);
  assert.equal(blockStartLevel(25), 21);
  assert.equal(blockStartLevel(26), 26);
  assert.equal(blockStartLevel(250), 246);
});

test('tier ladder anchors are the adopted numbers (T1 0.55 → T12 3.60)', () => {
  assert.deepEqual(TIER_PPC, {
    1: 0.55, 2: 0.65, 3: 0.75, 4: 0.90, 5: 1.05, 6: 1.25,
    7: 1.50, 8: 1.80, 9: 2.15, 10: 2.55, 11: 2.90, 12: 3.60,
  });
});

test('block → tier/shape table matches the map', () => {
  const expected = [
    // [block, tier, shape]
    [1, 1, 'rect'], [2, 1, 'rect'], [3, 2, 'rect'], [4, 2, 'rect'], [5, 3, 'rect'],
    [6, 2, 'hex'], [7, 3, 'hex'], [8, 3, 'rect'], [9, 3, '4.8.8'], [10, 4, '4.8.8'],
    [11, 4, 'hex'], [12, 4, 'rhombille'], [13, 5, 'rhombille'], [14, 5, 'rect'], [15, 5, 'cairo'],
    [16, 6, 'cairo'], [17, 6, '4.8.8'], [18, 6, 'rhombille'], [19, 7, '4.8.8'], [20, 7, 'rect'],
    [21, 7, 'floret'], [22, 8, 'hex'], [23, 8, 'cairo'], [24, 8, 'floret'], [25, 8, 'rhombille'],
    [26, 9, 'rect'], [27, 9, 'hex'], [28, 9, 'rhombille'], [29, 9, '4.8.8'], [30, 9, 'rhombille'],
    [31, 10, 'hex'], [32, 10, 'floret'], [33, 10, 'rect'], [34, 10, 'floret'], [35, 10, 'cairo'],
    [36, 11, 'hex'], [37, 11, 'floret'], [38, 9, 'deltoidal'], [39, 11, 'deltoidal'], [40, 11, 'rect'],
    [41, 11, 'rhombille'], [42, 12, '4.8.8'], [43, 12, 'cairo'], [44, 12, 'deltoidal'], [45, 12, 'hex'],
    [46, 12, 'rect'], [47, 12, 'mixed'], [48, 12, 'gauntlet'], [49, 12, 'gauntlet'], [50, 12, 'gauntlet'],
  ];
  for (const [block, tier, shape] of expected) {
    const b = CHALLENGE_BLOCKS[block - 1];
    assert.equal(b.block, block);
    assert.equal(b.tier, tier, `block ${block} tier`);
    assert.equal(b.shape, shape, `block ${block} shape`);
  }
});

test('plateau targets: non-dip braid blocks sit AT their tier anchor; dips sit at the shape floor', () => {
  const dips = CHALLENGE_BLOCKS.filter((b) => b.dip).map((b) => b.block);
  assert.deepEqual(dips, [6, 9, 12, 15, 21, 38]);
  for (const b of CHALLENGE_BLOCKS) {
    if (b.ppc === null) { assert.ok(b.block <= 5, `only openers skip ppc (block ${b.block})`); continue; }
    if (b.dip) {
      // A dip prices at the shape's gentlest proven config. Cubes' floor
      // (0.98) sits a hair ABOVE its T4 label — the map's own note — so
      // the pin is "within the label tier's band ceiling or below".
      assert.ok(b.ppc <= TIER_PPC[b.tier] * 1.11, `dip block ${b.block} above its label band`);
    } else {
      assert.equal(b.ppc, TIER_PPC[b.tier], `block ${b.block} off its tier anchor`);
    }
  }
});

test('shape intros: 6/9/12/15/21/38, plain with a fifth-level tease', () => {
  const intros = [
    [6, 'hex', 'walls'], [9, '4.8.8', 'mystery'], [12, 'rhombille', 'liar'],
    [15, 'cairo', 'locked'], [21, 'floret', 'walls'], [38, 'deltoidal', 'mystery'],
  ];
  for (const [block, shape, tease] of intros) {
    const specs = allSpecs.filter((s) => s.block === block);
    for (let i = 0; i < 4; i++) {
      assert.equal(specs[i].shape, shape);
      assert.equal(specs[i].gimmicks.length, 0, `block ${block} L${i + 1} must be plain`);
    }
    assert.deepEqual(specs[4].gimmicks, [tease], `block ${block} tease`);
  }
});

test('modifier intro venues match the map', () => {
  const intros = [
    [2, 'walls', 'rect'], [3, 'liar', 'rect'], [4, 'mystery', 'rect'],
    [7, 'locked', 'hex'], [10, 'wormhole', '4.8.8'], [13, 'mirror', 'rhombille'],
    [16, 'sonar', 'cairo'], [19, 'compass', '4.8.8'], [22, 'worm', 'hex'],
  ];
  for (const [block, mod, shape] of intros) {
    const specs = allSpecs.filter((s) => s.block === block);
    for (const s of specs) {
      assert.equal(s.shape, shape, `block ${block} venue`);
      assert.deepEqual(s.gimmicks, [mod], `block ${block} carries only its intro modifier`);
    }
  }
});

test('the five reprises sit where the map placed them', () => {
  const reprises = [
    [25, 'wormhole', 'rhombille'], [28, 'sonar', 'rhombille'],
    [31, 'compass', 'hex'], [34, 'worm', 'floret'], [37, 'compass', 'floret'],
  ];
  for (const [block, mod, shape] of reprises) {
    const specs = allSpecs.filter((s) => s.block === block);
    for (const s of specs) {
      assert.equal(s.shape, shape, `reprise block ${block} shape`);
      assert.deepEqual(s.gimmicks, [mod], `reprise block ${block} is single-modifier`);
    }
  }
});

test('stacks reach 3 only from block 40; never more than 3', () => {
  let sawTriple = false;
  for (const s of allSpecs) {
    assert.ok(s.gimmicks.length <= 3, `L${s.level} stacks past 3`);
    if (s.gimmicks.length === 3) {
      assert.ok(s.block >= 40, `3-stack before block 40 (L${s.level})`);
      sawTriple = true;
    }
  }
  assert.ok(sawTriple, 'the 3-stack debut exists');
  assert.ok(allSpecs.filter((s) => s.block === 40).some((s) => s.gimmicks.length === 3),
    'block 40 is the 3-stack debut');
});

test('pressure plates and mineShift never appear on the ladder', () => {
  for (const s of allSpecs) {
    assert.ok(!s.gimmicks.includes('pressurePlate'), `L${s.level} carries a plate`);
    assert.ok(!s.gimmicks.includes('mineShift'), `L${s.level} carries mineShift`);
    for (const g of s.gimmicks) {
      assert.ok(LADDER_MODIFIERS.includes(g), `L${s.level} unknown modifier ${g}`);
    }
  }
});

test('gauntlet blocks run the mapped shape orders; L250 is the 3-stacked Kites crown', () => {
  const b48 = allSpecs.filter((s) => s.block === 48).map((s) => s.shape);
  const b49 = allSpecs.filter((s) => s.block === 49).map((s) => s.shape);
  const b50 = allSpecs.filter((s) => s.block === 50).map((s) => s.shape);
  assert.deepEqual(b48, ['rect', 'hex', '4.8.8', 'cairo', 'rhombille']);
  assert.deepEqual(b49, ['floret', 'deltoidal', 'rect', 'rhombille', 'cairo']);
  const summit = new Set([...b48, ...b49, ...b50]);
  assert.equal(summit.size, 7, 'all seven shapes appear across the summit trio');
  const crown = challengeSpecForLevel(250);
  assert.equal(crown.shape, 'deltoidal');
  assert.equal(crown.gimmicks.length, 3, 'the crown is 3-stacked');
});

test('opener blocks are rect-only with the deduction floor; the braid never carries it', () => {
  for (const s of allSpecs) {
    if (s.block <= 5) {
      assert.equal(s.shape, 'rect', `opener L${s.level} must be Classic`);
      assert.equal(s.minDeductions, OPENER_MIN_DEDUCTIONS, `opener L${s.level} floor`);
      assert.equal(s.ppc, null);
      assert.equal(ppcBandFor(s), null);
    } else {
      assert.equal(s.minDeductions, undefined, `braid L${s.level} must not carry the opener floor`);
      assert.ok(s.ppc > 0);
      const band = ppcBandFor(s);
      assert.ok(band[0] < s.ppc && s.ppc < band[1]);
    }
  }
});

test('pinned cell counts match buildTiling; rect cells are rows×cols', () => {
  const seen = new Set();
  for (const s of allSpecs) {
    if (s.shape === 'rect') {
      assert.equal(s.cells, s.rows * s.cols);
      continue;
    }
    const key = `${s.shape}:${s.M}x${s.N}`;
    if (seen.has(key)) continue;
    seen.add(key);
    assert.equal(buildTiling(s.shape, s.M, s.N).total, s.cells,
      `${key} pinned cells drifted from the builder`);
  }
});

test('static par sanity: authored target × cells stays inside the 8-minute ceiling', () => {
  for (const s of allSpecs) {
    if (s.ppc == null) continue;
    assert.ok(s.ppc * s.cells <= 480, `L${s.level} targets past the ceiling (${(s.ppc * s.cells).toFixed(0)}s)`);
  }
});

test('every ladder modifier appears again after its intro block', () => {
  const introBlock = {
    walls: 2, liar: 3, mystery: 4, locked: 7, wormhole: 10,
    mirror: 13, sonar: 16, compass: 19, worm: 22,
  };
  for (const [mod, intro] of Object.entries(introBlock)) {
    const later = allSpecs.some((s) => s.block > intro && s.gimmicks.includes(mod));
    assert.ok(later, `${mod} never returns after its intro`);
  }
});

test('gimmick vocabulary and dials: tiling mods are tiling-safe, gimmickLevel stays in old-ladder units', () => {
  for (const s of allSpecs) {
    if (s.gimmicks.length > 0) {
      assert.ok(s.gimmickLevel >= 11 && s.gimmickLevel <= 120,
        `L${s.level} gimmickLevel ${s.gimmickLevel} outside old-ladder units`);
    }
    if (s.shape !== 'rect') {
      for (const g of s.gimmicks) {
        assert.ok(TILING_SAFE_GIMMICKS.includes(g), `L${s.level} ${g} not tiling-safe`);
      }
      assert.equal(s.wallSegments, undefined, 'wallSegments is a rect-only dial');
    } else if (s.gimmicks.includes('walls')) {
      assert.ok(s.wallSegments >= 1, `rect walls spec L${s.level} needs wallSegments`);
    }
  }
});

test('sub-threshold Laves specs route constructive', () => {
  for (const s of allSpecs) {
    if (s.shape === 'rect' || !LAVES.includes(s.shape)) continue;
    const density = s.mines / s.cells;
    if (density < 0.22) {
      assert.equal(s.constructive, true,
        `L${s.level} ${s.shape} at ${(density * 100).toFixed(1)}% needs constructive: true`);
    }
  }
});

test('tiers never step down across blocks except at the six intro dips', () => {
  for (let b = 2; b <= 50; b++) {
    const prev = CHALLENGE_BLOCKS[b - 2];
    const cur = CHALLENGE_BLOCKS[b - 1];
    if (cur.dip) continue;
    // The block after a dip returns to the line; compare against the last
    // non-dip block's tier.
    let back = b - 2;
    while (back >= 0 && CHALLENGE_BLOCKS[back].dip) back--;
    const anchor = back >= 0 ? CHALLENGE_BLOCKS[back].tier : prev.tier;
    assert.ok(cur.tier >= anchor, `block ${b} steps the plateau down (T${cur.tier} after T${anchor})`);
  }
});

test('the intro-block exports match the levels table (checkpoint labels read these)', () => {
  assert.deepEqual(MOD_INTRO_BLOCKS, {
    2: 'walls', 3: 'liar', 4: 'mystery', 7: 'locked', 10: 'wormhole',
    13: 'mirror', 16: 'sonar', 19: 'compass', 22: 'worm',
  });
  assert.deepEqual(SHAPE_INTRO_BLOCKS, {
    6: 'hex', 9: '4.8.8', 12: 'rhombille', 15: 'cairo', 21: 'floret', 38: 'deltoidal',
  });
  // Cross-pin against the specs themselves: a mod-intro block's levels all
  // carry exactly that modifier; a shape-intro block is that shape's dip.
  for (const [block, mod] of Object.entries(MOD_INTRO_BLOCKS)) {
    for (const s of allSpecs.filter((x) => x.block === Number(block))) {
      assert.deepEqual(s.gimmicks, [mod]);
    }
  }
  for (const [block, shape] of Object.entries(SHAPE_INTRO_BLOCKS)) {
    const b = CHALLENGE_BLOCKS[Number(block) - 1];
    assert.equal(b.shape, shape);
    assert.equal(b.dip, true);
  }
});

test('blockStartLevel agrees with the checkpoint formula (death returns to the block start)', async () => {
  // getCheckpointForLevel (headerRenderer) and blockStartLevel are two
  // copies of one rule — the mirror-pair drift class. Pin them to each
  // other so "block = checkpoint = survival unit" can never silently split.
  await import('./domShim.mjs');
  const { getCheckpointForLevel, CHECKPOINT_INTERVAL } = await import('../src/ui/headerRenderer.js');
  assert.equal(CHECKPOINT_INTERVAL, CHALLENGE_BLOCK_SIZE);
  for (let lv = 1; lv <= CHALLENGE_MAX_LEVEL; lv++) {
    assert.equal(blockStartLevel(lv), getCheckpointForLevel(lv), `L${lv}`);
  }
});

test('specFingerprint separates dial variants and collapses repeats', () => {
  const a = challengeSpecForLevel(31); // liar intro ramp level 1
  const b = challengeSpecForLevel(35); // liar intro ramp level 5 (different gl + mines)
  assert.notEqual(specFingerprint(a), specFingerprint(b));
  const c1 = challengeSpecForLevel(51); // block 11 constant spec
  const c2 = challengeSpecForLevel(52);
  assert.equal(specFingerprint(c1), specFingerprint(c2));
});

// ── Builder smoke (cheap layers only; the validator owns the heavy proof) ──

test('builder: L1 opener draw is certified, floored, and priced', () => {
  const spec = challengeSpecForLevel(1);
  const res = buildChallenge250Board(spec, challengeBoardSeed(1, 0, 'test'));
  assert.ok(res, 'L1 must build');
  assert.ok(res.check.solvable && res.check.remainingUnknowns === 0);
  assert.ok(res.check.totalClicks - 1 >= OPENER_MIN_DEDUCTIONS, 'deduction floor holds');
  assert.equal(res.totalMines, spec.mines);
  assert.ok(res.par > 0 && res.features, 'features + par ride the result');
  assert.equal(res.firstClick, Math.floor(spec.rows / 2) * spec.cols + Math.floor(spec.cols / 2));
});

test('builder: hex shape-intro draw comes back on the lattice with its own opener', () => {
  const spec = challengeSpecForLevel(26);
  const res = buildChallenge250Board(spec, challengeBoardSeed(26, 0, 'test'));
  assert.ok(res, 'L26 must build');
  assert.ok(res.board._cellNeighbors, 'explicit topology present');
  assert.equal(res.tiling.type, 'hex');
  assert.ok(res.features.tilingType === 'hex', 'features carry the shape');
  assert.ok(res.par > 0);
});

test('builder: a locked intro draw is strict (locked is exempt, board certified)', () => {
  const spec = challengeSpecForLevel(31);
  const res = buildChallenge250Board(spec, challengeBoardSeed(31, 0, 'test'));
  assert.ok(res, 'L31 must build');
  assert.ok(res.check.solvable && res.check.remainingUnknowns === 0);
});

test('REGRESSION: generateTilingBoard stamps its load-bearing verdict on the result', () => {
  // Strict path: a testable gimmick under an active budget returns [].
  const strict = generateTilingBoard({
    type: 'hex', M: 7, N: 7, mines: 9, seed: 'c250-decor-pin',
    gimmicks: ['sonar'],
  });
  assert.ok(strict, 'hex sonar board generates');
  assert.deepEqual(strict.decorative, [], 'measured-strict boards stamp an empty list');

  // Budget disabled: the verdict was never measured — null, not [].
  const unmeasured = generateTilingBoard({
    type: 'hex', M: 7, N: 7, mines: 9, seed: 'c250-decor-pin',
    gimmicks: ['sonar'], loadBearingBudget: 0,
  });
  assert.ok(unmeasured);
  assert.equal(unmeasured.decorative, null, 'budget-off boards stamp null (unmeasured)');

  // Exempt-only boards are strict trivially.
  const exempt = generateTilingBoard({
    type: 'hex', M: 7, N: 7, mines: 9, seed: 'c250-decor-pin',
    gimmicks: ['walls'],
  });
  assert.ok(exempt);
  assert.deepEqual(exempt.decorative, [], 'exempt-only boards stamp []');
});
