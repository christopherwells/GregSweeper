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
import { showToast } from './toastManager.js';
import { reportCaughtError } from '../diagnostics/errorReporter.js';

let _frontier = null; // { safe: [...], mines: [...], contradiction } at death
let _pulseTimer = null;

// Compute and paint the loss receipt. Called by handleLoss BEFORE the
// mine cascade mutates revealed state. Returns the frontier so the
// caller can build its verdict line.
export function prepareLossReceipt() {
  _frontier = findDeducibleFrontier(state.board, { respectFlags: false });
  for (const s of _frontier.safe) {
    const cell = state.board[s.row]?.[s.col];
    if (cell) cell.frontierSafe = true;
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
    showToast('✅ Provably safe — the proof lived in the highlighted cells', 2600);
    _pulseSources(safeHit.sources);
  } else if (mineHit) {
    showToast('💣 Provably a mine — the highlighted cells proved it', 2600);
    _pulseSources(mineHit.sources);
  } else {
    showToast('🤷 Not deducible at the time — no proof reached this cell', 2600);
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
    showToast('🔍 The lens works mid-game — start revealing first', 2200);
    return;
  }
  try {
    const flagCheck = detectWrongFlags(state.board);
    if (flagCheck.wrongFlags.length > 0 || flagCheck.contradiction) {
      recordHintEvent('flag-warning');
      showToast('🚩 One of your flags is provably wrong', 3000);
      return;
    }
    const frontier = findDeducibleFrontier(state.board, { respectFlags: false });
    const next = frontier.safe.find(s => !state.board[s.row][s.col].isFlagged)
      || frontier.safe[0]
      || frontier.mines[0];
    if (!next) {
      // Should be impossible on a generator-certified board.
      showToast('🤔 Nothing provable found — that should not happen on an official board', 3200);
      reportCaughtError('lens-empty-frontier', new Error(`mode=${state.gameMode} seed=${state.dailyRngSeed || ''}`));
      return;
    }
    recordHintEvent('region');
    _pulseSources(next.sources);
    if (next.tier === 0) {
      showToast('🔍 Look again at the highlighted clue — it is already satisfied', 3200);
    } else if (next.sources.length <= 3) {
      showToast('🔍 The proof lives in the highlighted cells — compare what they claim', 3200);
    } else {
      showToast('🔍 The answer is in the highlighted region — it needs enumeration; no small clue exists', 3600);
    }
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
    return { text: 'That mine was provable', avoidable: true };
  }
  if (f.safe.length > 0) {
    const n = f.safe.length;
    return { text: `${n} provably safe cell${n !== 1 ? 's' : ''} existed elsewhere`, avoidable: true };
  }
  return { text: 'You were at the frontier — nothing was provable yet', avoidable: false };
}
