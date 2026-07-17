// ?level= playtest deep link (test builds only) — the practice guard.
// /test/ shares its origin's localStorage with prod, so a playtest jump
// that bumped maxLevelReached would unlock REAL checkpoints (self-cheat
// pollution), inflate win streaks, and overwrite bestTimes. The guard in
// saveGameResult must therefore record NOTHING for a practice run.
//
// Run: node --test test/levelPractice.test.mjs

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { loadStats, saveGameResult } = await import('../src/storage/statsStorage.js');

test('REGRESSION: a level-practice win records nothing at all', () => {
  const before = JSON.stringify(loadStats());
  const returned = saveGameResult(true, 42, 105, { gameMode: 'normal', isLevelPractice: true });
  assert.equal(JSON.stringify(loadStats()), before, 'stats byte-identical after a practice win');
  assert.equal(returned.maxLevelReached, JSON.parse(before).maxLevelReached,
    'the returned stats carry no phantom progression');

  saveGameResult(false, 30, 105, { gameMode: 'normal', isLevelPractice: true });
  assert.equal(JSON.stringify(loadStats()), before, 'a practice loss records nothing either');

  // Control: the same win WITHOUT the flag records normally — the guard
  // must not silently disable real progression.
  const stats = saveGameResult(true, 42, 105, { gameMode: 'normal' });
  assert.equal(stats.maxLevelReached, 105);
  assert.equal(stats.wins, JSON.parse(before).wins + 1);
});
