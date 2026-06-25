// ── The Receipt: post-loss proof surfaces ──────────────
// When a game ends (loss, or post-strike inspection), the engine opens
// its books: the full deducible frontier is painted on the board, and
// the player can tap ANY unrevealed cell to ask "was this knowable?" —
// the answer pulses the constraint region that proves it. Everything
// here reads the FLAGS-BLIND frontier (player flags are claims, not
// facts; one wrong flag must never make the receipt lie).
//
// Voice rule: receipts describe the BOARD's proof ("this was provably
// safe — the proof lived here"), never narrate the player's reasoning.

import { state, recordHintEvent } from '../state/gameState.js';
import { boardEl } from './domHelpers.js';
import { findDeducibleFrontier, detectWrongFlags } from '../logic/boardSolver.js';
import { explainDeduction } from '../logic/proofExplainer.js';
import { showToast } from './toastManager.js';
import { showBoardCoach } from './boardCoach.js';
import { reportCaughtError } from '../diagnostics/errorReporter.js';

let _frontier = null; // { safe: [...], mines: [...], contradiction } at death
let _pulseTimer = null;

// Compute and paint the loss receipt. Called by handleLoss BEFORE the
// mine cascade mutates revealed state. Returns the frontier so the
// caller can build its verdict line.
export function prepareLossReceipt() {
  _frontier = findDeducibleFrontier(state.board, { respectFlags: false });
  // Precompute the plain-language explanation for every frontier entry
  // NOW, against the board as the player saw it at death. The loss
  // cascade is about to reveal every mine, which would inflate the
  // "known mines" counts and make the sentences claim knowledge the
  // player never had.
  for (const s of _frontier.safe) {
    s.why = explainDeduction(state.board, s, { style: 'full', kind: 'safe' });
    const cell = state.board[s.row]?.[s.col];
    if (cell) cell.frontierSafe = true;
  }
  for (const m of _frontier.mines) {
    m.why = explainDeduction(state.board, m, { style: 'full', kind: 'mine' });
  }
  return _frontier;
}

export function clearReceipt() {
  _frontier = null;
  if (_pulseTimer) { clearTimeout(_pulseTimer); _pulseTimer = null; }
}

function _cellEl(row, col) {
  return boardEl.children[row * state.cols + col] || null;
}

function _pulseSources(sources) {
  if (_pulseTimer) clearTimeout(_pulseTimer);
  const els = [];
  for (const s of sources) {
    const el = _cellEl(s.row, s.col);
    if (el) { el.classList.add('receipt-source-pulse'); els.push(el); }
  }
  _pulseTimer = setTimeout(() => {
    for (const el of els) el.classList.remove('receipt-source-pulse');
    _pulseTimer = null;
  }, 2600);
}

// Tap-to-interrogate: in the post-loss explore view, answer "was this
// cell knowable at the time of death?" for any unrevealed cell.
// Returns true when the tap was consumed (caller skips other handling).
export function handleInterrogateTap(row, col) {
  if (state.status !== 'lost' || !_frontier) return false;
  const cell = state.board[row]?.[col];
  if (!cell) return false;
  // Revealed-at-death cells aren't part of the question.
  if (cell.isRevealed && !cell.isMine) return false;

  const safeHit = _frontier.safe.find(s => s.row === row && s.col === col);
  const mineHit = _frontier.mines.find(m => m.row === row && m.col === col);
  if (safeHit) {
    showToast(`This was knowable. ${safeHit.why || 'The highlighted clues settle it.'}`, 4200, 'uiSuccess');
    _pulseSources(safeHit.sources);
  } else if (mineHit) {
    showToast(`This mine was catchable. ${mineHit.why || 'The highlighted clues pin it down.'}`, 4200, 'mine');
    _pulseSources(mineHit.sources);
  } else {
    showToast('Not knowable at that point. The numbers had not reached this square yet', 2800, 'uiUnknown');
  }
  return true;
}

// ── The Lens: Socratic mid-game help ───────────────────
// Three honest answers, in priority order, none of which ever names the
// safe cell:
//   1. "One of your flags is wrong" — the most common true cause of a
//      stuck player, detected by the dual-solve diff. Deliberately not
//      localized (saying WHICH flag would solve a chunk of the board).
//   2. Pulse the proving region of the first available deduction, sized
//      honestly by tier: a single satisfied constraint for Pass A, the
//      constraint set for subsets, the whole component for enumeration
//      (and the copy SAYS it needs enumeration — that teaches what tank
//      reasoning is).
//   3. "No safe move exists" is impossible by construction on an
//      official board — if the frontier ever comes back empty we say so
//      honestly and report it, because it means something broke.
// Every invocation is recorded into state.hintEvents: hints change
// completion times, and the nightly par fit must be able to exclude
// hinted plays or the Lens quietly corrupts the model.
export function handleLensRequest() {
  if (state.status !== 'playing') {
    showToast('The lens works mid-game. Start revealing first', 2200, 'uiLens');
    return;
  }
  try {
    const flagCheck = detectWrongFlags(state.board);
    if (flagCheck.wrongFlags.length > 0 || flagCheck.contradiction) {
      recordHintEvent('flag-warning');
      showBoardCoach('One of your flags does not add up: a number near it cannot be satisfied. Re-check your flags first.', 'flag');
      return;
    }
    const frontier = findDeducibleFrontier(state.board, { respectFlags: false });
    // Teach the SIMPLEST available step, not the first-found one: pick
    // the lowest-tier deduction across safes and mines (tie → safe).
    // Without this, a board with a plain 1-1 available could hint the
    // whole-region enumeration instead.
    const lowest = (list) => list.reduce((best, d) => (!best || d.tier < best.tier ? d : best), null);
    const bestSafe = lowest(frontier.safe.filter(s => !state.board[s.row][s.col].isFlagged))
      || lowest(frontier.safe);
    const bestMine = lowest(frontier.mines);
    const next = bestSafe && bestMine
      ? (bestSafe.tier <= bestMine.tier ? bestSafe : bestMine)
      : (bestSafe || bestMine);
    if (!next) {
      // An empty frontier is NOT broken-board evidence by itself: the
      // no-guess certificate runs from the marked start cell, and a
      // player who first-clicked elsewhere can legitimately sit in a
      // proof-free state (measured: most off-path first clicks do).
      // Three honest answers:
      //  1. The marked start is still fogged → point back to the
      //     contract's entry. Not a spoiler — the game itself marked
      //     that cell at the start.
      //  2. Daily/weekly with the start already revealed → genuinely
      //     impossible by information monotonicity; report it.
      //  3. Challenge/timed → the player may have gambled past the
      //     proof chain; say so plainly, no false alarm.
      let startCell = null;
      if (state.gameMode === 'daily' || state.gameMode === 'weekly') {
        outer: for (let r = 0; r < state.rows; r++) {
          for (let c = 0; c < state.cols; c++) {
            if (state.board[r][c].suggestedStart && !state.board[r][c].isRevealed) {
              startCell = { row: r, col: c };
              break outer;
            }
          }
        }
      }
      if (startCell) {
        recordHintEvent('region');
        _pulseSources([startCell]);
        showBoardCoach('Nothing can be worked out from here yet. The highlighted square is the guaranteed safe start, so begin there.', 'uiLens');
      } else if (state.gameMode === 'daily' || state.gameMode === 'weekly') {
        showBoardCoach('Nothing can be worked out from here. That should not happen on this board', 'uiLens');
        reportCaughtError('lens-empty-frontier', new Error(`mode=${state.gameMode} seed=${state.dailyRngSeed || ''}`));
      } else {
        showBoardCoach('Nothing can be worked out from this position. The provable path runs through squares you have not opened yet', 'uiLens');
      }
      return;
    }
    recordHintEvent('region');
    _pulseSources(next.sources);
    const isMineDeduction = next === bestMine && next !== bestSafe;
    const ask = explainDeduction(state.board, next, {
      style: 'socratic',
      kind: isMineDeduction ? 'mine' : 'safe',
    });
    showBoardCoach(`${ask || 'The highlighted clues hold the next step. Compare what they claim.'}`, 'uiLens');
  } catch (err) {
    reportCaughtError('lens-request', err);
  }
}

// One-line verdict for a struck mine (daily/weekly bomb hits). Computed
// from the pre-strike board state the caller passes in. The three
// honest answers, strongest first:
//   - the struck cell itself was provably a mine,
//   - it wasn't provable, but provably safe moves existed elsewhere,
//   - nothing was provable: the player was genuinely at the frontier.
export function bombStrikeVerdict(board, strikeRow, strikeCol) {
  const f = findDeducibleFrontier(board, { respectFlags: false });
  if (f.mines.some(m => m.row === strikeRow && m.col === strikeCol)) {
    return { text: 'The numbers around this square already pinned it as a mine', avoidable: true };
  }
  if (f.safe.length > 0) {
    const n = f.safe.length;
    return { text: `This one was not knowable, but ${n} safe square${n !== 1 ? 's were' : ' was'} still findable elsewhere`, avoidable: true };
  }
  // Nothing was knowable from the squares the player had open. On a
  // certified board that NEVER means a forced 50/50: the knowable path
  // exists from the marked start and stays available. The honest read
  // is that the player moved past it, so the copy must not absolve the
  // click as "a fair gamble".
  return { text: 'Nothing you had open could settle this square. The knowable path was elsewhere on the board', avoidable: false };
}
