// Share surfaces describe the run that was played (2026-07-11/12 audits).
//
// Outward-facing caption/card bugs, all CALL-tested headless via domShim:
//   1. buildShareData (the canvas card) read state.dailyBombHits for every
//      mode, so a weekly win's strikes never reached the shared image — the
//      win modal branches to weeklyBombHits, and the card must match it.
//   2. generateShareCard (the text caption) sent weekly through the generic
//      branch, which stamps getDifficultyForLevel(state.currentLevel) —
//      weekly never sets currentLevel, so the card claimed whatever
//      challenge level the player last had ("Level 47 (13x13)") instead of
//      the real weekly board.
//   3. Chaos hit the same generic branch with currentLevel PINNED at 1 by
//      modeManager, so every chaos caption read "Level 1 (5x5)" while the
//      real round-1 board is 8x8 minimum.

import './domShim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { state } = await import('../src/state/gameState.js');
const { buildShareData } = await import('../src/ui/shareCardImage.js');
const { generateShareCard } = await import('../src/ui/shareActions.js');

function weeklyWinState() {
  state.gameMode = 'weekly';
  state.rows = 12;
  state.cols = 14;
  state.totalMines = 30;
  state.revealedCount = 100;
  state.elapsedTime = 84;
  state.weeklySeed = '2026-07-06';
  state.weeklyBombHits = 2;
  state.dailyBombHits = 0;
  state.currentLevel = 47; // stale challenge level left in state
  state.activeGimmicks = [];
  state.boardCertificate = { clicks: 40, tier: 1 };
}

test('REGRESSION: the weekly canvas card carries the weekly strike count', () => {
  weeklyWinState();
  const data = buildShareData(state);
  assert.equal(data.modeLabel, 'WEEKLY');
  assert.equal(data.dateLabel, 'JULY 6');
  assert.equal(data.bombHits, 2,
    'weekly strikes live in weeklyBombHits — the card must not read the daily counter');
});

test('the daily canvas card still reads the daily counter', () => {
  weeklyWinState();
  state.gameMode = 'daily';
  state.dailySeed = '2026-07-10';
  state.dailyBombHits = 1;
  const data = buildShareData(state);
  assert.equal(data.bombHits, 1);
});

test('REGRESSION: the weekly text caption reports the real board, never a challenge level', () => {
  weeklyWinState();
  const card = generateShareCard();
  assert.match(card, /Weekly/);
  assert.match(card, /12x14 in 84s/, 'the board actually played');
  assert.doesNotMatch(card, /Level\s*\d/,
    "weekly has no level — the stale challenge currentLevel must not label the card");
});

test('REGRESSION: the chaos text caption reports the round and real board, never "Level 1 (5x5)"', () => {
  // Chaos pins currentLevel = 1 on entry and sizes boards by chaosRound,
  // so the generic branch deterministically claimed "Level 1 (5x5)" on
  // every chaos share while the card IMAGE beside it drew the real board.
  weeklyWinState();
  state.gameMode = 'chaos';
  state.chaosRound = 3;
  state.rows = 9;
  state.cols = 9;
  state.elapsedTime = 25;
  state.currentLevel = 1; // what modeManager pins on chaos entry
  const card = generateShareCard();
  assert.match(card, /Chaos/);
  assert.match(card, /Round 3 · 9x9 in 25s/, 'the round and board actually played');
  assert.doesNotMatch(card, /Level\s*\d/);
  assert.doesNotMatch(card, /5x5/, 'the tutorial-level dims must never label a chaos card');
});
