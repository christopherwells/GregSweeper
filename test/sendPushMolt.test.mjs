// Push-notification molt-day branches. The 8pm streak warning must NOT fire
// when a banked molt day covers tonight (it would be a false alarm) — a soft
// covered-nudge goes out instead — and the morning reminder acknowledges a
// cover that saved yesterday. These pin the decision helpers send-push.mjs
// uses for both passes. (The bank math itself is in test/moltDay.test.mjs.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reminderDecision, streakDecision } from '../scripts/send-push.mjs';

const DATE = '2026-06-16';
const YESTERDAY = '2026-06-15';
const onPrefs = { enabled: true, hourLocal: 9, dailyReminder: true, streakWarning: true };

// ── 8pm streak pass ──────────────────────────────────────────────────────
test('streak warning fires at risk (played yesterday, nothing banked)', () => {
  const p = streakDecision({
    prefs: onPrefs, dailyStreak: 5, lastDailyDate: YESTERDAY, moltDay: { banked: 0 }, date: DATE,
  });
  assert.ok(p, 'should send a warning');
  assert.equal(p.tag, 'gregsweeper-streak');
  assert.equal(p.title, 'GregSweeper — Streak warning');
  assert.ok(p.body.includes('5'), 'warning names the streak length');
});

test('streak warning is replaced by the soft covered-nudge when a molt day covers tonight', () => {
  const p = streakDecision({
    prefs: onPrefs, dailyStreak: 5, lastDailyDate: YESTERDAY, moltDay: { banked: 1 }, date: DATE,
  });
  assert.ok(p, 'covered users still get the soft nudge');
  assert.equal(p.title, 'GregSweeper — Streak covered');
  assert.equal(p.tag, 'gregsweeper-streak');
  assert.ok(!p.body.includes('ends at midnight'), 'must not use the at-risk wording');
});

test('streak pass: already played today is skipped', () => {
  const p = streakDecision({
    prefs: onPrefs, dailyStreak: 9, lastDailyDate: DATE, moltDay: { banked: 0 }, date: DATE,
  });
  assert.equal(p, null);
});

test('streak pass: streak under 3 is skipped', () => {
  assert.equal(
    streakDecision({ prefs: onPrefs, dailyStreak: 2, lastDailyDate: YESTERDAY, moltDay: { banked: 0 }, date: DATE }),
    null
  );
});

test('streak pass: opted out of streak warnings is skipped (even when covered)', () => {
  const off = { ...onPrefs, streakWarning: false };
  assert.equal(
    streakDecision({ prefs: off, dailyStreak: 9, lastDailyDate: YESTERDAY, moltDay: { banked: 2 }, date: DATE }),
    null
  );
});

test('streak pass: a deeper gap the bank cannot cover still warns', () => {
  // last played 06-13, today 06-16: 2 days already missed. Skipping tonight is
  // a 3rd; 1 banked can't cover it, so the warning is honest.
  const p = streakDecision({
    prefs: onPrefs, dailyStreak: 9, lastDailyDate: '2026-06-13', moltDay: { banked: 1 }, date: DATE,
  });
  assert.ok(p);
  assert.equal(p.title, 'GregSweeper — Streak warning');
});

// ── Morning reminder pass ────────────────────────────────────────────────
test('morning reminder acknowledges a molt day that covered yesterday', () => {
  const p = reminderDecision({
    prefs: onPrefs, category: 'daily', hour: 9,
    moltDay: { banked: 0, lastUse: { date: YESTERDAY, covered: ['2026-06-14'], streakKept: 8 } },
    date: DATE, yesterday: YESTERDAY,
  });
  assert.ok(p);
  assert.equal(p.tag, 'gregsweeper-daily');
  assert.ok(p.body.toLowerCase().includes('molt day covered'), 'names the cover');
  assert.ok(p.body.includes('Streak intact at 8'), 'names the kept streak');
});

test('morning reminder is the plain daily nudge when no cover happened', () => {
  const p = reminderDecision({
    prefs: onPrefs, category: 'daily', hour: 9,
    moltDay: null, date: DATE, yesterday: YESTERDAY,
  });
  assert.ok(p);
  assert.equal(p.tag, 'gregsweeper-daily');
  assert.ok(!p.body.toLowerCase().includes('molt day'), 'no molt mention on a normal day');
});

test('morning reminder: a stale lastUse (not yesterday) does not trigger the ack', () => {
  const p = reminderDecision({
    prefs: onPrefs, category: 'daily', hour: 9,
    moltDay: { banked: 1, lastUse: { date: '2026-06-10', covered: ['2026-06-09'], streakKept: 6 } },
    date: DATE, yesterday: YESTERDAY,
  });
  assert.ok(p);
  assert.ok(!p.body.toLowerCase().includes('molt day covered'), 'only yesterday acks');
});

test('morning reminder: hour mismatch is skipped', () => {
  assert.equal(
    reminderDecision({ prefs: onPrefs, category: 'daily', hour: 8, moltDay: null, date: DATE, yesterday: YESTERDAY }),
    null
  );
});
