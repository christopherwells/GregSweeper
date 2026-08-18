// Daily score submission, the field-parity contract.
//
// A daily win can submit through two paths: the AUTO path in winLossHandler
// (the player already has a saved name) and the MANUAL path in main.js (the
// name form). Both call submitOnlineScore with an identical `extras` object.
// If they drift, a field present in one path but not the other is silently
// dropped, the documented failure mode (a missing bombHitEvents / rngSeed
// killed the experimental-design and bomb-adjusted-model data streams with no
// error). This builder is the single source both paths call, so they cannot
// drift, and the test pins the exact field set.
//
// Pure module, node-tested in test/winSubmissionPlan.test.mjs.

/**
 * Build the `extras` payload for submitOnlineScore on a daily win. BOTH the
 * auto-submit (winLossHandler) and manual-submit (main.js) paths must use this.
 *
 * @param {object} state   live game state, reads dailyPar, dailyFeatures,
 *   dailyBombHitEvents, wormEvents, dailyRngSeed, totalMines, boardScrolled
 * @param {string} dateStr the board's effective date/seed key (rngSeed falls back to it)
 * @param {string} uid     the player's Firebase uid (getUid())
 * @returns {{uid: string, par: number, features: object, bombHitEvents: Array,
 *   wormEvents: Array, rngSeed: string, totalMines: number, scrolled: boolean}}
 */
export function buildDailyScoreExtras(state, dateStr, uid) {
  return {
    uid,
    par: state.dailyPar,
    features: state.dailyFeatures,
    bombHitEvents: state.dailyBombHitEvents || [],
    // Worm hatch log (finalized by stopTimer before the win handler runs):
    // the refit computes each row's REALIZED worm dose from these, the
    // scheduled wormLoad alone would attenuate the coefficient, since fast
    // solvers experience less of it (Christopher, 2026-07-17).
    wormEvents: state.wormEvents || [],
    rngSeed: state.dailyRngSeed || dateStr,
    totalMines: state.totalMines,
    // ALWAYS written, never omitted when false, and that is the point: an
    // ABSENT scrolled means a client that predates the field, while `false`
    // means a client that measured and found the board fitted. The R side
    // needs to tell those apart, so the boolean is stated rather than
    // implied.
    scrolled: !!state.boardScrolled,
  };
}
