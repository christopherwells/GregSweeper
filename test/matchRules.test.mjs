// The Challenge match's rule vocabulary (src/logic/matchRules.js): the
// board-count bounds and steering cap are his rulings verbatim, the unlock
// derivation follows the Climb library's own introduction schedule, and the
// filter/pick pair is what the config sheet's live counts and the deal both
// stand on. Everything here is pure; the library DATA is held to its own
// contract in test/matchLibrary.test.mjs.

import test from 'node:test';
import assert from 'node:assert';
import {
  MATCH_BOARD_MIN, MATCH_BOARD_MAX, steeredSlotCap,
  MATCH_TIME_BANDS, MATCH_DENSITY_BANDS, timeBandOf, densityBandOf,
  densityPhrase, matchUnlocks, matchUnlockLevel,
  defaultMatchRules, sanitizeMatchRules,
  matchIndexRow, matchIndexFeatureKeys, parseMatchIndex, boardMatchesRules, eligibleRows,
  MATCH_PAR_CEILING_SECONDS,
  pickMatchBoards, matchAdvance, matchTotals, resolveMatchPicks,
  matchRulesForLaunch, unmetMatchRules,
} from '../src/logic/matchRules.js';
import { LIB_SHAPE_INTROS, LIB_MOD_INTROS } from '../src/logic/climbLibrary.js';
import { TILING_TYPES } from '../src/logic/tilingGeometry.js';
import { readFileSync } from 'node:fs';
// The real list, imported HERE and deliberately not in matchRules.js: a test
// pays no page weight for reaching into the solver.
import { CONTRIBUTION_FEATURE_KEYS } from '../src/logic/boardSolver.js';

// ── His rulings, as numbers ─────────────────────────────────────────────

test('a match is 1-10 boards (his ruling)', () => {
  assert.equal(MATCH_BOARD_MIN, 1);
  assert.equal(MATCH_BOARD_MAX, 10);
});

test('mission steering is capped at floor(N/5) (his ruling)', () => {
  assert.equal(steeredSlotCap(1), 0);
  assert.equal(steeredSlotCap(4), 0);
  assert.equal(steeredSlotCap(5), 1);
  assert.equal(steeredSlotCap(9), 1);
  assert.equal(steeredSlotCap(10), 2);
  assert.equal(steeredSlotCap(0), 0);
  assert.equal(steeredSlotCap(undefined), 0);
});

// ── Unlocks follow the library's introduction schedule ──────────────────

test('a fresh player gets Classic and nothing else', () => {
  assert.deepEqual(matchUnlocks(0), { shapes: ['rect'], mods: [] });
  assert.deepEqual(matchUnlocks(1), { shapes: ['rect'], mods: [] });
});

test('every shape and modifier unlocks exactly at its debut level', () => {
  for (const [block, shape] of Object.entries(LIB_SHAPE_INTROS)) {
    const lvl = matchUnlockLevel('shape', shape);
    assert.equal(lvl, (Number(block) - 1) * 5 + 1, `${shape} debut level`);
    assert.ok(!matchUnlocks(lvl - 1).shapes.includes(shape),
      `${shape} must stay locked below L${lvl}`);
    assert.ok(matchUnlocks(lvl).shapes.includes(shape),
      `${shape} must unlock at L${lvl}`);
  }
  for (const [block, mod] of Object.entries(LIB_MOD_INTROS)) {
    const lvl = matchUnlockLevel('mod', mod);
    assert.equal(lvl, (Number(block) - 1) * 5 + 1, `${mod} debut level`);
    assert.ok(!matchUnlocks(lvl - 1).mods.includes(mod),
      `${mod} must stay locked below L${lvl}`);
    assert.ok(matchUnlocks(lvl).mods.includes(mod),
      `${mod} must unlock at L${lvl}`);
  }
});

test('a crowned player has all seven shapes and all nine daily-safe modifiers', () => {
  const u = matchUnlocks(250);
  assert.deepEqual([...u.shapes].sort(), ['rect', ...TILING_TYPES].sort());
  assert.equal(u.mods.length, Object.keys(LIB_MOD_INTROS).length);
});

// ── Bands ───────────────────────────────────────────────────────────────

test('time bands split at two and four minutes, with an open top', () => {
  // His cutoffs, 2026-08-15, replacing 60/150: Quick under two minutes,
  // Standard two to four, Long past four. The old split sold a two-and-a-half
  // minute board as "Standard", which he called wrong the moment the
  // distribution was in front of him.
  assert.equal(MATCH_TIME_BANDS.length, 3);
  assert.equal(timeBandOf(119.9), 'quick');
  assert.equal(timeBandOf(120), 'short');
  assert.equal(timeBandOf(239.9), 'short');
  assert.equal(timeBandOf(240), 'long');
  assert.equal(timeBandOf(9999), 'long');
  // The top stays OPEN while the ceiling is an admission rule: a board past it
  // must never be un-bandable, or a re-price that nudged one over would leave
  // it in no corner at all.
  assert.equal(timeBandOf(MATCH_PAR_CEILING_SECONDS + 1), 'long');
  assert.equal(MATCH_PAR_CEILING_SECONDS, 600, 'his ceiling: ten minutes, for now');
});

test('density bands split at 0.16 and 0.26', () => {
  assert.equal(MATCH_DENSITY_BANDS.length, 3);
  assert.equal(densityBandOf(15, 100), 'sparse');
  assert.equal(densityBandOf(16, 100), 'standard');
  assert.equal(densityBandOf(26, 100), 'dense');
});

test('density is spoken as "~1 in N", never a decimal (his sheet ruling)', () => {
  assert.equal(densityPhrase(10, 40), '~1 in 4');
  assert.equal(densityPhrase(25, 100), '~1 in 4');
  assert.equal(densityPhrase(7, 85), '~1 in 12');
  assert.equal(densityPhrase(0, 40), '');
  assert.equal(densityPhrase(40, 40), '~1 in 2', 'floor of 2, never "~1 in 1"');
});

// ── Rules sanitation ────────────────────────────────────────────────────

const UNLOCKS = { shapes: ['rect', 'hex'], mods: ['walls', 'liar'] };

test('garbage rules degrade to the defaults, never a throw', () => {
  const def = defaultMatchRules(UNLOCKS);
  assert.deepEqual(sanitizeMatchRules(null, UNLOCKS), def);
  assert.deepEqual(sanitizeMatchRules('x', UNLOCKS), def);
  assert.deepEqual(sanitizeMatchRules({ count: 'a', shapes: 7, time: 'nope' }, UNLOCKS).time, 'any');
});

test('count clamps to 1-10 and rounds', () => {
  assert.equal(sanitizeMatchRules({ count: 0 }, UNLOCKS).count, 1);
  assert.equal(sanitizeMatchRules({ count: 99 }, UNLOCKS).count, 10);
  assert.equal(sanitizeMatchRules({ count: 7.6 }, UNLOCKS).count, 8);
});

test('locked shapes and modifiers are filtered out, empty shapes fall back', () => {
  const r = sanitizeMatchRules({ shapes: ['hex', 'deltoidal'], mods: ['walls', 'sonar'] }, UNLOCKS);
  assert.deepEqual(r.shapes, ['hex']);
  assert.deepEqual(r.mods, ['walls']);
  const empty = sanitizeMatchRules({ shapes: ['deltoidal'] }, UNLOCKS);
  assert.deepEqual(empty.shapes, UNLOCKS.shapes, 'no legal shape left means every unlocked shape');
});

test('REGRESSION: an empty modifier list survives sanitation (plain-boards-only is a real corner)', () => {
  // The plain corner is the one PR #288 widened the pool for; sanitation
  // treating [] as "missing" would silently turn his plain-only match into
  // an everything match.
  const r = sanitizeMatchRules({ mods: [] }, UNLOCKS);
  assert.deepEqual(r.mods, []);
});

// ── The index row contract ──────────────────────────────────────────────

test('matchIndexRow and parseMatchIndex round-trip, feature vector included', () => {
  const entry = {
    par: 73.2,
    spec: { shape: 'hex', cells: 72, mines: 12, gimmicks: ['sonar', 'liar'] },
    features: { cellCount: 72, sonarCellCount: 3, clueShare3: 0.123456789 },
  };
  const keys = matchIndexFeatureKeys([entry]);
  assert.deepEqual(keys, ['cellCount', 'clueShare3', 'sonarCellCount'], 'sorted union');
  const row = matchIndexRow(3, 7, entry, keys);
  const rows = parseMatchIndex({ featureKeys: keys, rows: [row] });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    page: 3, idx: 7, shape: 'hex', cells: 72, mines: 12, par: 73.2,
    mods: ['liar', 'sonar'], key: '3:7', oversized: false,
    // Rounded to MATCH_INDEX_FEATURE_DP: these numbers steer a choice among
    // boards, and par is re-priced from the page's full-precision copy.
    features: { cellCount: 72, clueShare3: 0.1235, sonarCellCount: 3 },
  });
});

// REGRESSION (2026-08-14): match boards began carrying gimmick-contribution
// features so the contribution study could finally see a Challenge board, and
// the index header, which is derived blind from whatever the boards hold, took
// them straight into the STEERING vector.
//
// Those keys may never steer. His ruling kept them out of `target_candidates`
// structurally rather than by convention, the stated mechanism being that
// "candidate vectors lack the keys, so a mission targeting one could never win
// a day". Measuring the boards removed that mechanism by accident. Excluding
// them here restores it, costs the study nothing (a dealt entry takes its
// features from the PAGE, not the index) and keeps 56 KB off every deal.
test('the index header carries NO contribution keys, so nothing can steer on one', () => {
  const entry = {
    par: 73.2,
    spec: { shape: 'hex', cells: 72, mines: 12, gimmicks: ['sonar', 'liar'] },
    features: {
      cellCount: 72, sonarCellCount: 3,
      sonarRequired: 1, sonarClicksSaved: 4, liarRequired: 0, liarClicksSaved: 0,
    },
  };
  const keys = matchIndexFeatureKeys([entry]);
  assert.deepEqual(keys, ['cellCount', 'sonarCellCount'],
    'the steerable features survive and the measurements do not');
  // The vector encodes positionally against that header, so an excluded key
  // must be absent after a round trip, not merely zeroed.
  const rows = parseMatchIndex({ featureKeys: keys, rows: [matchIndexRow(0, 0, entry, keys)] });
  assert.deepEqual(Object.keys(rows[0].features).sort(), ['cellCount', 'sonarCellCount']);
});

test('the exclusion rule and CONTRIBUTION_FEATURE_KEYS agree in BOTH directions', () => {
  // The rule is written as a suffix convention rather than as a copy of the
  // list, to keep the solver out of this leaf. That is only safe while the two
  // describe the same set, so this is the pin. Direction one: every real
  // contribution key is excluded.
  const asFeatures = Object.fromEntries(CONTRIBUTION_FEATURE_KEYS.map((k) => [k, 1]));
  assert.ok(CONTRIBUTION_FEATURE_KEYS.length > 0, 'non-vacuous: the list must not be empty');
  assert.deepEqual(matchIndexFeatureKeys([{ features: asFeatures }]), [],
    'every contribution key must be excluded from the header');

  // Direction two: nothing ELSE a real board carries gets caught by the suffix.
  // Driven off the live library rather than a hand-written list, so a feature
  // added tomorrow is covered without anyone remembering this test.
  const page = JSON.parse(readFileSync(
    new URL('../scripts/data/match-library/match-000.json', import.meta.url), 'utf8'));
  // The first LIVE board, not slot 0: since the tombstone eviction a slot may
  // hold `{ evicted, seed }`, which carries no features by design.
  const sample = page.boards.find((b) => b && !b.evicted);
  assert.ok(sample, 'non-vacuous: page 0 must hold at least one dealable board');
  const real = Object.keys(sample.features || {});
  assert.ok(real.length > 0, 'non-vacuous: the sample board must carry features');
  const excluded = real.filter((k) => !matchIndexFeatureKeys([{ features: { [k]: 1 } }]).length);
  assert.deepEqual(excluded.sort(), CONTRIBUTION_FEATURE_KEYS.filter((k) => real.includes(k)).sort(),
    'the suffix must catch the contribution keys and nothing else on a real board');
});

test('a row with NO feature vector still parses, and steers on nothing', () => {
  // An index cached from before the vector shipped must keep dealing boards.
  // Refusing it would turn a stale file into an unplayable Challenge, which is
  // a far worse trade than a quiet study.
  const legacy = [3, 7, 'hex', 72, 12, 73.2, ['liar', 'sonar']];
  const rows = parseMatchIndex({ rows: [legacy] });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].features, {});
  assert.equal(rows[0].par, 73.2, 'everything the deal needs still reads');
});

test('a missing feature value reads as 0, never as NaN', () => {
  // A board without one of the union's keys must not poison a comparison:
  // NaN > 0 is false, but NaN would spread through any arithmetic on it.
  const keys = ['a', 'b'];
  const entry = { par: 1, spec: { shape: 'rect', cells: 9, mines: 1, gimmicks: [] }, features: { a: 5 } };
  const rows = parseMatchIndex({ featureKeys: keys, rows: [matchIndexRow(0, 0, entry, keys)] });
  assert.deepEqual(rows[0].features, { a: 5, b: 0 });
});

test('parseMatchIndex refuses malformed rows outright', () => {
  assert.equal(parseMatchIndex(null), null);
  assert.equal(parseMatchIndex({}), null);
  assert.equal(parseMatchIndex({ rows: [[1, 2, 'rect']] }), null, 'short row');
  assert.equal(parseMatchIndex({ rows: [['a', 0, 'rect', 1, 1, 1, []]] }), null, 'non-integer page');
  assert.equal(parseMatchIndex({ rows: [[0, 0, 'rect', 1, 1, 1, 'sonar']] }), null, 'mods not a list');
});

// ── Eligibility ─────────────────────────────────────────────────────────

const row = (over) => ({
  page: 0, idx: 0, shape: 'rect', cells: 100, mines: 20, par: 45, mods: [], key: '0:0', ...over,
});

test('modifiers are an ALLOWED set: plain boards pass any rule, extras fail', () => {
  const rules = { shapes: ['rect'], mods: ['sonar'], time: 'any', density: 'any' };
  assert.ok(boardMatchesRules(row(), rules), 'a plain board is allowed under a sonar rule');
  assert.ok(boardMatchesRules(row({ mods: ['sonar'] }), rules));
  assert.ok(!boardMatchesRules(row({ mods: ['sonar', 'liar'] }), rules), 'liar is outside the rule');
  const plainOnly = { ...rules, mods: [] };
  assert.ok(!boardMatchesRules(row({ mods: ['sonar'] }), plainOnly), 'empty list means plain boards only');
});

test('shape, time band, and density band all filter', () => {
  const rules = { shapes: ['hex'], mods: [], time: 'quick', density: 'standard' };
  assert.ok(boardMatchesRules(row({ shape: 'hex' }), rules));
  assert.ok(!boardMatchesRules(row(), rules), 'wrong shape');
  // 200s is Standard under the two-and-four-minute cutoffs. It was 80s while
  // the split was 60/150, which stopped discriminating the moment Quick
  // widened to two minutes: the assertion passed on a board the filter now
  // (correctly) accepts.
  assert.ok(!boardMatchesRules(row({ shape: 'hex', par: 200 }), rules), 'wrong time band');
  assert.equal(timeBandOf(200), 'short', 'the par above must sit outside the quick band');
  assert.ok(!boardMatchesRules(row({ shape: 'hex', mines: 30 }), rules), 'wrong density band');
  assert.equal(eligibleRows([row(), row({ shape: 'hex' })], rules).length, 1);
});

// ── The pick: his seen-cycle rule at match scale ────────────────────────

const mkRows = (n) => Array.from({ length: n }, (_, i) =>
  row({ idx: i, key: `0:${i}` }));

test('picks are distinct within a match and deterministic under injected rand', () => {
  const rows = mkRows(6);
  const { picks } = pickMatchBoards(rows, 4, () => 0, []);
  assert.equal(picks.length, 4);
  assert.equal(new Set(picks.map((p) => p.key)).size, 4, 'no repeats inside one match');
  const again = pickMatchBoards(rows, 4, () => 0, []);
  assert.deepEqual(picks.map((p) => p.key), again.picks.map((p) => p.key));
});

test('unseen boards deal first; the cycle resets only when the space exhausts', () => {
  const rows = mkRows(4);
  const seen = ['0:0', '0:1', '0:2'];
  const one = pickMatchBoards(rows, 1, () => 0.99, seen);
  assert.equal(one.picks[0].key, '0:3', 'the one unseen board must deal first');
  assert.equal(one.cycled, false);
  const three = pickMatchBoards(rows, 3, () => 0, seen);
  assert.equal(three.picks[0].key, '0:3');
  assert.equal(three.cycled, true, 'reaching into seen boards is the cycle reset');
  assert.equal(new Set(three.picks.map((p) => p.key)).size, 3);
});

test('an eligible space smaller than the match deals what exists', () => {
  const { picks, cycled } = pickMatchBoards(mkRows(2), 5, () => 0.5, []);
  assert.equal(picks.length, 2);
  assert.equal(cycled, false, 'nothing seen to cycle into');
});

// ── Progression + totals ────────────────────────────────────────────────

test('matchAdvance says next until the last board, then summary', () => {
  assert.equal(matchAdvance({ entries: [1, 2, 3], current: 0 }), 'next');
  assert.equal(matchAdvance({ entries: [1, 2, 3], current: 1 }), 'next');
  assert.equal(matchAdvance({ entries: [1, 2, 3], current: 2 }), 'summary');
  assert.equal(matchAdvance(null), 'summary');
  assert.equal(matchAdvance({}), 'summary');
});

test('totals sum per-board times and penalties; adjusted is time over k (the leaderboard convention)', () => {
  const results = [
    { time: 61.2, penalty: 4.5 },
    { time: 30.1, penalty: 0 },
  ];
  assert.deepEqual(matchTotals(results, 1.5), { raw: 91.3, penalty: 4.5, adjusted: 60.9 });
});

test('an unrated player gets no adjusted total, never a fake 1.0 pretense', () => {
  const results = [{ time: 50, penalty: 0 }];
  assert.equal(matchTotals(results, null).adjusted, null);
  assert.equal(matchTotals(results, 0).adjusted, null);
  assert.equal(matchTotals(results, NaN).adjusted, null);
  assert.equal(matchTotals([], 2).raw, 0);
});

// ── Whose rules a launch plays (the host-unlocks ruling) ────────────────

test('a HOST re-sanitizes against their own current unlocks', () => {
  // A saved rule set from before a progression reset must never reach outside
  // what this player has met (his rule: the host's filter IS the rules).
  const unlocks = { shapes: ['rect'], mods: [] };
  const out = matchRulesForLaunch(
    { count: 4, shapes: ['rect', 'hex'], mods: ['worm'], time: 'any', density: 'any' },
    null, unlocks,
  );
  assert.deepStrictEqual(out.shapes, ['rect']);
  assert.deepStrictEqual(out.mods, []);
  assert.strictEqual(out.count, 4);
});

test('REGRESSION: a GUEST plays the stored rules verbatim, never the intersection', () => {
  // His ruling is that the HOST's unlocks build the match, with a warning
  // naming what the guest has not met. Re-sanitizing here against the guest's
  // own unlocks would silently rewrite the match the two of them agreed to
  // play, and the boards are already dealt and frozen, so it would also
  // describe a set of boards that is not the one being played.
  const hostRules = { count: 5, shapes: ['rect', 'cairo'], mods: ['worm', 'liar'], time: 'quick', density: 'any' };
  const guestUnlocks = { shapes: ['rect'], mods: [] };
  const out = matchRulesForLaunch(null, { rules: hostRules }, guestUnlocks);
  assert.strictEqual(out, hostRules, 'the stored object must pass through untouched');
  assert.deepStrictEqual(out.shapes, ['rect', 'cairo']);
  assert.deepStrictEqual(out.mods, ['worm', 'liar']);
});

test('a shared node with no rules still degrades to a sanitized set', () => {
  const unlocks = { shapes: ['rect'], mods: [] };
  for (const shared of [{}, { rules: null }, { rules: 'nope' }]) {
    const out = matchRulesForLaunch(null, shared, unlocks);
    assert.ok(out && Array.isArray(out.shapes) && out.shapes.length > 0);
  }
});

test('unmetMatchRules NAMES what a guest has not met, and removes nothing', () => {
  const rules = { shapes: ['rect', 'cairo', 'floret'], mods: ['worm', 'liar'] };
  const unmet = unmetMatchRules(rules, { shapes: ['rect', 'cairo'], mods: ['liar'] });
  assert.deepStrictEqual(unmet.shapes, ['floret']);
  assert.deepStrictEqual(unmet.mods, ['worm']);
  // The rules object itself is untouched: this reports, it does not filter.
  assert.deepStrictEqual(rules.shapes, ['rect', 'cairo', 'floret']);
});

test('unmetMatchRules is empty when the guest has met everything, and never throws', () => {
  assert.deepStrictEqual(
    unmetMatchRules({ shapes: ['rect'], mods: [] }, { shapes: ['rect', 'hex'], mods: ['worm'] }),
    { shapes: [], mods: [] });
  assert.deepStrictEqual(unmetMatchRules(null, null), { shapes: [], mods: [] });
  assert.deepStrictEqual(unmetMatchRules({}, { shapes: [], mods: [] }), { shapes: [], mods: [] });
});

// ── Resolving picks against fetched pages ───────────────────────────────

test('REGRESSION: a page that fails MID-deal marks the boards actually dealt', () => {
  // The defect: the caller collected entries and then took the first
  // `entries.length` picks as the seen keys, which is only right when the
  // failures land at the end. Here the FIRST pick is the broken one, so a
  // slice would mark 0:0 and 0:1 seen while 0:1 and 0:2 were the boards
  // dealt: one board marked that nobody played, one played that nobody
  // marked, quietly corrupting his cycle rule.
  const picks = [
    { page: 0, idx: 0, key: '0:0' },
    { page: 0, idx: 1, key: '0:1' },
    { page: 0, idx: 2, key: '0:2' },
  ];
  const byPage = new Map([[0, [
    { seed: 'a' },                        // no payload: malformed
    { seed: 'b', payload: {} },
    { seed: 'c', payload: {} },
  ]]]);
  const { entries, keys, missing } = resolveMatchPicks(picks, byPage);
  assert.deepEqual(keys, ['0:1', '0:2']);
  assert.deepEqual(entries.map((e) => e.seed), ['b', 'c']);
  assert.deepEqual(missing.map((p) => p.key), ['0:0']);
  // The invariant the slice broke: one key per entry, in the same order.
  assert.equal(keys.length, entries.length);
});

test('resolveMatchPicks survives a page that never arrived', () => {
  const picks = [{ page: 0, idx: 0, key: '0:0' }, { page: 9, idx: 0, key: '9:0' }];
  const byPage = new Map([[0, [{ seed: 'a', payload: {} }]], [9, null]]);
  const { entries, keys, missing } = resolveMatchPicks(picks, byPage);
  assert.deepEqual(keys, ['0:0']);
  assert.equal(entries.length, 1);
  assert.deepEqual(missing.map((p) => p.key), ['9:0']);
  // And an empty deal is a no-op rather than a throw.
  assert.deepEqual(resolveMatchPicks([], new Map()), { entries: [], keys: [], missing: [] });
  assert.deepEqual(resolveMatchPicks(null, null), { entries: [], keys: [], missing: [] });
});

// ── The difficulty axis (his ruling 2026-08-16: Gentle/Standard/Mean at
// 1.0/2.0 seconds per cell, ppc being the ladder's own currency) ─────────

import {
  MATCH_DIFFICULTY_BANDS, difficultyBandOf, boardMatchesRules as bmr,
  sanitizeMatchRules as smr, buildMatchCorners as bmc, parseMatchSummary as pms,
  countEligibleCorners as cec, needsTenths, fmtClock,
} from '../src/logic/matchRules.js';

test('difficultyBandOf cuts at 1.0 and 2.0 seconds per cell', () => {
  assert.equal(difficultyBandOf(50, 100), 'gentle');
  assert.equal(difficultyBandOf(100, 100), 'standard', 'the boundary belongs upward');
  assert.equal(difficultyBandOf(199, 100), 'standard');
  assert.equal(difficultyBandOf(200, 100), 'mean');
  assert.equal(MATCH_DIFFICULTY_BANDS.map((b) => b.label).join('/'), 'Gentle/Standard/Mean');
});

test('rules stored before difficulty shipped read as any, never refuse', () => {
  const row = { shape: 'rect', mods: [], par: 150, mines: 20, cells: 100 };
  const legacy = { shapes: ['rect'], mods: [], time: 'any', density: 'any' };
  assert.equal(bmr(row, legacy), true, 'an absent difficulty is any');
  const un = { shapes: ['rect'], mods: ['sonar'] };
  const sane = smr({ ...legacy, difficulty: 'nonsense' }, un);
  assert.equal(sane.difficulty, 'any', 'garbage degrades, never throws');
  assert.equal(smr({ ...legacy, difficulty: 'mean' }, un).difficulty, 'mean');
});

test('the summary difficulty split is exact, and an old summary still parses', () => {
  // ONE corner (rect, plain, quick, sparse) spanning all three ppc bands:
  // cells are not corners, so the difficulty spread must come from cell
  // count at a fixed time band, not from par alone.
  const rows = [
    { shape: 'rect', mods: [], par: 100, mines: 12, cells: 120, key: 'a' },
    { shape: 'rect', mods: [], par: 110, mines: 8, cells: 80, key: 'b' },
    { shape: 'rect', mods: [], par: 115, mines: 5, cells: 50, key: 'c' },
  ];
  const corners = pms({ corners: bmc(rows) });
  assert.equal(corners.length, 1, 'one corner: same shape, band, and density');
  assert.deepEqual(corners[0].diff, [1, 1, 1]);
  const rules = { shapes: ['rect'], mods: [], time: 'any', density: 'any', difficulty: 'mean' };
  assert.equal(cec(corners, rules), 1, 'the split answers a difficulty filter exactly');
  // A summary cached before the split shipped: five-element tuples.
  const old = pms({ corners: [['rect', '', 'quick', 'sparse', 3]] });
  assert.equal(old[0].diff, null);
  assert.equal(cec(old, rules), 3,
    'a stale summary overstates gracefully rather than refusing to count');
});

test('tenths appear only when a gap is inside one second (his ruling)', () => {
  assert.equal(needsTenths([372.4, 398.1]), false);
  assert.equal(needsTenths([372.4, 372.9]), true);
  assert.equal(needsTenths([372.4]), false);
  assert.equal(needsTenths([100, 250, 250.4]), true, 'any close pair is enough');
  assert.equal(fmtClock(372.4), '6:12');
  assert.equal(fmtClock(372.4, true), '6:12.4');
  assert.equal(fmtClock(41.23, true), '41.2s');
  assert.equal(fmtClock(41.23), '41s');
  assert.equal(fmtClock(59.96), '1:00', 'rounding must carry, never print 0:60');
  assert.equal(fmtClock(-3), '');
});

// ── The rules node whitelist, in lockstep with what the client writes ───

test('REGRESSION: every rules field the client writes is whitelisted in the match node', () => {
  // The 866683d class, paid again on 2026-08-16: the difficulty axis added a
  // field to defaultMatchRules and nobody added it to firebase-rules.json's
  // matches rules block, whose $other refuses unknown children, so every
  // shared-match create dropped whole with "Try again in a moment". The
  // client's own rules shape and the server's whitelist must move together.
  const rules = JSON.parse(readFileSync(new URL('../firebase-rules.json', import.meta.url), 'utf8'));
  const block = rules.rules.matches.$matchId.rules;
  const allowed = new Set(Object.keys(block).filter((k) => !k.startsWith('.') && k !== '$other'));
  const unlocks = { shapes: ['rect'], mods: [] };
  const written = sanitizeMatchRules(defaultMatchRules(unlocks), unlocks);
  for (const key of Object.keys(written)) {
    assert.ok(allowed.has(key),
      `the client writes rules.${key} but the match node's whitelist lacks it`);
  }
});

// ── The SCROLL opt-in (the marathon lane's rules child, 2026-08-17) ──────
// A boolean, not a band: true admits OVERSIZED boards (bigger than the phone
// fit, played through the camera) alongside everything else; false or absent
// deals the fit-legal library only. Exact `=== true` on both sides because a
// guest plays host rules UNSANITIZED, so absent, false, and garbage must all
// read the safe way.

import {
  matchShardFileForRow, matchShardFilesFor, oversizedShardPrefix,
  MATCH_SHARD_PREFIX,
} from '../src/logic/matchRules.js';

test('an oversized row deals only under the scroll opt-in, and fit rows always deal', () => {
  const fit = { shape: 'rect', mods: [], par: 150, mines: 20, cells: 100 };
  const over = { ...fit, oversized: true };
  const base = { shapes: ['rect'], mods: [], time: 'any', density: 'any', difficulty: 'any' };
  assert.equal(bmr(over, { ...base, scroll: true }), true, 'opt-in admits');
  assert.equal(bmr(over, { ...base, scroll: false }), false);
  assert.equal(bmr(over, base), false, 'absent reads as excluded, never as any');
  // A guest plays host rules verbatim, so garbage must read as excluded too.
  assert.equal(bmr(over, { ...base, scroll: 'yes' }), false);
  assert.equal(bmr(over, { ...base, scroll: 1 }), false);
  // Allowed, never required: the opt-in widens the deal, fit rows stay in.
  assert.equal(bmr(fit, { ...base, scroll: true }), true);
  assert.equal(bmr(fit, base), true);
});

test('sanitize coerces scroll to an exact boolean; defaults carry it false', () => {
  const un = { shapes: ['rect'], mods: [] };
  assert.equal(defaultMatchRules(un).scroll, false);
  assert.equal(smr({ shapes: ['rect'], mods: [], scroll: true }, un).scroll, true);
  assert.equal(smr({ shapes: ['rect'], mods: [], scroll: 'yes' }, un).scroll, false);
  assert.equal(smr({ shapes: ['rect'], mods: [] }, un).scroll, false);
});

test('the index row carries oversized as an appended 1; fit rows keep their exact shape', () => {
  const entry = {
    par: 73.2, oversized: true,
    spec: { shape: 'hex', cells: 288, mines: 40, gimmicks: [] },
    features: { cellCount: 288 },
  };
  const keys = matchIndexFeatureKeys([entry]);
  const row = matchIndexRow(3, 7, entry, keys);
  assert.equal(row.length, 9, 'the flag rides element 8');
  assert.equal(parseMatchIndex({ featureKeys: keys, rows: [row] })[0].oversized, true);
  // A fit entry's row is BYTE-stable: no ninth element, so the shipped
  // library's files do not change shape underneath the flag.
  const fitRow = matchIndexRow(3, 8, { ...entry, oversized: undefined }, keys);
  assert.equal(fitRow.length, 8);
  assert.equal(parseMatchIndex({ featureKeys: keys, rows: [fitRow] })[0].oversized, false);
});

test('the summary oversized split is exact under scroll and difficulty together', () => {
  // One corner (rect, plain, quick, sparse) holding a fit board and an
  // oversized board in DIFFERENT difficulty bands, so every filter combo
  // has a distinct exact answer the sweep can check against eligibleRows.
  const rows = [
    { shape: 'rect', mods: [], par: 100, mines: 12, cells: 120, key: 'a' },
    { shape: 'rect', mods: [], par: 110, mines: 8, cells: 80, key: 'b' },
    { shape: 'rect', mods: [], par: 115, mines: 5, cells: 50, key: 'c', oversized: true },
  ];
  const corners = pms({ corners: bmc(rows) });
  assert.equal(corners.length, 1);
  assert.deepEqual(corners[0].diff, [1, 1, 1]);
  assert.deepEqual(corners[0].over, [0, 0, 1], 'the oversized split rides its difficulty band');
  const base = { shapes: ['rect'], mods: [], time: 'any', density: 'any' };
  for (const difficulty of ['any', 'gentle', 'mean']) {
    for (const scroll of [true, false]) {
      const rules = { ...base, difficulty, scroll };
      assert.equal(cec(corners, rules), eligibleRows(rows, rules).length,
        `exact under difficulty=${difficulty} scroll=${scroll}`);
    }
  }
  // An all-fit library emits NO over element: the summary's bytes are
  // unchanged until the lane actually holds a board.
  const fitOnly = bmc(rows.slice(0, 2));
  assert.equal(fitOnly[0].length, 6, 'no seventh element without oversized boards');
  assert.equal(pms({ corners: fitOnly })[0].over, null);
  // A summary cached before the split: six-element tuples still parse and
  // count exactly (they described a library with no oversized boards).
  const old = pms({ corners: [['rect', '', 'quick', 'sparse', 3, [1, 1, 1]]] });
  assert.equal(old[0].over, null);
  assert.equal(cec(old, { ...base, difficulty: 'any', scroll: false }), 3);
});

test('oversized rows shard into their own file class, fetched only under the opt-in', () => {
  const fit = { shape: 'rect', mods: [], par: 100, mines: 12, cells: 120 };
  const over = { ...fit, oversized: true };
  assert.equal(matchShardFileForRow(fit), 'mx-rect-quick-sparse-none.json');
  assert.equal(matchShardFileForRow(over), 'mxo-rect-quick-sparse-none.json');
  // The mxo- name never matches an /^mx-/ scan: the two file classes stay
  // separate to every directory walk that predates the lane.
  assert.equal(/^mx-/.test(oversizedShardPrefix(MATCH_SHARD_PREFIX) + '-'), false);

  const corners = pms({ corners: bmc([fit, { ...over, key: 'k' }]) });
  const rules = { shapes: ['rect'], mods: [], time: 'quick', density: 'sparse' };
  const off = matchShardFilesFor(rules, corners);
  assert.deepEqual(off, ['mx-rect-quick-sparse-none.json'],
    'without the opt-in the oversized shard is never requested');
  const on = matchShardFilesFor({ ...rules, scroll: true }, corners);
  assert.deepEqual(on,
    ['mx-rect-quick-sparse-none.json', 'mxo-rect-quick-sparse-none.json']);
  // A pre-split summary (over null) understates gracefully: base only.
  const oldCorners = pms({ corners: [['rect', '', 'quick', 'sparse', 2, [1, 1, 0]]] });
  assert.deepEqual(matchShardFilesFor({ ...rules, scroll: true }, oldCorners),
    ['mx-rect-quick-sparse-none.json']);
  // A corner that is ALL oversized has no base file to request.
  const allOver = pms({ corners: bmc([{ ...over, key: 'k' }]) });
  assert.deepEqual(matchShardFilesFor({ ...rules, scroll: true }, allOver),
    ['mxo-rect-quick-sparse-none.json']);
  assert.deepEqual(matchShardFilesFor(rules, allOver), [],
    'an all-oversized corner offers nothing without the opt-in');
});

// ── The per-space seen reset (issue #305) ────────────────────────────────

test('REGRESSION #305: exhausting a narrow filter resets only that space, never the library-wide record', async () => {
  const { nextMatchSeen } = await import('../src/logic/matchRules.js');
  // A player with history across the library plays a two-board Petals-only
  // corner to exhaustion. The old reset replaced the WHOLE list with the
  // dealt keys; the fix removes only the exhausted space's keys.
  const seen = ['0:1', '0:2', '7:4', 'c:seed-a', 'p:1', 'p:2'];
  const eligible = ['p:1', 'p:2', 'p:3'];
  const dealt = ['p:3', 'p:1'];
  const next = nextMatchSeen(seen, eligible, dealt, true);
  for (const k of ['0:1', '0:2', '7:4', 'c:seed-a']) {
    assert.ok(next.includes(k), `${k} was played under other rules and must keep its no-repeat standing`);
  }
  assert.ok(next.includes('p:3') && next.includes('p:1'), 'the re-dealt space records its new cycle');
  assert.ok(!next.includes('p:2'), 'the exhausted corner\'s undealt key resets');
});

test('a non-cycled deal appends, and no key ever doubles', async () => {
  const { nextMatchSeen } = await import('../src/logic/matchRules.js');
  const next = nextMatchSeen(['0:1', '0:2'], ['0:1', '0:2', '0:3', '0:4'], ['0:3'], false);
  assert.deepEqual(next, ['0:1', '0:2', '0:3']);
  // A cycled deal that re-serves a still-listed key keeps one copy.
  const again = nextMatchSeen(['a', 'x:1'], ['x:1', 'x:2'], ['x:1'], true);
  assert.deepEqual(again, ['a', 'x:1']);
});
