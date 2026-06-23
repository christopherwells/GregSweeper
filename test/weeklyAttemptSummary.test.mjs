// Weekly win-modal attempt summary. Pins the documented "1st attempt reported
// as 2nd" double-count (attemptsUsed must count PRIOR attempts + this one, from
// a snapshot that excludes the current time), the prior/new-best math, the day
// circles, and the four summary branches.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeWeeklyAttempt } from '../src/logic/weeklyAttemptSummary.js';

test('REGRESSION: a first attempt reports 1/7, not 2/7', () => {
  // Snapshot is empty (no prior attempts). Even though weeklyDayTimes already
  // holds today's time (the win block added it), the snapshot is what counts.
  const r = summarizeWeeklyAttempt({
    precise: 42.0, priorTimesAtWin: [], weeklyDayTimes: { 2: 42.0 }, weeklyDay: 2,
  });
  assert.equal(r.attemptsUsed, 1);
  assert.equal(r.priorBest, null);
  assert.equal(r.newBest, 42.0);
  assert.equal(r.summaryClass, 'par-even');
  assert.equal(r.summarySpanText, 'First attempt this week. You set the bar at 42.0s.');
  assert.equal(r.summaryTrailing, '');
});

test('fallback derivation excludes the current attempt from priorTimes', () => {
  // No snapshot passed: derive from weeklyDayTimes, filtering out the ~current
  // time. Only the genuinely-prior 50.0 remains → 2nd attempt.
  const r = summarizeWeeklyAttempt({
    precise: 42.0, priorTimesAtWin: undefined, weeklyDayTimes: { 1: 50.0, 2: 42.0 }, weeklyDay: 2,
  });
  assert.equal(r.attemptsUsed, 2);
  assert.equal(r.priorBest, 50.0);
});

test('faster than best: under-par class, delta, and new best', () => {
  const r = summarizeWeeklyAttempt({
    precise: 40.0, priorTimesAtWin: [50.0, 45.0], weeklyDayTimes: { 0: 50, 1: 45, 2: 40 }, weeklyDay: 2,
  });
  assert.equal(r.attemptsUsed, 3);
  assert.equal(r.priorBest, 45.0);
  assert.equal(r.newBest, 40.0);
  assert.equal(r.summaryClass, 'par-under');
  assert.equal(r.summarySpanText, '5.0s faster than your best');
  assert.equal(r.summaryTrailing, ' · new best 40.0s');
});

test('slower than best: over-par class keeps the prior best', () => {
  const r = summarizeWeeklyAttempt({
    precise: 60.0, priorTimesAtWin: [45.0], weeklyDayTimes: { 1: 45, 2: 60 }, weeklyDay: 2,
  });
  assert.equal(r.newBest, 45.0, 'a slower attempt does not improve the best');
  assert.equal(r.summaryClass, 'par-over');
  assert.equal(r.summarySpanText, '15.0s off your best');
  assert.equal(r.summaryTrailing, ' · still 45.0s to beat');
});

test('matched best: even class', () => {
  const r = summarizeWeeklyAttempt({
    precise: 45.0, priorTimesAtWin: [45.0], weeklyDayTimes: { 1: 45, 2: 45 }, weeklyDay: 2,
  });
  assert.equal(r.summaryClass, 'par-even');
  assert.equal(r.summarySpanText, 'Matched your best!');
  assert.equal(r.summaryTrailing, ' · 45.0s');
});

test('day circles mark today (◉), other played days (●), and not-yet (○)', () => {
  const r = summarizeWeeklyAttempt({
    precise: 30, priorTimesAtWin: [40], weeklyDayTimes: { 0: 40, 3: 30 }, weeklyDay: 3,
  });
  // index:        0   1   2   3(today)   4   5   6
  assert.equal(r.dayCircles, '● ○ ○ ◉ ○ ○ ○');
});
