// Ladder playability + play-time streak bookkeeping. A regression in the
// Challenge 250 spec table could ship un-playably dense boards or violate
// the mobile width cap (the sawtooth's getDifficultyForLevel is gone —
// challengeSpecForLevel is the level→board authority now); saveGameResult
// is where the daily streak is incremented/reset at play time (distinct
// from the history-derived computeStreakFromHistory).

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { BOARD_WIDTH_CAP } = await import('../src/logic/difficulty.js');
const { challengeSpecForLevel, CHALLENGE_MAX_LEVEL } = await import('../src/logic/challenge250.js');
const stats = await import('../src/storage/statsStorage.js');

test('every challenge level spec yields a sane, playable board within the width cap', () => {
  for (let lv = 1; lv <= CHALLENGE_MAX_LEVEL; lv++) {
    const s = challengeSpecForLevel(lv);
    assert.ok(s.mines >= 1 && s.mines < s.cells, `L${lv}: mines ${s.mines} vs ${s.cells} cells`);
    if (s.shape === 'rect') {
      assert.ok(Number.isInteger(s.rows) && s.rows >= 5, `L${lv}: rows ${s.rows}`);
      assert.ok(Number.isInteger(s.cols) && s.cols >= 5, `L${lv}: cols ${s.cols}`);
      assert.ok(s.cols <= BOARD_WIDTH_CAP, `L${lv}: cols ${s.cols} exceeds width cap ${BOARD_WIDTH_CAP}`);
      // The classic density sweep proved certification and the 2s cap to
      // 0.45 on 11×11; nothing authored may sit past that measured reach.
      assert.ok(s.mines / s.cells <= 0.46, `L${lv}: density ${(s.mines / s.cells).toFixed(3)} past the proven reach`);
    } else {
      // Tiling boards are pitch-fitted, not CSS-grid columns, so the width
      // cap does not apply; the density-ceiling sweep proved 0.38.
      assert.ok(s.mines / s.cells <= 0.39, `L${lv}: tiling density ${(s.mines / s.cells).toFixed(3)} past the swept ceiling`);
    }
  }
});

test('the ladder ramps: the opener is smaller and easier than the summit', () => {
  const l1 = challengeSpecForLevel(1);
  const hexSummit = challengeSpecForLevel(246); // FINALE III honeycomb, 110 cells
  assert.ok(l1.cells < hexSummit.cells, 'L1 board should be smaller than the summit');
  assert.ok(l1.mines < hexSummit.mines, 'L1 should have fewer mines than the summit');
  // Out-of-range levels clamp rather than throw (the old ladder's contract).
  assert.deepEqual(challengeSpecForLevel(0), challengeSpecForLevel(1));
  assert.deepEqual(challengeSpecForLevel(999), challengeSpecForLevel(CHALLENGE_MAX_LEVEL));
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
