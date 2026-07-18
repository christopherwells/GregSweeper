// Board heatmap pure layer: the rollup's aggregation decisions and the
// notebook exhibit's honesty gate.
//
// The gate is the point of the feature. Until a board has a real
// audience there is no honest population claim to make, so the exhibit
// does not exist at all below MIN_PLAYERS_FOR_HEATMAP: no map, no
// waiting copy, no card. These tests pin that, plus the rule that
// shading is a RATE against the solver count rather than a rank against
// the board's own busiest square, and that the map never opens on a
// board the player still has ahead of them (it is a partial mine map,
// and past dailies are replayable).
//
// Run: node --test test/heatmapAggregate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_PLAYERS_FOR_HEATMAP,
  HEAT_BANDS,
  HEAT_LEVELS,
  aggregateBombHits,
  cellKey,
  parseCellKey,
  heatLevel,
  maxCellCount,
  drawableCells,
  selectHeatmapDate,
  heatmapCopy,
} from '../src/logic/boardHeatmap.js';

const BOARD = { rows: 10, cols: 10, totalMines: 20 };

function row(uid, hits, extra = {}) {
  return {
    uid,
    bombHits: hits.length,
    bombHitEvents: hits.map(([r, c], i) => ({ t: i + 1, row: r, col: c })),
    ...extra,
  };
}

// ── aggregation ──────────────────────────────────────────────────────

test('sums hits per cell and counts distinct solvers', () => {
  const agg = aggregateBombHits([
    row('a', [[1, 1], [2, 2]]),
    row('b', [[1, 1]]),
    row('c', []),
  ], BOARD);

  assert.equal(agg.cells[cellKey(1, 1)], 2, 'two players hit 1_1');
  assert.equal(agg.cells[cellKey(2, 2)], 1);
  assert.equal(agg.totals, 3);
  assert.equal(agg.nPlayers, 3, 'a player who hit nothing still solved the board');
});

test('n_players counts solvers, not hitters', () => {
  const agg = aggregateBombHits([row('a', []), row('b', []), row('c', [])], BOARD);
  assert.equal(agg.nPlayers, 3);
  assert.equal(agg.totals, 0);
  assert.deepEqual(agg.cells, {}, 'a clean board publishes an empty map, not a fake one');
});

test('one row per player: a replay never doubles that player s struggle', () => {
  const agg = aggregateBombHits([
    row('a', [[3, 3]], { timestamp: 100 }),
    row('a', [[4, 4], [5, 5]], { timestamp: 200, archivePlay: true }),
  ], BOARD);

  assert.equal(agg.nPlayers, 1, 'same uid is one person');
  assert.equal(agg.totals, 1, 'the day-of attempt is the one that counts');
  assert.equal(agg.cells[cellKey(3, 3)], 1);
  assert.equal(agg.cells[cellKey(4, 4)], undefined, 'the archive replay was not also counted');
});

test('one row per player: the archive row is used when there is no day-of row', () => {
  const agg = aggregateBombHits([
    row('a', [[4, 4]], { timestamp: 200, archivePlay: true }),
  ], BOARD);
  assert.equal(agg.nPlayers, 1);
  assert.equal(agg.cells[cellKey(4, 4)], 1);
});

test('REGRESSION: a brute-force probe run is dropped, not mapped', () => {
  // A run that detonates more than 30% of the mines is reading the
  // layout, not struggling with it. The submit gate rejects these now,
  // but historical rows exist and one of them would otherwise light up
  // most of the board.
  const probe = Array.from({ length: 15 }, (_, i) => [i % 10, Math.floor(i / 10)]);
  const agg = aggregateBombHits([
    row('cheat', probe),
    row('honest', [[1, 1]]),
  ], BOARD);

  assert.equal(agg.nCheatRows, 1);
  assert.equal(agg.totals, 1, 'only the honest hit survived');
  assert.equal(agg.cells[cellKey(1, 1)], 1);
  // Someone who detonates a third of the mines is messing around, not
  // playing, so they leave the denominator too (Christopher, 2026-07-18).
  assert.equal(agg.nPlayers, 1, 'the probe player is not counted as a solver');
});

test('out-of-bounds and malformed coordinates are dropped', () => {
  const agg = aggregateBombHits([{
    uid: 'a',
    bombHits: 4,
    bombHitEvents: [
      { t: 1, row: 99, col: 0 },
      { t: 2, row: 0, col: -1 },
      { t: 3, row: 'x', col: 2 },
      { t: 4, row: 2, col: 2 },
    ],
  }], BOARD);

  assert.equal(agg.totals, 1, 'only the in-bounds integer hit counted');
  assert.equal(agg.cells[cellKey(2, 2)], 1);
  assert.ok(agg.nOutOfBounds >= 2);
});

test('object-shaped bombHitEvents (Firebase sparse keys) aggregate the same', () => {
  const agg = aggregateBombHits([{
    uid: 'a',
    bombHits: 2,
    bombHitEvents: { 0: { t: 1, row: 1, col: 1 }, 2: { t: 2, row: 1, col: 1 } },
  }], BOARD);
  assert.equal(agg.cells[cellKey(1, 1)], 2);
});

test('rows without a uid are ignored entirely', () => {
  const agg = aggregateBombHits([
    { bombHits: 1, bombHitEvents: [{ t: 1, row: 1, col: 1 }] },
    row('a', [[2, 2]]),
  ], BOARD);
  assert.equal(agg.nPlayers, 1);
  assert.equal(agg.cells[cellKey(1, 1)], undefined);
});

test('empty and junk input never throws', () => {
  for (const input of [[], null, undefined, [null, 3, 'x']]) {
    const agg = aggregateBombHits(/** @type {any} */ (input), BOARD);
    assert.equal(agg.nPlayers, 0);
    assert.equal(agg.totals, 0);
  }
});

// ── cell keys + shading ──────────────────────────────────────────────

test('cell keys round-trip and reject junk', () => {
  assert.equal(cellKey(3, 7), '3_7');
  assert.deepEqual(parseCellKey('3_7'), { r: 3, c: 7 });
  assert.deepEqual(parseCellKey('12_0'), { r: 12, c: 0 });
  for (const bad of ['', 'a_b', '3-7', '3_7_1', '999_1', null]) {
    assert.equal(parseCellKey(/** @type {any} */ (bad)), null, `${bad} must not parse`);
  }
});

test('maxCellCount finds the busiest cell', () => {
  assert.equal(maxCellCount({ '1_1': 2, '2_2': 5, '3_3': 1 }), 5);
  assert.equal(maxCellCount({}), 0);
  assert.equal(maxCellCount(null), 0);
});

// ── shading is a rate, not a rank ────────────────────────────────────

test('REGRESSION: shading is the share of solvers, never a rank against the busiest square', () => {
  // Scaling to the board's own maximum made a board where three people
  // had a bad moment and nobody else did light up as though it were
  // brutal, because those three WERE the maximum. On a fixed rate scale
  // three of thirty reads as the 10% it is (Christopher, 2026-07-18).
  const lonely = heatLevel(3, 30);
  const brutal = heatLevel(3, 3);
  assert.ok(lonely < HEAT_LEVELS, 'three of thirty is not the top of the scale');
  assert.equal(brutal, HEAT_LEVELS, 'three of three is');
  assert.equal(heatLevel(1, 30), 1, 'a lone hit is drawn, at the faintest step');
});

test('the same count shades differently as the denominator grows', () => {
  const counts = [30, 60, 120].map(n => heatLevel(6, n));
  assert.ok(counts[0] >= counts[1] && counts[1] >= counts[2],
    'a fixed count is a smaller share of a bigger field, so it can only fade');
});

test('heat levels stay inside 1..HEAT_LEVELS and honor the band edges', () => {
  for (const edge of HEAT_BANDS) {
    const atEdge = heatLevel(Math.round(edge * 100), 100);
    assert.ok(atEdge >= 1 && atEdge <= HEAT_LEVELS, `level out of range at ${edge}`);
  }
  assert.equal(heatLevel(100, 100), HEAT_LEVELS, 'every solver hitting it is the darkest step');
  assert.equal(heatLevel(0, 30), 0, 'untouched squares are unshaded');
  assert.equal(heatLevel(5, 0), 0, 'a zero denominator cannot shade anything');
  assert.equal(heatLevel(NaN, 30), 0);
});

test('drawableCells keeps every touched square and carries the denominator', () => {
  const drawn = drawableCells({ '1_1': 1, '2_2': 7 }, 30);
  assert.equal(drawn.nDrawn, 2, 'a single hit is perfectly fine to color');
  assert.equal(drawn.nPlayers, 30, 'the denominator travels with the counts');
  assert.equal(drawn.cells['1_1'], 1);
});

test('drawableCells ignores junk values and empty maps', () => {
  assert.equal(drawableCells({ a: 'x', b: null, c: NaN, d: 0, e: -2 }, 30).nDrawn, 0);
  assert.equal(drawableCells({}, 30).nDrawn, 0);
  assert.equal(drawableCells(null, 30).nDrawn, 0);
});

// ── the board gate ───────────────────────────────────────────────────

const entry = (date, n) => ({ date, payload: { n_players: n, totals: n, cells: {}, rows: 10, cols: 10 } });

test('REGRESSION: a board without the audience produces no exhibit at all', () => {
  // Not a waiting message and not an empty frame. Below the threshold
  // the feature is invisible (Christopher, 2026-07-18).
  const entries = [entry('2026-07-10', 7), entry('2026-07-11', 4)];
  const plan = selectHeatmapDate(entries, ['2026-07-10', '2026-07-11']);
  assert.equal(plan.state, 'none', 'seven solvers is one afternoon, not a population');
  assert.equal(plan.payload, null, 'no payload means nothing can be painted');
  assert.equal(heatmapCopy(plan, ''), null, 'and no copy, so no card renders');
});

test('a qualified board the player solved renders', () => {
  const entries = [entry('2026-07-10', MIN_PLAYERS_FOR_HEATMAP), entry('2026-07-09', 40)];
  const plan = selectHeatmapDate(entries, ['2026-07-10']);
  assert.equal(plan.state, 'ready');
  assert.equal(plan.date, '2026-07-10', 'the most recent qualified board the player has solved');
});

test('a ready plan hands the caller the counts AND their denominator', () => {
  const entries = [{
    date: '2026-07-10',
    payload: { n_players: 40, totals: 9, rows: 10, cols: 10, cells: { '1_1': 8, '2_2': 1 } },
  }];
  const plan = selectHeatmapDate(entries, ['2026-07-10']);
  assert.equal(plan.state, 'ready');
  assert.equal(plan.drawn.nDrawn, 2, 'every touched square is drawn');
  assert.equal(plan.drawn.nPlayers, 40, 'a count can never be shaded without its share');
  assert.ok(heatLevel(plan.drawn.cells['2_2'], plan.drawn.nPlayers)
    < heatLevel(plan.drawn.cells['1_1'], plan.drawn.nPlayers),
    'one of forty must read fainter than eight of forty');
});

test('the newest qualified board the player solved wins over an older one', () => {
  const entries = [entry('2026-07-09', 40), entry('2026-07-10', 40), entry('2026-07-11', 40)];
  const plan = selectHeatmapDate(entries, ['2026-07-09', '2026-07-10']);
  assert.equal(plan.date, '2026-07-10');
});

test('REGRESSION: a board the player has not solved is never drawn', () => {
  // The map only lights cells that held mines, and past dailies are
  // replayable from the archive, so drawing an unplayed board hands the
  // player a partial mine map for a puzzle they still have ahead.
  const plan = selectHeatmapDate([entry('2026-07-10', 40)], []);
  assert.equal(plan.state, 'unplayed');
  assert.equal(plan.payload, null, 'the payload is withheld, not just hidden in CSS');
});

test('unknown play history resolves to none, never to a guess', () => {
  const plan = selectHeatmapDate([entry('2026-07-10', 40)], null);
  assert.equal(plan.state, 'none', 'logged out or a failed fetch must not risk a spoiler');
  assert.equal(plan.payload, null);
});

test('no rolled-up dates resolves to none', () => {
  assert.equal(selectHeatmapDate([], []).state, 'none');
  assert.equal(selectHeatmapDate(null, []).state, 'none');
});

test('the gate boundary is inclusive at MIN_PLAYERS_FOR_HEATMAP', () => {
  const at = selectHeatmapDate([entry('2026-07-10', MIN_PLAYERS_FOR_HEATMAP)], ['2026-07-10']);
  const below = selectHeatmapDate([entry('2026-07-10', MIN_PLAYERS_FOR_HEATMAP - 1)], ['2026-07-10']);
  assert.equal(at.state, 'ready');
  assert.equal(below.state, 'none');
});

// ── copy ─────────────────────────────────────────────────────────────

const HEDGES = /\b(maybe|perhaps|possibly|probably|might|roughly|somewhat|apparently|seemingly|arguably)\b/gi;

function assertVoice(text, label) {
  assert.ok(!text.includes('—'), `${label}: em-dash in player copy`);
  assert.ok(!text.includes('–'), `${label}: en-dash in player copy`);
  assert.ok(!/\b(between nothing|almost nothing|nearly nothing)\b/i.test(text),
    `${label}: a quantity must speak its number, not say "nothing"`);
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (!sentence.trim()) continue;
    const hedges = sentence.match(HEDGES) || [];
    assert.ok(hedges.length <= 1, `${label}: stacked hedges in "${sentence}"`);
    assert.ok(/[.!?]$/.test(sentence.trim()), `${label}: unterminated sentence "${sentence}"`);
    assert.ok(/^[A-Z]/.test(sentence.trim()), `${label}: sentence does not open with a capital: "${sentence}"`);
  }
}

test('every copy state reads in Greg s voice', () => {
  const cases = [
    [{ state: 'unplayed', bestPlayers: 40, payload: { n_players: 40 } }, 'Jul 10'],
    [{ state: 'ready', bestPlayers: 40, payload: { n_players: 40, totals: 12 }, drawn: { nDrawn: 2 } }, 'Jul 10'],
    [{ state: 'ready', bestPlayers: 40, payload: { n_players: 40, totals: 0 }, drawn: { nDrawn: 0 } }, 'Jul 10'],
  ];
  for (const [plan, label] of cases) {
    const copy = heatmapCopy(/** @type {any} */ (plan), label);
    assert.ok(copy && copy.body, `${plan.state}: copy missing`);
    assertVoice(copy.body, plan.state);
    assert.ok(copy.title.length > 0);
  }
});

test('copy speaks only counts it was given', () => {
  const clean = heatmapCopy({ state: 'ready', bestPlayers: 40, payload: { n_players: 40, totals: 0 }, drawn: { nDrawn: 0 } }, 'Jul 10');
  assert.ok(clean.body.includes('not one of them set off a mine'),
    'a board nobody detonated says so plainly');
});

test('the shading caption describes a share, not a raw count', () => {
  const drawnCopy = heatmapCopy(
    { state: 'ready', bestPlayers: 40, payload: { n_players: 40, totals: 12 }, drawn: { nDrawn: 3 } },
    'Jul 10',
  );
  assert.ok(/share/.test(drawnCopy.body),
    'the caption must promise a proportion, since that is what the shading encodes');
});

test('state none renders nothing at all', () => {
  assert.equal(heatmapCopy({ state: 'none', bestPlayers: 0, payload: null, date: null }, ''), null);
  assert.equal(heatmapCopy(null, ''), null);
});
