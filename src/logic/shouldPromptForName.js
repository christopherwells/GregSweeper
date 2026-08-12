// Name-gate decision (pure).
//
// A player used to be able to finish a daily / weekly / timed game without
// ever giving a leaderboard name: the daily win card showed an OPTIONAL inline
// name form that sat next to a Done button (dismissible, and its submit never
// even persisted the name to Settings), weekly showed no prompt at all and
// silently dropped a nameless win, and timed posted nameless wins as
// "Anonymous". This helper decides, before the end card renders, whether we
// must block for a name first.
//
// Extracted so the gate condition is node-testable without the DOM (the win
// flow lives in DOM-coupled winLossHandler.js). Consumed by
// src/ui/nameCapture.js's ensureLeaderboardName.
//
// Prompt ONLY for the modes that put a name in front of other people, and only
// when no usable name is saved. Archive replays and practice dailies are
// excluded (they don't post to the day-of leaderboard).
//
// MATCH joined the set when the match node shipped. PR 3 left a solo match
// deliberately ungated on the reasoning that it submitted nothing anywhere;
// both halves of that reasoning are now false. A match board files a par-fit
// row under the player's name, and a shared match shows that name in the
// standings every other player is watching. The gate fires at most once per
// player: the first match board a nameless player clears, after which the name
// is saved and every later mode finds it.
//
// NOT gated on the test environment: the gate is a real UX element that must be
// reviewable on the /test/ build, and it stays harmless there (submissions are
// short-circuited downstream, and publishPlayerName no-ops in test env). No
// automated e2e spec wins a game, so the modal never blocks CI; a future
// win-journey spec would seed a player name (as a returning player has one).

const GATED_MODES = new Set(['daily', 'weekly', 'match']);

/**
 * @param {Object} args
 * @param {string} args.mode        state.gameMode
 * @param {string} args.savedName   getPlayerName(), '' when unset
 * @param {boolean} [args.isArchive] state.isArchivePlay
 * @param {boolean} [args.isPractice] state.isDailyPractice
 * @returns {boolean} true when the player must be prompted for a name first
 */
export function shouldPromptForName({ mode, savedName, isArchive = false, isPractice = false }) {
  if (isArchive || isPractice) return false;
  if (!GATED_MODES.has(mode)) return false;
  return !(savedName && String(savedName).trim());
}
