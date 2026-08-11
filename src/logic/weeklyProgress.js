// The weekly's calendar: which past weeks are replayable, and how the week
// streak advances.
//
// The daily has three of these already, archiveEligibility.js for "which
// past boards are offered", moltDay.js for "what does completing today do to
// the streak". The weekly gets one module for both because they are the same
// arithmetic seen twice: everything here is a Monday `weekStart` string, and
// the only operation either half needs is "how many weeks apart are these
// two". Splitting that across two files would mean two copies of it.
//
// Pure: no DOM, no storage, no clock. Callers pass the current week in, the
// way the daily's helpers take `today`. YYYY-MM-DD strings compare correctly
// with < and >= because they are fixed-width and zero-padded, so the window
// checks need no Date parsing; only the week ARITHMETIC does.
//
// The weekly deliberately has no molt days (Christopher, 2026-08-05). A molt
// day insures a daily ritual against one missed evening; a week is already
// seven chances at the same board, so the insurance would be insuring a
// window that is itself the insurance.

// The first weekStart with a stored canonical `weeklyBoard`, the mode's own
// launch. Earlier weeks have no board to replay, and unlike the daily there is
// no backfill: a weekly board is one board for one week, and regenerating a
// past week from its seed would produce a board nobody ever played.
export const FIRST_ARCHIVE_WEEK = '2026-05-04';

// The first Monday whose week ran under the per-week COMPLETION record
// (`users/{uid}/weeklyCompletions/{weekStart}`, written at the win). Weeks
// before it have only the ATTEMPTS record, which is written on the first
// click and so proves a week was opened, never that it was finished. The
// constant is FROZEN in both directions: moving it earlier claims completion
// records for weeks that never wrote any, and moving it later re-admits the
// abandoned-attempt banking issue #254 closed. See bankableWeeks for the
// policy split it anchors.
export const WEEKLY_COMPLETIONS_EPOCH = '2026-08-10';

/** Add (or subtract) whole weeks to a Monday weekStart string. */
export function addWeeks(weekStart, delta) {
  const [y, m, d] = String(weekStart).split('-').map(Number);
  // Local noon: a DST boundary inside the span can't shift the result a day.
  const dt = new Date(y, m - 1, d, 12);
  dt.setDate(dt.getDate() + delta * 7);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/**
 * Whole weeks from `a` to `b` (positive when b is later). Both must be Monday
 * anchors from getWeekStart, so the span is always a whole number of weeks and
 * rounding only absorbs the DST hour.
 */
export function weeksBetween(a, b) {
  const [ay, am, ad] = String(a).split('-').map(Number);
  const [by, bm, bd] = String(b).split('-').map(Number);
  const t1 = new Date(ay, am - 1, ad, 12).getTime();
  const t2 = new Date(by, bm - 1, bd, 12).getTime();
  return Math.round((t2 - t1) / (7 * 86400000));
}

const isWeekString = (w) => typeof w === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(w);

// ── Labels ───────────────────────────────────────────────────────────────
// A weekStart is a Monday, and nobody thinks in Mondays: the row has to say
// which stretch of days it was. Built at local noon so a DST boundary can't
// walk the label back a day, and spelled "to" rather than a dash because the
// house style keeps dashes out of player copy.

function _labelParts(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

/** "May 4", the Monday alone. */
export function weekStartLabel(weekStart) {
  if (!isWeekString(weekStart)) return '';
  return _labelParts(weekStart).toLocaleString(undefined, { month: 'short', day: 'numeric' });
}

/** "May 4 to May 10", the week the board belonged to. */
export function weekRangeLabel(weekStart) {
  if (!isWeekString(weekStart)) return '';
  const end = addWeeks(weekStart, 0);
  const [y, m, d] = end.split('-').map(Number);
  const sun = new Date(y, m - 1, d + 6, 12);
  const fmt = { month: 'short', day: 'numeric' };
  return `${_labelParts(weekStart).toLocaleString(undefined, fmt)} to ${sun.toLocaleString(undefined, fmt)}`;
}

// ── Past weeklies ────────────────────────────────────────────────────────

/**
 * Is `weekStart` offered in the weekly archive? A stored past week: at or
 * after the first weekly, and strictly before the current one. THIS week is
 * the live Weekly's job, it still has attempts left in it.
 */
export function isArchivableWeek(weekStart, currentWeek, firstWeek = FIRST_ARCHIVE_WEEK) {
  if (!isWeekString(weekStart) || !isWeekString(currentWeek)) return false;
  return weekStart >= firstWeek && weekStart < currentWeek;
}

/**
 * What the past-weeklies list should do with one row.
 *
 *   'playable'    - offered, tap to replay
 *   'done'        - offered but already COMPLETED; shows its mark and is not
 *                   tappable, exactly as a finished daily is. The week's board
 *                   is one board: once you have cleared it there is nothing
 *                   left to find, and a replay records nothing anyway.
 *   'current'     - this week, which the live Weekly card owns
 *   'unavailable' - outside the window
 *
 * `completed` is the set of weeks the player has FINISHED, from
 * fetchCompletedWeeks reading `users/{uid}/weeklyCompletions`. It is
 * deliberately NOT the attempts record: an attempt is written on the first
 * click, so marking 'done' from attempts locked out every week that was
 * opened and abandoned, a board the player never cleared and might well want
 * back (issue #254's sibling annoyance). Weeks completed before the record
 * existed rely on the leaderboard backfill; a completion with no record
 * anywhere reads playable, which fails OPEN like everything else here and
 * costs only a pointless replay that records nothing.
 *
 * `completed` may be a Set, an array, or null. NULL MEANS UNKNOWN, not empty,
 * the daily calendar's rule and for the same reason: a signed-out player or a
 * failed read cannot be told what they have finished.
 */
export function weekArchiveState(weekStart, currentWeek, completed = null, firstWeek = FIRST_ARCHIVE_WEEK) {
  if (!isWeekString(weekStart) || !isWeekString(currentWeek)) return 'unavailable';
  if (weekStart === currentWeek) return 'current';
  if (!isArchivableWeek(weekStart, currentWeek, firstWeek)) return 'unavailable';
  if (!completed) return 'playable';
  const has = completed instanceof Set ? completed.has(weekStart) : completed.includes(weekStart);
  return has ? 'done' : 'playable';
}

/**
 * The past weeks to list, newest first. Bounded by `limit` because the list is
 * a scrolling column rather than a calendar grid: it grows by one row a week
 * forever, and a player looking for last month's board should not have to
 * scroll past a year of them.
 */
export function pastWeekStarts(currentWeek, limit = 26, firstWeek = FIRST_ARCHIVE_WEEK) {
  if (!isWeekString(currentWeek)) return [];
  const out = [];
  let w = addWeeks(currentWeek, -1);
  while (out.length < limit && w >= firstWeek) {
    out.push(w);
    w = addWeeks(w, -1);
  }
  return out;
}

// ── Week streak ──────────────────────────────────────────────────────────
//
// One completion in a week banks that week, his rule (2026-08-05): "only need
// to play one of the weekly to get a week streak". The seven daily attempts
// are the week's generosity, not seven separate obligations, so the streak
// counts WEEKS PLAYED and never asks how many of the seven were used.
//
// Completion, not merely opening a board, is what banks it, the same bar the
// daily streak uses. The weekly has no loss state, so an attempt either
// finishes or is abandoned, and "played" would otherwise be satisfied by one
// click on a board nobody solved.

/**
 * Commit a weekly completion to the streak.
 *
 * Same week as the last completion → nothing moves (later days of a week the
 * player already banked are the same week, not a second one).
 * The very next week → the streak grows.
 * Any wider gap, or no history → the streak restarts at 1.
 *
 * @param {{lastWeek: string|null, streak: number, best: number}} prev
 * @param {string} week the completed board's weekStart
 * @returns {{lastWeek: string, streak: number, best: number, extended: boolean}}
 */
export function applyWeekContinuation(prev, week) {
  const lastWeek = prev && isWeekString(prev.lastWeek) ? prev.lastWeek : null;
  const prevStreak = Math.max(0, Number(prev?.streak) || 0);
  const prevBest = Math.max(0, Number(prev?.best) || 0);
  if (!isWeekString(week)) {
    return { lastWeek, streak: prevStreak, best: prevBest, extended: false };
  }

  let streak;
  let extended;
  if (lastWeek === week) {
    // Already banked this week. Hold everything, including a streak of 0 that
    // some other path has not yet set, this branch must never invent one.
    streak = Math.max(1, prevStreak);
    extended = false;
  } else if (lastWeek && weeksBetween(lastWeek, week) === 1) {
    streak = prevStreak + 1;
    extended = true;
  } else {
    streak = 1;
    extended = true;
  }
  return {
    lastWeek: week,
    streak,
    best: Math.max(prevBest, streak),
    extended,
  };
}

/**
 * The streak implied by a set of weeks already played: the maximal run of
 * consecutive weeks ending at the most recent one.
 *
 * The counterpart to computeStreakFromHistory for dailies, and it exists for
 * the same reason. A streak kept only as a counter starts at zero the day the
 * counter ships, so the feature launched telling players who had never missed
 * a weekly that they had no streak, fourteen weeks of history sitting in
 * their own account, uncounted (his report, 2026-08-05). The history is the
 * authority; the counter is a cache of it.
 *
 * Order and duplicates in the input do not matter.
 *
 * @param {string[]} weekStarts Monday anchors of weeks the player has played
 * @returns {{streak: number, lastWeek: string|null}}
 */
/**
 * Filter a list of weeks down to the ones a streak may derive from: valid
 * Monday anchors strictly BEFORE the current week, the weekly counterpart of
 * streakBearingDates. The live week is not history, the player can still earn
 * it honestly before Sunday, and the reconcile runs on every boot, so counting
 * it banked a week for one click, spliced it onto a genuine run (measured: a
 * real 2-week run read 3), and raised the monotonic `best`, which nothing can
 * lower again (issue #254). Anything dated after the current week is dropped
 * for the same reason plus one more: it cannot be a completion, only a clock
 * disagreement.
 *
 * `currentWeek` is required and the filter fails CLOSED without it, in keeping
 * with this module's no-clock rule: not knowing what "now" is means not being
 * able to tell history from the live week, and returning everything would
 * silently restore the defect. An empty result leaves the stored record
 * alone, since the reconcile treats it as nothing to derive.
 *
 * This is the mechanical half. WHICH records may bank a week (attempts vs
 * completions, split at WEEKLY_COMPLETIONS_EPOCH) is bankableWeeks' question,
 * and both of its sources pass through here.
 *
 * @param {string[]|null} weekStarts Monday anchors
 * @param {string} currentWeek this week's Monday anchor
 * @returns {string[]} the weeks a streak may count
 */
export function streakBearingWeeks(weekStarts, currentWeek) {
  if (!Array.isArray(weekStarts) || !isWeekString(currentWeek)) return [];
  return weekStarts.filter((w) => isWeekString(w) && w < currentWeek);
}

/**
 * The weeks the streak reconcile may bank, merged from the two per-week
 * records with the boundary stated rather than implied.
 *
 * `attempted` (users/{uid}/weeklyAttempts) is written on the FIRST CLICK, so
 * it proves a week was opened, never that it was finished. `completed`
 * (users/{uid}/weeklyCompletions) is written at the win and is the record the
 * streak actually means, but it only exists from WEEKLY_COMPLETIONS_EPOCH on.
 *
 * So the split. BEFORE the epoch, an attempt still banks its week: attempts
 * are the only per-week record every player has for that era (the completion
 * evidence is on the weekly leaderboard, which a player without a name never
 * reached), and erring generous on history the player can no longer replay
 * errs the same direction the daily's upward-only self-heal does. FROM the
 * epoch on, an attempt alone banks nothing: the completions record is written
 * for every finished week, so its absence next to an attempt means the board
 * was opened and walked away from, exactly the state issue #254 stopped the
 * live week from banking.
 *
 * Both sources pass through streakBearingWeeks, so the live-week exclusion
 * and the fail-closed no-currentWeek contract cover completions exactly as
 * they always covered attempts. Either source may be null (signed out, or its
 * read failed); the other still counts, since the two reads are independent.
 *
 * @param {{attempted?: string[]|null, completed?: string[]|null,
 *          currentWeek: string, epoch?: string}} args
 * @returns {string[]} deduped weeks the streak may count
 */
export function bankableWeeks({ attempted = null, completed = null, currentWeek, epoch = WEEKLY_COMPLETIONS_EPOCH } = {}) {
  const preEpochAttempts = streakBearingWeeks(attempted, currentWeek).filter((w) => w < epoch);
  const completions = streakBearingWeeks(completed, currentWeek);
  return [...new Set([...preEpochAttempts, ...completions])];
}

export function weekStreakFromHistory(weekStarts) {
  if (!Array.isArray(weekStarts)) return { streak: 0, lastWeek: null };
  const sorted = [...new Set(weekStarts.filter(isWeekString))].sort();
  if (!sorted.length) return { streak: 0, lastWeek: null };
  const lastWeek = sorted[sorted.length - 1];
  let streak = 1;
  for (let i = sorted.length - 1; i > 0; i--) {
    if (weeksBetween(sorted[i - 1], sorted[i]) === 1) streak++;
    else break;
  }
  return { streak, lastWeek };
}

/**
 * Is a stored week streak still alive as of `currentWeek`?
 *
 * Alive means the last completion was this week or last week, while the
 * current week is still running, a streak that ended last week has not been
 * broken yet, it is merely waiting. Anything older is over, and the card must
 * not keep advertising it.
 */
export function isWeekStreakAlive(lastWeek, currentWeek) {
  if (!isWeekString(lastWeek) || !isWeekString(currentWeek)) return false;
  const gap = weeksBetween(lastWeek, currentWeek);
  return gap === 0 || gap === 1;
}

/**
 * What completing THIS week would do to the streak, without committing it.
 * The card uses it to say "play this week to keep your N week streak" while
 * the week is still open.
 *
 * @returns {{streak: number, atRisk: boolean}} `streak` is the value after a
 *   completion; `atRisk` is true when the streak is riding on this week (last
 *   completion was the previous week, and this week is still unplayed).
 */
export function projectWeekContinuation(prev, currentWeek) {
  const next = applyWeekContinuation(prev, currentWeek);
  const lastWeek = prev && isWeekString(prev.lastWeek) ? prev.lastWeek : null;
  const atRisk = !!lastWeek
    && isWeekString(currentWeek)
    && weeksBetween(lastWeek, currentWeek) === 1;
  return { streak: next.streak, atRisk };
}

/**
 * The streak a stored record can honestly claim right now: the stored value
 * while it is alive, 0 once it has lapsed. Read-side only, a lapsed streak is
 * not rewritten to 0 in storage, because the next completion's continuation
 * math resets it anyway and a read must never mutate.
 */
export function liveWeekStreak(record, currentWeek) {
  const streak = Math.max(0, Number(record?.streak) || 0);
  if (!streak) return 0;
  return isWeekStreakAlive(record?.lastWeek, currentWeek) ? streak : 0;
}
