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
  pickMatchBoards, matchAdvance, matchTotals, resolveMatchPicks,
  matchRulesForLaunch, unmetMatchRules,
} from '../src/logic/matchRules.js';
import { LIB_SHAPE_INTROS, LIB_MOD_INTROS } from '../src/logic/climbLibrary.js';
import { TILING_TYPES } from '../src/logic/tilingGeometry.js';

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

test('time bands split at 60 and 150 with an open top', () => {
  assert.equal(MATCH_TIME_BANDS.length, 3);
  assert.equal(timeBandOf(59.9), 'quick');
  assert.equal(timeBandOf(60), 'short');
  assert.equal(timeBandOf(149.9), 'short');
  assert.equal(timeBandOf(150), 'long');
  assert.equal(timeBandOf(9999), 'long');
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
    mods: ['liar', 'sonar'], key: '3:7',
    // Rounded to MATCH_INDEX_FEATURE_DP: these numbers steer a choice among
    // boards, and par is re-priced from the page's full-precision copy.
    features: { cellCount: 72, clueShare3: 0.1235, sonarCellCount: 3 },
  });
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
  assert.ok(!boardMatchesRules(row({ shape: 'hex', par: 80 }), rules), 'wrong time band');
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
