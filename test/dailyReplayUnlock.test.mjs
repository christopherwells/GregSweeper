// The daily-card lock must answer "has this account finished TODAY'S BOARD",
// not "did it play a daily today". Those came apart on 2026-08-07: the submit
// guard (#252) refuses a score set on a non-canonical board, so the day still
// counts for the streak while the real board sits unplayed — and the cloud's
// `lastDailyDate` says "today" either way.
//
// Two things are pinned here. The completion must RECORD WHICH BOARD it was
// on, and the unlock must be STICKY: applyCloudProgress re-derives the lock
// from lastDailyDate, and the progress listener re-applies the cloud on every
// write under users/{uid} — a lastSeen beacon is enough — so a plain
// clear-the-flag unlock survives milliseconds and the player stays locked out
// of the board they need in order to compete.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  markDailyCompleted, isDailyCompleted, getDailyCompletionRecord,
  unlockDailyReplay, isDailyReplayUnlocked,
  applyCloudProgress, resetDailyStatsForAccountSwitch,
  saveDailyPar, loadDailyPar,
} from '../src/storage/statsStorage.js';
import { getLocalDateString } from '../src/logic/seededRandom.js';

const TODAY = getLocalDateString();
const CANON = `${TODAY}:trial5`;
const DIVERGENT = `${TODAY}:trial3`;

// The cloud state a divergent completion leaves behind: the streak write fires
// regardless of whether the score was ranked, so lastDailyDate IS today.
function cloudSaysPlayedToday() {
  applyCloudProgress({ dailyStreak: 9, lastDailyDate: TODAY }, { overwrite: true });
}

test('a completion records the board it was on', () => {
  markDailyCompleted(TODAY, CANON);
  assert.equal(isDailyCompleted(TODAY), true);
  assert.deepEqual(getDailyCompletionRecord(), { date: TODAY, seed: CANON });
});

test('a seedless completion records UNKNOWN, never a stale seed', () => {
  markDailyCompleted(TODAY, CANON);
  markDailyCompleted(TODAY); // vintage-shaped call
  assert.equal(getDailyCompletionRecord().seed, null,
    'a completion with no seed must not inherit the previous board\'s');
});

test('REGRESSION: the replay unlock survives applyCloudProgress', () => {
  // Before the sticky marker, this sequence re-locked the card: the divergent
  // play still counts the day, so the cloud legitimately reports lastDailyDate
  // === today, and the re-set fired on every write under users/{uid}.
  markDailyCompleted(TODAY, DIVERGENT);
  unlockDailyReplay(TODAY);
  assert.equal(isDailyCompleted(TODAY), false, 'unlock must clear the flag');

  cloudSaysPlayedToday();
  assert.equal(isDailyCompleted(TODAY), false,
    'cloud lastDailyDate === today must NOT re-lock a proven-divergent day');

  // And it holds across repeated listener fires, which is how it actually
  // arrives — once on attach, then on every subsequent write.
  cloudSaysPlayedToday();
  cloudSaysPlayedToday();
  assert.equal(isDailyCompleted(TODAY), false);
});

test('the unlock drops the recorded board too, so nothing stale can be read back', () => {
  markDailyCompleted(TODAY, DIVERGENT);
  unlockDailyReplay(TODAY);
  assert.deepEqual(getDailyCompletionRecord(), { date: null, seed: null });
  assert.equal(isDailyReplayUnlocked(TODAY), true);
});

test('completing the real board supersedes the unlock', () => {
  markDailyCompleted(TODAY, DIVERGENT);
  unlockDailyReplay(TODAY);
  markDailyCompleted(TODAY, CANON);
  assert.equal(isDailyReplayUnlocked(TODAY), false,
    'a fresh completion must retire the unlock that granted the replay');
  assert.equal(isDailyCompleted(TODAY), true);
  assert.equal(getDailyCompletionRecord().seed, CANON);
  // With the unlock retired, the cloud re-set is free to work again.
  cloudSaysPlayedToday();
  assert.equal(isDailyCompleted(TODAY), true);
});

test('an unlock for another date does not suppress today\'s cloud re-set', () => {
  // Yesterday's unlock must not leak into today, or the card would never lock
  // again on the day after a divergent play.
  unlockDailyReplay('2020-01-01');
  assert.equal(isDailyReplayUnlocked(TODAY), false);
  cloudSaysPlayedToday();
  assert.equal(isDailyCompleted(TODAY), true);
});

test('REGRESSION: the unlock drops the cached par/moves/features for the date', () => {
  // They describe the board that was played, which was the wrong one. Left
  // behind, the Daily card prints the divergent board's par and parResolve
  // hands the win modal a feature vector for a layout nobody is playing.
  saveDailyPar(TODAY, 123, 45, { cellCount: 99 });
  markDailyCompleted(TODAY, DIVERGENT);
  unlockDailyReplay(TODAY);
  const cached = loadDailyPar(TODAY);
  assert.equal(cached.par, 0);
  assert.equal(cached.moves, 0);
  assert.equal(cached.features, null);
});

test('an account switch drops the unlock and the recorded board with the flag', () => {
  markDailyCompleted(TODAY, DIVERGENT);
  unlockDailyReplay(TODAY);
  resetDailyStatsForAccountSwitch();
  assert.equal(isDailyReplayUnlocked(TODAY), false,
    'a stale unlock would suppress the NEW account\'s legitimate re-lock');
  assert.deepEqual(getDailyCompletionRecord(), { date: null, seed: null });
});
