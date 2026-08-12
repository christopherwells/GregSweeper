// Resume-eligibility rules for persisted saves and live sessions.
//
// Daily and weekly games are DATE-ANCHORED: a daily belongs to one ET
// date, a weekly attempt to one (weekStart, dayIndex) pair. Crossing
// midnight ET forfeits an unfinished attempt, the player gets the new
// day's puzzle, never a resurrected stale one. These helpers are the
// single source of truth for "is this game still current?", used by
// tryResumeGame (persisted saves) and the visibility-wake check in
// main.js (live sessions that slept through midnight in a background
// tab or suspended PWA).
//
// Everything here anchors to CLOCK values passed in via ctx, never to
// live state such as state.dailySeed: a session that survived
// midnight still carries yesterday's date in state, and trusting it is
// how yesterday's unfinished daily once resurrected as "today's"
// puzzle. Pure functions, node-tested in test/resumeEligibility.test.mjs.

import { isValidCellNeighbors } from './adjacency.js';

/**
 * Is a saved CHALLENGE game a position the player can actually hold?
 *
 * The ladder advances one level at a time and every win records the level, so
 * the level you are playing is at most one above the highest you have won.
 * That is an invariant of how progression works, not an estimate: the
 * checkpoint selector only unlocks blocks at or below `maxLevelReached + 1`,
 * a death moves you DOWN to the block start, and `?level=` playtests never
 * persist. So a save claiming a level above `maxLevelReached + 1` did not come
 * from this progression.
 *
 * It is what the Challenge 250 epoch reset needed and did not have. The reset
 * wiped stats, checkpoints and power-ups but the in-progress save is a
 * separate storage family it never reached, so a pre-reset game sat in the
 * slot at its old-ladder level and the very same init that ran the reset
 * resumed it, the checkpoint modal offering "Resume Game · Level 100" to a
 * player the reset had just put back at Level 1. Winning it re-stamped
 * `maxLevelReached` and pushed it into the epoch-matched cloud node, which
 * every device then adopts and no later reset can undo (issue #239).
 *
 * Written as an invariant rather than an epoch check because it also holds
 * for saves written BEFORE any epoch stamp existed (every save in the wild
 * today), works cross-device, and destroys nothing legitimate: a real
 * in-progress game always satisfies it.
 *
 * @param {{currentLevel?: number}} gs the parsed save
 * @param {number} [maxLevelReached] the player's highest won level
 * @returns {boolean}
 */
export function challengeSaveIsCurrent(gs, maxLevelReached) {
  if (!gs) return false;
  // Unknown progression (an old caller that passes nothing) can't judge, so
  // it doesn't: the check is a refusal of provable staleness, never a
  // requirement that the caller supply evidence.
  if (!Number.isFinite(maxLevelReached)) return true;
  const level = Number(gs.currentLevel);
  if (!Number.isFinite(level)) return true;
  return level <= Math.max(1, maxLevelReached) + 1;
}

/**
 * Decide whether a persisted save may be resumed.
 *
 * @param {object|null} gs - the parsed save (loadGameState result)
 * @param {object} ctx
 *   mode             - the mode slot the save was loaded from
 *   today            - current ET date string (getLocalDateString())
 *   weekStart        - current ET week anchor (getWeekStart())
 *   weekDayIndex     - current ET week day 0-6 (getWeekDayIndex())
 *   isDailyPractice  - live practice flag (?seed= deep link)
 *   practiceSeed     - the practice seed when isDailyPractice
 *   canonicalDate    - date of the cached canonical daily board, if any
 *   canonicalRngSeed - rngSeed of the cached canonical daily board, if any
 *   canonicalWeek         - weekStart of the cached canonical weekly board, if any
 *   canonicalWeeklyRngSeed - rngSeed of that weekly board, if any
 *   maxLevelReached  - highest challenge level won (challengeSaveIsCurrent)
 * @returns {boolean}
 */
export function isSaveResumable(gs, ctx) {
  if (!gs || !gs.board || !gs.gameMode) return false;

  // A save whose own gameMode disagrees with the slot it was loaded
  // from is a cross-mode write (the pre-fix handlers could stamp a new
  // mode onto an old game's snapshot). Never resume it into either mode.
  if (ctx.mode && gs.gameMode !== ctx.mode) return false;

  if (gs.gameMode === 'daily') {
    // A daily save without its full seed identity is unverifiable, it
    // can't be checked against today's date or the canonical board, so
    // it must never resume. Saves like this exist in the wild: the
    // pre-fix Daily card handler nulled the live seeds before
    // switchMode persisted the outgoing game, stripping the very
    // fingerprint this check needs.
    if (!gs.dailySeed || !gs.dailyRngSeed) return false;

    // Date anchor. A practice daily (?seed=) belongs to its custom
    // seed; an official daily belongs to today's ET date.
    const expectedSeed = ctx.isDailyPractice ? ctx.practiceSeed : ctx.today;
    if (gs.dailySeed !== expectedSeed) return false;

    // Divergent-canonical check: if the save was generated against a
    // different `:trialN` seed than the canonical board on Firebase,
    // discard it and let newGame() pull the canonical. Without this, a
    // player whose previous load lost a Firebase race (and silently
    // fell through to local generation) would keep playing the wrong
    // board on every return visit until they manually cleared their
    // cache. Kate hit exactly this scenario on 2026-05-06, saved
    // trial3 in her browser even though canonical was trial5.
    if (ctx.canonicalRngSeed
        && ctx.canonicalDate === gs.dailySeed
        && ctx.canonicalRngSeed !== gs.dailyRngSeed) {
      return false;
    }
  }

  if (gs.gameMode === 'weekly') {
    // Same shape as daily: full identity required (a save missing its
    // weeklyRngSeed never came from the weekly branch's real board),
    // and the attempt anchor must match the live ET clock. A new ET
    // day means a fresh attempt; a new ISO week means a new board.
    if (gs.weeklySeed == null || gs.weeklyDay == null || !gs.weeklyRngSeed) return false;
    if (gs.weeklySeed !== ctx.weekStart) return false;
    if (gs.weeklyDay !== ctx.weekDayIndex) return false;

    // Divergent-canonical check, the exact counterpart of the daily's above.
    // The weekly branch required weeklyRngSeed only to be TRUTHY, which proves
    // the save came from the weekly path and nothing about WHICH board it came
    // from. So a save generated locally against a missed canonical resumed
    // happily on every return visit, the Kate-on-trial3 scenario the daily
    // check exists to stop, on the mode where it costs more: a weekly attempt
    // is one of seven, committed on first click, and the whole week's
    // leaderboard is one board.
    if (ctx.canonicalWeeklyRngSeed
        && ctx.canonicalWeek === gs.weeklySeed
        && ctx.canonicalWeeklyRngSeed !== gs.weeklyRngSeed) {
      return false;
    }
  }

  if (gs.gameMode === 'normal' && !challengeSaveIsCurrent(gs, ctx.maxLevelReached)) {
    return false;
  }

  // A Challenge match resumes only with its whole match structure intact:
  // the dealt entries ARE the match (a resume that re-dealt would hand the
  // player different boards mid-match, and next PR different boards from
  // the opponent's), and the board index has to point inside them. A save
  // missing any of that is refused rather than half-restored, the same
  // shape the daily's seed-identity rule takes.
  if (gs.gameMode === 'match') {
    const m = gs.match;
    if (!m || !m.rules || !Array.isArray(m.entries) || m.entries.length === 0) return false;
    if (!Number.isInteger(m.current) || m.current < 0 || m.current >= m.entries.length) return false;
  }

  // Cells corrupted by the v1.5.19 canonical-board deserializer bug
  // (cells without row/col) make an unplayable board where reveal
  // cascades never visually update, reject so newGame() refetches
  // with the fixed deserializer.
  if (Array.isArray(gs.board) && gs.board[0] && gs.board[0][0]) {
    const c0 = gs.board[0][0];
    if (typeof c0.row !== 'number' || typeof c0.col !== 'number') return false;
  }

  // A save carrying an explicit topology (a Coastline tiling board) is only
  // resumable if that topology still validates, right length, in range,
  // symmetric. A truncated or corrupt edge list would restore a board whose
  // adjacency disagrees with the one it was certified under, which breaks the
  // no-guess promise silently rather than loudly. Drop it and let newGame()
  // rebuild. Ordinary rectangular saves carry no such field and skip this.
  if (gs.cellNeighbors != null) {
    if (!isValidCellNeighbors(gs.rows, gs.cols, gs.cellNeighbors)) {
      return false;
    }
    // An explicit topology without the GEOMETRY to draw it is the issue-#189
    // shape: the graph restores but _cellPos is the renderer's own test for
    // "is this a tiling board", so the hexagons would come back as a
    // rectangular CSS grid whose hit-testing is not the board. A pre-fix save
    // (topology only) is refused rather than half-restored; no such save can
    // exist in the wild, coastline runs never persist, so this rejects
    // corruption, not history.
    if (!Array.isArray(gs.cellPos) || gs.cellPos.length !== gs.rows * gs.cols) {
      return false;
    }
    const t = gs.tiling;
    if (!t || typeof t.type !== 'string'
        || !Number.isFinite(t.M) || !Number.isFinite(t.N)) {
      return false;
    }
  }

  return true;
}

/**
 * What tapping the Weekly card (or following a `?mode=weekly` link) should do.
 *
 *   'fresh'   - no attempt used today, start this day's attempt
 *   'resume'  - today's attempt is already committed and its board is still
 *               open, so reopen it
 *   'blocked', today's attempt is spent and finished; come back tomorrow
 *
 * The gate used to collapse the last two: the attempt is committed on the
 * FIRST CLICK (so a mine-hit-then-restart cannot buy a second one), and the
 * card refused entry on that same marker before `switchMode('weekly')` could
 * run. Since that is the only production door into weekly mode, the resume
 * branch behind it was unreachable, one Home tap mid-attempt and the board
 * was gone for good, with the day's cloud-recorded attempt spent on a puzzle
 * the player never finished (issue #246). Refusing a SECOND attempt is the
 * rule; resuming the first is not a second attempt.
 *
 * A finished attempt reports `resumable: false` because winning clears the
 * slot, the same signal every other mode uses to stop re-offering a game it
 * has already ended.
 *
 * @param {{attempted?: boolean, resumable?: boolean}} [ctx]
 * @returns {'fresh'|'resume'|'blocked'}
 */
export function weeklyEntryPlan(ctx) {
  const { attempted, resumable } = ctx || {};
  if (!attempted) return 'fresh';
  return resumable ? 'resume' : 'blocked';
}

/**
 * Decide whether a LIVE (in-memory) game has expired because its date
 * anchor no longer matches the ET clock, i.e. the session slept
 * through midnight. Only daily (non-practice) and weekly games are
 * date-anchored; challenge, timed, and chaos sessions never expire.
 * Only resumable statuses can expire: a finished game is history, not
 * an in-progress attempt.
 *
 * @param {object} live  - {gameMode, status, isDailyPractice, dailySeed, weeklySeed, weeklyDay}
 * @param {object} clock - {today, weekStart, weekDayIndex}
 * @returns {boolean}
 */
export function isLiveGameExpired(live, clock) {
  if (live.status !== 'playing' && live.status !== 'idle') return false;
  // An ARCHIVE replay is anchored to a past date on purpose, so the clock can
  // never invalidate it: expiry exists to stop yesterday's unfinished attempt
  // resurrecting as today's, and a replay is not an attempt at anything. Left
  // in, backgrounding the tab and returning would expire the board mid-play
  // and toast the player about a new day they were not waiting for.
  if (live.isArchivePlay || live.isWeeklyArchive) return false;
  if (live.gameMode === 'daily' && !live.isDailyPractice && live.dailySeed) {
    return live.dailySeed !== clock.today;
  }
  if (live.gameMode === 'weekly' && live.weeklySeed != null) {
    return live.weeklySeed !== clock.weekStart || live.weeklyDay !== clock.weekDayIndex;
  }
  return false;
}

/**
 * Decide whether the in-memory weekly-attempt cache
 * (state.cachedWeeklyDayAttempts) has gone stale because the ET week
 * rolled over while a long-lived session stayed open.
 *
 * The cache is seeded ONCE at boot for that day's week and never
 * re-derived afterward. A tab or installed PWA left open across the
 * Sunday→Monday boundary therefore keeps the PREVIOUS week's attempts
 * in memory, so the Weekly card reports "Done N/7" and the play gate
 * refuses a fresh attempt on a week that has in fact reset, the weekly
 * "didn't reset" symptom. Returns true when the cache must be reloaded
 * for `liveWeek`. A null/empty liveWeek (date helper unavailable) is
 * never treated as a rollover.
 *
 * @param {string|null|undefined} cachedWeek - weekStart the cache was loaded for
 * @param {string} liveWeek - the current ET weekStart (getWeekStart())
 * @returns {boolean}
 */
export function isWeeklyAttemptCacheStale(cachedWeek, liveWeek) {
  if (!liveWeek) return false;
  return cachedWeek !== liveWeek;
}
