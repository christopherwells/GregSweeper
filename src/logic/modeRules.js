// Cross-surface mode rules (pure, node-tested).
//
// Daily and weekly are canonical single-puzzle modes: every player on the
// date plays the same frozen board, and the clock is the score. A manual
// restart (smiley, keyboard shortcut, or any future entry point) would hand
// the player a fresh clock on a board they have already seen, a leaderboard
// cheat. The smiley button always guarded this; the R keyboard shortcut did
// not (2026-07-10 audit), so the rule now lives here and every restart
// surface asks the same function.

/**
 * True when the mode forbids manually restarting the current board.
 * @param {string} gameMode state.gameMode
 */
export function blocksManualRestart(gameMode) {
  return gameMode === 'daily' || gameMode === 'weekly';
}
