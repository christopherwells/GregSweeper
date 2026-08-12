// Manual-restart rule for the canonical single-puzzle modes.
//
// 2026-07-10 audit: the smiley reset button guarded daily/weekly ("no reset —
// the board is canonical and the clock is the score"), but the R keyboard
// shortcut called newGame() unguarded, regenerating today's canonical board
// with the timer back at zero — memorize the layout, press R, speedrun it
// onto the leaderboard. The rule now lives in one pure function that every
// restart surface consults.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { blocksManualRestart } = await import('../src/logic/modeRules.js');

test('REGRESSION: daily and weekly block manual restart (the R-shortcut cheat)', () => {
  assert.equal(blocksManualRestart('daily'), true);
  assert.equal(blocksManualRestart('weekly'), true);
});

test('a match board blocks manual restart too (its clock feeds the match total)', () => {
  assert.equal(blocksManualRestart('match'), true);
});

test('replayable modes allow manual restart', () => {
  assert.equal(blocksManualRestart('normal'), false);
  assert.equal(blocksManualRestart('chaos'), false);
});
