// Molt-day cloud-merge atomicity. The bank + lastUse must ride the SAME
// snapshot as the streak through applyCloudProgress: whichever side wins by the
// date-anchor rules supplies all of them together. A bank paired with the other
// side's streak would let a cross-device merge fabricate or destroy a cover.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCloudProgress, loadStats, backfillMoltDays, getDailyStreak,
  resetDailyStatsForAccountSwitch,
} from '../src/storage/statsStorage.js';
import { getLocalDateString } from '../src/logic/seededRandom.js';

function daily() {
  return loadStats().modeStats.daily;
}

// Seed local state directly (overwrite adopts cloud verbatim). NOTE: a
// banked > 0 (or a lastUse) seeds reliably; a bare banked:0/no-lastUse seed is
// now a no-op for the molt fields (it reads as "no real molt state" and
// preserves whatever was there), so a test that needs a true local 0 must seed
// a non-empty molt and let the assertion's own cloud apply drive it to 0.
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

test('overwrite with no cloud molt node: streak adopts, local bank is PRESERVED', () => {
  // A missing cloud moltDay node is the pre-molt shape every legacy account
  // carries — absence of info, not an authoritative 0. The streak still adopts
  // verbatim under overwrite, but the local bank must survive (regression: the
  // listener used to zero it on every boot, wiping the one-time backfill grant).
  seed({ streak: 9, lastDate: '2026-06-12', banked: 2 });
  applyCloudProgress({ dailyStreak: 3, lastDailyDate: '2026-06-13' }, { overwrite: true });
  const d = daily();
  assert.equal(d.dailyStreak, 3);
  assert.equal(d.moltBanked, 2);
});

test('overwrite with bare default cloud molt {banked:0}: local bank is PRESERVED', () => {
  // The other legacy shape: a stale {banked:0, no lastUse} written by a
  // completion BEFORE the backfill shipped. Same as a missing node — no real
  // molt state — so a locally-backfilled bank must not be clobbered.
  seed({ streak: 9, lastDate: '2026-06-12', banked: 2 });
  applyCloudProgress(
    { dailyStreak: 9, lastDailyDate: '2026-06-12', moltDay: { banked: 0, lastUse: null } },
    { overwrite: true }
  );
  assert.equal(daily().moltBanked, 2);
});

test('a recorded cloud spend (lastUse set, banked 0) IS adopted, not preserved', () => {
  // The mirror: {banked:0} WITH a lastUse is real molt state (the player spent
  // their last molt day on another device). That must overwrite a stale local
  // bank, or a spend would resurrect cross-device.
  seed({ streak: 9, lastDate: '2026-06-12', banked: 2 });
  applyCloudProgress(
    { dailyStreak: 9, lastDailyDate: '2026-06-12',
      moltDay: { banked: 0, lastUse: { date: '2026-06-12', covered: ['2026-06-11'], streakKept: 9 } } },
    { overwrite: true }
  );
  const d = daily();
  assert.equal(d.moltBanked, 0);
  assert.equal(d.moltLastUse.date, '2026-06-12');
});

test('END-TO-END: a legacy long streak is backfilled and the listener keeps it', () => {
  // The exact bug a 92-day-streak player hit. A pre-molt account: long live
  // streak, no molt state anywhere in the cloud. Boot grants the one-time
  // backfill locally, then the real-time cloud listener re-applies the
  // (molt-less) cloud snapshot under overwrite. The grant must SURVIVE.
  resetDailyStatsForAccountSwitch();
  const today = getLocalDateString(); // clock-robust: seed "today" so the streak reads alive
  // Legacy cloud snapshot: streak 92, completed today (alive), NO moltDay node.
  applyCloudProgress({ dailyStreak: 92, lastDailyDate: today }, { overwrite: true });
  assert.equal(getDailyStreak().streak, 92);
  assert.equal(getDailyStreak().banked, 0); // nothing banked yet

  // Boot backfill: a streak over 9 earns the cap of 2.
  assert.equal(backfillMoltDays(), true);
  assert.equal(getDailyStreak().banked, 2);

  // The real-time listener fires again with the still-molt-less cloud snapshot.
  applyCloudProgress({ dailyStreak: 92, lastDailyDate: today }, { overwrite: true });
  assert.equal(getDailyStreak().banked, 2); // PRESERVED, not wiped (the regression)

  // Idempotent: a second boot does not re-grant (the guard sees the bank).
  assert.equal(backfillMoltDays(), false);
  assert.equal(getDailyStreak().banked, 2);
});
