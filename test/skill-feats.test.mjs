// Skill-feat counters: saveGameResult must increment exactly the feats
// the win handler detected, never on losses or chaos, and the
// achievement categories must read them back.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { saveGameResult, loadStats } = await import('../src/storage/statsStorage.js');
const { getAchievementState } = await import('../src/logic/achievements.js');

test('skill feats increment on wins and surface in achievement state', () => {
  const before = loadStats();
  const f0 = before.flaglessWins || 0;
  const e0 = before.efficientWins || 0;
  const s0 = before.searchWins || 0;
  const l0 = before.liarWins || 0;

  saveGameResult(true, 42, 1, {
    gameMode: 'daily', isDaily: true,
    skillFeats: { flagless: true, efficient: true, search: true, liar: false },
  });
  let stats = loadStats();
  assert.equal(stats.flaglessWins, f0 + 1);
  assert.equal(stats.efficientWins, e0 + 1);
  assert.equal(stats.searchWins, s0 + 1);
  assert.equal(stats.liarWins, l0);

  // Losses never increment feats.
  saveGameResult(false, 30, 1, {
    gameMode: 'daily', skillFeats: { flagless: true, efficient: true, search: true, liar: true },
  });
  stats = loadStats();
  assert.equal(stats.flaglessWins, f0 + 1);
  assert.equal(stats.searchWins, s0 + 1);

  // The rebuilt categories read the counters.
  const state = getAchievementState(stats);
  const ids = state.map(c => c.id);
  for (const id of ['flagless', 'efficient', 'tankCommander', 'lieDetector']) {
    assert.ok(ids.includes(id), `missing category ${id}`);
  }
  // The grind categories are gone.
  assert.ok(!ids.includes('games'), 'Dedicated (total games) should be cut');
  assert.ok(!ids.includes('level'), 'Survivor (duplicate wins) should be cut');
  const flagless = state.find(c => c.id === 'flagless');
  assert.ok(flagless.tierIndex >= 0, 'one flagless win unlocks bronze');
});
