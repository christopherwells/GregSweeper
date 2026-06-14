// Archive replays must be invisible to daily-mode stats. The daily-streak
// block in saveGameResult keys on the game MODE ('daily'), not on the isDaily
// flag, so an archive replay (gameMode 'daily') would advance the streak and
// completion counters unless explicitly excluded. This pins that exclusion
// (caught live on /test/: an archive win moved the streak 0 -> 1).

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { saveGameResult, loadStats } = await import('../src/storage/statsStorage.js');

test('an archive replay touches no daily-mode counter', () => {
  // A real daily win writes the daily-mode counters.
  const s1 = saveGameResult(true, 42, 0, { isDaily: true, gameMode: 'daily', dailySeed: '2026-06-10' });
  const snap = { ...s1.modeStats.daily };

  // An archive replay of a PAST date must move none of them.
  const s2 = saveGameResult(true, 30, 0, { isArchive: true, gameMode: 'daily', dailySeed: '2026-05-12' });
  const d = s2.modeStats.daily;
  assert.equal(d.dailyStreak, snap.dailyStreak, 'dailyStreak must not change');
  assert.equal(d.dailiesCompleted, snap.dailiesCompleted, 'dailiesCompleted must not change');
  assert.equal(d.lastDailyCompletedDate, snap.lastDailyCompletedDate, 'lastDailyCompletedDate must not move');
  assert.equal(d.wins, snap.wins, 'daily-mode wins must not change');
  assert.equal(d.totalGames, snap.totalGames, 'daily-mode totalGames must not change');
});

test('the exclusion is not over-broad: a real consecutive daily still advances the streak', () => {
  // Two consecutive real dailies (far-future dates to avoid any lapse with
  // prior tests in this process) advance the raw streak field by exactly one.
  const a = saveGameResult(true, 42, 0, { isDaily: true, gameMode: 'daily', dailySeed: '2026-07-01' });
  const streakA = a.modeStats.daily.dailyStreak;
  const b = saveGameResult(true, 42, 0, { isDaily: true, gameMode: 'daily', dailySeed: '2026-07-02' });
  assert.equal(b.modeStats.daily.dailyStreak, streakA + 1, 'consecutive real dailies advance the streak');
});

test('an archive win still counts as a generic win so achievements fire', () => {
  const before = loadStats().wins || 0;
  const after = saveGameResult(true, 30, 0, { isArchive: true, gameMode: 'daily', dailySeed: '2026-05-13' });
  assert.equal((after.wins || 0), before + 1, 'archive win increments global wins');
});
