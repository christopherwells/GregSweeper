// Deal a Climb board from the pre-generated library.
//
// The library (scripts/data/climb-library/, one JSON per level, built and
// re-binned offline) is why a Climb level no longer generates under the
// player's click: a dealt board was selected hardest-of-many offline, so
// the 2-second budget and the take-first-that-certifies softness are both
// gone, and a deal cannot exhaust the way a draw can (issue #286's whole
// class). The drawn path stays as the fallback behind this, guarded by the
// abort contract (issue #285).
//
// Trust is re-established at the point of play: the payload re-certifies
// from its stored opener before it is dealt (milliseconds; generation's
// cost was always the rejected candidates, never one clean solve), so a
// corrupt or tampered file degrades to the drawn fallback rather than
// shipping an unverified board. Same posture as the daily's canonical
// gate, scaled to a same-origin static file.
//
// Seen-tracking is his cycle rule (pickFromBin), marked ON DEAL so a death
// still counts as having seen the layout, and never marked in practice:
// ?level= runs share this origin's localStorage with production, the same
// reason practice records nothing else.

import { state } from '../state/gameState.js';
import { deserializeBoard } from '../firebase/dailyBoardSync.js';
import { isBoardSolvable } from '../logic/boardSolver.js';
import { levelHasLibrary, levelFileUrl, pickFromBin } from '../logic/climbLibrary.js';
import { getClimbSeen, setClimbSeen } from '../storage/statsStorage.js';
import { reportCaughtError } from '../diagnostics/errorReporter.js';

// Bounded like every other await on a board path (the boot-hang lesson):
// a half-open socket must cost five seconds and fall back to the drawn
// path, never strand the level behind a fetch that will not settle.
const LIBRARY_FETCH_TIMEOUT_MS = 5000;

export { levelHasLibrary };

/**
 * Fetch the level's bin, pick under the seen-cycle, verify, and return the
 * same shape the drawn path's builder returns (so the install code cannot
 * tell them apart). Null on ANY failure; the caller falls back to drawing.
 */
export async function dealClimbBoard(level) {
  if (!levelHasLibrary(level)) return null;

  let bin = null;
  try {
    const res = await Promise.race([
      fetch(levelFileUrl(level)),
      new Promise((resolve) => setTimeout(() => resolve(null), LIBRARY_FETCH_TIMEOUT_MS)),
    ]);
    if (!res || !res.ok) return null;
    bin = await res.json();
  } catch {
    return null;
  }
  if (!bin || bin.level !== level || !Array.isArray(bin.boards) || bin.boards.length === 0) {
    return null;
  }

  // Test-env override for deterministic e2e venues: ?level=N&board=I picks
  // bin index I instead of rolling. Practice-lane-only by construction,
  // main.js stamps it beside isLevelPractice and nothing else sets it.
  let pick = null;
  let cycled = false;
  const forced = state.climbBoardIndex;
  if (state.isLevelPractice && Number.isInteger(forced) && bin.boards[forced]) {
    pick = bin.boards[forced];
  } else {
    const seen = getClimbSeen(level);
    ({ pick, cycled } = pickFromBin(bin.boards, seen, Math.random));
  }
  if (!pick || !pick.payload) return null;

  let d = null;
  let check = null;
  try {
    d = deserializeBoard(pick.payload);
    const fc = d.firstClick;
    check = isBoardSolvable(d.board, d.rows, d.cols, Math.floor(fc / d.cols), fc % d.cols);
  } catch (err) {
    reportCaughtError('climb-deal-verify', err);
    return null;
  }
  if (!check || !check.solvable || check.remainingUnknowns !== 0) {
    reportCaughtError('climb-deal-verify',
      new Error(`L${level} ${pick.seed}: stored board does not re-certify`));
    return null;
  }

  if (!state.isLevelPractice) {
    const seen = getClimbSeen(level);
    setClimbSeen(level, cycled ? [pick.seed] : [...seen, pick.seed]);
  }

  return {
    board: d.board,
    rows: d.rows,
    cols: d.cols,
    totalMines: d.totalMines,
    activeGimmicks: d.activeGimmicks || [],
    applied: {},
    firstClick: d.firstClick,
    check,
    features: pick.features || null,
    par: pick.par || 0,
    seed: pick.seed,
    spec: pick.spec || null,
  };
}
