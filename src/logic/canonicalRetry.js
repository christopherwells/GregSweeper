// When the startup gate should ask for a canonical board again.
//
// A canonical read returns null for reasons that want opposite answers, and
// until issue #255 the caller could not tell them apart. `weeklyCanonical.js`
// already names the problem from the other side ("loadWeeklyBoard returns null
// both for 'reachable and empty' and for 'could not reach it', and those two
// want opposite answers") and works around it by using the WRITE as its
// signal. This is the direct answer: the read reports its own reason and the
// retry decides on that.
//
// Pure: no clock, no network, no storage. The caller passes elapsed time and
// online-ness in, the way the weekly's helpers take `currentWeek`.

/** A board came back and it is trusted. Nothing to retry. */
export const CANONICAL_OK = 'ok';
/** The server was reached and the date is EMPTY. There is no board to get. */
export const CANONICAL_ABSENT = 'absent';
/** A board came back and failed signature/trust. The same bytes will fail again. */
export const CANONICAL_UNTRUSTED = 'untrusted';
/** The read timed out, errored, or Firebase never came ready. Worth another try. */
export const CANONICAL_UNREAD = 'unread';

/** How many extra reads the gate may spend. */
export const CANONICAL_RETRIES = 2;
/** Linear backoff: 500ms before the first extra read, 1000ms before the second. */
export const CANONICAL_RETRY_DELAY_MS = 500;
/**
 * Wall-clock budget, checked BEFORE starting an attempt rather than raced
 * against one in flight — cutting off a read that was about to land would
 * defeat the retry's whole purpose, which is to avoid a divergent board.
 *
 * It bounds the loop at "the budget, plus at most one fetch timeout". With a
 * 5s fetch timeout that is a ~5.5s ceiling instead of the 11.5s an
 * attempt-count budget allowed, because after one timed-out read the elapsed
 * time already exceeds the budget and no second attempt starts.
 */
export const CANONICAL_RETRY_BUDGET_MS = 3000;

/** Milliseconds to wait before attempt N (1-based). */
export function canonicalRetryDelay(attempt) {
  return CANONICAL_RETRY_DELAY_MS * Math.max(1, attempt);
}

/**
 * Should the gate spend another read?
 *
 * ONLY an unread result is worth retrying. An absent one is the server
 * answering definitively — the date has no board, and asking again in half a
 * second cannot change that, so the old loop spent its whole budget on the one
 * case guaranteed not to benefit. An untrusted one is the same shape of waste:
 * a tampered or unverifiable payload returns the same bytes next time, and the
 * local-generation fallback is the designed response to it.
 *
 * @param {object} args
 * @param {string} args.reason     one of the CANONICAL_* reasons
 * @param {number} args.attempt    which extra read this would be, 1-based
 * @param {number} args.elapsedMs  time already spent retrying THIS canonical
 * @param {boolean} args.online    navigator.onLine, or true when unknown
 * @returns {boolean}
 */
export function shouldRetryCanonical({ reason, attempt, elapsedMs, online = true }) {
  if (reason !== CANONICAL_UNREAD) return false;
  // A player can lose the network between attempts; there is no sense sleeping
  // out the rest of a budget for a read that cannot land.
  if (online === false) return false;
  if (!Number.isFinite(attempt) || attempt < 1 || attempt > CANONICAL_RETRIES) return false;
  if (!Number.isFinite(elapsedMs) || elapsedMs >= CANONICAL_RETRY_BUDGET_MS) return false;
  return true;
}

/**
 * The reason a canonical read produced what it did, from the pieces the
 * loaders already have. Defined here so the daily and weekly loaders cannot
 * classify the same situation differently.
 *
 * @param {object} args
 * @param {object|null} args.board   what the loader is about to return
 * @param {boolean} args.reached     did the server answer at all
 * @param {boolean} args.exists      did the node have data (only meaningful when reached)
 * @returns {string} a CANONICAL_* reason
 */
export function canonicalReadReason({ board, reached, exists }) {
  if (board) return CANONICAL_OK;
  if (!reached) return CANONICAL_UNREAD;
  return exists ? CANONICAL_UNTRUSTED : CANONICAL_ABSENT;
}
