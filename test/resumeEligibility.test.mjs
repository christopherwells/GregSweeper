// Resume-eligibility regression suite.
//
// Pins the date-anchoring contract for persisted saves and live
// sessions: a daily belongs to one ET date, a weekly attempt to one
// (weekStart, dayIndex) pair, and crossing midnight forfeits an
// unfinished attempt. The headline regression: a daily save whose
// seed fingerprint was stripped (dailySeed: null — written by the
// pre-fix Daily card handler nulling live seeds before switchMode
// persisted the outgoing game) must NEVER resume. That save resumed
// unconditionally and resurrected yesterday's board as "today's"
// daily (reported 2026-06-12).

import test from 'node:test';
import assert from 'node:assert/strict';
import { isSaveResumable, isLiveGameExpired } from '../src/logic/resumeEligibility.js';

const TODAY = '2026-06-12';
const YESTERDAY = '2026-06-11';
const WEEK = '2026-06-08';
const LAST_WEEK = '2026-06-01';
const DAY_IDX = 4; // Friday

function mkBoard(rows = 2, cols = 2) {
  return Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => ({ row: r, col: c, isMine: false, adjacentMines: 0 })));
}

function dailySave(overrides = {}) {
  return {
    board: mkBoard(),
    gameMode: 'daily',
    dailySeed: TODAY,
    dailyRngSeed: `${TODAY}:trial8`,
    savedStatus: 'playing',
    ...overrides,
  };
}

function weeklySave(overrides = {}) {
  return {
    board: mkBoard(),
    gameMode: 'weekly',
    weeklySeed: WEEK,
    weeklyDay: DAY_IDX,
    weeklyRngSeed: `${WEEK}:weekly:trial2`,
    savedStatus: 'playing',
    ...overrides,
  };
}

function ctx(overrides = {}) {
  return {
    mode: 'daily',
    today: TODAY,
    weekStart: WEEK,
    weekDayIndex: DAY_IDX,
    isDailyPractice: false,
    practiceSeed: null,
    canonicalDate: TODAY,
    canonicalRngSeed: `${TODAY}:trial8`,
    ...overrides,
  };
}

// ── Daily saves ────────────────────────────────────────

test('daily save for today with matching canonical resumes', () => {
  assert.equal(isSaveResumable(dailySave(), ctx()), true);
});

test('REGRESSION: fingerprint-less daily save (dailySeed null) never resumes', () => {
  // The exact poisoned save the pre-fix card handler wrote. It used to
  // bypass every guard (each guard skipped itself when the field it
  // checks was missing) and resume yesterday's board on any date.
  const poisoned = dailySave({ dailySeed: null, dailyRngSeed: null });
  assert.equal(isSaveResumable(poisoned, ctx()), false);
});

test('daily save missing only dailyRngSeed never resumes', () => {
  assert.equal(isSaveResumable(dailySave({ dailyRngSeed: null }), ctx()), false);
});

test("yesterday's daily save is rejected on today's clock", () => {
  const stale = dailySave({ dailySeed: YESTERDAY, dailyRngSeed: `${YESTERDAY}:trial3` });
  assert.equal(isSaveResumable(stale, ctx()), false);
});

test('clock anchor holds even with no canonical board cached (offline)', () => {
  const stale = dailySave({ dailySeed: YESTERDAY, dailyRngSeed: `${YESTERDAY}:trial3` });
  assert.equal(isSaveResumable(stale, ctx({ canonicalDate: null, canonicalRngSeed: null })), false);
  assert.equal(isSaveResumable(dailySave(), ctx({ canonicalDate: null, canonicalRngSeed: null })), true);
});

test('divergent-canonical daily save is rejected (Kate 2026-05-06)', () => {
  const divergent = dailySave({ dailyRngSeed: `${TODAY}:trial3` });
  assert.equal(isSaveResumable(divergent, ctx({ canonicalRngSeed: `${TODAY}:trial5` })), false);
});

test('practice save resumes only under its own practice seed', () => {
  const practice = dailySave({ dailySeed: 'my-custom-seed', dailyRngSeed: 'my-custom-seed' });
  assert.equal(isSaveResumable(practice, ctx({ isDailyPractice: true, practiceSeed: 'my-custom-seed' })), true);
  // Entering the official daily (card tap) must not resume a practice board.
  assert.equal(isSaveResumable(practice, ctx()), false);
  // A different practice seed must not resume another seed's board.
  assert.equal(isSaveResumable(practice, ctx({ isDailyPractice: true, practiceSeed: 'other-seed' })), false);
});

test("official daily save does not resume into a practice session", () => {
  assert.equal(isSaveResumable(dailySave(), ctx({ isDailyPractice: true, practiceSeed: 'my-custom-seed' })), false);
});

// ── Cross-mode and corrupt saves ───────────────────────

test('save whose gameMode disagrees with the slot is rejected', () => {
  const crossMode = { board: mkBoard(), gameMode: 'normal', currentLevel: 7 };
  assert.equal(isSaveResumable(crossMode, ctx({ mode: 'daily' })), false);
});

test('challenge save has no date anchor and resumes', () => {
  const challenge = { board: mkBoard(), gameMode: 'normal', currentLevel: 7 };
  assert.equal(isSaveResumable(challenge, ctx({ mode: 'normal' })), true);
});

test('null / boardless / modeless saves are rejected', () => {
  assert.equal(isSaveResumable(null, ctx()), false);
  assert.equal(isSaveResumable({ gameMode: 'daily' }, ctx()), false);
  assert.equal(isSaveResumable({ board: mkBoard() }, ctx()), false);
});

test('v1.5.19 corrupt cells (missing row/col) are rejected', () => {
  const corrupt = dailySave();
  corrupt.board = [[{ isMine: false, adjacentMines: 0 }]];
  assert.equal(isSaveResumable(corrupt, ctx()), false);
});

// ── Weekly saves ───────────────────────────────────────

test("weekly save for today's attempt resumes", () => {
  assert.equal(isSaveResumable(weeklySave(), ctx({ mode: 'weekly' })), true);
});

test("a previous day's weekly attempt is forfeit on the new day", () => {
  const stale = weeklySave({ weeklyDay: DAY_IDX - 1 });
  assert.equal(isSaveResumable(stale, ctx({ mode: 'weekly' })), false);
});

test("last week's weekly save is rejected in a new week", () => {
  const stale = weeklySave({ weeklySeed: LAST_WEEK });
  assert.equal(isSaveResumable(stale, ctx({ mode: 'weekly' })), false);
});

test('weekly save with incomplete identity never resumes', () => {
  assert.equal(isSaveResumable(weeklySave({ weeklyRngSeed: null }), ctx({ mode: 'weekly' })), false);
  assert.equal(isSaveResumable(weeklySave({ weeklyDay: null }), ctx({ mode: 'weekly' })), false);
  assert.equal(isSaveResumable(weeklySave({ weeklySeed: null }), ctx({ mode: 'weekly' })), false);
});

// ── Live-session expiry (visibility wake) ──────────────

const CLOCK = { today: TODAY, weekStart: WEEK, weekDayIndex: DAY_IDX };

test("live daily from yesterday expires on wake, today's does not", () => {
  assert.equal(isLiveGameExpired({ gameMode: 'daily', status: 'playing', dailySeed: YESTERDAY }, CLOCK), true);
  assert.equal(isLiveGameExpired({ gameMode: 'daily', status: 'idle', dailySeed: YESTERDAY }, CLOCK), true);
  assert.equal(isLiveGameExpired({ gameMode: 'daily', status: 'playing', dailySeed: TODAY }, CLOCK), false);
});

test('live practice daily never expires', () => {
  assert.equal(isLiveGameExpired(
    { gameMode: 'daily', status: 'playing', isDailyPractice: true, dailySeed: 'my-custom-seed' }, CLOCK), false);
});

test('live weekly expires on day or week rollover', () => {
  assert.equal(isLiveGameExpired({ gameMode: 'weekly', status: 'playing', weeklySeed: WEEK, weeklyDay: DAY_IDX - 1 }, CLOCK), true);
  assert.equal(isLiveGameExpired({ gameMode: 'weekly', status: 'playing', weeklySeed: LAST_WEEK, weeklyDay: DAY_IDX }, CLOCK), true);
  assert.equal(isLiveGameExpired({ gameMode: 'weekly', status: 'playing', weeklySeed: WEEK, weeklyDay: DAY_IDX }, CLOCK), false);
});

test('finished or modeless games never expire', () => {
  assert.equal(isLiveGameExpired({ gameMode: 'daily', status: 'won', dailySeed: YESTERDAY }, CLOCK), false);
  assert.equal(isLiveGameExpired({ gameMode: 'daily', status: 'lost', dailySeed: YESTERDAY }, CLOCK), false);
  assert.equal(isLiveGameExpired({ gameMode: 'normal', status: 'playing' }, CLOCK), false);
  assert.equal(isLiveGameExpired({ gameMode: 'timed', status: 'playing' }, CLOCK), false);
});
