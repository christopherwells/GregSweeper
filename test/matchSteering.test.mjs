// Mission steering for a Challenge match's deal (src/logic/matchSteering.js).
//
// His constraints are the design, so they are what this file pins:
//   - the host's FILTER IS THE RULES and nothing may reach outside it,
//   - at most floor(N/5) boards of a match may steer,
//   - "if no discovery can happen, that's fine",
//   - "it can't feel forced".
//
// Plus the two invariants steering rides on top of and must not bend: his
// seen-cycle (every unseen eligible board is dealt before any seen one) and
// the R/JS mirror pair that carries the shape deficits (a client reading a key
// the refit never emits is the fieldnote-drift class).

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  steerMissions, currentSteerMissions, planMatchDeal,
} from '../src/logic/matchSteering.js';
import { normalizeShapeCoverage } from '../src/logic/experimentDesign.js';
import { steeredSlotCap, eligibleRows, boardMatchesRules } from '../src/logic/matchRules.js';
import { TILING_TYPES } from '../src/logic/tilingGeometry.js';

// ── Harness ─────────────────────────────────────────────────────────────
//
// A deterministic unit-interval source, so a "picks at random" assertion can
// be run thousands of times reproducibly. Plain LCG, no seeding library.
function lcg(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

let _nextKey = 0;
function row(over = {}) {
  const page = over.page ?? 0;
  const idx = over.idx ?? _nextKey++;
  return {
    page, idx,
    shape: over.shape ?? 'rect',
    cells: over.cells ?? 100,
    mines: over.mines ?? 20,
    par: over.par ?? 100,
    mods: over.mods ?? [],
    key: `${page}:${idx}`,
  };
}

const RULES = (over = {}) => ({
  count: 5,
  shapes: ['rect', 'hex'],
  mods: ['compass', 'sonar'],
  time: 'any',
  density: 'any',
  ...over,
});

// A shape mission for `shape` that outranks everything else in the list.
const shapeSpec = (shape, weight = 0.5) => ({
  target: null, coverage: [],
  shapes: [{ shape, n_boards: 1, deficit_weight: weight }],
});

// ── The filter is the rules ─────────────────────────────────────────────

test('steering never selects a board outside the host filter', () => {
  // The corner that matters: the ONLY board carrying the starved shape is one
  // the host cannot use, because they have not unlocked that lattice.
  const rows = [
    row({ shape: 'rect' }), row({ shape: 'rect' }), row({ shape: 'rect' }),
    row({ shape: 'floret' }),   // the starved shape, and not in rules.shapes
  ];
  const rules = RULES({ count: 10, shapes: ['rect'] });
  const missions = steerMissions(shapeSpec('floret', 0.9));
  assert.equal(missions.length, 1, 'the floret mission must exist to be refused');

  const { picks, steered } = planMatchDeal(rows, rules, { rand: lcg(7), missions });
  assert.equal(steered.length, 0, 'an unusable shape must claim no slot');
  for (const p of picks) {
    assert.ok(boardMatchesRules(p, rules), `${p.key} (${p.shape}) escaped the filter`);
  }
  assert.ok(!picks.some((p) => p.shape === 'floret'));
});

test('every pick clears the filter across a sweep of rule sets and missions', () => {
  const rows = [];
  for (const shape of ['rect', ...TILING_TYPES]) {
    for (const mods of [[], ['compass'], ['sonar'], ['compass', 'liar']]) {
      for (const par of [30, 100, 300]) {
        rows.push(row({ shape, mods, par, mines: 25, cells: 100 }));
      }
    }
  }
  // Every shape and every gimmick starved at once, the most aggressive
  // mission list the refit could possibly emit.
  const missions = steerMissions({
    target: 'compassCellCount',
    coverage: [
      { feature: 'sonarCellCount', deficit_weight: 0.5 },
      { feature: 'liarCellCount', deficit_weight: 0.4 },
    ],
    shapes: ['rect', ...TILING_TYPES].map((shape) => ({
      shape, n_boards: 0, deficit_weight: 1,
    })),
  });
  assert.ok(missions.length >= 9, 'sweep needs a full mission slate to be real');

  let sawSteer = false;
  const rand = lcg(11);
  for (const shapes of [['rect'], ['hex'], ['rect', 'floret'], ['rect', ...TILING_TYPES]]) {
    for (const mods of [[], ['compass'], ['compass', 'sonar', 'liar']]) {
      for (const time of ['any', 'quick', 'long']) {
        const rules = RULES({ count: 10, shapes, mods, time });
        const plan = planMatchDeal(rows, rules, { rand, missions });
        if (plan.steered.length > 0) sawSteer = true;
        for (const p of plan.picks) {
          assert.ok(boardMatchesRules(p, rules),
            `${p.key} (${p.shape} ${JSON.stringify(p.mods)} par ${p.par}) escaped ${JSON.stringify(rules)}`);
        }
      }
    }
  }
  // Non-vacuity: a sweep where steering never fired would prove nothing.
  assert.ok(sawSteer, 'the sweep must actually steer somewhere');
});

// ── The cap is his ruling ───────────────────────────────────────────────

test('at most floor(N/5) boards steer, at every match size', () => {
  // Every board carries the starved shape AND a starved modifier, so the only
  // thing that can hold steering back is the cap itself.
  const rows = Array.from({ length: 40 }, () => row({ shape: 'hex', mods: ['compass'] }));
  const missions = steerMissions({
    target: null,
    coverage: [{ feature: 'compassCellCount', deficit_weight: 0.4 }],
    shapes: [{ shape: 'hex', n_boards: 0, deficit_weight: 0.9 }],
  });
  assert.equal(missions.length, 2, 'both mission kinds must be live');

  for (let n = 1; n <= 10; n++) {
    const rules = RULES({ count: n, shapes: ['hex'], mods: ['compass'] });
    const plan = planMatchDeal(rows, rules, { rand: lcg(n + 1), missions });
    assert.equal(plan.picks.length, n, `match of ${n} must deal ${n} boards`);
    assert.ok(plan.steered.length <= steeredSlotCap(n),
      `N=${n}: ${plan.steered.length} steered against a cap of ${steeredSlotCap(n)}`);
  }
  // Non-vacuity: the cap must actually bind somewhere in that range, or the
  // loop above passes on a function that never steers at all.
  const ten = planMatchDeal(rows, RULES({ count: 10, shapes: ['hex'], mods: ['compass'] }),
    { rand: lcg(3), missions });
  assert.equal(ten.steered.length, 2, 'a 10-board match should spend both steered slots');
  const four = planMatchDeal(rows, RULES({ count: 4, shapes: ['hex'], mods: ['compass'] }),
    { rand: lcg(3), missions });
  assert.equal(four.steered.length, 0, 'a short match is pure variety (his ruling)');
});

test('two steered slots take two DIFFERENT missions, never double-sampling one', () => {
  const rows = Array.from({ length: 30 }, () => row({ shape: 'hex', mods: ['compass'] }));
  const missions = steerMissions({
    target: null,
    coverage: [{ feature: 'compassCellCount', deficit_weight: 0.4 }],
    shapes: [{ shape: 'hex', n_boards: 0, deficit_weight: 0.9 }],
  });
  const plan = planMatchDeal(rows, RULES({ count: 10, shapes: ['hex'], mods: ['compass'] }),
    { rand: lcg(5), missions });
  assert.equal(plan.steered.length, 2);
  const ids = plan.steered.map((s) => `${s.kind}:${s.key}`);
  assert.equal(new Set(ids).size, 2, `both slots went to ${ids[0]}`);
  // And onto two different boards.
  assert.equal(new Set(plan.steered.map((s) => s.boardKey)).size, 2);
});

test('a duplicated mission entry cannot claim two slots', () => {
  const missions = steerMissions({
    target: 'compassCellCount',
    coverage: [{ feature: 'compassCellCount', deficit_weight: 0.9 }],
    shapes: [
      { shape: 'hex', n_boards: 0, deficit_weight: 0.5 },
      { shape: 'hex', n_boards: 3, deficit_weight: 0.25 },
    ],
  });
  const ids = missions.map((m) => `${m.kind}:${m.key}`);
  assert.deepEqual([...new Set(ids)], ids, `duplicate missions survived: ${ids}`);
});

// ── "If no discovery can happen, that's fine" ───────────────────────────

test('an unadvanceable target deals normally and says nothing', () => {
  const rows = Array.from({ length: 20 }, () => row({ shape: 'rect', mods: [] }));
  const rules = RULES({ count: 10, shapes: ['rect'], mods: [] });
  const missions = steerMissions({
    target: 'compassCellCount',
    coverage: [{ feature: 'sonarCellCount', deficit_weight: 0.5 }],
    shapes: [{ shape: 'floret', n_boards: 0, deficit_weight: 1 }],
  });
  assert.ok(missions.length >= 3, 'the missions must exist to be unreachable');

  // The claim is that the deal is an ordinary one, which is about the boards
  // reachable, not about the rng stream: nothing here needs the cross-client
  // determinism the daily's selection does, so stream position is not a
  // contract and the tie-break shuffle is free to consume it.
  const reached = new Set();
  const rand = lcg(9);
  for (let i = 0; i < 400; i++) {
    const plan = planMatchDeal(rows, rules, { rand, missions });
    assert.equal(plan.steered.length, 0, 'nothing advanceable must claim a slot');
    assert.equal(plan.picks.length, 10);
    for (const p of plan.picks) reached.add(p.key);
  }
  assert.equal(reached.size, rows.length,
    'every eligible board must stay reachable when steering finds nothing');
});

test('an observational target never steers (digit shares are measured, not maximized)', () => {
  // clueShare4 is the live primary target as of 2026-08-12, and it must reach
  // nothing here for two independent reasons: it maps to no gimmick, and
  // missionCandidateScore refuses observational targets outright.
  const missions = steerMissions({ target: 'clueShare4', coverage: [], shapes: [] });
  assert.deepEqual(missions, []);
});

test('a decorrelation mission is not reachable from the index', () => {
  // The residual needs a digit share the index does not carry. The mission
  // must be absent, never half-scored on a missing column.
  const missions = steerMissions({
    target: 'wormLoad',
    coverage: [],
    shapes: [],
    decorrelation_mission: {
      feature: 'clueShare3', confounder: 'density',
      slope: 1, intercept: 0, residualSd: 1, weight: 0.9,
    },
  });
  assert.deepEqual(missions.map((m) => m.key), ['worm']);
});

// ── The seen-cycle survives ─────────────────────────────────────────────

test('steering deals unseen boards before seen ones', () => {
  // The starved shape sits on a SEEN board and on nothing else; unseen supply
  // is plentiful, so the cycle rule must refuse the steer.
  const seenHex = row({ shape: 'hex', mods: [] });
  const rows = [seenHex, ...Array.from({ length: 20 }, () => row({ shape: 'rect' }))];
  const rules = RULES({ count: 10, shapes: ['rect', 'hex'], mods: [] });
  const missions = steerMissions(shapeSpec('hex', 0.9));

  const plan = planMatchDeal(rows, rules, {
    rand: lcg(13), missions, seenKeys: [seenHex.key],
  });
  assert.equal(plan.steered.length, 0, 'a seen board must not be steered in early');
  assert.ok(!plan.picks.some((p) => p.key === seenHex.key),
    'the seen board must wait until the unseen supply runs out');
});

test('steering may reach a seen board once the unseen supply is short', () => {
  // Four eligible boards for a five-board match: one slot HAS to be a repeat,
  // and the starved shape is the honest one to spend it on.
  const seenHex = row({ shape: 'hex' });
  const rows = [seenHex, row({ shape: 'rect' }), row({ shape: 'rect' }), row({ shape: 'rect' })];
  const rules = RULES({ count: 5, shapes: ['rect', 'hex'], mods: [] });
  const missions = steerMissions(shapeSpec('hex', 0.9));

  const plan = planMatchDeal(rows, rules, {
    rand: lcg(4), missions, seenKeys: [seenHex.key],
  });
  assert.equal(plan.steered.length, 1);
  assert.equal(plan.steered[0].boardKey, seenHex.key);
  assert.equal(plan.cycled, true, 'the caller must be told to restart the seen list');
});

test('cycled means exactly what it meant before steering existed', () => {
  const rows = Array.from({ length: 6 }, () => row({ shape: 'hex', mods: [] }));
  const missions = steerMissions(shapeSpec('hex', 0.9));
  for (const seenCount of [0, 1, 3, 5, 6]) {
    for (const count of [1, 5, 10]) {
      const seenKeys = rows.slice(0, seenCount).map((r) => r.key);
      const rules = RULES({ count, shapes: ['hex'], mods: [] });
      const steeredPlan = planMatchDeal(rows, rules, { rand: lcg(2), missions, seenKeys });
      const plainPlan = planMatchDeal(rows, rules, { rand: lcg(2), missions: [], seenKeys });
      assert.equal(steeredPlan.cycled, plainPlan.cycled,
        `cycled diverged at seen=${seenCount} count=${count}`);
    }
  }
});

test('a match never deals the same board twice', () => {
  const rows = Array.from({ length: 12 }, () => row({ shape: 'hex', mods: ['compass'] }));
  const missions = steerMissions({
    target: null,
    coverage: [{ feature: 'compassCellCount', deficit_weight: 0.4 }],
    shapes: [{ shape: 'hex', n_boards: 0, deficit_weight: 0.9 }],
  });
  const rand = lcg(21);
  for (let trial = 0; trial < 200; trial++) {
    const plan = planMatchDeal(rows, RULES({ count: 10, shapes: ['hex'], mods: ['compass'] }),
      { rand, missions });
    const keys = plan.picks.map((p) => p.key);
    assert.equal(new Set(keys).size, keys.length, `trial ${trial} dealt a duplicate`);
  }
});

// ── "It can't feel forced" ──────────────────────────────────────────────

test('steered boards are spread through the match, not clustered at the front', () => {
  // One starved shape, one board of it, a five-board match: the steered board
  // must be able to land anywhere in the running order.
  const target = row({ shape: 'hex' });
  const rows = [target, ...Array.from({ length: 12 }, () => row({ shape: 'rect' }))];
  const rules = RULES({ count: 5, shapes: ['rect', 'hex'], mods: [] });
  const missions = steerMissions(shapeSpec('hex', 0.9));

  const positions = new Array(5).fill(0);
  const rand = lcg(99);
  const TRIALS = 4000;
  for (let i = 0; i < TRIALS; i++) {
    const plan = planMatchDeal(rows, rules, { rand, missions });
    assert.equal(plan.steered.length, 1);
    positions[plan.picks.findIndex((p) => p.key === target.key)]++;
  }
  // Uniform placement would be 800 each; a generous band still fails hard on
  // "always first", which is the failure mode that would announce steering.
  for (let i = 0; i < 5; i++) {
    assert.ok(positions[i] > TRIALS / 10,
      `position ${i} took only ${positions[i]} of ${TRIALS}: steered boards are clustering`);
  }
});

test('equal-weight missions break ties at random, never by list order', () => {
  // Three shapes tied at zero boards, the state the very first nights are in.
  // A fixed order would send every steered slot in the world to one of them.
  const rows = [
    row({ shape: 'hex' }), row({ shape: 'floret' }), row({ shape: 'cairo' }),
    ...Array.from({ length: 10 }, () => row({ shape: 'rect' })),
  ];
  const rules = RULES({ count: 5, shapes: ['rect', 'hex', 'floret', 'cairo'], mods: [] });
  const missions = steerMissions({
    target: null, coverage: [],
    shapes: ['hex', 'floret', 'cairo'].map((shape) => ({
      shape, n_boards: 0, deficit_weight: 1,
    })),
  });

  const hits = new Map();
  const rand = lcg(1234);
  for (let i = 0; i < 900; i++) {
    const plan = planMatchDeal(rows, rules, { rand, missions });
    assert.equal(plan.steered.length, 1);
    const k = plan.steered[0].key;
    hits.set(k, (hits.get(k) || 0) + 1);
  }
  assert.equal(hits.size, 3, `only ${[...hits.keys()]} ever won a tie`);
  for (const [shape, n] of hits) {
    assert.ok(n > 150, `${shape} won only ${n} of 900 ties`);
  }
});

test('the most starved mission still wins when weights differ', () => {
  const rows = [
    row({ shape: 'hex' }), row({ shape: 'floret' }),
    ...Array.from({ length: 10 }, () => row({ shape: 'rect' })),
  ];
  const rules = RULES({ count: 5, shapes: ['rect', 'hex', 'floret'], mods: [] });
  const missions = steerMissions({
    target: null, coverage: [],
    shapes: [
      { shape: 'hex', n_boards: 40, deficit_weight: 0.024 },
      { shape: 'floret', n_boards: 1, deficit_weight: 0.5 },
    ],
  });
  const rand = lcg(77);
  for (let i = 0; i < 300; i++) {
    const plan = planMatchDeal(rows, rules, { rand, missions });
    assert.equal(plan.steered[0].key, 'floret',
      'the thinner shape must take the slot every time');
  }
});

// ── Degradation ─────────────────────────────────────────────────────────

test('a missing or malformed experiment file steers nothing', () => {
  const rows = Array.from({ length: 10 }, () => row({ shape: 'hex', mods: ['compass'] }));
  const rules = RULES({ count: 10, shapes: ['hex'], mods: ['compass'] });
  for (const spec of [undefined, null, {}, { shapes: 'nope', coverage: 7 }]) {
    const missions = steerMissions(spec);
    const plan = planMatchDeal(rows, rules, { rand: lcg(6), missions });
    assert.equal(plan.steered.length, 0, `spec ${JSON.stringify(spec)} steered something`);
    assert.equal(plan.picks.length, 10);
  }
});

test('a shape row with a broken weight is dropped, not ranked on a NaN', () => {
  assert.deepEqual(normalizeShapeCoverage([
    { shape: 'hex', n_boards: 2, deficit_weight: 0.33 },
    { shape: 'floret', n_boards: 0, deficit_weight: 'lots' },
    { shape: 'cairo', n_boards: 0, deficit_weight: 0 },
    { shape: '', n_boards: 0, deficit_weight: 1 },
    null,
  ]), [{ shape: 'hex', n_boards: 2, deficit_weight: 0.33 }]);
  assert.deepEqual(normalizeShapeCoverage(null), []);
  assert.deepEqual(normalizeShapeCoverage('rect'), []);
});

test('an empty eligible set deals nothing rather than throwing', () => {
  const plan = planMatchDeal([row({ shape: 'rect' })], RULES({ count: 5, shapes: ['deltoidal'] }),
    { rand: lcg(1), missions: steerMissions(shapeSpec('deltoidal', 1)) });
  assert.deepEqual(plan.picks, []);
  assert.equal(plan.eligible, 0);
  assert.deepEqual(plan.steered, []);
});

test('currentSteerMissions reads the loaded file without throwing on a cold cache', () => {
  // No fetch has run in this process, so the module cache is empty: the
  // default target maps to no gimmick and there is no shape list.
  assert.deepEqual(currentSteerMissions(), []);
});

// ── The R/JS mirror pair ────────────────────────────────────────────────

const R_SRC = readFileSync(new URL('../scripts/refit-par-model.R', import.meta.url), 'utf8');

test('the refit emits shape_coverage into experimentTarget.json', () => {
  assert.ok(/shape_coverage\s*=\s*shape_coverage/.test(R_SRC),
    'shape_coverage is missing from the emitted experiment object');
  assert.ok(/shape_coverage_keys\s*<-\s*c\("rect",\s*names\(SHAPE_TABLE\)\)/.test(R_SRC),
    'the emitted shape keys must derive from SHAPE_TABLE, never a hand-kept list');
  assert.ok(/deficit_weight\s*=\s*round\(1\s*\/\s*\(cnt\s*\+\s*1\),\s*4\)/.test(R_SRC),
    'shape deficits must ride the same 1/(n+1) scale coverage_targets uses');
});

test('every shape the client can steer toward is a shape the refit can name', () => {
  // The refit's keys are 'rect' + SHAPE_TABLE, and SHAPE_TABLE is pinned
  // against TILING_TYPES by test/tilingParModelContract.test.mjs. So the set
  // the client may see is exactly this, and a mission built on any of them
  // must survive steerMissions rather than being silently dropped.
  const emitted = ['rect', ...TILING_TYPES];
  const missions = steerMissions({
    target: null, coverage: [],
    shapes: emitted.map((shape) => ({ shape, n_boards: 0, deficit_weight: 1 })),
  });
  assert.deepEqual(missions.map((m) => m.key), emitted);
  // Non-vacuity: TILING_TYPES must not be empty, or the assertion above holds
  // trivially on a one-element list.
  assert.ok(TILING_TYPES.length >= 6, 'the shipped lattice registry shrank');
});

test('the deal applies the filter itself, so no caller can hand it raw rows', () => {
  // planMatchDeal takes the FULL index and filters inside. A caller that
  // pre-filtered would be harmless; a caller that forgot must still be safe,
  // which is the whole reason the filter moved in here.
  const rows = [row({ shape: 'rect' }), row({ shape: 'deltoidal' })];
  const rules = RULES({ count: 2, shapes: ['rect'], mods: [] });
  const plan = planMatchDeal(rows, rules, { rand: lcg(1), missions: [] });
  assert.equal(plan.eligible, 1);
  assert.equal(plan.picks.length, 1);
  assert.equal(eligibleRows(rows, rules).length, 1);
});
