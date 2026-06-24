// Skill-feat detection from a won game.
//
// Honestly detectable from the click timeline + the board's CERTIFIED solve,
// never from heuristics:
//   flagless  — the recorded timeline contains no flag action.
//   efficient — the player's reveal+chord count matched (or beat) the certified
//               solve's click count, reconstructed from the stored move-type
//               counters via the solver invariant
//               passA + pattern + search + disjunctive + 1 = totalClicks.
//   search    — the board PROVABLY required tank/gauss enumeration.
//   liar      — the board PROVABLY required disjunctive liar reasoning.
// Feature-based feats only exist where a feature vector was computed (daily /
// weekly / timed); challenge/normal wins can still earn flagless. Chaos earns
// nothing (it's outside the no-guess contract — no certified solve to compare).
//
// Extracted from handleWin so the certifiedClicks invariant and the feature/
// mode gating are node-tested directly, not only through saveGameResult's
// counter side effects. Pure module — node-tested in test/skillFeatDetection.test.mjs.

/**
 * @param {object} state live game state — reads gameMode, clickTimeline, and
 *   the per-mode feature vector (dailyFeatures / weeklyFeatures / timedFeatures)
 * @returns {{flagless: boolean, efficient: boolean, search: boolean, liar: boolean} | {}}
 *   the feats to credit (an empty object for chaos)
 */
export function detectSkillFeats(state) {
  if (state.gameMode === 'chaos') return {};

  const winFeatures = state.gameMode === 'daily' ? state.dailyFeatures
    : state.gameMode === 'weekly' ? state.weeklyFeatures
    : state.gameMode === 'timed' ? state.timedFeatures
    : null;
  const timeline = Array.isArray(state.clickTimeline) ? state.clickTimeline : [];
  const certifiedClicks = winFeatures
    ? (winFeatures.passAMoves || 0) + (winFeatures.canonicalSubsetMoves || 0)
      + (winFeatures.genericSubsetMoves || 0) + (winFeatures.advancedLogicMoves || 0)
      + (winFeatures.disjunctiveMoves || 0) + 1
    : 0;
  const playerClicks = timeline.filter((e) => e.a === 'r' || e.a === 'c').length;

  return {
    flagless: timeline.length > 0 && !timeline.some((e) => e.a === 'f'),
    efficient: !!winFeatures && playerClicks > 0 && playerClicks <= certifiedClicks,
    search: !!winFeatures && (winFeatures.advancedLogicMoves || 0) >= 1,
    liar: !!winFeatures && (winFeatures.disjunctiveMoves || 0) >= 1,
  };
}
