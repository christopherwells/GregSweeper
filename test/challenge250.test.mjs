// The Challenge ladder: authored opener (L1-25), the EMERGENT BRAID drawn
// from the proven pool (L26-250), and the endless zone past the crown.
//
// What changed, and what this file therefore pins. The braid used to be a
// hand-authored 45-block table, and it repeated: 250 levels carried 109
// distinct boards, the worst spec appeared 8 times, and Christopher hit the
// same one three times at L65-70. Blocks 6-50 are now DERIVED: each block
// asks the pool what it can carry at that difficulty, a pending shape or
// modifier debuts on the first block that can give it five distinct boards,
// and nothing is ever drawn twice. So the tests that used to pin a fixed
// block table now pin the PROPERTIES that table was written to have: the ramp
// climbs, the band widens, every shape and modifier gets introduced and then
// stays in the mix, and no board ever repeats.
//
// Uniqueness is judged on specFace throughout, what a player can tell apart,
// never on specFingerprint, which separates dials nobody can see.
//
// Generation and pricing PROOF lives in
// scripts/validate-challenge250-specs.mjs (the 2s cap is a measurement, not a
// unit test); this file pins what the ladder CLAIMS.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CHALLENGE_MAX_LEVEL, CHALLENGE_BLOCK_SIZE, CHALLENGE_BLOCK_COUNT,
  CHALLENGE_BLOCKS, TIER_PPC, challengeSpecForLevel, blockStartLevel,
  specFace, specFingerprint, ppcBandFor,
  PAR_CEILING_SECONDS, GEN_CAP_MS, CLIMB_MIN_DEDUCTIONS,
  MOD_INTRO_BLOCKS, SHAPE_INTRO_BLOCKS, UNINTRODUCED,
  BRAID_START_LEVEL, BRAID_START_BLOCK, braidTargetPpc, braidBand,
  ENDLESS_START_LEVEL, endlessSpecForLevel,
} from '../src/logic/challenge250.js';
import { LADDER_POOL } from '../src/logic/challengePool.js';
import { buildChallenge250Board, challengeBoardSeed } from '../src/logic/challenge250Builder.js';
import { buildTiling, TILING_TYPES } from '../src/logic/tilingGeometry.js';
import { generateTilingBoard, TILING_SAFE_GIMMICKS } from '../src/logic/tilingGenerator.js';

const ladder = () => Array.from({ length: CHALLENGE_MAX_LEVEL }, (_, i) => challengeSpecForLevel(i + 1));
const braid = () => ladder().slice(BRAID_START_LEVEL - 1);
const ALL_SHAPES = ['rect', ...TILING_TYPES];
const ALL_MODS = ['walls', 'liar', 'mystery', 'locked', 'wormhole', 'mirror', 'sonar', 'compass', 'worm'];

function firstLevelOf(block) { return (block - 1) * CHALLENGE_BLOCK_SIZE + 1; }
function levelsOfBlock(block) {
  const first = firstLevelOf(block);
  return Array.from({ length: CHALLENGE_BLOCK_SIZE }, (_, i) => challengeSpecForLevel(first + i));
}

// ── The headline: nothing repeats ──────────────────────────────────────

test('REGRESSION: all 250 levels are distinct boards (his L65-70 report)', () => {
  const seen = new Map();
  for (const s of ladder()) {
    const f = specFace(s);
    assert.equal(seen.has(f), false,
      `L${s.level} repeats the board first seen at L${seen.get(f)}: ${f}`);
    seen.set(f, s.level);
  }
  assert.equal(seen.size, CHALLENGE_MAX_LEVEL);
});

test('the distinctness check is NOT vacuous: specFace ignores what a player cannot see', () => {
  // A face must COLLAPSE the dials, or "250 distinct faces" would be a claim
  // about gimmickLevel rather than about boards. The authored table this
  // replaced reported 130 distinct fingerprints over 109 distinct boards, so
  // a fingerprint-based check would have passed while repeating 21 of them.
  const base = { shape: 'rect', rows: 9, cols: 9, mines: 16, gimmicks: ['walls', 'liar'] };
  const a = { ...base, gimmickLevel: 63, wallSegments: 2 };
  const b = { ...base, gimmickLevel: 64, wallSegments: 3, constructive: true };
  assert.equal(specFace(a), specFace(b));
  assert.notEqual(specFingerprint(a), specFingerprint(b));
  // Modifier ORDER is not a difference either.
  assert.equal(specFace({ ...base, gimmicks: ['liar', 'walls'] }), specFace(a));

  // And no single (shape, modifier set) family is big enough to have carried
  // the ladder alone, so distinctness is a constraint the assignment actually
  // had to satisfy rather than one the pool hands out for free.
  const families = new Map();
  for (const e of LADDER_POOL) {
    const k = `${e.shape}|${[...e.gimmicks].sort().join('+')}`;
    families.set(k, (families.get(k) || 0) + 1);
  }
  assert.ok(Math.max(...families.values()) < CHALLENGE_MAX_LEVEL,
    'a single family could supply the whole ladder, the check proves nothing');
});

// ── Representation: his ruling that the search must not default ────────

test('REPRESENTATION: every shape and every modifier reaches the ladder', () => {
  // His ruling, 2026-08-08: "I would like to see somewhat equal
  // representation of gimmicks, tilings, etc. I do not want it to default to
  // classic compass boards or something when there is a ton of space to
  // explore here."
  const shapes = new Map();
  const mods = new Map();
  for (const s of ladder()) {
    shapes.set(s.shape, (shapes.get(s.shape) || 0) + 1);
    for (const g of s.gimmicks) mods.set(g, (mods.get(g) || 0) + 1);
  }
  for (const shape of ALL_SHAPES) {
    assert.ok((shapes.get(shape) || 0) >= 8,
      `${shape} appears on only ${shapes.get(shape) || 0} levels`);
  }
  for (const g of ALL_MODS) {
    assert.ok((mods.get(g) || 0) >= 8,
      `${g} appears on only ${mods.get(g) || 0} levels`);
  }
  // No shape may run away with the ladder either. Seven shapes over 225 braid
  // levels is ~32 each; a third of the whole ladder is the bar for "this
  // defaulted", and rect legitimately runs ahead because it owns the 25
  // authored openers outright.
  for (const [shape, n] of shapes) {
    assert.ok(n <= CHALLENGE_MAX_LEVEL / 3,
      `${shape} carries ${n} of ${CHALLENGE_MAX_LEVEL} levels, the ladder defaulted to it`);
  }
});

test('nothing is left unintroduced', () => {
  // A shape or modifier stranded here never appears on the ladder at all.
  // That is a POOL problem, search wider, never something to route around
  // in the assignment, which is why this asserts on the assignment's own
  // honest report of what it could not place.
  assert.deepEqual([...UNINTRODUCED.shapes], []);
  assert.deepEqual([...UNINTRODUCED.gimmicks], []);
});

// ── Emergent introductions ─────────────────────────────────────────────

test('every shape and modifier is introduced exactly once, on its own block', () => {
  const introduced = [
    ...Object.entries(SHAPE_INTRO_BLOCKS).map(([b, k]) => [Number(b), k]),
    ...Object.entries(MOD_INTRO_BLOCKS).map(([b, k]) => [Number(b), k]),
  ];
  const blocks = introduced.map(([b]) => b);
  assert.equal(new Set(blocks).size, blocks.length, 'two things debut on one block');
  const keys = introduced.map(([, k]) => k);
  assert.equal(new Set(keys).size, keys.length, 'something debuts twice');

  // Every tiling and every modifier is covered; rect needs no debut because
  // the opener IS Classic.
  assert.deepEqual(Object.values(SHAPE_INTRO_BLOCKS).slice().sort(), TILING_TYPES.slice().sort());
  assert.deepEqual(Object.values(MOD_INTRO_BLOCKS).slice().sort(), ALL_MODS.slice().sort());
});

test('an intro block is five levels that ALL carry the new thing', () => {
  for (const [block, shape] of Object.entries(SHAPE_INTRO_BLOCKS)) {
    const levels = levelsOfBlock(Number(block));
    assert.equal(levels.length, CHALLENGE_BLOCK_SIZE);
    for (const s of levels) {
      assert.equal(s.shape, shape, `block ${block} introduces ${shape} but L${s.level} is ${s.shape}`);
    }
  }
  for (const [block, mod] of Object.entries(MOD_INTRO_BLOCKS)) {
    if (Number(block) < BRAID_START_BLOCK) continue;   // the opener's three are authored
    for (const s of levelsOfBlock(Number(block))) {
      assert.ok(s.gimmicks.includes(mod),
        `block ${block} introduces ${mod} but L${s.level} does not carry it`);
    }
  }
});

test('nothing appears BEFORE its introduction', () => {
  const shapeIntroLevel = {};
  for (const [b, k] of Object.entries(SHAPE_INTRO_BLOCKS)) shapeIntroLevel[k] = firstLevelOf(Number(b));
  const modIntroLevel = {};
  for (const [b, k] of Object.entries(MOD_INTRO_BLOCKS)) modIntroLevel[k] = firstLevelOf(Number(b));

  for (const s of ladder()) {
    const si = shapeIntroLevel[s.shape];
    if (si != null) assert.ok(s.level >= si, `${s.shape} appears at L${s.level}, before its L${si} debut`);
    for (const g of s.gimmicks) {
      const mi = modIntroLevel[g];
      if (mi != null) assert.ok(s.level >= mi, `${g} appears at L${s.level}, before its L${mi} debut`);
    }
  }
});

test('after its five levels, a thing rejoins the general draw', () => {
  // His ruling: "once a board or gimmick is introduced, it gets played 5
  // times, then any gimmick/shape can be brought in". An introduction is a
  // door, not a chapter that closes behind it.
  for (const [block, shape] of Object.entries(SHAPE_INTRO_BLOCKS)) {
    const after = ladder().filter((s) => s.block > Number(block) && s.shape === shape);
    assert.ok(after.length >= 3, `${shape} is barely seen again after block ${block}`);
  }
  for (const [block, mod] of Object.entries(MOD_INTRO_BLOCKS)) {
    const after = ladder().filter((s) => s.block > Number(block) && s.gimmicks.includes(mod));
    assert.ok(after.length >= 3, `${mod} is barely seen again after block ${block}`);
  }
});

// ── The ramp and the widening band ─────────────────────────────────────

test('the difficulty ramp climbs from the opener exit to the T12 summit', () => {
  assert.ok(braidTargetPpc(BRAID_START_LEVEL) < braidTargetPpc(CHALLENGE_MAX_LEVEL));
  assert.equal(Number(braidTargetPpc(CHALLENGE_MAX_LEVEL).toFixed(2)), TIER_PPC[12]);
  for (let lv = BRAID_START_LEVEL; lv < CHALLENGE_MAX_LEVEL; lv++) {
    assert.ok(braidTargetPpc(lv + 1) > braidTargetPpc(lv), `ramp stalls at L${lv}`);
  }
});

test('the band WIDENS as the ladder climbs (his "decently wide but every increased width")', () => {
  const width = (lv) => { const [lo, hi] = braidBand(lv); return (hi - lo) / braidTargetPpc(lv); };
  assert.ok(width(CHALLENGE_MAX_LEVEL) > width(BRAID_START_LEVEL) * 2);
  for (let lv = BRAID_START_LEVEL; lv < CHALLENGE_MAX_LEVEL - 5; lv += 5) {
    assert.ok(width(lv + 5) >= width(lv) - 1e-9, `band narrows at L${lv}`);
  }
});

test('measured difficulty actually rises across the braid', () => {
  // The band is wide and the draw is varied, so no single level is guaranteed
  // harder than the one before it, that is the design. What must hold is
  // that the CLIMB is real, checked on medians a third of the ladder apart.
  const med = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  const b = braid();
  const third = Math.floor(b.length / 3);
  const early = med(b.slice(0, third).map((s) => s.ppc));
  const mid = med(b.slice(third, 2 * third).map((s) => s.ppc));
  const late = med(b.slice(2 * third).map((s) => s.ppc));
  assert.ok(mid > early * 1.2, `mid ${mid} vs early ${early}`);
  assert.ok(late > mid * 1.2, `late ${late} vs mid ${mid}`);
});

test('every braid level lands within reach of its own target', () => {
  // Deliberately NOT the band itself: the assignment may widen when the pool
  // is thin at a difficulty, and that is the honest failure mode, a board
  // off target beats a repeat. What it may never do is hand out something
  // from a different part of the ladder entirely.
  for (const s of braid()) {
    const t = braidTargetPpc(s.level);
    const ratio = s.ppc / t;
    assert.ok(ratio > 0.3 && ratio < 3.3,
      `L${s.level} prices ${s.ppc.toFixed(2)} against a ${t.toFixed(2)} target`);
  }
});

// ── Structure that survives the rewrite ────────────────────────────────

test('ladder structure: 250 levels, 50 blocks of 5, unbounded above', () => {
  assert.equal(CHALLENGE_MAX_LEVEL, 250);
  assert.equal(CHALLENGE_BLOCK_SIZE, 5);
  assert.equal(CHALLENGE_BLOCK_COUNT, 50);
  assert.equal(CHALLENGE_BLOCKS.length, 50);
  for (let lv = 1; lv <= CHALLENGE_MAX_LEVEL; lv++) {
    const s = challengeSpecForLevel(lv);
    assert.equal(s.level, lv);
    assert.equal(s.block, Math.floor((lv - 1) / CHALLENGE_BLOCK_SIZE) + 1);
    assert.ok(s.cells > 0 && s.mines > 0);
  }
  // Past the crown the endless zone takes over, with no upper clamp.
  assert.equal(challengeSpecForLevel(ENDLESS_START_LEVEL).level, ENDLESS_START_LEVEL);
  assert.equal(challengeSpecForLevel(9999).endless, true);
});

test('tier ladder anchors are the adopted numbers (T1 0.55 → T12 3.60)', () => {
  assert.equal(TIER_PPC[1], 0.55);
  assert.equal(TIER_PPC[12], 3.60);
  for (let t = 2; t <= 12; t++) assert.ok(TIER_PPC[t] > TIER_PPC[t - 1]);
});

test('pressure plates and mineShift never appear on the ladder', () => {
  for (const s of ladder()) {
    assert.equal(s.gimmicks.includes('pressurePlate'), false, `L${s.level}`);
    assert.equal(s.gimmicks.includes('mineShift'), false, `L${s.level}`);
  }
});

test('the L1-10 ramp: boards and deduction caps both climb, and L1 is a handful of clicks', () => {
  const ramp = ladder().slice(0, 10);
  assert.equal(ramp[0].cells, 25);
  assert.equal(ramp[0].maxDeductions, 5);
  for (let i = 1; i < ramp.length; i++) {
    assert.ok(ramp[i].cells >= ramp[i - 1].cells, `L${i + 1} shrank`);
    assert.ok(ramp[i].maxDeductions >= ramp[i - 1].maxDeductions, `L${i + 1} cap fell`);
  }
  for (const s of ramp) assert.equal(s.shape, 'rect');
});

test('REGRESSION: EVERY level carries a deduction floor, openers and braid alike', () => {
  // This test used to assert the opposite for the braid, that it carried no
  // floor at all, and that assertion was the bug written down. Nothing stopped
  // a drawn level being over on the opening click: measured before the fix,
  // L29 cleared outright on 13% of draws and L26 on 5%, and half of L26's
  // draws needed two decisions or fewer. His report, 2026-08-10: "one puzzle
  // that took one button press to solve the whole thing".
  //
  // The openers keep the higher floor they were authored with, because their
  // job is teaching a ramp; the braid takes the pool-feasible one.
  for (const s of ladder().slice(0, 25)) {
    assert.equal(s.shape, 'rect', `L${s.level} is not a Classic opener`);
    assert.ok(s.minDeductions >= 3, `L${s.level} has no deduction floor`);
  }
  for (const s of braid()) {
    assert.equal(s.minDeductions, CLIMB_MIN_DEDUCTIONS,
      `L${s.level} has no deduction floor, so a draw can be over on the opening click`);
    assert.equal(s.maxDeductions, undefined, `L${s.level} caps deductions outside the ramp`);
  }
  // A floor nothing enforces is decoration. The builder's accept gate is the
  // enforcer, and it reached only the rectangular path until 2026-08-10, which
  // is why every one-click board was a lattice.
  const builder = readFileSync(new URL('../src/logic/challenge250Builder.js', import.meta.url), 'utf8');
  const tiling = builder.slice(builder.indexOf('function buildTilingSpec'));
  assert.match(tiling.slice(0, tiling.indexOf('\n}')), /accepts\(spec,/,
    'buildTilingSpec must apply the accept gate, or the floor never reaches a lattice board');
});

test('pinned cell counts match buildTiling; rect cells are rows×cols', () => {
  for (const s of ladder()) {
    if (s.shape === 'rect') {
      assert.equal(s.cells, s.rows * s.cols, `L${s.level}`);
    } else {
      assert.equal(s.cells, buildTiling(s.shape, s.M, s.N).total, `L${s.level} ${s.shape}`);
    }
    assert.ok(s.mines < s.cells, `L${s.level} has more mines than cells`);
  }
});

test('static par sanity: every braid level stays inside the 8-minute ceiling', () => {
  for (const s of braid()) {
    assert.ok(s.ppc * s.cells <= PAR_CEILING_SECONDS,
      `L${s.level} targets ${(s.ppc * s.cells).toFixed(0)}s`);
  }
});

test('gimmick vocabulary and dials: tiling mods are tiling-safe, gimmickLevel stays in old-ladder units', () => {
  for (const s of ladder()) {
    if (s.shape !== 'rect') {
      for (const g of s.gimmicks) {
        assert.ok(TILING_SAFE_GIMMICKS.includes(g), `L${s.level}: ${g} is not tiling-safe`);
      }
    }
    if (s.gimmicks.length) {
      assert.ok(s.gimmickLevel >= 11 && s.gimmickLevel <= 120,
        `L${s.level}: gimmickLevel ${s.gimmickLevel} is outside old-ladder units`);
    }
  }
});

test('sub-threshold tiling specs route constructive, and rect never does', () => {
  for (const s of ladder()) {
    if (s.shape === 'rect') { assert.notEqual(s.constructive, true, `L${s.level}`); continue; }
    if (s.mines / s.cells < 0.22) {
      assert.equal(s.constructive, true,
        `L${s.level} at density ${(s.mines / s.cells).toFixed(3)} needs the constructive placer`);
    }
  }
});

test('the pool is priced within the ladder\'s own rulings', () => {
  assert.ok(LADDER_POOL.length > CHALLENGE_MAX_LEVEL,
    `the pool (${LADDER_POOL.length}) is smaller than the ladder it feeds`);
  for (const e of LADDER_POOL) {
    assert.ok(e.ppc > 0, 'a pool entry has no measured price');
    assert.ok(e.ppc * e.cells <= PAR_CEILING_SECONDS,
      `pool entry ${specFace(e)} prices ${(e.ppc * e.cells).toFixed(0)}s`);
    assert.ok(ALL_SHAPES.includes(e.shape));
    for (const g of e.gimmicks) assert.ok(ALL_MODS.includes(g), `${g} is not a ladder modifier`);
  }
  assert.equal(new Set(LADDER_POOL.map(specFace)).size, LADDER_POOL.length,
    'the pool itself carries duplicate faces');
});

test('the POOL is evenly represented too, not only the ladder drawn from it', () => {
  // The ladder could look balanced while resting on a lopsided pool, which
  // would fail the moment the assignment changed. This is the search's own
  // stratification, asserted where it can regress.
  const byShape = new Map();
  for (const e of LADDER_POOL) byShape.set(e.shape, (byShape.get(e.shape) || 0) + 1);
  for (const shape of ALL_SHAPES) {
    assert.ok((byShape.get(shape) || 0) >= 10,
      `the pool holds only ${byShape.get(shape) || 0} ${shape} boards`);
  }
  for (const g of ALL_MODS) {
    const n = LADDER_POOL.filter((e) => e.gimmicks.includes(g)).length;
    assert.ok(n >= 10, `the pool holds only ${n} boards carrying ${g}`);
  }
});

test('blockStartLevel agrees with the checkpoint formula (death returns to the block start)', async () => {
  // headerRenderer owns the SECOND copy of this formula (the checkpoint
  // selector reads it), so the two are pinned against each other here. It is
  // a DOM module, hence the shim.
  await import('./domShim.mjs');
  const { CHECKPOINT_INTERVAL, getCheckpointForLevel } = await import('../src/ui/headerRenderer.js');
  assert.equal(CHECKPOINT_INTERVAL, CHALLENGE_BLOCK_SIZE);
  for (const lv of [1, 5, 6, 25, 26, 100, 250, 251, 999]) {
    assert.equal(getCheckpointForLevel(lv), blockStartLevel(lv), `L${lv}`);
  }
  for (const lv of [1, 5, 6, 25, 26, 100, 250, 251, 999]) {
    assert.equal(blockStartLevel(lv), Math.floor((lv - 1) / CHALLENGE_BLOCK_SIZE) * CHALLENGE_BLOCK_SIZE + 1);
  }
});

test('the intro-block exports agree with the levels table (checkpoint labels read these)', () => {
  for (const [block, shape] of Object.entries(SHAPE_INTRO_BLOCKS)) {
    assert.equal(levelsOfBlock(Number(block))[0].shape, shape);
    assert.equal(CHALLENGE_BLOCKS[Number(block) - 1].block, Number(block));
  }
  for (const [block, mod] of Object.entries(MOD_INTRO_BLOCKS)) {
    assert.ok(levelsOfBlock(Number(block))[0].gimmicks.includes(mod), `block ${block}`);
  }
});

test('ppcBandFor: braid levels band around their own measured price, openers do not band', () => {
  for (const s of ladder().slice(0, 25)) assert.equal(ppcBandFor(s), null);
  for (const s of braid()) {
    const [lo, hi] = ppcBandFor(s);
    assert.ok(lo < s.ppc && s.ppc < hi, `L${s.level}`);
  }
});

// ── The endless zone ───────────────────────────────────────────────────

test('the endless zone still draws hard, varied, non-repeating blocks', () => {
  const shapes = new Set();
  const faces = new Set();
  for (let lv = ENDLESS_START_LEVEL; lv < ENDLESS_START_LEVEL + CHALLENGE_BLOCK_SIZE; lv++) {
    const s = endlessSpecForLevel(lv);
    assert.equal(s.endless, true);
    shapes.add(s.shape);
    faces.add(specFace(s));
  }
  assert.equal(faces.size, CHALLENGE_BLOCK_SIZE, 'an endless block repeats a board');
  assert.ok(shapes.size >= 4, 'an endless block repeats shapes while unused ones remain');
});

// ── The builder still honours every spec the ladder now produces ───────

test('builder: L1 opener draw is certified, floored, and priced', () => {
  const spec = challengeSpecForLevel(1);
  const built = buildChallenge250Board(spec, challengeBoardSeed(1, 0, 'test'));
  assert.ok(built, 'L1 failed to build');
  assert.ok(built.check.solvable);
  assert.equal(built.check.remainingUnknowns, 0);
  assert.ok(built.check.totalClicks - 1 >= spec.minDeductions);
  assert.ok(built.check.totalClicks - 1 <= spec.maxDeductions);
  assert.ok(built.par > 0);
});

test('builder: the first braid level builds on whatever the pool handed it', () => {
  const spec = challengeSpecForLevel(BRAID_START_LEVEL);
  const t0 = Date.now();
  const built = buildChallenge250Board(spec, challengeBoardSeed(BRAID_START_LEVEL, 0, 'test'));
  assert.ok(built, `L${BRAID_START_LEVEL} (${specFace(spec)}) failed to build`);
  assert.ok(built.check.solvable);
  assert.ok(Date.now() - t0 < GEN_CAP_MS * 3, 'generation blew past the cap');
});

test('REGRESSION: generateTilingBoard stamps its load-bearing verdict on the result', () => {
  const res = generateTilingBoard({
    type: 'hex', M: 7, N: 7, mines: 9, seed: 'verdict-test',
    gimmicks: ['sonar'], gimmickLevel: 60, loadBearingBudget: Infinity,
  });
  assert.ok(res, 'no board');
  assert.ok(Array.isArray(res.decorative), 'no load-bearing verdict on the result');
});
