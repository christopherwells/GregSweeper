// Game-over modal visibility plan (pure, node-tested).
//
// The #gameover-overlay modal is ONE shared surface reused by every end state
// (win / mine loss / time-out) across every mode, and its optional sections
// persist in the DOM between games. Before this module, each handler hid only
// the sections it knew about, so any section another path had shown leaked
// into the next render: a challenge loss after a weekly win displayed the
// stale weekly leaderboard inside #gameover-par, and a timed loss after a
// daily win had NO Play Again button because only handleWin ever touched
// #gameover-retry (2026-07-10 audit).
//
// The fix is structural: every render path starts by applying a COMPLETE
// visibility map over the full element registry, then unhides only its own
// data-dependent sections (par line, record, achievements, ...). A section
// can no longer be forgotten, because the plan must decide every element —
// the test suite fails if a plan and the registry ever disagree.
//
// Two kinds of visibility:
//   - STATIC (decided by outcome + mode alone): encoded here as `true`.
//   - DATA-DEPENDENT (needs game data — par > 0, new record, unlocks...):
//     always `false` here; the handler unhides after populating content.

// Every optional element inside #gameover-overlay. Adding a section to the
// modal means adding it here, which forces every plan to decide it.
export const GAMEOVER_ELEMENT_IDS = [
  'gameover-par',
  'gameover-par-breakdown',
  'gameover-history-dots',
  'gameover-receipt',
  'gameover-record',
  'gameover-nextlevel',
  'gameover-powerup-earned',
  'gameover-share',
  'gameover-crux-challenge',
  'gameover-remind-tomorrow',
  'gameover-retry',
  'gameover-done',
  'gameover-achievements',
  'gameover-encouragement',
  'gameover-analysis',
  'gameover-explore',
  'gameover-chaos-next',
  'chaos-run-summary',
  'share-card-preview',
];

/**
 * Baseline visibility for one game-over render.
 *
 * @param {'win'|'loss'|'timeout'} outcome  which handler is rendering
 * @param {string} mode                     state.gameMode
 * @returns {Object<string, boolean>}       id -> visible, covering the FULL registry
 */
export function gameoverModalPlan(outcome, mode) {
  const isDailyLike = mode === 'daily' || mode === 'weekly';
  const isChaos = mode === 'chaos';

  // Everything hidden is the safe default: an unknown outcome (future
  // caller bug) degrades to a modal with just the retry escape hatch
  // rather than a stale mixture of the previous game's sections.
  const plan = {};
  for (const id of GAMEOVER_ELEMENT_IDS) plan[id] = false;

  if (outcome === 'win') {
    plan['gameover-share'] = true;
    plan['gameover-crux-challenge'] = isDailyLike;
    plan['gameover-retry'] = !isDailyLike;
    plan['gameover-done'] = isDailyLike;
    plan['gameover-chaos-next'] = isChaos;
    // Data-dependent, unhidden by handleWin after content renders:
    // par, history-dots, receipt, record, nextlevel, powerup-earned,
    // achievements, remind-tomorrow, share-card-preview.
  } else if (outcome === 'loss') {
    plan['gameover-retry'] = true;
    plan['gameover-encouragement'] = true;
    plan['gameover-analysis'] = true;
    plan['gameover-explore'] = true;
    plan['chaos-run-summary'] = isChaos;
  } else if (outcome === 'timeout') {
    plan['gameover-retry'] = true;
    plan['gameover-encouragement'] = true;
  } else {
    plan['gameover-retry'] = true;
  }

  return plan;
}
