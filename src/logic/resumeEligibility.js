// Resume-eligibility rules for persisted saves and live sessions.
//
// Daily and weekly games are DATE-ANCHORED: a daily belongs to one ET
// date, a weekly attempt to one (weekStart, dayIndex) pair. Crossing
// midnight ET forfeits an unfinished attempt — the player gets the new
// day's puzzle, never a resurrected stale one. These helpers are the
// single source of truth for "is this game still current?", used by
// tryResumeGame (persisted saves) and the visibility-wake check in
// main.js (live sessions that slept through midnight in a background
// tab or suspended PWA).
//
// Everything here anchors to CLOCK values passed in via ctx, never to
// live state fields like state.dailySeed: a session that survived
// midnight still carries yesterday's date in state, and trusting it is
// how yesterday's unfinished daily once resurrected as "today's"
// puzzle. Pure functions — node-tested in test/resumeEligibility.test.mjs.

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
 * @returns {boolean}
 */
export function isSaveResumable(gs, ctx) {
  if (!gs || !gs.board || !gs.gameMode) return false;

  // A save whose own gameMode disagrees with the slot it was loaded
  // from is a cross-mode write (the pre-fix handlers could stamp a new
  // mode onto an old game's snapshot). Never resume it into either mode.
  if (ctx.mode && gs.gameMode !== ctx.mode) return false;

  if (gs.gameMode === 'daily') {
    // A daily save without its full seed identity is unverifiable — it
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
    // cache. Kate hit exactly this scenario on 2026-05-06 — saved
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
  }

  // Cells corrupted by the v1.5.19 canonical-board deserializer bug
  // (cells without row/col) make an unplayable board where reveal
  // cascades never visually update — reject so newGame() refetches
  // with the fixed deserializer.
  if (Array.isArray(gs.board) && gs.board[0] && gs.board[0][0]) {
    const c0 = gs.board[0][0];
    if (typeof c0.row !== 'number' || typeof c0.col !== 'number') return false;
  }

  return true;
}

/**
 * Decide whether a LIVE (in-memory) game has expired because its date
 * anchor no longer matches the ET clock — i.e. the session slept
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
 * refuses a fresh attempt on a week that has in fact reset — the weekly
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
