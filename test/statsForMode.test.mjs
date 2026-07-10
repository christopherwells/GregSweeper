// statsForMode — the one place the gameMode → modeStats key mapping lives.
//
// 2026-07-10 audit: the Challenge stats tab read stats.modeStats.normal, but
// saveGameResult files challenge games under modeStats.CHALLENGE (getModeKey
// maps 'normal' → 'challenge'). The literal was always undefined, so the
// panel silently fell back to the ALL-MODES aggregate — every daily, weekly,
// timed, and chaos game inflated "Played" and distorted the win rate, and
// the recent-games chart read a frozen legacy list. Callers now resolve the
// block through statsForMode so a hand-rolled key can't drift again.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { saveGameResult, loadStats, statsForMode, resetStats } = await import('../src/storage/statsStorage.js');

test("REGRESSION: statsForMode(stats, 'normal') resolves the challenge block, not the aggregate", () => {
  resetStats();
  // One challenge win and one timed win: the aggregate says 2 games, the
  // challenge block must say 1.
  saveGameResult(true, 30, 1, { gameMode: 'normal' });
  saveGameResult(true, 25, 1, { gameMode: 'timed' });
  const stats = loadStats();
  assert.equal(stats.totalGames, 2, 'aggregate counts every mode');
  const challenge = statsForMode(stats, 'normal');
  assert.ok(challenge, 'challenge block exists');
  assert.equal(challenge.totalGames, 1, 'the challenge view counts ONLY challenge games');
  assert.equal(challenge.wins, 1);
  // The old literal the panel used — always undefined, the silent fallback.
  assert.equal(stats.modeStats.normal, undefined);
});

test('statsForMode passes non-mapped modes through and null-guards missing blocks', () => {
  resetStats();
  saveGameResult(true, 25, 2, { gameMode: 'timed' });
  const stats = loadStats();
  assert.equal(statsForMode(stats, 'timed').totalGames, 1);
  assert.equal(statsForMode(stats, 'no-such-mode'), null);
  assert.equal(statsForMode(null, 'normal'), null);
});
