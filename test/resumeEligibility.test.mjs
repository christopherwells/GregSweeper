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
import { readFileSync } from 'node:fs';
import {
  isSaveResumable, isLiveGameExpired, isWeeklyAttemptCacheStale, weeklyEntryPlan,
} from '../src/logic/resumeEligibility.js';

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

test('REGRESSION: a weekly save on a DIVERGENT board never resumes', () => {
  // The weekly branch required weeklyRngSeed only to be truthy, which proves
  // the save came from the weekly path and nothing about WHICH board. So a
  // save generated locally against a missed canonical resumed happily every
  // visit — the daily's Kate-on-trial3 scenario, on the mode where it costs
  // more (one of seven attempts, one board for the whole week's leaderboard).
  const diverged = ctx({
    mode: 'weekly',
    canonicalWeek: WEEK,
    canonicalWeeklyRngSeed: `${WEEK}:weekly:trial9`, // save carries :trial2
  });
  assert.equal(isSaveResumable(weeklySave(), diverged), false);
});

test('a weekly save MATCHING the canonical still resumes', () => {
  // Non-vacuity: the check must refuse a mismatch, not every weekly save.
  const agreeing = ctx({
    mode: 'weekly',
    canonicalWeek: WEEK,
    canonicalWeeklyRngSeed: `${WEEK}:weekly:trial2`,
  });
  assert.equal(isSaveResumable(weeklySave(), agreeing), true);
});

test('no cached weekly canonical (offline boot) leaves the save resumable', () => {
  // Same fail-open shape as the daily's: absence of the canonical is not
  // evidence of divergence, and a plane trip must not eat an attempt.
  assert.equal(isSaveResumable(weeklySave(), ctx({ mode: 'weekly', canonicalWeeklyRngSeed: null })), true);
  // A canonical cached for a DIFFERENT week says nothing about this save.
  assert.equal(isSaveResumable(weeklySave(), ctx({
    mode: 'weekly', canonicalWeek: LAST_WEEK, canonicalWeeklyRngSeed: 'other:trial9',
  })), true);
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

// ── Weekly-attempt cache rollover (long-open session) ──

test('REGRESSION: weekly-attempt cache is stale when the week rolled over while open', () => {
  // The bug: a background tab / installed PWA seeds state.cachedWeekly-
  // DayAttempts once at boot and never re-derives it. Reopened after the
  // Sunday→Monday boundary, it still holds last week's all-7-days map, so
  // the Weekly card showed "Done 7/7" and the play gate refused a new
  // attempt on a week that had actually reset ("the weekly didn't reset",
  // reported 2026-06-29). This flag is what drives the on-wake re-seed.
  assert.equal(isWeeklyAttemptCacheStale(LAST_WEEK, WEEK), true);
});

test('weekly-attempt cache is fresh when the cached week matches the live week', () => {
  assert.equal(isWeeklyAttemptCacheStale(WEEK, WEEK), false);
});

test('a never-seeded weekly cache (null week) is treated as stale and re-seeds', () => {
  assert.equal(isWeeklyAttemptCacheStale(null, WEEK), true);
  assert.equal(isWeeklyAttemptCacheStale(undefined, WEEK), true);
});

test('missing live week (date helper unavailable) is never a rollover', () => {
  // Guard against churn if getWeekStart() ever returns falsy — better to
  // keep the existing cache than to wipe it to an empty map mid-session.
  assert.equal(isWeeklyAttemptCacheStale(WEEK, ''), false);
  assert.equal(isWeeklyAttemptCacheStale(WEEK, null), false);
});

// ── Explicit topology (Coastline tiling saves) ─────────
//
// The save snapshot is JSON, and JSON.stringify drops properties stamped on
// the board ARRAY — which is why wallEdges rides as its own top-level field.
// _cellNeighbors had no such field, so a tiling game saved and resumed came
// back RECTANGULAR mid-play: the board silently changes shape under the
// player and the adjacency it was certified under is gone (found in the
// Coastline Phase 1 adversarial review, 2026-07-19).

// A tiny but real 4.8.8 patch: 4 octagons in a square, 1 interstitial square
// cell touching all four. Indices 0-3 octagons, 4 the square.
const TILING_5 = [
  [1, 2, 4],
  [0, 3, 4],
  [0, 3, 4],
  [1, 2, 4],
  [0, 1, 2, 3],
];

// Matching geometry for the 5-cell patch (values only need the right SHAPE
// here — eligibility validates presence and length, not coordinates).
const TILING_POS = [
  { cx: 0.5, cy: 0.5, shape: 'oct' }, { cx: 1.5, cy: 0.5, shape: 'oct' },
  { cx: 0.5, cy: 1.5, shape: 'oct' }, { cx: 1.5, cy: 1.5, shape: 'oct' },
  { cx: 1.0, cy: 1.0, shape: 'sq' },
];

function tilingSave(overrides = {}) {
  return dailySave({
    rows: 5, cols: 1, board: mkBoard(5, 1),
    cellNeighbors: TILING_5,
    cellPos: TILING_POS,
    tiling: { type: '4.8.8', M: 2, N: 2, wUnits: 2, hUnits: 2 },
    tilingWalls: [],
    ...overrides,
  });
}

test('a save carrying a valid explicit topology resumes', () => {
  assert.equal(isSaveResumable(tilingSave(), ctx()), true);
});

test('REGRESSION #189: a topology without its geometry never resumes', () => {
  // The pre-fix save shape: cellNeighbors persisted, cellPos/tiling dropped.
  // Restoring it hands the renderer a board whose own tiling test
  // (_cellPos) fails, so hexagons come back as a rectangular CSS grid whose
  // hit-testing is not the board — refuse and let newGame() rebuild.
  assert.equal(isSaveResumable(tilingSave({ cellPos: undefined, tiling: undefined }), ctx()), false);
  assert.equal(isSaveResumable(tilingSave({ cellPos: null }), ctx()), false);
  assert.equal(isSaveResumable(tilingSave({ tiling: null }), ctx()), false);
  // A geometry list that does not cover every cell is as unrenderable as a
  // missing one.
  assert.equal(isSaveResumable(tilingSave({ cellPos: TILING_POS.slice(0, 3) }), ctx()), false);
  // And a descriptor without the fields applyWallsTiling rebuilds from.
  assert.equal(isSaveResumable(tilingSave({ tiling: { type: '4.8.8' } }), ctx()), false);
});

test('REGRESSION: a save whose topology is TRUNCATED never resumes', () => {
  // The shape a partial write or a quota-clipped save leaves behind.
  // Restoring it would hand the player a board whose adjacency disagrees
  // with the one it was certified under — the no-guess promise breaking
  // silently rather than loudly.
  assert.equal(isSaveResumable(tilingSave({ cellNeighbors: TILING_5.slice(0, 3) }), ctx()), false);
});

test('REGRESSION: a save whose topology is ASYMMETRIC never resumes', () => {
  // One direction severed: 0 still lists 1, but 1 no longer lists 0. A board
  // like this solves happily for the certifier and is unsolvable in the hand,
  // because one cell's clue counts a mine the mine's own neighborhood does not.
  const broken = TILING_5.map(l => l.slice());
  broken[1] = broken[1].filter(x => x !== 0);
  assert.equal(isSaveResumable(tilingSave({ cellNeighbors: broken }), ctx()), false);
});

test('a save whose topology names an out-of-range cell never resumes', () => {
  const broken = TILING_5.map(l => l.slice());
  broken[0] = [...broken[0], 99];
  assert.equal(isSaveResumable(tilingSave({ cellNeighbors: broken }), ctx()), false);
});

test('ordinary rectangular saves carry no topology and are unaffected', () => {
  // The field is absent on every board shipped today; its absence must never
  // be read as a corrupt topology.
  assert.equal(isSaveResumable(dailySave(), ctx()), true);
  assert.equal(isSaveResumable(dailySave({ cellNeighbors: null }), ctx()), true);
  assert.equal(isSaveResumable(dailySave({ cellNeighbors: undefined }), ctx()), true);
});

// ── Archive replays are anchored to the past on purpose ──────────────────
// Expiry exists so yesterday's unfinished attempt cannot resurrect as today's.
// A replay of a past board is not an attempt at anything, so the clock must
// never invalidate it — before this, backgrounding the tab during one and
// coming back expired the board mid-play and toasted the player about a new
// day. Found while adding the weekly's archive lane (2026-08-05); the daily
// lane had it too.
test('an archive replay never expires on a clock wake', () => {
  const clock = { today: '2026-08-05', weekStart: '2026-08-03', weekDayIndex: 2 };

  // Daily: a past board being replayed.
  assert.equal(isLiveGameExpired({
    gameMode: 'daily', status: 'playing', dailySeed: '2026-06-14', isArchivePlay: true,
  }, clock), false);
  // Control: the same past date WITHOUT the archive flag is a stale live
  // daily, and must still expire — that is the case expiry was built for.
  assert.equal(isLiveGameExpired({
    gameMode: 'daily', status: 'playing', dailySeed: '2026-06-14',
  }, clock), true);

  // Weekly: a past week being replayed.
  assert.equal(isLiveGameExpired({
    gameMode: 'weekly', status: 'playing', weeklySeed: '2026-07-20', weeklyDay: null,
    isWeeklyArchive: true,
  }, clock), false);
  // Control: last week's live attempt is forfeit, as it has always been.
  assert.equal(isLiveGameExpired({
    gameMode: 'weekly', status: 'playing', weeklySeed: '2026-07-20', weeklyDay: 2,
  }, clock), true);
});

// ── The weekly's one-attempt-per-day gate (issue #246) ───────────────────
// The attempt is committed on the FIRST CLICK, so a mine hit followed by a
// restart cannot buy a second one. The card then refused entry on that same
// marker — and since it is the only production door into weekly mode, the
// resume branch behind it could never run. One Home tap mid-attempt and the
// board was unreachable for good, with the day's cloud-recorded attempt spent
// on a puzzle the player never finished.
test('an unused day starts a fresh attempt', () => {
  assert.equal(weeklyEntryPlan({ attempted: false, resumable: false }), 'fresh');
  // A leftover save from an earlier day cannot make a fresh day look used.
  assert.equal(weeklyEntryPlan({ attempted: false, resumable: true }), 'fresh');
});

test('REGRESSION: a committed attempt whose board is still open RESUMES', () => {
  assert.equal(weeklyEntryPlan({ attempted: true, resumable: true }), 'resume',
    'resuming the first attempt is not a second attempt');
});

test('a committed attempt with no live board is blocked until tomorrow', () => {
  // Winning clears the slot, which is what makes a finished attempt
  // unresumable — the same signal every other mode ends a game with.
  assert.equal(weeklyEntryPlan({ attempted: true, resumable: false }), 'blocked');
});

test('a missing context blocks nothing on its own', () => {
  assert.equal(weeklyEntryPlan(), 'fresh');
  assert.equal(weeklyEntryPlan({}), 'fresh');
});

test('REGRESSION: every weekly entry gate routes through weeklyEntryPlan', () => {
  // The rule being right is not enough — the defect was a caller that never
  // asked it. Each gate that can turn a player away must consult the plan,
  // and the plan must be able to see a live save.
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const lines = main.split('\n');

  const refusals = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => line.includes("already played today's weekly puzzle"));
  assert.ok(refusals.length >= 2, 'the mode card and the Play Again button both refuse');
  for (const { i } of refusals) {
    const window = lines.slice(Math.max(0, i - 4), i).join('\n');
    assert.match(window, /weeklyEntryPlan\(/,
      `the refusal at main.js:${i + 1} must come from the plan, not from the attempt marker alone`);
  }

  // The ?mode=weekly deep link is the door that turns players away SILENTLY,
  // so it has no toast to find it by: locate its branch and read it directly.
  const deepLink = main.slice(main.indexOf("deepLinkMode === 'weekly'"));
  assert.ok(deepLink, 'the weekly deep-link branch must exist');
  assert.match(deepLink.slice(0, 900), /weeklyEntryPlan\(/,
    '?mode=weekly must ask the same question, or a notification tap strands an open attempt');

  // And the context must actually look for a resumable board; without this
  // the plan can only ever answer 'fresh' or 'blocked'.
  const ctx = main.match(/function weeklyEntryContext\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(ctx, 'weeklyEntryContext must exist as the one place the two facts are gathered');
  assert.match(ctx[0], /canResumeMode\('weekly'\)/);
  assert.match(ctx[0], /cachedWeeklyDayAttempts/);
});
