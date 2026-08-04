// The weekly feeds the par model.
//
// REGRESSION (2026-08-04): it never had. `WEEKLY_FIT_DATA_ENABLED` in
// winLossHandler shipped FALSE in v1.6 as a deliberate hold — the weekly's
// rules were still moving and half-baked inputs would have dragged the
// coefficients — and the flag was never flipped. Fourteen weeks and 34
// player-weeks of real completions went unrecorded, and the symptom was
// silent: `daily/{weekStart}_weekly_first` was simply empty for every week
// while `dailyMeta/{weekStart}_weekly_first` filled in normally, because the
// PRECOMPUTE half writes meta at generation and only the SCORE half was
// gated.
//
// A boolean constant cannot be caught by a behaviour test that never asserts
// on it, which is why this file asserts on the constant itself. The
// submission's payload shape is covered by winSubmissionPlan; what is pinned
// here is that the gate is OPEN and that the recovery script's own reading of
// the stored history is right.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const WIN_LOSS = readFileSync('src/game/winLossHandler.js', 'utf8');

test('REGRESSION: the weekly first-attempt submission is ENABLED', () => {
  const m = WIN_LOSS.match(/const WEEKLY_FIT_DATA_ENABLED = (true|false);/);
  assert.ok(m, 'WEEKLY_FIT_DATA_ENABLED has moved or been renamed');
  assert.equal(m[1], 'true',
    'the weekly first attempt must feed the par fit. It shipped false as a temporary '
    + 'hold in v1.6 and stayed that way for fourteen weeks; if it is being turned off '
    + 'again, that is a decision worth writing down beside the constant.');
});

test('the submission is still gated to the FIRST attempt of the week', () => {
  // Days 2-7 are speedruns of a known board and must never enter the fit.
  // The flag being on makes that gate load-bearing rather than academic.
  assert.match(WIN_LOSS, /isFirstAttemptThisWeek && WEEKLY_FIT_DATA_ENABLED/,
    'the first-attempt gate must still guard the submission');
  assert.match(WIN_LOSS, /_weeklyPriorTimesAtWin[\s\S]{0,200}length === 0/,
    'first-attempt detection must read the PRE-win snapshot, not the mutated map');
});

test('the submission lands on the key the refit joins against', () => {
  assert.match(WIN_LOSS, /state\.weeklySeed \+ '_weekly_first'/,
    'the row key must be {weekStart}_weekly_first, which is what dailyMeta uses too');
});

// ── The recovery script's reading of stored history ──────────────────────

// `weekly/{weekStart}/{uid}` carries dayTimes and dayBombHits as day-indexed
// arrays (0 = Monday) with holes for unplayed days. Firebase turns a sparse
// array into an OBJECT, so both shapes reach the reader; picking the earliest
// played day wrong would silently backfill the wrong attempt.
function firstAttempt(rec) {
  const times = rec.dayTimes || {};
  const bombs = rec.dayBombHits || {};
  const days = Object.keys(times)
    .filter((k) => times[k] !== null && times[k] !== undefined && Number.isFinite(Number(times[k])))
    .map(Number)
    .sort((a, b) => a - b);
  if (!days.length) return null;
  const day = days[0];
  return { day, time: Number(times[day]), bombHits: Number(bombs[day] ?? bombs[String(day)] ?? 0) || 0 };
}

test('the first attempt of the week is read correctly from stored history', () => {
  // A dense array, Monday first.
  assert.deepEqual(
    firstAttempt({ dayTimes: [117.4, 178.1, 72.9], dayBombHits: [2, 2, 0] }),
    { day: 0, time: 117.4, bombHits: 2 });

  // Leading holes: the real 2026-05-04 shape, where nobody played until
  // Thursday. Taking index 0 would read null as the first attempt.
  assert.deepEqual(
    firstAttempt({ dayTimes: [null, null, null, 123, 138.3], dayBombHits: [null, null, null, 1, 3] }),
    { day: 3, time: 123, bombHits: 1 });

  // The sparse-array-as-object shape Firebase actually returns.
  assert.deepEqual(
    firstAttempt({ dayTimes: { 2: 90.5, 5: 71.2 }, dayBombHits: { 2: 1, 5: 0 } }),
    { day: 2, time: 90.5, bombHits: 1 });

  // Day ordering is NUMERIC, not lexicographic: '10' must not sort before '2'.
  assert.equal(firstAttempt({ dayTimes: { 2: 50, 10: 40 } }).day, 2);

  // A missing bomb count is zero, not NaN — it rides into the fit as a number.
  assert.equal(firstAttempt({ dayTimes: [60] }).bombHits, 0);
  assert.equal(firstAttempt({ dayTimes: {}, dayBombHits: {} }), null);
  assert.equal(firstAttempt({}), null);
});

test('the backfilled marker is whitelisted in the daily row rules', () => {
  // An un-whitelisted child makes the WHOLE write fail validation and drop
  // silently (the 866683d class). The recovery writes through a service
  // account, which bypasses rules — so without this the schema would declare
  // its own stored rows invalid.
  const rules = JSON.parse(readFileSync('firebase-rules.json', 'utf8'));
  const row = rules.rules.daily.$date.$entry;
  assert.ok(row.backfilled, 'daily rows must whitelist `backfilled`');
  assert.equal(row.$other['.validate'], false,
    'the daily row block must still reject unknown children');
});
