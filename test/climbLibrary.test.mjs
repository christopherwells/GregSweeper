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

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import {
  parFloor, parWindowTop, intakeRules, boardAllowedAtLevel,
  PAR_FLOOR_SHAPE_RELIEF, OUT_DIR,
} from '../scripts/build-climb-library.mjs';
import { predictPar } from '../src/logic/dailyFeatures.js';
import { modelFingerprint } from '../src/logic/parModelFingerprint.js';

const files = readdirSync(OUT_DIR).filter((f) => /^level-\d+\.json$/.test(f)).sort();
const levels = files.map((f) => JSON.parse(readFileSync(new URL(f, OUT_DIR), 'utf8')));
const reserve = existsSync(new URL('reserve.json', OUT_DIR))
  ? JSON.parse(readFileSync(new URL('reserve.json', OUT_DIR), 'utf8'))
  : { parModel: modelFingerprint(), boards: [] };

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
  }
});
