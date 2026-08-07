// What to play after the weekly had to generate its own board.
//
// The weekly keeps a local-generation fallback that the daily no longer has,
// and keeping it is deliberate (Christopher, 2026-08-07): the board it writes
// is the precompute-failure recovery, and a week with no canonical at all is
// worse than a week whose canonical came from the first player through the
// door. What the fallback must NOT do is play a board of its own while a
// different canonical already exists, which is the weekly half of the
// divergence the daily closed on the same date.
//
// The signal is the WRITE, not the read. `weeklyBoard/{weekStart}` is
// write-once, so a rejected write is not a duplicate to shrug at, it is the
// server saying a canonical is already there. A read alone cannot say that:
// loadWeeklyBoard returns null both for "reachable and empty" and for "could
// not reach it", and those two want opposite answers.
//
// Hence the table below. It is small enough to read in one go and that is the
// point, because the version of it that lived inline was three conditions
// spread across sixty lines of generation code and nothing exercised it.

/**
 * @typedef {object} WeeklyLocalGenPlan
 * @property {boolean} adopt   true when the settled canonical should replace
 *                             the board we just generated
 * @property {string}  reason  'established' | 'unreachable' | 'agrees' | 'superseded'
 * @property {string=} settledSeed the canonical's rngSeed, when one was read
 */

/**
 * Decide whether a locally generated weekly board may be played.
 *
 * @param {object} args
 * @param {boolean} args.wrote        did saveWeeklyBoard report success
 * @param {object|null} args.settled  the canonical read back after a failed write
 * @param {string} args.generatedSeed the rngSeed we generated under
 * @param {string} args.weekStart     Monday's YYYY-MM-DD in ET
 * @returns {WeeklyLocalGenPlan}
 */
export function weeklyLocalGenPlan({ wrote, settled, generatedSeed, weekStart }) {
  // The write landed, so no canonical existed and ours is now it.
  if (wrote) return { adopt: false, reason: 'established' };

  // The write failed and nothing came back. Offline, or a test build whose
  // writes are gated. Playing our own board is where this code has always
  // been and is still the best answer available: local generation is
  // deterministic from the weekStart, so every client on the same build
  // builds the same board.
  if (!settled) return { adopt: false, reason: 'unreachable' };

  // A canonical omits rngSeed when it equals its own key, the same convention
  // score rows use (see effectiveRowSeed in scoreRowMatch.js). Reconstructing
  // it here rather than at the call site is what stops a plain-seeded week
  // reading as a mismatch against itself.
  const settledSeed = settled.rngSeed || weekStart;
  if (settledSeed === generatedSeed) return { adopt: false, reason: 'agrees', settledSeed };

  // A different board is already the week's. Ours would be a board nobody else
  // is on, played with one of only seven attempts, for a score the submit
  // guard refuses.
  return { adopt: true, reason: 'superseded', settledSeed };
}
