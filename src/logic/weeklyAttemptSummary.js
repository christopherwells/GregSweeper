// Weekly win-modal attempt summary.
//
// Computes the prior-best / new-best / attempts-used numbers, the day-of-week
// circles, and the faster/slower/matched/first summary copy. The win handler
// keeps the DOM (the innerHTML template + the inline leaderboard fetch).
//
// The load-bearing subtlety: attemptsUsed and priorBest must be computed from
// the prior-times snapshot taken BEFORE handleWin's weekly block mutates
// state.weeklyDayTimes (it adds today's time to compute the bestTime to submit).
// Without the snapshot, priorTimes would already include the current attempt
// and the modal would report a 1st attempt as a 2nd. The caller passes that
// snapshot in (state._weeklyPriorTimesAtWin); the fallback derivation here
// excludes the current time defensively.
//
// Pure module — node-tested in test/weeklyAttemptSummary.test.mjs.

/**
 * @param {object} args
 * @param {number} args.precise          this attempt's time (seconds)
 * @param {number[]|undefined} args.priorTimesAtWin  the pre-mutation snapshot of
 *   prior attempt times (state._weeklyPriorTimesAtWin); when absent it's derived
 *   from weeklyDayTimes with the current time filtered out
 * @param {Object<number,number>} args.weeklyDayTimes  day index → time map
 * @param {number} args.weeklyDay        the day index (0-6) this win landed on
 * @returns {{
 *   priorBest: (number|null), newBest: number, attemptsUsed: number,
 *   dayCircles: string, summaryClass: string, summarySpanText: string,
 *   summaryTrailing: string,
 * }}
 */
export function summarizeWeeklyAttempt({ precise, priorTimesAtWin, weeklyDayTimes, weeklyDay }) {
  const priorTimes = priorTimesAtWin
    || Object.values(weeklyDayTimes || {}).filter((t) => typeof t === 'number' && Math.abs(t - precise) > 0.01);
  const priorBest = priorTimes.length > 0 ? Math.min(...priorTimes) : null;
  const newBest = priorBest != null ? Math.min(priorBest, precise) : precise;
  const attemptsUsed = priorTimes.length + 1;

  // Day circles: ◉ for the day this win landed on, ● for other played days, ○
  // for not-yet. After the win mutation weeklyDayTimes includes today.
  const playedDays = weeklyDayTimes || {};
  const dayCircles = [0, 1, 2, 3, 4, 5, 6].map((d) => {
    if (d === weeklyDay) return '◉';
    if (playedDays[d] != null) return '●';
    return '○';
  }).join(' ');

  let summaryClass, summarySpanText, summaryTrailing = '';
  if (priorBest == null) {
    summaryClass = 'par-even';
    summarySpanText = `First attempt this week. You set the bar at ${precise.toFixed(1)}s.`;
  } else if (precise < priorBest) {
    summaryClass = 'par-under';
    summarySpanText = `${(priorBest - precise).toFixed(1)}s faster than your best`;
    summaryTrailing = ` · new best ${newBest.toFixed(1)}s`;
  } else if (precise > priorBest) {
    summaryClass = 'par-over';
    summarySpanText = `${(precise - priorBest).toFixed(1)}s off your best`;
    summaryTrailing = ` · still ${newBest.toFixed(1)}s to beat`;
  } else {
    summaryClass = 'par-even';
    summarySpanText = 'Matched your best!';
    summaryTrailing = ` · ${newBest.toFixed(1)}s`;
  }

  return { priorBest, newBest, attemptsUsed, dayCircles, summaryClass, summarySpanText, summaryTrailing };
}
