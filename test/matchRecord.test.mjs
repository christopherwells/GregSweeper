// A player's head-to-head record across Challenge matches
// (src/logic/matchRecord.js).
//
// The mode has NO LOSS: a match board's mines are strikes, so the board is
// always cleared. The stats panel's old `wins / totalGames` was therefore
// structurally 100% and could not move, and the only thing a Challenge win can
// mean is the head-to-head. These tests pin that reading, and the three
// honesty rules that decide the number: contested is the denominator, adjusted
// and raw are both reported, and a tie counts for nobody.

import test from 'node:test';
import assert from 'node:assert';
import {
  matchBoardBreakdown, matchRecord, winPct, rankedSplits,
} from '../src/logic/matchRecord.js';

// Two boards: a plain rect and a hex carrying compass.
const SPECS = [
  { shape: 'rect', cells: 100, mines: 10, gimmicks: [] },
  { shape: 'hex', cells: 100, mines: 30, gimmicks: ['compass', 'liar'] },
];
const node = (players, specs = SPECS) => ({
  host: 'me', createdAt: 1, playerCount: Object.keys(players).length,
  boards: specs.map((spec, i) => ({ seed: `s${i}`, spec, par: 60 })),
  players,
});
const player = (name, times) => ({
  name, joinedAt: 1, finishedAt: 2,
  results: times.map((t) => (t === null ? null : { time: t, penalty: 0 })),
});

// ── What a win means when nothing can be lost ───────────────────────────

test('a board you were fastest on is a win, raw and adjusted', () => {
  const rows = matchBoardBreakdown(
    node({ me: player('Me', [30, 50]), you: player('You', [40, 40]) }),
    { myUid: 'me' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].wonRaw, true, 'board 1: 30s beats 40s');
  assert.equal(rows[0].wonAdjusted, true);
  assert.equal(rows[1].wonRaw, false, 'board 2: 50s loses to 40s');
  assert.equal(rows[1].fastestRaw.uid, 'you');
});

test('the HANDICAP can flip a board: raw and adjusted disagree, and both show', () => {
  // He is slower on the clock but rated harder, so the fair comparison and
  // the finishing order are different facts. Reporting only one would be
  // picking whichever flatters.
  const rows = matchBoardBreakdown(
    node({ me: player('Me', [60, 60]), you: player('You', [50, 50]) }),
    { myUid: 'me', handicaps: { me: 2.0, you: 1.0 } });
  assert.equal(rows[0].wonRaw, false, '60s is slower than 50s');
  assert.equal(rows[0].wonAdjusted, true, '60/2.0 = 30 beats 50/1.0 = 50');
  assert.equal(rows[0].mine.adjusted, 30);
});

test('an unrated player ranks RAW (k = 1), never a pretend handicap', () => {
  const rows = matchBoardBreakdown(
    node({ me: player('Me', [40, 40]), you: player('You', [50, 50]) }),
    { myUid: 'me', handicaps: { you: 0 } });          // 0 is garbage, not a k
  assert.equal(rows[0].mine.adjusted, 40);
  assert.equal(rows[0].entries.find((e) => e.uid === 'you').adjusted, 50);
});

// ── Contested is the denominator ────────────────────────────────────────

test('a SOLO run is not a 100% win rate', () => {
  // The trap the old stat fell into, from the other direction: with nobody to
  // race, every board is "won" unless the denominator says otherwise.
  const rec = matchRecord([node({ me: player('Me', [30, 30]) })], { myUid: 'me' });
  assert.equal(rec.contested, 0);
  assert.equal(rec.wonAdjusted, 0);
  assert.equal(winPct(rec.wonAdjusted, rec.contested), null, 'no rate to report');
  assert.equal(rec.boardsPlayed, 2, 'the boards still count as played');
  assert.equal(rec.matchesPlayed, 1);
});

test('a board the opponent never reached is outside the question', () => {
  const rows = matchBoardBreakdown(
    node({ me: player('Me', [30, 30]), you: player('You', [40, null]) }),
    { myUid: 'me' });
  assert.equal(rows[0].contested, true);
  assert.equal(rows[1].contested, false, 'they never posted board 2');
  // Not false: an unraced board must not be countable as a loss either.
  assert.equal(rows[1].wonAdjusted, null);
  assert.equal(rows[1].wonRaw, null);
  const rec = matchRecord([node({ me: player('Me', [30, 30]), you: player('You', [40, null]) })],
    { myUid: 'me' });
  assert.equal(rec.contested, 1);
  assert.equal(rec.wonAdjusted, 1);
});

test('a board YOU never reached is not counted against you', () => {
  const rec = matchRecord([node({ me: player('Me', [30, null]), you: player('You', [40, 20]) })],
    { myUid: 'me' });
  assert.equal(rec.contested, 1, 'only the board both played');
  assert.equal(rec.boardsPlayed, 1);
});

// ── A tie counts for nobody ─────────────────────────────────────────────

test('an exact tie is a win for nobody, in either measure', () => {
  const rows = matchBoardBreakdown(
    node({ me: player('Me', [40, 40]), you: player('You', [40, 40]) }),
    { myUid: 'me' });
  assert.equal(rows[0].contested, true);
  assert.equal(rows[0].wonRaw, false);
  assert.equal(rows[0].wonAdjusted, false);
  assert.equal(rows[0].fastestRaw.tied, true);
  // And it still counts in the denominator: a race happened.
  const rec = matchRecord([node({ me: player('Me', [40, 40]), you: player('You', [40, 40]) })],
    { myUid: 'me' });
  assert.equal(rec.contested, 2);
  assert.equal(rec.wonAdjusted, 0);
  assert.equal(winPct(rec.wonAdjusted, rec.contested), 0);
});

// ── The splits his question actually asks for ───────────────────────────

test('splits are per BOARD, so a mixed match answers "which shapes"', () => {
  // The reason the unit is the board: this match is one rect and one hex, and
  // a match-level record could not say anything about either.
  const rec = matchRecord([node({ me: player('Me', [30, 90]), you: player('You', [40, 40]) })],
    { myUid: 'me' });
  assert.equal(rec.splits.shape.rect.wonAdjusted, 1);
  assert.equal(rec.splits.shape.rect.contested, 1);
  assert.equal(rec.splits.shape.hex.wonAdjusted, 0);
  assert.equal(rec.splits.shape.hex.contested, 1);
  // Density bands come from the board's own mines/cells.
  assert.equal(rec.splits.density.sparse.wonAdjusted, 1, '10 of 100 is sparse');
  assert.equal(rec.splits.density.dense.contested, 1, '30 of 100 is packed');
});

test('a board counts once PER modifier, so the modifier tallies do not sum', () => {
  const rec = matchRecord([node({ me: player('Me', [30, 90]), you: player('You', [40, 40]) })],
    { myUid: 'me' });
  // Board 2 carries compass AND liar; both record the same loss.
  assert.equal(rec.splits.modifier.compass.contested, 1);
  assert.equal(rec.splits.modifier.liar.contested, 1);
  assert.equal(rec.splits.modifier.compass.wonAdjusted, 0);
  // The plain board is in NO modifier bucket, which is why the sum (2) does
  // not equal the contested total (2 boards, but one of them plain).
  const modTotal = Object.values(rec.splits.modifier).reduce((s, t) => s + t.contested, 0);
  assert.equal(rec.contested, 2);
  assert.equal(modTotal, 2, 'two modifier entries from ONE modified board');
});

test('the record accumulates across matches', () => {
  const a = node({ me: player('Me', [30, 30]), you: player('You', [40, 40]) });
  const b = node({ me: player('Me', [90, 90]), you: player('You', [40, 40]) });
  const rec = matchRecord([a, b], { myUid: 'me' });
  assert.equal(rec.contested, 4);
  assert.equal(rec.wonAdjusted, 2);
  assert.equal(rec.matchesPlayed, 2);
  assert.equal(winPct(rec.wonAdjusted, rec.contested), 50);
});

// ── Showing a split honestly ────────────────────────────────────────────

test('a split too thin to mean anything is withheld, and n rides every row', () => {
  // One contested board reading "100% on Kites" is the failure mode: with a
  // handful of friends the splits are tiny, and a percentage without its
  // sample is a claim the data cannot support.
  const bucket = {
    rect: { contested: 8, wonAdjusted: 6, wonRaw: 5 },
    hex: { contested: 3, wonAdjusted: 3, wonRaw: 3 },
    floret: { contested: 1, wonAdjusted: 1, wonRaw: 1 },
  };
  const shown = rankedSplits(bucket, { minContested: 3 });
  assert.deepEqual(shown.map((r) => r.name), ['hex', 'rect'], 'floret is too thin to show');
  assert.equal(shown[0].pct, 100);
  assert.equal(shown[0].contested, 3, 'the sample rides the row');
  assert.equal(shown[1].pct, 75);
  // Raising the bar drops more, and an empty result is a real answer.
  assert.deepEqual(rankedSplits(bucket, { minContested: 20 }), []);
});

test('rankedSplits can rank on the RAW record too', () => {
  const bucket = { rect: { contested: 8, wonAdjusted: 6, wonRaw: 2 } };
  assert.equal(rankedSplits(bucket, { key: 'wonAdjusted' })[0].pct, 75);
  assert.equal(rankedSplits(bucket, { key: 'wonRaw' })[0].pct, 25);
});

// ── Degradation ─────────────────────────────────────────────────────────

test('a malformed node yields nothing rather than throwing', () => {
  for (const bad of [null, undefined, {}, { boards: 'x' }, { boards: [], players: 'x' }]) {
    assert.deepEqual(matchBoardBreakdown(bad, { myUid: 'me' }), []);
  }
  const rec = matchRecord([null, undefined, {}], { myUid: 'me' });
  assert.equal(rec.contested, 0);
  assert.equal(rec.matchesPlayed, 0);
  assert.deepEqual(rec.splits.shape, {});
});

test('a garbage result is skipped, never read as a zero-second board', () => {
  const bad = {
    name: 'You', joinedAt: 1,
    results: [{ time: 'fast' }, { time: -5 }],
  };
  const rows = matchBoardBreakdown(node({ me: player('Me', [30, 30]), you: bad }), { myUid: 'me' });
  assert.equal(rows[0].entries.length, 1, 'a non-numeric time is not an entry');
  assert.equal(rows[0].contested, false);
  assert.equal(rows[1].entries.length, 1, 'a negative time is not an entry');
});

test('winPct refuses to divide by nothing', () => {
  assert.equal(winPct(0, 0), null);
  assert.equal(winPct(3, null), null);
  assert.equal(winPct(1, 2), 50);
});

// ── Rivalries and the field row (his ask 2026-08-16) ────────────────────

import { rivalries } from '../src/logic/matchRecord.js';

test('rivalries: per-opponent tallies with signed median margins', () => {
  // Three boards against two rivals. Against You: ahead by 10, behind by 5,
  // ahead by 3 — record 2-1, margins [-10, +5, -3], median -3 (ahead).
  const r = rivalries([node({
    me: player('Me', [30, 45, 60]),
    you: player('You', [40, 40, 63]),
    kate: player('Kate', [35, 50, null]),
  }, [SPECS[0], SPECS[1], SPECS[0]])], { myUid: 'me' });

  const you = r.rivals.find((x) => x.uid === 'you');
  assert.equal(you.won, 2);
  assert.equal(you.lost, 1);
  assert.equal(you.boards, 3);
  assert.equal(you.medianMargin, -3, 'median of [-10, +5, -3] is -3: usually ahead');

  const kate = r.rivals.find((x) => x.uid === 'kate');
  assert.equal(kate.boards, 2, 'a board Kate never posted is not in the rivalry');
  assert.equal(kate.won, 2);

  // The field row scores each board against the BEST rival on it, and its
  // won count is exactly the aggregate wonAdjusted, so the two surfaces can
  // never disagree.
  assert.equal(r.field.boards, 3);
  assert.equal(r.field.won, 2);
  const agg = matchRecord([node({
    me: player('Me', [30, 45, 60]),
    you: player('You', [40, 40, 63]),
    kate: player('Kate', [35, 50, null]),
  }, [SPECS[0], SPECS[1], SPECS[0]])], { myUid: 'me' });
  assert.equal(r.field.won, agg.wonAdjusted);
});

test('rivalries: a tie counts for nobody and is tallied on its own', () => {
  const r = rivalries([node({
    me: player('Me', [40]),
    you: player('You', [40]),
  }, [SPECS[0]])], { myUid: 'me' });
  const you = r.rivals[0];
  assert.equal(you.won, 0);
  assert.equal(you.lost, 0);
  assert.equal(you.ties, 1);
  assert.equal(r.field.ties, 1);
  assert.equal(r.field.medianMargin, 0);
});

test('rivalries: adjusted decides, and solo boards stay out entirely', () => {
  const r = rivalries([node({
    me: player('Me', [60, 30]),
    you: player('You', [50, null]),
  }, [SPECS[0], SPECS[1]])], { myUid: 'me', handicaps: { me: 2.0, you: 1.0 } });
  const you = r.rivals[0];
  assert.equal(you.boards, 1, 'the solo second board is nobody\'s rivalry');
  assert.equal(you.won, 1, '60/2.0 = 30 beats 50/1.0 = 50, adjusted decides');
  assert.equal(you.medianMargin, -20);
});
