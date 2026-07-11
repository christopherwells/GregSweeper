// Achievement tier boundaries. The 2026-06-23 Wave B re-spread dropped the
// platinum tier, leaving five (bronze/silver/gold/emerald/diamond) with five
// thresholds per category. Tier state recomputes from counters (no stored
// unlock data), so a silently-shifted threshold would quietly move every
// player's tier. skill-feats.test.mjs only checks "one win unlocks bronze";
// this pins the actual boundary math, the inverted (lower-is-better) path, and
// the no-data→locked path that otherwise have no coverage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getAchievementState, getTotalScore, getAllTierNames,
} from '../src/logic/achievements.js';

function cat(stats, id) {
  return getAchievementState(stats).find((c) => c.id === id);
}

test('the ladder is exactly five tiers, platinum dropped', () => {
  assert.deepEqual(getAllTierNames(), ['bronze', 'silver', 'gold', 'emerald', 'diamond']);
});

test('thirteen categories, max score = 13 categories × 5 tiers = 65', () => {
  const state = getAchievementState({});
  assert.equal(state.length, 13, 'a category was added or dropped');
  const { total, max } = getTotalScore({});
  assert.equal(max, 65, 'max score must track categories × tiers (a dropped tier or category moved it)');
  assert.ok(total >= 0);
});

test('every category has five strictly-monotonic thresholds in its direction', () => {
  // Structural guard: a re-spread that breaks monotonicity (a tier no harder
  // than the one below it) or changes the tier count fails here. inverted
  // categories (lower-is-better) must strictly DESCEND; the rest ASCEND.
  for (const c of getAchievementState({})) {
    assert.equal(c.thresholds.length, 5, `${c.id} must have 5 thresholds`);
    for (let i = 1; i < c.thresholds.length; i++) {
      if (c.inverted) {
        assert.ok(c.thresholds[i] < c.thresholds[i - 1],
          `${c.id} inverted thresholds must strictly descend: ${c.thresholds}`);
      } else {
        assert.ok(c.thresholds[i] > c.thresholds[i - 1],
          `${c.id} thresholds must strictly ascend: ${c.thresholds}`);
      }
    }
  }
});

test('normal (higher-is-better) boundaries: Victory wins [1,5,25,100,200]', () => {
  const tier = (wins) => cat({ wins }, 'wins').tierIndex;
  assert.equal(tier(0), -1, '0 wins is locked');
  assert.equal(tier(1), 0, '1 win is bronze');
  assert.equal(tier(4), 0, 'just below silver is still bronze');
  assert.equal(tier(5), 1, 'exactly the threshold unlocks silver');
  assert.equal(tier(24), 1);
  assert.equal(tier(25), 2, 'gold');
  assert.equal(tier(100), 3, 'emerald');
  assert.equal(tier(199), 3);
  assert.equal(tier(200), 4, 'diamond');
  assert.equal(tier(10000), 4, 'never exceeds the top tier');

  // At the top tier there is no next tier to chase.
  const maxed = cat({ wins: 200 }, 'wins');
  assert.equal(maxed.currentTier, 'diamond');
  assert.equal(maxed.nextTier, null);
  assert.equal(maxed.totalUnlocked, 5);

  // Locked state surfaces no current tier.
  const locked = cat({ wins: 0 }, 'wins');
  assert.equal(locked.currentTier, null);
  assert.equal(locked.totalUnlocked, 0);
});

test('inverted (lower-is-better) boundaries: Speed Demon [60,45,30,15,10]', () => {
  // speed reads the DURABLE bestTimes map; no recorded win → Infinity → locked.
  const tier = (time) => cat({ bestTimes: { level3: time } }, 'speed').tierIndex;
  assert.equal(cat({}, 'speed').tierIndex, -1, 'no games is locked, not bronze');
  assert.equal(tier(61), -1, 'not fast enough for bronze stays locked');
  assert.equal(tier(60), 0, 'exactly 60s is bronze');
  assert.equal(tier(45), 1, 'silver');
  assert.equal(tier(30), 2, 'gold');
  assert.equal(tier(15), 3, 'emerald');
  assert.equal(tier(10), 4, 'diamond');
  assert.equal(tier(9), 4, 'faster than the top threshold stays diamond');
  assert.equal(cat({ bestTimes: { level1: 90, level7: 28 } }, 'speed').tierIndex, 2,
    'the fastest across all per-level bests drives the tier');
});

// 2026-07-11 audit (Q4): the speed medals must read the durable bestTimes
// maps, not the rolling recentGames window. The window (50 global / 30
// per-mode) silently DEMOTED a medal once the qualifying win scrolled out —
// tiers recompute from counters, so nothing preserved the unlock — and the
// global window includes chaos rounds, which must earn nothing.
test('REGRESSION: a fast win keeps its medal after aging out of recentGames', () => {
  const staleWindow = Array.from({ length: 50 }, () => ({ won: true, time: 300, mode: 'normal' }));
  const s = cat({ recentGames: staleWindow, bestTimes: { level12: 12 } }, 'speed');
  assert.equal(s.tierIndex, 3, 'the 12s win lives in bestTimes forever, whatever the window holds');
});

test('REGRESSION: a fast chaos round earns no Speed Demon', () => {
  // Chaos wins land in recentGames but are excluded from bestTimes
  // (saveGameResult skips the global bestTimes block for chaos).
  const s = cat({ recentGames: [{ won: true, time: 4, mode: 'chaos' }], bestTimes: {} }, 'speed');
  assert.equal(s.tierIndex, -1, 'chaos earns nothing');
});

test('REGRESSION: Speedrunner reads the timed bestTimes map, not the timed window', () => {
  const stats = {
    modeStats: {
      timed: {
        recentGames: Array.from({ length: 30 }, () => ({ won: true, time: 200 })),
        bestTimes: { level2: 24 },
      },
    },
  };
  assert.equal(cat(stats, 'timedSpeed').tierIndex, 3, 'the aged-out 24s run still holds emerald');
  assert.equal(cat({ modeStats: { timed: { recentGames: [{ won: true, time: 10 }], bestTimes: {} } } }, 'timedSpeed').tierIndex, -1,
    'window-only data does not earn the medal (nothing durable recorded)');
});
