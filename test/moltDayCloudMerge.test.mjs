// Molt-day cloud-merge atomicity. The bank + lastUse must ride the SAME
// snapshot as the streak through applyCloudProgress: whichever side wins by the
// date-anchor rules supplies all of them together. A bank paired with the other
// side's streak would let a cross-device merge fabricate or destroy a cover.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCloudProgress, loadStats } from '../src/storage/statsStorage.js';

function daily() {
  return loadStats().modeStats.daily;
}

// Seed local state directly (overwrite adopts cloud verbatim).
function seed({ streak, lastDate, banked, lastUse = null, best = 0 }) {
  applyCloudProgress(
    { dailyStreak: streak, bestDailyStreak: best, lastDailyDate: lastDate, moltDay: { banked, lastUse } },
    { overwrite: true }
  );
}

test('cloud date newer: streak, bank, and lastUse adopt together', () => {
  seed({ streak: 5, lastDate: '2026-06-10', banked: 2 });
  applyCloudProgress({
    dailyStreak: 8,
    lastDailyDate: '2026-06-12',
    moltDay: { banked: 1, lastUse: { date: '2026-06-12', covered: ['2026-06-11'], streakKept: 8 } },
  });
  const d = daily();
  assert.equal(d.dailyStreak, 8);
  assert.equal(d.moltBanked, 1);
  assert.equal(d.lastDailyCompletedDate, '2026-06-12');
  assert.equal(d.moltLastUse.date, '2026-06-12');
});

test('cloud date older: local snapshot kept whole, bank untouched', () => {
  seed({ streak: 8, lastDate: '2026-06-12', banked: 1 });
  applyCloudProgress({ dailyStreak: 5, lastDailyDate: '2026-06-10', moltDay: { banked: 2 } });
  const d = daily();
  assert.equal(d.dailyStreak, 8);
  assert.equal(d.moltBanked, 1);
  assert.equal(d.lastDailyCompletedDate, '2026-06-12');
});

test('same date, cloud streak higher: cloud bank comes with it', () => {
  seed({ streak: 6, lastDate: '2026-06-12', banked: 0 });
  applyCloudProgress({ dailyStreak: 7, lastDailyDate: '2026-06-12', moltDay: { banked: 2 } });
  const d = daily();
  assert.equal(d.dailyStreak, 7);
  assert.equal(d.moltBanked, 2);
});

test('same date, local streak higher: local bank kept, no mix with cloud', () => {
  seed({ streak: 7, lastDate: '2026-06-12', banked: 2 });
  applyCloudProgress({ dailyStreak: 6, lastDailyDate: '2026-06-12', moltDay: { banked: 0 } });
  const d = daily();
  assert.equal(d.dailyStreak, 7);
  assert.equal(d.moltBanked, 2); // NOT cloud's 0 — the bank never pairs with the losing streak
});

test('overwrite with no cloud molt node: bank resets to 0 (cloud is authoritative)', () => {
  seed({ streak: 9, lastDate: '2026-06-12', banked: 2 });
  applyCloudProgress({ dailyStreak: 3, lastDailyDate: '2026-06-13' }, { overwrite: true });
  const d = daily();
  assert.equal(d.dailyStreak, 3);
  assert.equal(d.moltBanked, 0);
  assert.equal(d.moltLastUse, null);
});
