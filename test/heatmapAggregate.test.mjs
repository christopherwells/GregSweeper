// Board heatmap pure layer: the rollup's aggregation decisions and the
// notebook exhibit's honesty gate.
//
// The gate is the point of the feature. With a small player base a
// per-cell count of 1 is one person's bad afternoon, so painting it as a
// population signal would fabricate exactly the kind of claim the rest
// of the Journal refuses to make. These tests pin that the map stays
// shut below MIN_PLAYERS_FOR_HEATMAP, that it never opens on a board the
// player still has to solve (the map is a partial mine map and past
// dailies are replayable), and that the waiting copy reads honestly.
//
// Run: node --test test/heatmapAggregate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_PLAYERS_FOR_HEATMAP,
  MIN_CELL_HITS_TO_DRAW,
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
  assert.equal(agg.nPlayers, 2, 'the probe player still solved the board');
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

test('heat levels span 1..HEAT_LEVELS with 0 reserved for untouched', () => {
  assert.equal(heatLevel(0, 8), 0);
  assert.equal(heatLevel(8, 8), HEAT_LEVELS, 'the busiest cell is the darkest');
  assert.equal(heatLevel(1, 8), 1, 'a single hit is the faintest shade, never invisible');
  for (let n = 1; n <= 8; n++) {
    const lv = heatLevel(n, 8);
    assert.ok(lv >= 1 && lv <= HEAT_LEVELS, `level for ${n} out of range: ${lv}`);
  }
  assert.equal(heatLevel(3, 0), 0, 'a zero max cannot shade anything');
});

test('maxCellCount finds the busiest cell', () => {
  assert.equal(maxCellCount({ '1_1': 2, '2_2': 5, '3_3': 1 }), 5);
  assert.equal(maxCellCount({}), 0);
  assert.equal(maxCellCount(null), 0);
});

// ── the per-square gate ──────────────────────────────────────────────

test('REGRESSION: a square only one player hit is never shaded', () => {
  // The solver gate licenses the BOARD; this one licenses the SQUARE.
  // Without it, a board with fifteen solvers and one unlucky click
  // scaled that click to the darkest shade on the map, under a caption
  // reading "the darker a square, the more of them set off a mine on
  // it" — one person rendered as a population.
  const drawn = drawableCells({ '3_4': 1 });
  assert.equal(drawn.nDrawn, 0, 'a single hit draws nothing at all');
  assert.deepEqual(drawn.cells, {});
});

test('REGRESSION: one player s multi-mine run cannot light up a map', () => {
  // Five separate cells, each hit once, all by the same person.
  const drawn = drawableCells({ '0_0': 1, '1_1': 1, '2_2': 1, '3_3': 1, '4_4': 1 });
  assert.equal(drawn.nDrawn, 0);
});

test('a square at exactly the threshold draws, and below it does not', () => {
  const drawn = drawableCells({ at: MIN_CELL_HITS_TO_DRAW, below: MIN_CELL_HITS_TO_DRAW - 1 });
  assert.equal(drawn.nDrawn, 1);
  assert.equal(drawn.cells.at, MIN_CELL_HITS_TO_DRAW);
  assert.equal(drawn.cells.below, undefined);
});

test('a flat map at the threshold renders mid-tone, not maximal', () => {
  const drawn = drawableCells({ a: MIN_CELL_HITS_TO_DRAW, b: MIN_CELL_HITS_TO_DRAW });
  assert.ok(drawn.max > MIN_CELL_HITS_TO_DRAW,
    'the denominator is floored above the cut so a flat map looks flat');
  assert.ok(heatLevel(MIN_CELL_HITS_TO_DRAW, drawn.max) < HEAT_LEVELS,
    'nothing hits the darkest bucket just for clearing the threshold');
});

test('drawableCells ignores junk values and empty maps', () => {
  assert.equal(drawableCells({ a: 'x', b: null, c: NaN }).nDrawn, 0);
  assert.equal(drawableCells({}).nDrawn, 0);
  assert.equal(drawableCells(null).nDrawn, 0);
});

// ── the board gate ───────────────────────────────────────────────────

const entry = (date, n) => ({ date, payload: { n_players: n, totals: n, cells: {}, rows: 10, cols: 10 } });

test('REGRESSION: sparse dates never render per-cell counts', () => {
  const entries = [entry('2026-07-10', 7), entry('2026-07-11', 4)];
  const plan = selectHeatmapDate(entries, ['2026-07-10', '2026-07-11']);
  assert.equal(plan.state, 'sparse', 'seven solvers is one afternoon, not a population');
  assert.equal(plan.payload, null, 'no payload means nothing can be painted');
  assert.equal(plan.bestPlayers, 7, 'the copy gets the real best-covered count');
});

test('a qualified board the player solved renders', () => {
  const entries = [entry('2026-07-10', MIN_PLAYERS_FOR_HEATMAP), entry('2026-07-09', 40)];
  const plan = selectHeatmapDate(entries, ['2026-07-10']);
  assert.equal(plan.state, 'ready');
  assert.equal(plan.date, '2026-07-10', 'the most recent qualified board the player has solved');
});

test('a ready plan resolves the per-square gate for the caller', () => {
  // The caller must not be able to reach past the gate to the raw
  // counts, so the approved subset rides on the plan itself.
  const entries = [{
    date: '2026-07-10',
    payload: { n_players: 40, totals: 9, rows: 10, cols: 10, cells: { '1_1': 8, '2_2': 1 } },
  }];
  const plan = selectHeatmapDate(entries, ['2026-07-10']);
  assert.equal(plan.state, 'ready');
  assert.equal(plan.drawn.nDrawn, 1, 'only the well-sampled square survives');
  assert.equal(plan.drawn.cells['2_2'], undefined, 'the single-hit square is withheld');
  assert.equal(plan.drawn.cells['1_1'], 8);
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
  assert.equal(below.state, 'sparse');
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
    [{ state: 'sparse', bestPlayers: 7, payload: null }, ''],
    [{ state: 'sparse', bestPlayers: 0, payload: null }, ''],
    [{ state: 'unplayed', bestPlayers: 40, payload: { n_players: 40 } }, 'Jul 10'],
    [{ state: 'ready', bestPlayers: 40, payload: { n_players: 40, totals: 12 }, drawn: { nDrawn: 2 } }, 'Jul 10'],
    [{ state: 'ready', bestPlayers: 40, payload: { n_players: 40, totals: 12 }, drawn: { nDrawn: 0 } }, 'Jul 10'],
    [{ state: 'ready', bestPlayers: 40, payload: { n_players: 40, totals: 0 }, drawn: { nDrawn: 0 } }, 'Jul 10'],
  ];
  for (const [plan, label] of cases) {
    const copy = heatmapCopy(/** @type {any} */ (plan), label);
    assert.ok(copy && copy.body, `${plan.state}: copy missing`);
    assertVoice(copy.body, plan.state);
    assert.ok(copy.title.length > 0);
  }
});

test('copy speaks real counts as words, and only counts it was given', () => {
  const sparse = heatmapCopy({ state: 'sparse', bestPlayers: 7, payload: null }, '');
  assert.ok(sparse.body.includes('fifteen'), 'the gate threshold is named');
  assert.ok(sparse.body.includes('seven'), 'the real best-covered count is named');
  assert.ok(!/\d/.test(sparse.body), 'small counts render as words, not digits');

  const clean = heatmapCopy({ state: 'ready', bestPlayers: 40, payload: { n_players: 40, totals: 0 }, drawn: { nDrawn: 0 } }, 'Jul 10');
  assert.ok(clean.body.includes('not one of them set off a mine'),
    'a board nobody detonated says so plainly');
});

test('REGRESSION: a ready board with nothing drawable says so instead of drawing', () => {
  const scattered = heatmapCopy(
    { state: 'ready', bestPlayers: 40, payload: { n_players: 40, totals: 6 }, drawn: { nDrawn: 0 } },
    'Jul 10',
  );
  assert.ok(/scattered/.test(scattered.body),
    'scattered single hits are described, never shaded');
  assert.ok(!/darker/.test(scattered.body),
    'the shading caption must not appear when nothing is shaded');

  const drawnCopy = heatmapCopy(
    { state: 'ready', bestPlayers: 40, payload: { n_players: 40, totals: 12 }, drawn: { nDrawn: 3 } },
    'Jul 10',
  );
  assert.ok(drawnCopy.body.includes(`at least ${['zero', 'one', 'two', 'three'][MIN_CELL_HITS_TO_DRAW]}`),
    'the drawn caption states the per-square floor it enforced');
});

test('a zero best-covered count does not claim a board exists', () => {
  const copy = heatmapCopy({ state: 'sparse', bestPlayers: 0, payload: null }, '');
  assert.ok(!copy.body.includes('zero'), 'saying "the best board has zero" reads as a bug');
  assert.ok(/no board/i.test(copy.body));
});

test('state none renders nothing at all', () => {
  assert.equal(heatmapCopy({ state: 'none', bestPlayers: 0, payload: null, date: null }, ''), null);
  assert.equal(heatmapCopy(null, ''), null);
});
