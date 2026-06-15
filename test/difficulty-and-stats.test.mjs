// Difficulty curve + play-time streak bookkeeping. A regression in
// getDifficultyForLevel could ship un-playably dense boards or violate
// the mobile width cap; saveGameResult is where the daily streak is
// incremented/reset at play time (distinct from the history-derived
// computeStreakFromHistory).

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { getDifficultyForLevel, MAX_LEVEL, BOARD_WIDTH_CAP } = await import('../src/logic/difficulty.js');
const stats = await import('../src/storage/statsStorage.js');

test('every challenge level yields a sane, playable board within the width cap', () => {
  for (let lv = 1; lv <= MAX_LEVEL; lv++) {
    const { rows, cols, mines } = getDifficultyForLevel(lv);
    assert.ok(Number.isInteger(rows) && rows >= 5, `L${lv}: rows ${rows}`);
    assert.ok(Number.isInteger(cols) && cols >= 5, `L${lv}: cols ${cols}`);
    assert.ok(cols <= BOARD_WIDTH_CAP, `L${lv}: cols ${cols} exceeds width cap ${BOARD_WIDTH_CAP}`);
    assert.ok(mines >= 1 && mines < rows * cols, `L${lv}: mines ${mines} vs ${rows * cols} cells`);
    // Density never exceeds the documented 34% hard cap (+ rounding slack).
    assert.ok(mines / (rows * cols) <= 0.35, `L${lv}: density ${(mines / (rows * cols)).toFixed(3)} too high`);
  }
});

test('early levels are smaller/easier than late levels', () => {
  const l1 = getDifficultyForLevel(1);
  const l120 = getDifficultyForLevel(120);
  assert.ok(l1.rows * l1.cols < l120.rows * l120.cols, 'L1 board should be smaller than L120');
  assert.ok(l1.mines < l120.mines, 'L1 should have fewer mines than L120');
  // Out-of-range levels clamp rather than throw.
  assert.deepEqual(getDifficultyForLevel(0), getDifficultyForLevel(1));
  assert.deepEqual(getDifficultyForLevel(999), getDifficultyForLevel(MAX_LEVEL));
});

test('daily streak increments on consecutive days and resets on a gap', () => {
  localStorage.clear();
  stats.invalidateStatsCache?.();
  const win = (seed) => stats.saveGameResult(true, 50, 1, { isDaily: true, gameMode: 'daily', dailySeed: seed });

  win('2026-06-01');
  assert.equal(stats.loadStats().modeStats.daily.dailyStreak, 1, 'first daily → streak 1');
  win('2026-06-02');
  assert.equal(stats.loadStats().modeStats.daily.dailyStreak, 2, 'consecutive day → streak 2');
  win('2026-06-03');
  assert.equal(stats.loadStats().modeStats.daily.dailyStreak, 3, 'consecutive day → streak 3');
  win('2026-06-06'); // 3-day gap
  assert.equal(stats.loadStats().modeStats.daily.dailyStreak, 1, 'gap → streak resets to 1');
  // bestDailyStreak holds the high-water mark across the reset.
  assert.equal(stats.loadStats().modeStats.daily.bestDailyStreak, 3, 'best streak preserved');
});

test('replaying the same daily date does not double-count the streak', () => {
  localStorage.clear();
  stats.invalidateStatsCache?.();
  stats.saveGameResult(true, 50, 1, { isDaily: true, gameMode: 'daily', dailySeed: '2026-06-01' });
  stats.saveGameResult(true, 45, 1, { isDaily: true, gameMode: 'daily', dailySeed: '2026-06-01' });
  assert.equal(stats.loadStats().modeStats.daily.dailyStreak, 1, 'same-day replay keeps streak at 1');
});

test('gym technique counts accumulate per name and ignore junk', () => {
  localStorage.clear();
  assert.deepEqual(stats.getGymTechniqueCounts(), {}, 'starts empty');
  stats.recordGymTechnique('1-2-1');
  stats.recordGymTechnique('1-2-1');
  stats.recordGymTechnique('count');
  stats.recordGymTechnique(null); // ignored, never throws
  const counts = stats.getGymTechniqueCounts();
  assert.equal(counts['1-2-1'], 2);
  assert.equal(counts['count'], 1);
  assert.equal(counts['nope'], undefined);
});
