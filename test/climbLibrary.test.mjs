// The Climb library's standing contract, and the refit-drift alarm.
//
// The library stores ~2,900 pre-generated boards binned by level window,
// and a refit moves every window's contents (his re-bin ruling 2026-08-11:
// boards are never tossed, they move to the level whose window now holds
// them, and only the remaining shortfall is generated). These tests hold
// the library to that contract under the model of the day:
//
//   - the vintage lockstep: every file carries the CURRENT model
//     fingerprint, so a refit that lands without running
//     scripts/reprice-climb-library.mjs reddens here with the remedy in
//     the message (the poolReprice pattern);
//   - window membership: every board's par sits inside its level's
//     admission window, and par is exactly predictPar of the board's own
//     stored features;
//   - schedule legality: no board sits at a level whose introduction
//     schedule forbids its shape or stack, and debut blocks keep their
//     single-shape / carries-the-debut-mod rules;
//   - the face cap: at most two boards of one face per level;
//   - reserve honesty: a reserve board is there because NO level can take
//     it, not because the re-binner gave up early.
//
// Deliberately NOT asserted: per-level minimum counts. Deficits are the
// generation side's job (deficits.json + the top-up's --fill mode), and a
// hard minimum here would redden main on the refit's own unattended
// schedule, the exact class the 2026-08-10 latent-red taught us to avoid.
//
// The ENDLESS bins (endless-index.json + endless-NNN.json pages, 2026-08-11)
// are held to the same contract in their own section below: lockstep,
// features-price-exact, the 400s floor as their ONE window bound, all seven
// shapes, and the heavy-stack variety his ruling names.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import {
  parFloor, parWindowTop, intakeRules, boardAllowedAtLevel,
  PAR_FLOOR_SHAPE_RELIEF, OUT_DIR, ENDLESS_PAR_FLOOR, ENDLESS_FACE_CAP,
  ENDLESS_SHAPE_FLOOR, ENDLESS_SHAPE_TARGET,
} from '../scripts/build-climb-library.mjs';
import { predictPar } from '../src/logic/dailyFeatures.js';
import { modelFingerprint } from '../src/logic/parModelFingerprint.js';

const files = readdirSync(OUT_DIR).filter((f) => /^level-\d+\.json$/.test(f)).sort();
const levels = files.map((f) => JSON.parse(readFileSync(new URL(f, OUT_DIR), 'utf8')));
const reserve = existsSync(new URL('reserve.json', OUT_DIR))
  ? JSON.parse(readFileSync(new URL('reserve.json', OUT_DIR), 'utf8'))
  : { parModel: modelFingerprint(), boards: [] };
const endlessIndex = JSON.parse(readFileSync(new URL('endless-index.json', OUT_DIR), 'utf8'));
const endlessPages = Array.from({ length: endlessIndex.pages }, (_, k) =>
  JSON.parse(readFileSync(new URL(`endless-${String(k).padStart(3, '0')}.json`, OUT_DIR), 'utf8')));
const endlessBoards = endlessPages.flatMap((p) => p.boards);

test('the library is complete and non-vacuous', () => {
  assert.equal(levels.length, 225, 'one file per level, L26 through L250');
  const total = levels.reduce((a, j) => a + j.boards.length, 0);
  assert.ok(total >= 2500, `${total} boards is too few to be the real library`);
});

test('LOCKSTEP: every file is priced under the model of the day', () => {
  const fp = modelFingerprint();
  for (const j of levels) {
    assert.equal(j.parModel, fp,
      `level-${j.level} is priced under ${j.parModel}, the shipped model is ${fp}. `
      + 'A refit landed without re-binning: run node scripts/reprice-climb-library.mjs');
  }
  assert.equal(reserve.parModel, fp, 'reserve.json is stale; run the reprice');
});

test('every board prices from its own stored features, inside its window', () => {
  for (const j of levels) {
    const lo = parFloor(j.level) * PAR_FLOOR_SHAPE_RELIEF;
    const hi = parWindowTop(j.level);
    for (const b of j.boards) {
      assert.ok(b.features && typeof b.features === 'object',
        `L${j.level} ${b.seed} has no stored features`);
      const par = predictPar(b.features);
      assert.ok(Math.abs(par - b.par) < 1e-6,
        `L${j.level} ${b.seed}: stored par ${b.par} but features price to ${par}`);
      assert.ok(b.par >= lo && b.par <= hi,
        `L${j.level} ${b.seed}: par ${Math.round(b.par)}s outside [${Math.round(lo)}, ${Math.round(hi)}]`);
    }
  }
});

test('every board is schedule-legal at its level, debut rules included', () => {
  for (const j of levels) {
    const rules = intakeRules(j.level, j.intro);
    for (const b of j.boards) {
      assert.ok(boardAllowedAtLevel(b, rules),
        `L${j.level} holds a ${b.spec.shape} [${(b.spec.gimmicks || []).join('+')}] its schedule forbids`);
    }
  }
});

test('no level carries more than two boards of one face', () => {
  for (const j of levels) {
    const counts = new Map();
    for (const b of j.boards) counts.set(b.face, (counts.get(b.face) || 0) + 1);
    for (const [face, n] of counts) {
      assert.ok(n <= 2, `L${j.level} carries ${n} boards of face ${face}`);
    }
  }
});

test('reserve boards genuinely fit nowhere', () => {
  for (const b of reserve.boards) {
    assert.ok(b.features, `reserve ${b.seed} has no stored features`);
    const par = predictPar(b.features);
    const home = levels.find((j) => {
      const lo = parFloor(j.level) * PAR_FLOOR_SHAPE_RELIEF;
      const hi = parWindowTop(j.level);
      if (par < lo || par > hi) return false;
      if (!boardAllowedAtLevel(b, intakeRules(j.level, j.intro))) return false;
      const sameFace = j.boards.filter((x) => x.face === b.face).length;
      return sameFace < 2;
    });
    assert.equal(home, undefined,
      `reserve ${b.seed} (par ${Math.round(par)}s) fits L${home?.level}; the re-binner should have placed it`);
    // The endless bins are the catch-all above their floor, so a reserve
    // board at or over 400s means the re-binner's endless intake refused it
    // for a reason the face cap must explain.
    if (par >= ENDLESS_PAR_FLOOR) {
      const sameFace = endlessBoards.filter((x) => x.face === b.face).length;
      assert.ok(sameFace >= ENDLESS_FACE_CAP,
        `reserve ${b.seed} (par ${Math.round(par)}s) belongs in the endless bins`);
    }
  }
});

// ── The ENDLESS bins (2026-08-11): the same contract past the crown ─────
//
// ~500 pre-generated boards at launch (his ruling: "start with 500", the
// library appends) for L251+, dealt randomly under one global seen-cycle
// (his rule: a board cannot repeat until every other board has been
// served). One window bound, the 400s par floor; per-shape ceilings are
// build-time admission, deliberately NOT asserted here, because a refit
// that re-prices a board over its ceiling has made it harder, which the
// zone welcomes ("there's no max").

test('the endless library is real, sharded, and its index tells the truth', () => {
  assert.ok(endlessIndex.pages === endlessPages.length, 'index page count matches the files');
  assert.equal(endlessIndex.parFloor, ENDLESS_PAR_FLOOR, 'the index states the one window bound');
  assert.deepEqual(endlessIndex.counts, endlessPages.map((p) => p.boards.length),
    'per-page counts drive the deal\'s page weighting and must match the pages');
  assert.equal(endlessIndex.boards, endlessBoards.length, 'the index total matches the boards');
  assert.ok(endlessBoards.length >= 350,
    `${endlessBoards.length} endless boards is far under the ~500 launch target `
    + '(his 2026-08-11 ruling); append supply with: node scripts/build-climb-library.mjs --endless');
  const seeds = new Set(endlessBoards.map((b) => b.seed));
  assert.equal(seeds.size, endlessBoards.length, 'every endless board has a unique seed');
});

test('LOCKSTEP: the endless bins are priced under the model of the day', () => {
  const fp = modelFingerprint();
  assert.equal(endlessIndex.parModel, fp,
    `endless-index is priced under ${endlessIndex.parModel}, the shipped model is ${fp}. `
    + 'A refit landed without re-binning: run node scripts/reprice-climb-library.mjs');
  for (const p of endlessPages) {
    assert.equal(p.parModel, fp, `endless page ${p.page} is stale; run the reprice`);
  }
});

test('every endless board prices from its own stored features, at or above the floor', () => {
  for (const b of endlessBoards) {
    assert.ok(b.features && typeof b.features === 'object', `endless ${b.seed} has no stored features`);
    const par = predictPar(b.features);
    assert.ok(Math.abs(par - b.par) < 1e-6,
      `endless ${b.seed}: stored par ${b.par} but features price to ${par}`);
    assert.ok(b.par >= ENDLESS_PAR_FLOOR,
      `endless ${b.seed}: par ${Math.round(b.par)}s under the ${ENDLESS_PAR_FLOOR}s floor`);
    assert.ok(b.payload, `endless ${b.seed} has no stored payload to deal`);
  }
});

test('the endless bins carry all SEVEN shapes, Classic included', () => {
  // His even-coverage ruling, and the surface that restores Classic to the
  // endless zone (pre-generation pays the cost that parked it). A shape
  // draining below the bar after a refit is a real event worth a red: the
  // remedy is targeted supply, node scripts/build-climb-library.mjs
  // --endless --shape <s>.
  const byShape = new Map();
  for (const b of endlessBoards) byShape.set(b.spec.shape, (byShape.get(b.spec.shape) || 0) + 1);
  for (const s of ['rect', '4.8.8', 'hex', 'cairo', 'floret', 'rhombille', 'deltoidal']) {
    assert.ok((byShape.get(s) || 0) >= ENDLESS_SHAPE_FLOOR,
      `the endless bins hold ${byShape.get(s) || 0} ${s} boards, under the ${ENDLESS_SHAPE_FLOOR} floor`);
  }
});

test('REGRESSION: the nightly re-bin reserves the endless shape floor before the ladder takes its pick', () => {
  // 2026-08-13: the refit's bad rhombille prices pushed 344 rhombille boards
  // out of the endless bins; the re-bin found 194 ladder levels under their
  // minimum and, on first refusal, handed the ladder every one of them. 118
  // cleared the 400s endless floor comfortably, so the shape emptied out of a
  // zone with plenty of material for it and the only thing that noticed was
  // the test above, whose named remedy is an hours-long rebuild.
  //
  // The floor lived only in this file, so the tool that had to satisfy it
  // could not see it. Both halves are pinned: the constant is EXPORTED by the
  // producer (a floor two files disagree on is not a floor), and the re-bin
  // reserves against it BEFORE its placement loop, because reserving after
  // the ladder has taken first refusal reserves out of an empty pool.
  assert.equal(typeof ENDLESS_SHAPE_FLOOR, 'number');
  assert.ok(ENDLESS_SHAPE_TARGET > ENDLESS_SHAPE_FLOOR,
    'the re-bin must aim above the floor: a shape reserved exactly to it is one re-price from red, '
    + 'and a board priced under the par floor cannot be handed back to repair it');

  const src = readFileSync(new URL('../scripts/reprice-climb-library.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('ENDLESS_SHAPE_TARGET'),
    'the re-bin must read the shape target rather than restating a number');
  const reserve = src.indexOf('ENDLESS_SHAPE_TARGET - endlessShapeCount(shape)');
  // Anchored on what only the LADDER placement does. `for (const b of
  // homeless)` also opens the duplicate-seed pass, and matching that one made
  // this assertion fire on correct code.
  const placement = src.indexOf('const eligible = levels.filter(');
  assert.ok(reserve > 0 && placement > 0, 'the re-bin no longer has the shape reserved before placement');
  assert.ok(reserve < placement,
    'the shape reservation must run BEFORE the ladder placement loop, or it reserves from nothing');
});

test('the endless bins keep his multi-gimmick variety, heavy stacks included', () => {
  const heavies = endlessBoards.filter((b) => (b.spec.gimmicks || []).length >= 4);
  assert.ok(heavies.length >= 30,
    `${heavies.length} boards carry a 4-5 stack; the HEAVY_SETS lane went missing`);
  for (const b of endlessBoards) {
    for (const g of b.spec.gimmicks || []) {
      assert.ok(g !== 'pressurePlate' && g !== 'mineShift',
        `endless ${b.seed} carries chaos-only '${g}'`);
    }
  }
  const counts = new Map();
  for (const b of endlessBoards) counts.set(b.face, (counts.get(b.face) || 0) + 1);
  for (const [face, n] of counts) {
    assert.ok(n <= ENDLESS_FACE_CAP, `the endless bins carry ${n} boards of face ${face}`);
  }
});
