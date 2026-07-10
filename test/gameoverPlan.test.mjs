// Game-over modal visibility plan — the structural fix for the stale-section
// class found in the 2026-07-10 orchestration audit. The #gameover-overlay is
// one shared surface reused by win / mine-loss / time-out across every mode;
// before the plan, each handler hid only the sections it knew about, so any
// section another path had shown leaked into the next render:
//
//   - a challenge loss after a WEEKLY win displayed the stale weekly
//     leaderboard (it lives inside #gameover-par, which only handleWin reset);
//   - a timed loss after a daily/weekly win rendered with NO Play Again
//     button (only handleWin ever touched #gameover-retry);
//   - a timed loss after a challenge loss carried the stale "N squares could
//     still be worked out" analysis line and Explore button.
//
// The completeness sweep is what makes the class near-impossible to
// reintroduce: every plan must decide EVERY registered element, so a new
// section added to the registry without a decision fails here, and a
// section that never joins the registry can't claim plan coverage.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { gameoverModalPlan, GAMEOVER_ELEMENT_IDS } = await import('../src/logic/gameoverPlan.js');

const OUTCOMES = ['win', 'loss', 'timeout'];
const MODES = ['normal', 'timed', 'daily', 'weekly', 'chaos'];

test('completeness: every plan decides every registered element, booleans only', () => {
  for (const outcome of OUTCOMES) {
    for (const mode of MODES) {
      const plan = gameoverModalPlan(outcome, mode);
      const keys = Object.keys(plan).sort();
      assert.deepEqual(keys, [...GAMEOVER_ELEMENT_IDS].sort(),
        `${outcome}/${mode}: plan keys must equal the element registry`);
      for (const [id, v] of Object.entries(plan)) {
        assert.equal(typeof v, 'boolean', `${outcome}/${mode}: ${id} must be an explicit boolean`);
      }
    }
  }
});

test('an unknown outcome degrades to everything-hidden plus the retry escape hatch', () => {
  const plan = gameoverModalPlan('someday-new-outcome', 'normal');
  assert.equal(plan['gameover-retry'], true);
  for (const id of GAMEOVER_ELEMENT_IDS) {
    if (id !== 'gameover-retry') assert.equal(plan[id], false, `${id} must default hidden`);
  }
});

test('REGRESSION: a timed loss shows Play Again (it vanished after a daily/weekly win)', () => {
  assert.equal(gameoverModalPlan('timeout', 'timed')['gameover-retry'], true);
});

test('REGRESSION: loss and timeout hide the par section (the weekly leaderboard lived there)', () => {
  for (const mode of MODES) {
    assert.equal(gameoverModalPlan('loss', mode)['gameover-par'], false, `loss/${mode}`);
    assert.equal(gameoverModalPlan('timeout', mode)['gameover-par'], false, `timeout/${mode}`);
    assert.equal(gameoverModalPlan('loss', mode)['gameover-history-dots'], false, `loss/${mode} dots`);
    assert.equal(gameoverModalPlan('loss', mode)['gameover-remind-tomorrow'], false, `loss/${mode} remind CTA`);
  }
});

test('REGRESSION: a timeout carries no stale loss-analysis or Explore button', () => {
  const plan = gameoverModalPlan('timeout', 'timed');
  assert.equal(plan['gameover-analysis'], false);
  assert.equal(plan['gameover-explore'], false);
  assert.equal(plan['gameover-encouragement'], true);
});

test('win statics: share always; retry/done/crux split on the canonical single-puzzle modes', () => {
  for (const mode of MODES) {
    const plan = gameoverModalPlan('win', mode);
    const dailyLike = mode === 'daily' || mode === 'weekly';
    assert.equal(plan['gameover-share'], true, `win/${mode} share`);
    assert.equal(plan['gameover-retry'], !dailyLike, `win/${mode} retry`);
    assert.equal(plan['gameover-done'], dailyLike, `win/${mode} done`);
    assert.equal(plan['gameover-crux-challenge'], dailyLike, `win/${mode} crux`);
    assert.equal(plan['gameover-chaos-next'], mode === 'chaos', `win/${mode} chaos-next`);
  }
});

test('loss statics: retry/encouragement/analysis/explore on; chaos run summary only in chaos', () => {
  for (const mode of MODES) {
    const plan = gameoverModalPlan('loss', mode);
    assert.equal(plan['gameover-retry'], true, `loss/${mode} retry`);
    assert.equal(plan['gameover-encouragement'], true, `loss/${mode} encouragement`);
    assert.equal(plan['gameover-analysis'], true, `loss/${mode} analysis`);
    assert.equal(plan['gameover-explore'], true, `loss/${mode} explore`);
    assert.equal(plan['chaos-run-summary'], mode === 'chaos', `loss/${mode} chaos summary`);
  }
});

test('data-dependent sections always start hidden (the handler unhides after content renders)', () => {
  const dataDependent = [
    'gameover-par', 'gameover-par-breakdown', 'gameover-history-dots',
    'gameover-receipt', 'gameover-record', 'gameover-nextlevel',
    'gameover-powerup-earned', 'gameover-achievements',
    'gameover-remind-tomorrow', 'share-card-preview',
  ];
  for (const outcome of OUTCOMES) {
    for (const mode of MODES) {
      const plan = gameoverModalPlan(outcome, mode);
      for (const id of dataDependent) {
        assert.equal(plan[id], false, `${outcome}/${mode}: ${id} must start hidden`);
      }
    }
  }
});
