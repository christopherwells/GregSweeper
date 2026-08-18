// Deal a Climb board from the pre-generated library.
//
// The library (scripts/data/climb-library/, one JSON per ladder level plus
// the sharded endless pages, built and re-binned offline) is why a Climb
// level no longer generates under the player's click: a dealt board was
// selected hardest-of-many offline, so the 2-second budget and the
// take-first-that-certifies softness are both gone, and a deal cannot
// exhaust the way a draw can (issue #286's whole class). The drawn path
// stays as the fallback behind this, guarded by the abort contract (issue
// #285).
//
// Trust is re-established at the point of play: the payload re-certifies
// from its stored opener before it is dealt (milliseconds; generation's
// cost was always the rejected candidates, never one clean solve), so a
// corrupt or tampered file degrades to the drawn fallback rather than
// shipping an unverified board. Same posture as the daily's canonical
// gate, scaled to a same-origin static file.
//
// Seen-tracking is his cycle rule (pickFromBin per ladder bin; one GLOBAL
// cycle across the endless library), marked ON DEAL so a death still
// counts as having seen the layout, and never marked in practice: ?level=
// runs share this origin's localStorage with production, the same reason
// practice records nothing else.
//
// The fetch + verify core (fetchLibraryJson / certifyStoredBoard) is
// deliberately exposed: the head-to-head Challenge mode's match deal draws
// its 1-10 boards through exactly this machinery.

import { state } from '../state/gameState.js';
import { deserializeBoard } from '../firebase/dailyBoardSync.js';
import { isBoardSolvable } from '../logic/boardSolver.js';
import { recalcAllAdjacency, recomputeDisplayedMines } from '../logic/gimmicks.js';
import {
  levelHasLibrary, levelHasEndlessLibrary, levelFileUrl,
  endlessIndexUrl, endlessPageUrl, pickFromBin, pickEndlessPage, endlessGlobalIndex,
} from '../logic/climbLibrary.js';
import {
  getClimbSeen, setClimbSeen, getEndlessSeen, setEndlessSeen,
} from '../storage/statsStorage.js';
import { reportCaughtError } from '../diagnostics/errorReporter.js';

// Bounded like every other await on a board path (the boot-hang lesson):
// a half-open socket must cost five seconds and fall back to the drawn
// path, never strand the level behind a fetch that will not settle.
const LIBRARY_FETCH_TIMEOUT_MS = 5000;

export { levelHasLibrary, levelHasEndlessLibrary };

/** Bounded fetch of a library JSON. Null on ANY failure, never a throw. */
export async function fetchLibraryJson(url) {
  try {
    const res = await Promise.race([
      fetch(url),
      new Promise((resolve) => setTimeout(() => resolve(null), LIBRARY_FETCH_TIMEOUT_MS)),
    ]);
    if (!res || !res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Re-certify a stored board from its own opener and return the install
 * shape the drawn path's builder returns (so the install code cannot tell
 * a deal from a draw). Null on any failure: a tampered or corrupt payload
 * must degrade, never install.
 */
export function certifyStoredBoard(pick, where) {
  if (!pick || !pick.payload) return null;
  let d = null;
  let check = null;
  try {
    d = deserializeBoard(pick.payload);
    const fc = d.firstClick;
    // GROUND-TRUTH AUDIT FIRST, the nightly sweep's own checks scaled to
    // one board: the certification below re-runs the no-guess PROOF, and a
    // proof reasons from the stored numbers, so a corrupt board whose
    // numbers disagree with its mines can walk straight through it (a
    // revealed mine reads adjacentMines 0, exactly what a zero cell reads).
    // the mine count must match, the opener must not be a mine, and
    // recomputing both number layers must reproduce the stored values.
    let mines = 0;
    for (const row of d.board) for (const cell of row) { if (cell.isMine) mines++; }
    if (mines !== d.totalMines) throw new Error(`${mines} mines against totalMines ${d.totalMines}`);
    if (d.board[Math.floor(fc / d.cols)][fc % d.cols].isMine) throw new Error('opener is a mine');
    const stored = d.board.flat().map((c) => [c.adjacentMines, c.displayedMines]);
    recalcAllAdjacency(d.board);
    recomputeDisplayedMines(d.board);
    const flat = d.board.flat();
    for (let i = 0; i < flat.length; i++) {
      if (flat[i].adjacentMines !== stored[i][0] || flat[i].displayedMines !== stored[i][1]) {
        throw new Error(`cell ${i}: stored numbers do not describe the stored mines`);
      }
    }
    check = isBoardSolvable(d.board, d.rows, d.cols, Math.floor(fc / d.cols), fc % d.cols);
  } catch (err) {
    reportCaughtError('climb-deal-verify', err);
    return null;
  }
  if (!check || !check.solvable || check.remainingUnknowns !== 0) {
    reportCaughtError('climb-deal-verify',
      new Error(`${where} ${pick.seed}: stored board does not re-certify`));
    return null;
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
    // Carried, not dropped: past a shape's fit ceiling the stored par is an
    // ANCHORED number and re-pricing it through predictPar here produces the
    // extrapolation the lane exists to avoid (a 178-minute par on an
    // 11-minute honeycomb board, his report 2026-08-18). The consumer needs
    // to know which kind of price it is holding.
    parProvisional: pick.parProvisional === true,
    seed: pick.seed,
    spec: pick.spec || null,
  };
}

/**
 * Fetch the level's bin, pick under the seen-cycle, verify, and return the
 * install shape. Null on ANY failure; the caller falls back to drawing.
 * Levels past the crown route to the endless library's global deal.
 */
export async function dealClimbBoard(level) {
  if (levelHasEndlessLibrary(level)) return dealEndlessBoard(level);
  if (!levelHasLibrary(level)) return null;

  const bin = await fetchLibraryJson(levelFileUrl(level));
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

  const res = certifyStoredBoard(pick, `L${level}`);
  if (!res) return null;

  if (!state.isLevelPractice) {
    const seen = getClimbSeen(level);
    setClimbSeen(level, cycled ? [res.seed] : [...seen, res.seed]);
  }
  return res;
}

/**
 * The endless deal: one small index, one page, one board, a random unseen
 * pick across the WHOLE library (the page is weighted by its unseen count,
 * so the deal is uniform over unseen boards), under one global seen-cycle
 * that resets only when everything has been met. The level number plays no
 * part in which board comes up: past the crown the zone's job is variety,
 * and every board out here already clears the 400s floor.
 */
export async function dealEndlessBoard(level) {
  const index = await fetchLibraryJson(endlessIndexUrl());
  if (!index || !Array.isArray(index.counts) || index.counts.length === 0) return null;

  // Deterministic e2e/practice venue: ?level=251&board=I resolves a GLOBAL
  // board index through the index's counts.
  const forced = state.climbBoardIndex;
  if (state.isLevelPractice && Number.isInteger(forced)) {
    const at = endlessGlobalIndex(index.counts, forced);
    if (!at) return null;
    const page = await fetchLibraryJson(endlessPageUrl(at.page));
    if (!page || !Array.isArray(page.boards)) return null;
    return certifyStoredBoard(page.boards[at.idx], `endless p${at.page}#${at.idx}`);
  }

  let seenMap = getEndlessSeen();
  const { page: pageNo, cycled } = pickEndlessPage(index.counts, seenMap, Math.random);
  if (pageNo == null) return null;
  if (cycled) seenMap = {};   // his rule: all seen, back to 1

  const page = await fetchLibraryJson(endlessPageUrl(pageNo));
  if (!page || page.page !== pageNo || !Array.isArray(page.boards) || page.boards.length === 0) {
    return null;
  }

  const seenHere = Array.isArray(seenMap[String(pageNo)]) ? seenMap[String(pageNo)] : [];
  const { pick, cycled: pageCycled } = pickFromBin(page.boards, seenHere, Math.random);
  const res = certifyStoredBoard(pick, `endless L${level} p${pageNo}`);
  if (!res) return null;

  if (!state.isLevelPractice) {
    seenMap[String(pageNo)] = pageCycled ? [res.seed] : [...seenHere, res.seed];
    setEndlessSeen(seenMap);
  }
  return res;
}
