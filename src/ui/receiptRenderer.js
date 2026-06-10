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

import { state } from '../state/gameState.js';
import { boardEl } from './domHelpers.js';
import { findDeducibleFrontier } from '../logic/boardSolver.js';
import { showToast } from './toastManager.js';

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
