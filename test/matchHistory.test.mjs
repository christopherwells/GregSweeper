// The Challenge history layer (src/logic/matchHistory.js): this device's
// solo-run records and the finished list's verdict lines (PR 6).
//
// The load-bearing claims: a solo record strips board payloads and rides the
// SOLO_UID node shape so the clean-compare painter and matchBoardBreakdown
// read it exactly like a fetched node; runOutcome mirrors the painter's own
// headline logic so the list row and the report can never disagree about who
// won; and the month grouping keys on the shared `at` stamp.

import test from 'node:test';
import assert from 'node:assert';
import {
  SOLO_HISTORY_CAP, SOLO_UID, soloRunRecord, appendSoloRun, soloNodeShape,
  runOutcome, monthLabel, shortDate, groupRunsByMonth,
} from '../src/logic/matchHistory.js';
import { matchStandings } from '../src/logic/matchStandings.js';
import { matchBoardBreakdown } from '../src/logic/matchRecord.js';

const entry = (seed, shape = 'rect') => ({
  seed,
  par: 60,
  features: { rows: 9, cols: 9, totalMines: 10 },
  spec: { shape, cells: 81, mines: 10, gimmicks: [] },
  payload: { rows: 9, cols: 9, totalMines: 10, cells: 'PAYLOAD BYTES' },
});
const FINISHED_AT = new Date(2026, 7, 14, 12).getTime();

test('soloRunRecord keeps seed, par and spec and drops the payload', () => {
  const match = {
    rules: { count: 2, shapes: ['rect'] },
    entries: [entry('a'), entry('b', 'hex')],
    results: [
      { seed: 'a', time: 31.4, penalty: 3, strikes: 1, par: 60, bombHitEvents: [{}], wormEvents: [] },
      { seed: 'b', time: 44.0, penalty: 0, strikes: 0, par: 60, bombHitEvents: [], wormEvents: [] },
    ],
  };
  const rec = soloRunRecord(match, FINISHED_AT);
  assert.equal(rec.finishedAt, FINISHED_AT);
  assert.deepEqual(rec.boards.map((b) => Object.keys(b).sort()),
    [['par', 'seed', 'spec'], ['par', 'seed', 'spec']],
    'a record stores nothing but seed, par and spec per board');
  assert.ok(!JSON.stringify(rec).includes('PAYLOAD'),
    'the payload must never reach storage');
  assert.deepEqual(rec.results, [
    { time: 31.4, penalty: 3, strikes: 1 },
    { time: 44, penalty: 0, strikes: 0 },
  ], 'results keep the three numbers the grid reads');
});

test('soloRunRecord returns null when nothing was cleared', () => {
  assert.equal(soloRunRecord(null, 1), null);
  assert.equal(soloRunRecord({ entries: [], results: [] }, 1), null);
  assert.equal(soloRunRecord({ entries: [entry('a')], results: [] }, 1), null);
  assert.equal(soloRunRecord({ entries: [entry('a')], results: [null] }, 1), null);
});

test('a hole in the results keeps its slot, so board indices stay aligned', () => {
  const match = {
    rules: { count: 2 },
    entries: [entry('a'), entry('b')],
    results: [undefined, { time: 20, penalty: 0, strikes: 0 }],
  };
  const rec = soloRunRecord(match, FINISHED_AT);
  assert.equal(rec.results[0], null);
  assert.equal(rec.results[1].time, 20);
});

test('appendSoloRun is newest first and capped, without mutating its input', () => {
  const old = Array.from({ length: SOLO_HISTORY_CAP }, (_, i) => ({ finishedAt: i }));
  const fresh = { finishedAt: 999999 };
  const next = appendSoloRun(old, fresh);
  assert.equal(next.length, SOLO_HISTORY_CAP, 'the cap holds');
  assert.equal(next[0], fresh, 'newest first');
  assert.equal(old.length, SOLO_HISTORY_CAP, 'input untouched');
  assert.ok(!next.includes(old[SOLO_HISTORY_CAP - 1]), 'the oldest record falls off');
});

test('soloNodeShape reads like a fetched node to the standings and the breakdown', () => {
  const rec = soloRunRecord({
    rules: { count: 2 },
    entries: [entry('a'), entry('b', 'hex')],
    results: [
      { time: 30, penalty: 0, strikes: 0 },
      { time: 40, penalty: 5, strikes: 1 },
    ],
  }, FINISHED_AT);
  const node = soloNodeShape(rec);
  const rows = matchStandings(node, { myUid: SOLO_UID });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].isMe, true, 'SOLO_UID resolves isMe with no live identity');
  assert.equal(rows[0].finished, true);
  assert.equal(rows[0].time, 70, 'the total is the summed clock');
  const breakdown = matchBoardBreakdown(node, { myUid: SOLO_UID });
  assert.equal(breakdown.length, 2);
  assert.equal(breakdown[1].spec.shape, 'hex', 'specs survive into the grid rows');
  assert.ok(breakdown.every((r) => r.contested === false),
    'a solo board is never contested: no rival, no win rate');
});

test('runOutcome mirrors the clean comparison headline, kind by kind', () => {
  const row = (over) => ({
    uid: 'u', isMe: false, finished: true, done: 3, of: 3, adjusted: 100, ...over,
  });
  // Won, by the gap to the SECOND finisher, the headline's own margin.
  assert.deepEqual(
    runOutcome([row({ uid: 'me', isMe: true, adjusted: 90 }), row({ uid: 'kate' })]),
    { kind: 'won', gap: 10, rivalUid: 'kate' });
  // A dead heat leads nobody, so it is its own kind, never a win.
  assert.equal(
    runOutcome([row({ uid: 'me', isMe: true }), row({ uid: 'kate' })]).kind, 'tied');
  // Behind: place among the finished, gap to the leader.
  assert.deepEqual(
    runOutcome([row({ uid: 'kate', adjusted: 80 }), row({ uid: 'me', isMe: true, adjusted: 95 }),
      row({ uid: 'sebas', adjusted: 99, finished: false })]),
    { kind: 'behind', place: 2, of: 3, gap: 15, rivalUid: 'kate' });
  // Finished with rivals still on the boards.
  assert.equal(
    runOutcome([row({ uid: 'me', isMe: true }), row({ uid: 'kate', finished: false })]).kind,
    'waiting');
  // Alone: a solo run, or a shared run nobody joined.
  assert.equal(runOutcome([row({ uid: 'me', isMe: true })]).kind, 'alone');
  // The player's own run is not done.
  assert.deepEqual(
    runOutcome([row({ uid: 'me', isMe: true, finished: false, done: 2, of: 5 })]),
    { kind: 'unfinished', done: 2, of: 5 });
  // No row at all (a node this player never played).
  assert.equal(runOutcome([row({ uid: 'kate' })]).kind, 'none');
  assert.equal(runOutcome(null).kind, 'none');
});

test('month labels and grouping key on the entry stamp, order preserved', () => {
  const aug14 = new Date(2026, 7, 14).getTime();
  const aug02 = new Date(2026, 7, 2).getTime();
  const jul30 = new Date(2026, 6, 30).getTime();
  assert.equal(monthLabel(aug14), 'August 2026');
  assert.equal(shortDate(aug14), 'Aug 14');
  const groups = groupRunsByMonth(
    [{ at: aug14 }, { at: aug02 }, { at: jul30 }], (e) => e.at);
  assert.deepEqual(groups.map((g) => [g.label, g.entries.length]),
    [['August 2026', 2], ['July 2026', 1]]);
});
