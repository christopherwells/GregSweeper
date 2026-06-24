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
  // speed reads the fastest win in recentGames; no wins → Infinity → locked.
  const tier = (time) => cat({ recentGames: [{ won: true, time }] }, 'speed').tierIndex;
  assert.equal(cat({}, 'speed').tierIndex, -1, 'no games is locked, not bronze');
  assert.equal(cat({ recentGames: [{ won: false, time: 5 }] }, 'speed').tierIndex, -1,
    'a loss does not count as a fast win');
  assert.equal(tier(61), -1, 'not fast enough for bronze stays locked');
  assert.equal(tier(60), 0, 'exactly 60s is bronze');
  assert.equal(tier(45), 1, 'silver');
  assert.equal(tier(30), 2, 'gold');
  assert.equal(tier(15), 3, 'emerald');
  assert.equal(tier(10), 4, 'diamond');
  assert.equal(tier(9), 4, 'faster than the top threshold stays diamond');
});
