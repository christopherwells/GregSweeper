// Startup completion ↔ cloud reconciliation decision.
//
// "Completed today" is a per-ACCOUNT fact; the localStorage flag is just this
// device's cache. The boot gate reads daily/{date} once and decides whether the
// local flag and the cloud disagree. This is the canonical-board cross-client
// divergence path (top of the regression history), so the decision tree lives
// here as a pure, node-tested function; main.js keeps the Firebase read and the
// localStorage/markDailyCompleted side effects.
//
// Pure module, node-tested in test/startupReconcilePlan.test.mjs.

import { findRowByUid, findRowForBoard } from './scoreRowMatch.js';

/**
 * Decide what boot reconciliation should do for today's daily.
 *
 *   'clearLocal'       - local flag is SET but this account has NOT finished the
 *                        day's canonical board, so the real board is still
 *                        unplayed and they are not on the leaderboard. Clear the
 *                        completion flag + cached par/moves so they can play it.
 *                        Three ways to establish that, in order of strength:
 *
 *                        (a) The LOCAL record names a different board. Strongest
 *                            and cheapest, no cloud row need exist, which
 *                            matters because since the submit guard (#252) one
 *                            never does: a divergent score is refused, so the
 *                            row the old cloud-only check read is precisely the
 *                            row that stopped being written.
 *                        (b) The account's own cloud row is POSITIVELY divergent
 *                            (a stored rngSeed differing from the canonical).
 *                            The historical path, kept for rows written before
 *                            the submit guard and for completions this device
 *                            never saw.
 *                        (c) VINTAGE ONLY, once ever: the local record predates
 *                            seed tracking AND the account has no row at all for
 *                            today. See `vintageUnlock` below.
 *
 *                        Otherwise a missing row trusts the local flag, an
 *                        earlier version cleared on missing-score and let raced
 *                        lookups unlock replays.
 *   'adoptCompletion'  - local flag is UNSET but a row matching the canonical's
 *                        effective seed exists: this account already finished
 *                        today's board on another device. Adopt it. Adoption
 *                        requires an explicit seed match, a divergent row must
 *                        NOT lock the player out of the canonical.
 *   'noop'             - local and cloud agree (or there's nothing to act on).
 *
 * Note the asymmetry: the clear branch keys off the account's FIRST row
 * regardless of seed (findRowByUid) and only fires on a positively-divergent
 * STORED seed; the adopt branch requires a row whose EFFECTIVE seed matches the
 * canonical (findRowForBoard). That difference is load-bearing and is exactly
 * what the tests pin.
 *
 * @param {object} args
 * @param {object|null} args.rows          daily/{date} rows object (keyed by pushId).
 *                                         Only ever passed when the read SUCCEEDED,
 *                                         so null here means "nobody has submitted",
 *                                         not "could not tell".
 * @param {string|null} args.uid           the player's Firebase uid
 * @param {string} args.dateString         today's ET date (the bucket key)
 * @param {string|null} args.canonicalSeed the canonical board's rngSeed
 * @param {boolean} args.localCompleted    is the local daily-completed flag set?
 * @param {string|null} args.localSeed     the board seed this device recorded the
 *                                         completion on; null when the completion
 *                                         predates seed tracking (UNKNOWN, never
 *                                         "the canonical")
 * @param {boolean} args.vintageUnlock     may this call spend the one-time vintage
 *                                         unlock? Only true on the single boot that
 *                                         migrates a pre-seed-tracking completion,
 *                                         because "no row" is otherwise a weak
 *                                         signal: a player with no name set, or one
 *                                         whose submission is still queued offline,
 *                                         legitimately has no row after finishing
 *                                         the real board. Bounded to one boot ever,
 *                                         it unlocks the player whose divergent
 *                                         score was refused and leaves everyone with
 *                                         a canonical row untouched.
 * @returns {{ action: 'clearLocal' | 'adoptCompletion' | 'noop' }}
 */
export function planCompletionReconcile({
  rows, uid, dateString, canonicalSeed, localCompleted,
  localSeed = null, vintageUnlock = false,
}) {
  if (!canonicalSeed || !uid) return { action: 'noop' };

  if (localCompleted) {
    // (a) This device knows which board it finished, and it was not this one.
    if (localSeed && localSeed !== canonicalSeed) return { action: 'clearLocal' };
    const myScore = findRowByUid(rows, uid);
    const myScoreSeed = (myScore && myScore.rngSeed) ? myScore.rngSeed : null;
    // (b) The account's own row names a different board.
    if (myScore && myScoreSeed && myScoreSeed !== canonicalSeed) return { action: 'clearLocal' };
    // (c) Vintage record, no row anywhere for this account on today's board.
    if (vintageUnlock && !localSeed && !findRowForBoard(rows, uid, dateString, canonicalSeed)) {
      return { action: 'clearLocal' };
    }
    return { action: 'noop' };
  }

  if (findRowForBoard(rows, uid, dateString, canonicalSeed)) return { action: 'adoptCompletion' };
  return { action: 'noop' };
}
