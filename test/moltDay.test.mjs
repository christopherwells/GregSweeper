// Molt day (streak insurance) contract. Pins the pure bank math shared by the
// completion path, the app-load provisional notice, and the push script. A
// silent change here would either break a streak a molt day should have saved
// or fabricate a save that did not happen, so every branch is nailed down.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyStreakContinuation,
  projectContinuation,
  isStreakAlive,
  coversTonight,
  MOLT_EARN_EVERY,
  MOLT_CAP,
} from '../src/logic/moltDay.js';

test('constants: earn every 5, hold at most 2', () => {
  assert.equal(MOLT_EARN_EVERY, 5);
  assert.equal(MOLT_CAP, 2);
});

// ── applyStreakContinuation: the no-gap cases ──────────────────────────
test('first daily ever: streak 1, nothing banked', () => {
  assert.deepEqual(
    applyStreakContinuation({ lastDailyDate: null, streak: 0, banked: 0, today: '2026-06-16' }),
    { streak: 1, banked: 0, coveredDates: [], earned: false }
  );
});

test('same day re-run: streak and bank unchanged, no earn', () => {
  // Defensive path (the completion gate blocks a real replay). Must not
  // re-bank even if the streak already sits on a multiple of 5.
  assert.deepEqual(
    applyStreakContinuation({ lastDailyDate: '2026-06-16', streak: 5, banked: 1, today: '2026-06-16' }),
    { streak: 5, banked: 1, coveredDates: [], earned: false }
  );
});

test('consecutive day: streak + 1, no earn off a multiple', () => {
  assert.deepEqual(
    applyStreakContinuation({ lastDailyDate: '2026-06-15', streak: 3, banked: 0, today: '2026-06-16' }),
    { streak: 4, banked: 0, coveredDates: [], earned: false }
  );
});

// ── Earning ────────────────────────────────────────────────────────────
test('earn at 5: bank goes 0 -> 1', () => {
  assert.deepEqual(
    applyStreakContinuation({ lastDailyDate: '2026-06-15', streak: 4, banked: 0, today: '2026-06-16' }),
    { streak: 5, banked: 1, coveredDates: [], earned: true }
  );
});

test('earn at 10: bank goes 1 -> 2', () => {
  assert.deepEqual(
    applyStreakContinuation({ lastDailyDate: '2026-06-15', streak: 9, banked: 1, today: '2026-06-16' }),
    { streak: 10, banked: 2, coveredDates: [], earned: true }
  );
});

test('cap at 2: a multiple-of-5 completion at a full bank earns nothing', () => {
  assert.deepEqual(
    applyStreakContinuation({ lastDailyDate: '2026-06-15', streak: 14, banked: 2, today: '2026-06-16' }),
    { streak: 15, banked: 2, coveredDates: [], earned: false }
  );
});

// ── Spending ─────────────────────────────────────────────────────────────
test('single-miss spend: one banked day covers a one-day gap, streak continues', () => {
  // last played 06-14, today 06-16, so 06-15 was missed and is now covered.
  assert.deepEqual(
    applyStreakContinuation({ lastDailyDate: '2026-06-14', streak: 7, banked: 1, today: '2026-06-16' }),
    { streak: 8, banked: 0, coveredDates: ['2026-06-15'], earned: false }
  );
});

test('double-miss spend: two banked days cover a two-day gap', () => {
  assert.deepEqual(
    applyStreakContinuation({ lastDailyDate: '2026-06-13', streak: 6, banked: 2, today: '2026-06-16' }),
    { streak: 7, banked: 0, coveredDates: ['2026-06-14', '2026-06-15'], earned: false }
  );
});

test('covered days do not help earn: an 8 over a covered gap lands on 9, not 10', () => {
  // If the covered day counted toward the streak it would reach 10 and earn.
  // It must not: only today's completion adds, so the streak is 9.
  assert.deepEqual(
    applyStreakContinuation({ lastDailyDate: '2026-06-14', streak: 8, banked: 1, today: '2026-06-16' }),
    { streak: 9, banked: 0, coveredDates: ['2026-06-15'], earned: false }
  );
});

test('gap exactly at the bank is covered (missed === banked)', () => {
  assert.deepEqual(
    applyStreakContinuation({ lastDailyDate: '2026-06-13', streak: 3, banked: 2, today: '2026-06-16' }),
    { streak: 4, banked: 0, coveredDates: ['2026-06-14', '2026-06-15'], earned: false }
  );
});

// ── Resetting (bank retained) ────────────────────────────────────────────
test('gap one over the bank: reset to 1, bank RETAINED', () => {
  assert.deepEqual(
    applyStreakContinuation({ lastDailyDate: '2026-06-13', streak: 7, banked: 1, today: '2026-06-16' }),
    { streak: 1, banked: 1, coveredDates: [], earned: false }
  );
});

test('triple-miss with 2 banked: reset, both molt days retained', () => {
  // 06-12 -> 06-16 misses 13/14/15 (3 days) > 2 banked: all-or-nothing reset.
  assert.deepEqual(
    applyStreakContinuation({ lastDailyDate: '2026-06-12', streak: 9, banked: 2, today: '2026-06-16' }),
    { streak: 1, banked: 2, coveredDates: [], earned: false }
  );
});

// ── Calendar boundaries ──────────────────────────────────────────────────
test('month rollover counts as consecutive', () => {
  assert.deepEqual(
    applyStreakContinuation({ lastDailyDate: '2026-05-31', streak: 4, banked: 0, today: '2026-06-01' }),
    { streak: 5, banked: 1, coveredDates: [], earned: true }
  );
});

test('covered gap across a month boundary lists the right missed date', () => {
  assert.deepEqual(
    applyStreakContinuation({ lastDailyDate: '2026-05-31', streak: 7, banked: 1, today: '2026-06-02' }),
    { streak: 8, banked: 0, coveredDates: ['2026-06-01'], earned: false }
  );
});

test('bank is clamped: an out-of-range stored bank cannot over-cover', () => {
  // A corrupted bank of 9 still can only ever behave as MOLT_CAP (2).
  const r = applyStreakContinuation({ lastDailyDate: '2026-06-11', streak: 7, banked: 9, today: '2026-06-16' });
  // 06-11 -> 06-16 misses 4 days (12/13/14/15) > 2 -> reset.
  assert.equal(r.streak, 1);
  assert.equal(r.banked, 2);
});

// ── projectContinuation mirrors the commit ───────────────────────────────
test('projectContinuation: covered gap reports willCover + the same streak', () => {
  const args = { lastDailyDate: '2026-06-14', streak: 7, banked: 1, today: '2026-06-16' };
  const commit = applyStreakContinuation(args);
  assert.deepEqual(projectContinuation(args), {
    willCover: true,
    coveredDates: commit.coveredDates,
    streakAfter: commit.streak,
  });
  assert.equal(commit.streak, 8);
});

test('projectContinuation: consecutive day does not cover', () => {
  assert.deepEqual(
    projectContinuation({ lastDailyDate: '2026-06-15', streak: 7, banked: 1, today: '2026-06-16' }),
    { willCover: false, coveredDates: [], streakAfter: 8 }
  );
});

test('projectContinuation: an uncoverable gap projects a reset, no cover', () => {
  assert.deepEqual(
    projectContinuation({ lastDailyDate: '2026-06-10', streak: 7, banked: 1, today: '2026-06-16' }),
    { willCover: false, coveredDates: [], streakAfter: 1 }
  );
});

// ── isStreakAlive (read-side lapse check) ────────────────────────────────
test('isStreakAlive: today and yesterday are alive', () => {
  assert.equal(isStreakAlive({ lastDailyDate: '2026-06-16', banked: 0, today: '2026-06-16' }), true);
  assert.equal(isStreakAlive({ lastDailyDate: '2026-06-15', banked: 0, today: '2026-06-16' }), true);
});

test('isStreakAlive: a one-day gap needs at least one banked day', () => {
  assert.equal(isStreakAlive({ lastDailyDate: '2026-06-14', banked: 0, today: '2026-06-16' }), false);
  assert.equal(isStreakAlive({ lastDailyDate: '2026-06-14', banked: 1, today: '2026-06-16' }), true);
});

test('isStreakAlive: a two-day gap needs two banked days', () => {
  assert.equal(isStreakAlive({ lastDailyDate: '2026-06-13', banked: 1, today: '2026-06-16' }), false);
  assert.equal(isStreakAlive({ lastDailyDate: '2026-06-13', banked: 2, today: '2026-06-16' }), true);
});

test('isStreakAlive: no history is not alive', () => {
  assert.equal(isStreakAlive({ lastDailyDate: null, banked: 2, today: '2026-06-16' }), false);
});

// ── coversTonight (push gate) ────────────────────────────────────────────
test('coversTonight: played yesterday, one banked day covers skipping tonight', () => {
  assert.equal(coversTonight({ lastDailyDate: '2026-06-15', banked: 0, today: '2026-06-16' }), false);
  assert.equal(coversTonight({ lastDailyDate: '2026-06-15', banked: 1, today: '2026-06-16' }), true);
});

test('coversTonight: already missed a day needs two banked to cover tonight too', () => {
  // last 06-14, today 06-16: 06-15 already missed. Skipping tonight makes two.
  assert.equal(coversTonight({ lastDailyDate: '2026-06-14', banked: 1, today: '2026-06-16' }), false);
  assert.equal(coversTonight({ lastDailyDate: '2026-06-14', banked: 2, today: '2026-06-16' }), true);
});

test('coversTonight: already played today, or no history, is never at risk-to-cover', () => {
  assert.equal(coversTonight({ lastDailyDate: '2026-06-16', banked: 2, today: '2026-06-16' }), false);
  assert.equal(coversTonight({ lastDailyDate: null, banked: 2, today: '2026-06-16' }), false);
});
