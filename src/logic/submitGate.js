// Should this score reach the leaderboard?
//
// Two questions stand between a finished run and a leaderboard row, and both
// were answered inline inside _doSubmitOnlineScore's try block:
//
//   1. DEDUPE, does this account already have a row for this exact board?
//      (another device finished first, or a queued retry actually landed)
//   2. DIVERGENCE, was this board the day's canonical at all?
//
// They live here because a decision buried in an async Firebase call is a
// decision nobody can test. The guard that shipped 2026-08-07 was pinned by 22
// SOURCE-SCAN assertions, they prove the string `return 'divergent'` sits near
// a read of the canonical seed, and prove nothing whatever about what the guard
// decides. This module is the same logic where a test can hand it inputs and
// read the verdict.
//
// BOTH READS FAIL OPEN, and that is the load-bearing property. A flaky read
// must never eat a real score: the cost of a missed duplicate is a second row,
// and the cost of a missed divergence is one bad row the nightly sweep will
// report, while the cost of failing CLOSED is silently dropping scores every
// time Firebase hiccups. Unavailable is expressed as `null`, never as a
// mismatch, so the caller cannot accidentally turn an outage into a refusal.
//
// Pure module, node-tested in test/submitGate.test.mjs.

import { findRowForBoard } from './scoreRowMatch.js';
import { isMatchRowKey } from './matchCodes.js';

/**
 * @typedef {'duplicate' | 'divergent' | 'proceed'} SubmitVerdict
 */

/**
 * Decide whether a score submission should be pushed.
 *
 * @param {object} args
 * @param {object|null} args.rows          the bucket's existing rows, or null when
 *                                         there are none OR the read failed,
 *                                         both mean "nothing blocks this push"
 * @param {string|null} args.uid           the player's Firebase uid; without one
 *                                         there is no account to dedupe against
 * @param {string} args.bucketKey          the row bucket's key (a date, or
 *                                         `{weekStart}_weekly_first`), rows omit
 *                                         rngSeed when it equals this, so it is
 *                                         what reconstructs their effective seed
 * @param {string} args.playedSeed         the effective seed of the board played
 * @param {string|null} args.canonicalSeed the canonical board's seed, or null when
 *                                         it could not be read. NULL IS NOT A
 *                                         MISMATCH, see the fail-open note above.
 * @returns {{ verdict: SubmitVerdict }}
 */
export function planScoreSubmission({ rows, uid, bucketKey, playedSeed, canonicalSeed }) {
  // Dedupe first, deliberately. A player who already has a row for this board
  // has nothing to gain from a second verdict, and reporting 'duplicate' is the
  // more useful thing to tell them.
  if (uid && findRowForBoard(rows, String(uid), bucketKey, playedSeed)) {
    return { verdict: 'duplicate' };
  }
  if (typeof canonicalSeed === 'string' && canonicalSeed && canonicalSeed !== playedSeed) {
    return { verdict: 'divergent' };
  }
  return { verdict: 'proceed' };
}

/**
 * Where the canonical seed for a row bucket lives.
 *
 * The daily's guard read `dailyBoard/{bucketKey}/rngSeed` for every bucket,
 * which is right for a date and WRONG for the weekly's fit row: a
 * `{weekStart}_weekly_first` row describes the WEEKLY board, which lives at
 * `weeklyBoard/{weekStart}`. The daily node has no such child, so the read
 * returned null, `typeof null !== 'string'`, and the check was skipped
 * entirely, the guard silently no-opped on every weekly fit row ever
 * submitted. Deriving the path from the key is what stops that recurring.
 *
 * A MATCH board has no canonical to diverge from, and saying so here is the
 * point. Its bytes come from the committed library and every player of it
 * re-certifies the stored payload through certifyStoredBoard's ground-truth
 * audit, which proves more than a seed comparison could: that the numbers
 * describe the mines and the board is solvable from its opener. Left to the
 * default, `dailyBoard/match_<hash>/rngSeed` would read null forever and the
 * divergence check would no-op by accident, which is exactly how the weekly's
 * guard silently did nothing for every fit row it ever wrote. Returning null
 * makes the caller skip a read it has no reason to make.
 *
 * @param {string} bucketKey  'YYYY-MM-DD', 'YYYY-MM-DD_weekly_first', or 'match_<hash>'
 * @returns {string|null} the Firebase path of the canonical's rngSeed, or null
 *                        when this bucket has no canonical
 */
export function canonicalSeedPath(bucketKey) {
  const WEEKLY_SUFFIX = '_weekly_first';
  if (isMatchRowKey(bucketKey)) return null;
  if (typeof bucketKey === 'string' && bucketKey.endsWith(WEEKLY_SUFFIX)) {
    return `weeklyBoard/${bucketKey.slice(0, -WEEKLY_SUFFIX.length)}/rngSeed`;
  }
  return `dailyBoard/${bucketKey}/rngSeed`;
}
