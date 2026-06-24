// Daily archive: which past dailies can be replayed, and which replay
// completions are allowed to feed the par-model fit.
//
// Two independent gates live here so the client and the test suite read the
// same rules from one place:
//   1. isArchivableDate  — is this date offered in the archive at all?
//   2. archiveSubmitPlan — what does a completion do (fit row? history row?)
//
// Pure module: no DOM, no Firebase, no clock. Callers pass the dates in.
// YYYY-MM-DD strings compare correctly with < and >= because they are
// fixed-width and zero-padded, so no Date parsing is needed.

// The first ET date the archive offers — the app's launch (2026-03-06, v0.1).
// Canonical storage only began 2026-04-27; the launch..04-26 boards were
// regenerated from each date's seed with the current pipeline and written by
// scripts/backfill-old-dailies.mjs. Those are fresh no-guess dailies stamped
// with old dates, NOT recreations of the per-device boards originally played
// (unrecoverable — never stored), and they're all below ARCHIVE_FIT_EPOCH so
// they never feed the par fit. See the Daily Archive section of CLAUDE.md.
export const FIRST_ARCHIVE_DATE = '2026-03-06';

// Archive completions only feed the par fit from the date per-user
// dailyHistory began recording (the dailyHistory ship, 2026-05-07). A
// completion for an earlier date could double-count against a live play that
// pre-dates history and so left no dailyHistory row to dedupe against, so an
// earlier date never submits a fit row (it stays playable, just out of the
// fit). See PR 3 / Daily Archive in CLAUDE.md.
export const ARCHIVE_FIT_EPOCH = '2026-05-07';

// localStorage key prefix marking that the player previewed a date's crux via
// PR 4's `?crux=` route. The archive submit reads `<prefix><date>` and tags
// the row `cruxViewed: true` so the refit drops it (a previewed crux changes
// the completion time). PR 4 owns the writer; defined here so reader and
// writer share one key. Nothing sets it until PR 4 ships, so it reads false.
export const CRUX_VIEWED_KEY_PREFIX = 'minesweeper_crux_viewed_';

/**
 * Is `date` offered in the archive? True for a stored past date: at or after
 * the first canonical, and strictly before today (today is the live Daily's
 * job, never the archive's). Canonical existence is probed separately at
 * launch; this gate is the cheap date-window check the calendar uses.
 *
 * @param {string} date  YYYY-MM-DD (ET) of the candidate board
 * @param {string} today YYYY-MM-DD (ET) of the current day
 * @param {string} [firstDate] override for the first archivable date
 * @returns {boolean}
 */
export function isArchivableDate(date, today, firstDate = FIRST_ARCHIVE_DATE) {
  if (typeof date !== 'string' || typeof today !== 'string') return false;
  return date >= firstDate && date < today;
}

/**
 * Decide what an archive completion for `date` does, given whether the player
 * already has a dailyHistory row for it.
 *
 *   submitFit    — push a dailyArchive/{date} row for the par fit. Gated on
 *                  the epoch so pre-history dates can never double-count.
 *   writeHistory — write users/{uid}/dailyHistory/{date}. This is both the
 *                  first-completion dedup key (a present row means "already
 *                  played, this is a replay") and the source the delta chart
 *                  reads, so an archived board slots into the chart with no
 *                  migration.
 *
 * A replay (history already present) does neither: first completion wins.
 *
 * Only a CONFIRMED-absent row is a first completion. 'unknown' means the
 * dailyHistory read failed or Firebase wasn't ready, and we must FAIL CLOSED:
 * a replay mis-read as fresh would double-feed the par fit (push-keyed
 * dailyArchive rows don't overwrite) and overwrite the first-completion chart
 * row. Record nothing and let a later healthy completion pick it up.
 * (REGRESSION: archive dedup fail-open — a failed/early read returned null and
 * was treated as "no prior completion", so a flaky read on a replay double-fed
 * the fit.)
 *
 * @param {string} date YYYY-MM-DD (ET) of the played board
 * @param {'present'|'absent'|'unknown'} historyStatus does
 *   users/{uid}/dailyHistory/{date} exist? 'present' = replay, 'absent' = first
 *   completion, 'unknown' = read failed / Firebase not ready.
 * @param {string} [epoch] override for the fit epoch
 * @returns {{ submitFit: boolean, writeHistory: boolean }}
 */
export function archiveSubmitPlan(date, historyStatus, epoch = ARCHIVE_FIT_EPOCH) {
  if (historyStatus !== 'absent') return { submitFit: false, writeHistory: false };
  return {
    submitFit: typeof date === 'string' && date >= epoch,
    writeHistory: true,
  };
}

/**
 * Resolve the `?crux=` share-route date with a spoiler + range guard. The route
 * shows a PAST daily's crux, so today and later are REFUSED (never spoil the
 * live board) and anything before the first canonical is out of range; both
 * fall back to yesterday. An empty / non-date param ('' or '1') also defaults
 * to yesterday. Pure string compares (fixed-width YYYY-MM-DD).
 *
 * @param {string} cruxParam   the raw ?crux= value ('', '1', or YYYY-MM-DD)
 * @param {string} todayET     today's ET date
 * @param {string} yesterdayET yesterday's ET date (the default + clamp target)
 * @param {string} [firstDate] earliest offered date
 * @returns {string} YYYY-MM-DD to show
 */
export function resolveCruxDate(cruxParam, todayET, yesterdayET, firstDate = FIRST_ARCHIVE_DATE) {
  let cruxDate = /^\d{4}-\d{2}-\d{2}$/.test(cruxParam) ? cruxParam : yesterdayET;
  if (cruxDate >= todayET || cruxDate < firstDate) cruxDate = yesterdayET;
  return cruxDate;
}
