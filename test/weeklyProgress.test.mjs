// The weekly's calendar: past-week eligibility and the week streak.
//
// His rules (2026-08-05): a week streak like the daily's, except that ONE of
// the week's seven attempts banks the week, and no molt days — a week is
// already seven chances at one board, so there is nothing for insurance to
// insure.
//
// The arithmetic is the part worth pinning. Every value here is a Monday
// weekStart string, and a "gap" is measured in whole weeks, so the two edges
// that matter are the same week hit twice (must not double-count) and a DST
// boundary inside a span (must not read as six days).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FIRST_ARCHIVE_WEEK, addWeeks, weeksBetween,
  isArchivableWeek, weekArchiveState, pastWeekStarts,
  weekStartLabel, weekRangeLabel,
  applyWeekContinuation, isWeekStreakAlive, projectWeekContinuation, liveWeekStreak,
} from '../src/logic/weeklyProgress.js';

// ── Week arithmetic ──────────────────────────────────────────────────────

test('addWeeks and weeksBetween are exact whole weeks, across DST and year ends', () => {
  assert.equal(addWeeks('2026-08-03', 1), '2026-08-10');
  assert.equal(addWeeks('2026-08-03', -1), '2026-07-27');
  assert.equal(addWeeks('2026-08-03', 0), '2026-08-03');
  // Month and year rollover.
  assert.equal(addWeeks('2026-12-28', 1), '2027-01-04');
  assert.equal(addWeeks('2027-01-04', -1), '2026-12-28');

  assert.equal(weeksBetween('2026-08-03', '2026-08-10'), 1);
  assert.equal(weeksBetween('2026-08-10', '2026-08-03'), -1);
  assert.equal(weeksBetween('2026-08-03', '2026-08-03'), 0);
  assert.equal(weeksBetween('2026-05-04', '2026-08-03'), 13);

  // DST: US clocks move on 2026-03-08 and 2026-11-01, both inside these spans.
  // A span measured in raw hours would come out 0.96 or 1.04 weeks and round
  // wrong somewhere; anchoring at noon keeps every step exactly 7 days.
  assert.equal(weeksBetween('2026-03-02', '2026-03-09'), 1);
  assert.equal(weeksBetween('2026-10-26', '2026-11-02'), 1);
  assert.equal(addWeeks('2026-03-02', 1), '2026-03-09');
  assert.equal(addWeeks('2026-10-26', 1), '2026-11-02');
});

// ── Past weeklies ────────────────────────────────────────────────────────

test('the archive window opens at the first stored week and stops before this one', () => {
  assert.equal(isArchivableWeek('2026-07-27', '2026-08-03'), true);
  assert.equal(isArchivableWeek(FIRST_ARCHIVE_WEEK, '2026-08-03'), true, 'the first week is offered');
  assert.equal(isArchivableWeek('2026-04-27', '2026-08-03'), false, 'before the weekly existed');
  assert.equal(isArchivableWeek('2026-08-03', '2026-08-03'), false, 'this week is the live Weekly');
  assert.equal(isArchivableWeek('2026-08-10', '2026-08-03'), false, 'never a future week');
  assert.equal(isArchivableWeek(null, '2026-08-03'), false);
});

test('weekArchiveState paints each row, and unknown history fails OPEN', () => {
  const played = new Set(['2026-07-20']);
  assert.equal(weekArchiveState('2026-07-27', '2026-08-03', played), 'playable');
  assert.equal(weekArchiveState('2026-07-20', '2026-08-03', played), 'done');
  assert.equal(weekArchiveState('2026-08-03', '2026-08-03', played), 'current');
  assert.equal(weekArchiveState('2026-01-05', '2026-08-03', played), 'unavailable');

  // NULL is unknown, not empty: a signed-out player still gets the list.
  assert.equal(weekArchiveState('2026-07-20', '2026-08-03', null), 'playable');
  // An array reads the same as a Set.
  assert.equal(weekArchiveState('2026-07-20', '2026-08-03', ['2026-07-20']), 'done');
});

test('pastWeekStarts lists newest first, never past the first week or the limit', () => {
  const list = pastWeekStarts('2026-08-03');
  assert.equal(list[0], '2026-07-27', 'newest first');
  assert.equal(list.at(-1), FIRST_ARCHIVE_WEEK, 'and stops at the first stored week');
  assert.deepEqual([...new Set(list)], list, 'no repeats');
  for (const w of list) {
    assert.equal(isArchivableWeek(w, '2026-08-03'), true, `${w} must be offerable`);
  }
  // Bounded: the column grows by a row a week forever otherwise.
  assert.equal(pastWeekStarts('2030-01-07', 5).length, 5);
  assert.deepEqual(pastWeekStarts(FIRST_ARCHIVE_WEEK), [], 'no past weeks in the first week');
});

test('week labels name the stretch of days, with no dash in player copy', () => {
  assert.match(weekStartLabel('2026-08-03'), /Aug\s*3/);
  const range = weekRangeLabel('2026-08-03');
  assert.match(range, /Aug\s*3/);
  assert.match(range, /Aug\s*9/, 'the range ends on the Sunday, not the next Monday');
  assert.match(range, / to /, 'spelled out, per the house style on dashes');
  assert.ok(!/[–—]/.test(range), 'no en or em dashes in player copy');
  assert.equal(weekRangeLabel('nonsense'), '');
});

// ── Week streak ──────────────────────────────────────────────────────────

test('one completion banks the week, and later attempts that week change nothing', () => {
  const fresh = { lastWeek: null, streak: 0, best: 0 };
  const first = applyWeekContinuation(fresh, '2026-07-20');
  assert.deepEqual(
    { streak: first.streak, best: first.best, lastWeek: first.lastWeek },
    { streak: 1, best: 1, lastWeek: '2026-07-20' },
  );

  // His rule: ONE of the seven. Finishing on Tuesday and again on Friday is
  // the same week, so the second must not advance anything.
  const again = applyWeekContinuation(first, '2026-07-20');
  assert.equal(again.streak, 1);
  assert.equal(again.extended, false, 'the same week is never a second week');
});

test('consecutive weeks build the streak; a skipped week restarts it at 1', () => {
  let rec = { lastWeek: null, streak: 0, best: 0 };
  for (const w of ['2026-06-29', '2026-07-06', '2026-07-13', '2026-07-20']) {
    rec = applyWeekContinuation(rec, w);
  }
  assert.equal(rec.streak, 4);
  assert.equal(rec.best, 4);

  // Skip 2026-07-27 entirely, come back the week after.
  const broken = applyWeekContinuation(rec, '2026-08-03');
  assert.equal(broken.streak, 1, 'a missed week breaks it — there are no molt days here');
  assert.equal(broken.best, 4, 'the high-water mark survives the break');
  assert.equal(broken.lastWeek, '2026-08-03');
});

test('a streak is alive through the week after its last completion, then lapses', () => {
  assert.equal(isWeekStreakAlive('2026-08-03', '2026-08-03'), true, 'played this week');
  assert.equal(isWeekStreakAlive('2026-07-27', '2026-08-03'), true,
    'last week counts: this week is still running, so nothing is broken yet');
  assert.equal(isWeekStreakAlive('2026-07-20', '2026-08-03'), false, 'two weeks back is over');
  assert.equal(isWeekStreakAlive(null, '2026-08-03'), false);

  // The read-side view: a lapsed streak reports 0 without being rewritten.
  assert.equal(liveWeekStreak({ streak: 6, lastWeek: '2026-07-27' }, '2026-08-03'), 6);
  assert.equal(liveWeekStreak({ streak: 6, lastWeek: '2026-07-20' }, '2026-08-03'), 0);
  assert.equal(liveWeekStreak({ streak: 0, lastWeek: null }, '2026-08-03'), 0);
});

test('projectWeekContinuation says when the streak is riding on this week', () => {
  // Played last week, this week still open: the streak is at risk and would
  // become N+1.
  const atRisk = projectWeekContinuation({ streak: 3, best: 3, lastWeek: '2026-07-27' }, '2026-08-03');
  assert.deepEqual(atRisk, { streak: 4, atRisk: true });

  // Already played this week: nothing is riding on anything.
  const done = projectWeekContinuation({ streak: 4, best: 4, lastWeek: '2026-08-03' }, '2026-08-03');
  assert.equal(done.atRisk, false);
  assert.equal(done.streak, 4);

  // Already lapsed: not "at risk", it is over — completing restarts at 1.
  const lapsed = projectWeekContinuation({ streak: 9, best: 9, lastWeek: '2026-06-01' }, '2026-08-03');
  assert.deepEqual(lapsed, { streak: 1, atRisk: false });
});

test('a malformed record never invents a streak', () => {
  assert.equal(applyWeekContinuation(null, '2026-08-03').streak, 1);
  assert.equal(applyWeekContinuation({ lastWeek: 'garbage', streak: 5 }, '2026-08-03').streak, 1);
  const noWeek = applyWeekContinuation({ lastWeek: '2026-07-27', streak: 3, best: 3 }, 'nope');
  assert.equal(noWeek.streak, 3, 'a bad week string commits nothing');
  assert.equal(noWeek.lastWeek, '2026-07-27');
});
