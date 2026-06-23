// Startup completion ↔ cloud reconciliation decision.
//
// "Completed today" is a per-ACCOUNT fact; the localStorage flag is just this
// device's cache. The boot gate reads daily/{date} once and decides whether the
// local flag and the cloud disagree. This is the canonical-board cross-client
// divergence path (top of the regression history), so the decision tree lives
// here as a pure, node-tested function; main.js keeps the Firebase read and the
// localStorage/markDailyCompleted side effects.
//
// Pure module — node-tested in test/startupReconcilePlan.test.mjs.

import { findRowByUid, findRowForBoard } from './scoreRowMatch.js';

/**
 * Decide what boot reconciliation should do for today's daily.
 *
 *   'clearLocal'       — local flag is SET but the account's own row is
 *                        POSITIVELY divergent (a stored rngSeed that differs
 *                        from the canonical): the player completed a wrong board
 *                        (cold-load race / pre-canonical client). Clear the
 *                        completion flag + cached par/moves so they can play the
 *                        real canonical. A missing row, or a row with no stored
 *                        seed (plain-date board), trusts the local flag — an
 *                        earlier version cleared on missing-score and let raced
 *                        lookups unlock replays.
 *   'adoptCompletion'  — local flag is UNSET but a row matching the canonical's
 *                        effective seed exists: this account already finished
 *                        today's board on another device. Adopt it. Adoption
 *                        requires an explicit seed match — a divergent row must
 *                        NOT lock the player out of the canonical.
 *   'noop'             — local and cloud agree (or there's nothing to act on).
 *
 * Note the asymmetry: the clear branch keys off the account's FIRST row
 * regardless of seed (findRowByUid) and only fires on a positively-divergent
 * STORED seed; the adopt branch requires a row whose EFFECTIVE seed matches the
 * canonical (findRowForBoard). That difference is load-bearing and is exactly
 * what the tests pin.
 *
 * @param {object} args
 * @param {object|null} args.rows          daily/{date} rows object (keyed by pushId)
 * @param {string|null} args.uid           the player's Firebase uid
 * @param {string} args.dateString         today's ET date (the bucket key)
 * @param {string|null} args.canonicalSeed the canonical board's rngSeed
 * @param {boolean} args.localCompleted    is the local daily-completed flag set?
 * @returns {{ action: 'clearLocal' | 'adoptCompletion' | 'noop' }}
 */
export function planCompletionReconcile({ rows, uid, dateString, canonicalSeed, localCompleted }) {
  if (!canonicalSeed || !uid) return { action: 'noop' };

  if (localCompleted) {
    const myScore = findRowByUid(rows, uid);
    const myScoreSeed = (myScore && myScore.rngSeed) ? myScore.rngSeed : null;
    if (myScore && myScoreSeed && myScoreSeed !== canonicalSeed) return { action: 'clearLocal' };
    return { action: 'noop' };
  }

  if (findRowForBoard(rows, uid, dateString, canonicalSeed)) return { action: 'adoptCompletion' };
  return { action: 'noop' };
}
