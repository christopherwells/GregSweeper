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
  FIRST_ARCHIVE_WEEK, WEEKLY_COMPLETIONS_EPOCH, addWeeks, weeksBetween,
  isArchivableWeek, weekArchiveState, pastWeekStarts,
  weekStartLabel, weekRangeLabel,
  applyWeekContinuation, isWeekStreakAlive, projectWeekContinuation, liveWeekStreak,
  weekStreakFromHistory, streakBearingWeeks, bankableWeeks,
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

// ── Deriving the streak from history (the launch omission) ───────────────
// A streak kept only as a counter starts at zero the day the counter ships.
// The feature launched telling a player with fourteen unbroken weeks that they
// had no streak, with the whole history sitting in their own account (his
// report, 2026-08-05). The history is the authority; the counter caches it.

test('REGRESSION: the streak derives from the weeks already played', () => {
  // Fourteen consecutive weeks, the real case.
  const weeks = [];
  let w = '2026-05-04';
  for (let i = 0; i < 14; i++) { weeks.push(w); w = addWeeks(w, 1); }
  assert.deepEqual(weekStreakFromHistory(weeks), { streak: 14, lastWeek: '2026-08-03' });

  // Order and duplicates in the input do not matter.
  const shuffled = [...weeks].reverse().concat(weeks[3], weeks[7]);
  assert.deepEqual(weekStreakFromHistory(shuffled), { streak: 14, lastWeek: '2026-08-03' });

  // Only the run ENDING at the most recent week counts: an older, longer run
  // behind a gap is history, not a live streak.
  const gapped = ['2026-05-04', '2026-05-11', '2026-05-18', '2026-06-15', '2026-06-22'];
  assert.deepEqual(weekStreakFromHistory(gapped), { streak: 2, lastWeek: '2026-06-22' });

  assert.deepEqual(weekStreakFromHistory([]), { streak: 0, lastWeek: null });
  assert.deepEqual(weekStreakFromHistory(null), { streak: 0, lastWeek: null });
  assert.deepEqual(weekStreakFromHistory(['nonsense']), { streak: 0, lastWeek: null });
  assert.deepEqual(weekStreakFromHistory(['2026-08-03']), { streak: 1, lastWeek: '2026-08-03' });
});

// ── Which weeks a streak may count (issue #254) ──────────────────────────

test('streakBearingWeeks keeps past weeks and drops the live one', () => {
  const played = ['2026-07-20', '2026-07-27', '2026-08-03', '2026-08-10'];
  assert.deepEqual(streakBearingWeeks(played, '2026-08-10'),
    ['2026-07-20', '2026-07-27', '2026-08-03'],
    'the week in progress is not history — the player can still earn it');

  // Nothing else about the input changes: order, duplicates and junk are the
  // downstream derivation's problem, not this filter's.
  assert.deepEqual(streakBearingWeeks(['2026-08-03', '2026-07-27'], '2026-08-10'),
    ['2026-08-03', '2026-07-27']);
  assert.deepEqual(streakBearingWeeks(['nonsense', '2026-08-03'], '2026-08-10'), ['2026-08-03']);
});

test('streakBearingWeeks drops anything dated after the current week', () => {
  // Only a clock disagreement produces one, and it cannot be a completion.
  assert.deepEqual(streakBearingWeeks(['2026-08-03', '2026-08-17'], '2026-08-10'), ['2026-08-03']);
});

test('streakBearingWeeks fails CLOSED without a current week', () => {
  // This module has no clock by design, so an absent currentWeek means the
  // caller cannot distinguish history from the live week. Returning the input
  // would silently restore the defect; returning nothing leaves the stored
  // record alone, which is the safe direction for an upward-only heal.
  const played = ['2026-07-27', '2026-08-03'];
  assert.deepEqual(streakBearingWeeks(played, undefined), []);
  assert.deepEqual(streakBearingWeeks(played, null), []);
  assert.deepEqual(streakBearingWeeks(played, 'not-a-week'), []);
  assert.deepEqual(streakBearingWeeks(null, '2026-08-10'), []);
});

// ── Which records may bank a week (the completion record) ────────────────
// weeklyAttempts proves a week was OPENED (written on the first click);
// weeklyCompletions proves it was FINISHED (written at the win). The
// completions record only exists from WEEKLY_COMPLETIONS_EPOCH, so the
// derivation splits there, a stated boundary rather than a silent change:
// before it, attempts keep their documented generosity; from it on, an
// attempt alone banks nothing.

test('the epoch is a frozen Monday anchor at the record\'s ship week', () => {
  assert.equal(WEEKLY_COMPLETIONS_EPOCH, '2026-08-10');
  const [y, m, d] = WEEKLY_COMPLETIONS_EPOCH.split('-').map(Number);
  assert.equal(new Date(y, m - 1, d, 12).getDay(), 1, 'a weekStart is always a Monday');
});

test('bankableWeeks: attempts bank only before the epoch, completions bank throughout', () => {
  const attempted = ['2026-07-27', '2026-08-03', '2026-08-17'];
  const completed = ['2026-08-24'];
  assert.deepEqual(
    bankableWeeks({ attempted, completed, currentWeek: '2026-08-31' }).sort(),
    ['2026-07-27', '2026-08-03', '2026-08-24'],
    'the post-epoch attempted-and-abandoned week (2026-08-17) banks nothing');
});

test('REGRESSION: a post-epoch week opened and abandoned does not bank once it is history', () => {
  // Issue #254 stopped the LIVE week from banking on an attempt; the epoch
  // stops the same abandoned attempt from banking after the week rolls over,
  // which the attempts record alone could never distinguish from a win.
  assert.deepEqual(bankableWeeks({ attempted: ['2026-08-17'], completed: [], currentWeek: '2026-08-31' }), []);
  // The pre-epoch generosity is unchanged, and documented in bankableWeeks.
  assert.deepEqual(bankableWeeks({ attempted: ['2026-08-03'], completed: [], currentWeek: '2026-08-31' }), ['2026-08-03']);
});

test('a run crossing the epoch derives whole', () => {
  const attempted = ['2026-07-27', '2026-08-03'];
  const completed = ['2026-08-10', '2026-08-17'];
  const run = weekStreakFromHistory(bankableWeeks({ attempted, completed, currentWeek: '2026-08-24' }));
  assert.deepEqual(run, { streak: 4, lastWeek: '2026-08-17' });
});

test('bankableWeeks fails CLOSED without a current week and drops the live week from BOTH sources', () => {
  assert.deepEqual(bankableWeeks({ attempted: ['2026-08-03'], completed: ['2026-08-10'] }), []);
  assert.deepEqual(bankableWeeks({ attempted: ['2026-08-03'], completed: ['2026-08-10'], currentWeek: 'junk' }), []);
  // A completed CURRENT week is the play path's job, not the heal's.
  assert.deepEqual(bankableWeeks({ attempted: ['2026-08-17'], completed: ['2026-08-17'], currentWeek: '2026-08-17' }), []);
});

test('either source may be null; the other still counts, deduped', () => {
  assert.deepEqual(bankableWeeks({ attempted: null, completed: ['2026-08-10'], currentWeek: '2026-08-24' }), ['2026-08-10']);
  assert.deepEqual(bankableWeeks({ attempted: ['2026-08-03'], completed: null, currentWeek: '2026-08-24' }), ['2026-08-03']);
  // A pre-epoch week both attempted and backfill-completed appears once, and
  // a backfilled pre-epoch completion needs no attempt beside it.
  assert.deepEqual(bankableWeeks({ attempted: ['2026-08-03'], completed: ['2026-08-03'], currentWeek: '2026-08-24' }), ['2026-08-03']);
  assert.deepEqual(bankableWeeks({ attempted: null, completed: ['2026-06-01'], currentWeek: '2026-08-24' }), ['2026-06-01']);
});
