// Matching rules for daily/{date} leaderboard rows.
//
// Two consumers, one source of truth:
//  - the startup gate's completion reconciliation ("has THIS account
//    already completed today's canonical board on any device?")
//  - the submission dedupe in firebaseLeaderboard ("does this account
//    already have a row for this exact board?")
//
// The subtlety both depend on: rows OMIT rngSeed when it equals the
// dateString (see _doSubmitOnlineScore — plain-date seeds are not
// stored), so seed comparisons must reconstruct the row's EFFECTIVE
// seed first. Matching on the effective seed rather than uid alone is
// what keeps practice plays (?seed= — submitted into the same
// daily/{date} bucket under the same uid, with the custom seed as
// rngSeed) from ever blocking or being blocked by the real daily, and
// what lets a player with a legitimately divergent historical row
// (pre-canonical-board clients) still land their canonical replay.
//
// Pure functions — node-tested in test/scoreRowMatch.test.mjs.

/**
 * The seed a row was actually played under. Rows written by
 * _doSubmitOnlineScore omit rngSeed when it equals the dateString.
 */
export function effectiveRowSeed(row, dateString) {
  return (row && typeof row.rngSeed === 'string' && row.rngSeed) ? row.rngSeed : dateString;
}

/**
 * The seed a score row was played under, for DIVERGENCE checking, across all
 * three row families the nightly sweep walks. Returns either a seed to compare
 * or a reason it cannot be compared.
 *
 * effectiveRowSeed above answers the same question for the daily alone and
 * cannot be reused here, because its "an absent seed means the bucket key"
 * convention is a property of _doSubmitOnlineScore's daily path and does not
 * hold for the other two:
 *
 *  - `daily/{weekStart}_weekly_first` — the bucket key is not a board seed and
 *    never equals one, so the writer always stores the seed. An absent one is
 *    a row that predates the guard, and reading it as the key would report
 *    every single fit row as divergent.
 *  - `weekly/{weekStart}/{uid}` — the writer stores rngSeed whenever it has
 *    one and omits nothing by convention (#262), so absent means "written
 *    before the weekly recorded its board", not "played the plain seed".
 *
 * UNVERIFIABLE IS NOT CLEAN. Returning it explicitly is what lets the sweep
 * report how much of its sample it could not check, instead of a green line
 * over rows it silently skipped.
 *
 * @param {'daily'|'weekly'} family which Firebase node the rows came from
 * @param {string} bucketKey  the date, weekStart, or '{weekStart}_weekly_first'
 * @param {object} row        the stored score row
 * @returns {{seed: string}|{unverifiable: 'weeklyFirst'|'weekly'}}
 */
export function rowPlayedSeed(family, bucketKey, row) {
  if (row && typeof row.rngSeed === 'string' && row.rngSeed) return { seed: row.rngSeed };
  if (family === 'weekly') return { unverifiable: 'weekly' };
  if (typeof bucketKey === 'string' && bucketKey.endsWith('_weekly_first')) {
    return { unverifiable: 'weeklyFirst' };
  }
  return { seed: bucketKey };
}

/**
 * First row in a daily/{date} rows object belonging to this uid, or
 * null. Push keys are chronological, so "first" is the earliest
 * submission — the one that counts under first-completion-wins.
 */
export function findRowByUid(rows, uid) {
  if (!rows || typeof rows !== 'object' || !uid) return null;
  for (const key of Object.keys(rows)) {
    const row = rows[key];
    if (row && row.uid === uid) return row;
  }
  return null;
}

/**
 * First row belonging to this uid AND played under the same effective
 * board seed, or null. This is the duplicate test for submissions and
 * the adoption test for cross-device completion: same account, same
 * actual board.
 *
 * @param {object|null} rows  daily/{date} rows object (keyed by pushId)
 * @param {string} uid        the player's Firebase uid
 * @param {string} dateString the bucket's date key
 * @param {string} [rngSeed]  the board's effective seed; defaults to dateString
 */
export function findRowForBoard(rows, uid, dateString, rngSeed) {
  if (!rows || typeof rows !== 'object' || !uid) return null;
  const targetSeed = (typeof rngSeed === 'string' && rngSeed) ? rngSeed : dateString;
  for (const key of Object.keys(rows)) {
    const row = rows[key];
    if (row && row.uid === uid && effectiveRowSeed(row, dateString) === targetSeed) return row;
  }
  return null;
}
