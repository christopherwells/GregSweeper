// ── Greg's Gym (player-facing name; module keeps its original
// "lexicon" filename) — drills behind the deducibility click-gate.
// A lesson board where clicking a square the clues can't yet settle
// does nothing except point at the clues that hold the next step. The
// player cannot luck through — completing a drill means performing the
// technique, and the pattern is named only at the end. Flags are gated
// the same way: you can only flag a square the clues can settle as a
// MINE, so a flag is a worked deduction too, never a guess marker.
// Dynamically imported from the title-screen button; never touches game
// state, scores, or the par pipeline.

import { findDeducibleFrontier } from '../logic/boardSolver.js';
import { explainDeduction } from '../logic/proofExplainer.js';
import { LESSONS, generateLessonBoard, applyLessonOpening, lessonComplete } from '../logic/lexicon.js';
import { showToast } from './toastManager.js';

let _overlay = null;
let _lessonBoard = null;
let _lesson = null;
let _boardsDone = 0;
let _pulseTimer = null;
let _lpTimer = null;   // long-press flag timer (touch)
let _lpFired = false;  // swallow the click that follows a long-press

export function openLexicon() {
  _lesson = LESSONS.subset12;
  _boardsDone = 0;
  _buildOverlay();
  _nextBoard();
}

function _buildOverlay() {
  closeLexicon();
  _overlay = document.createElement('div');
  _overlay.id = 'lexicon-overlay';
  _overlay.innerHTML = `
    <div class="lexicon-card">
      <div class="lexicon-header">
        <span class="lexicon-title">🏋️ Greg's Gym</span>
        <button class="lexicon-close" aria-label="Close">&times;</button>
      </div>
      <p class="lexicon-instruction">Only squares the clues can settle will open — and flags only stick on squares the clues can settle as mines. Hold or right-click to flag. If anything bounces, watch where the board points.</p>
      <div class="lexicon-grid" role="grid"></div>
      <p class="lexicon-naming hidden"></p>
      <div class="lexicon-actions hidden">
        <button class="lexicon-another action-btn primary">Another</button>
        <button class="lexicon-done action-btn secondary">Done</button>
      </div>
    </div>`;
  document.body.appendChild(_overlay);
  _overlay.querySelector('.lexicon-close').addEventListener('click', closeLexicon);
  _overlay.querySelector('.lexicon-done').addEventListener('click', closeLexicon);
  _overlay.querySelector('.lexicon-another').addEventListener('click', _nextBoard);
  const grid = _overlay.querySelector('.lexicon-grid');
  grid.addEventListener('click', _onCellClick);
  // Flagging: right-click on desktop, long-press on touch. The pointer
  // timer sets _lpFired so the synthetic click that follows a long-press
  // is swallowed instead of triggering a reveal attempt.
  grid.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const el = e.target.closest('.lexicon-cell');
    if (el) _tryFlag(parseInt(el.dataset.row, 10), parseInt(el.dataset.col, 10));
  });
  grid.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.lexicon-cell');
    if (!el || e.pointerType === 'mouse') return;
    _lpTimer = setTimeout(() => {
      _lpFired = true;
      _tryFlag(parseInt(el.dataset.row, 10), parseInt(el.dataset.col, 10));
    }, 450);
  });
  const cancelLp = () => { if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; } };
  grid.addEventListener('pointerup', cancelLp);
  grid.addEventListener('pointerleave', cancelLp);
  grid.addEventListener('pointercancel', cancelLp);
}

export function closeLexicon() {
  if (_pulseTimer) { clearTimeout(_pulseTimer); _pulseTimer = null; }
  if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
  _lpFired = false;
  if (_overlay) { _overlay.remove(); _overlay = null; }
  _lessonBoard = null;
}

function _nextBoard() {
  // Seed by session progression — deterministic enough to debug, varied
  // enough to feel fresh. (No Date/random in the seed: the count varies it.)
  _boardsDone++;
  _lessonBoard = generateLessonBoard(_lesson, `s${_boardsDone}`);
  if (!_lessonBoard) {
    showToast('Could not build a lesson board — please try again', 2500);
    closeLexicon();
    return;
  }
  applyLessonOpening(_lessonBoard);
  _overlay.querySelector('.lexicon-naming').classList.add('hidden');
  _overlay.querySelector('.lexicon-actions').classList.add('hidden');
  _render();
}

function _render() {
  const grid = _overlay.querySelector('.lexicon-grid');
  const { board, rows, cols } = _lessonBoard;
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.innerHTML = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      const el = document.createElement('div');
      el.className = 'lexicon-cell ' + (cell.isRevealed ? 'revealed' : 'unrevealed');
      el.dataset.row = r;
      el.dataset.col = c;
      if (cell.isRevealed && cell.adjacentMines > 0) {
        el.textContent = cell.adjacentMines;
        el.dataset.num = cell.adjacentMines;
      } else if (!cell.isRevealed && cell.isFlagged) {
        el.textContent = '🚩';
        el.classList.add('flagged');
      }
      grid.appendChild(el);
    }
  }
}

// Gated flagging: a flag only sticks on a square the clues can settle
// as a MINE — in the gym, a flag is a worked deduction, never a guess
// marker. Tapping a flagged square unflags it.
function _tryFlag(row, col) {
  if (!_lessonBoard) return;
  const { board } = _lessonBoard;
  const cell = board[row]?.[col];
  if (!cell || cell.isRevealed) return;
  if (cell.isFlagged) {
    cell.isFlagged = false;
    _render();
    return;
  }
  const frontier = findDeducibleFrontier(board, { respectFlags: false });
  const provablyMine = frontier.mines.some(m => m.row === row && m.col === col);
  if (!provablyMine) {
    const el = _cellEl(row, col);
    if (el) {
      el.classList.remove('lexicon-bounce');
      void el.offsetWidth;
      el.classList.add('lexicon-bounce');
    }
    const hit = frontier.mines[0] || frontier.safe[0];
    if (hit) {
      _pulse(hit.sources);
      const ask = explainDeduction(board, hit, {
        style: 'socratic',
        kind: frontier.mines.includes(hit) ? 'mine' : 'safe',
      });
      if (ask) showToast(`🤔 The clues can’t pin that square yet. ${ask}`, 3600);
    } else {
      showToast('🤔 The clues can’t pin that square as a mine yet', 2600);
    }
    return;
  }
  cell.isFlagged = true;
  _render();
}

function _cellEl(row, col) {
  return _overlay.querySelector(`.lexicon-cell[data-row="${row}"][data-col="${col}"]`);
}

function _pulse(cells) {
  if (_pulseTimer) clearTimeout(_pulseTimer);
  const els = [];
  for (const s of cells) {
    const el = _cellEl(s.row, s.col);
    if (el) { el.classList.add('lexicon-pulse'); els.push(el); }
  }
  _pulseTimer = setTimeout(() => {
    for (const el of els) el.classList.remove('lexicon-pulse');
    _pulseTimer = null;
  }, 2200);
}

function _onCellClick(e) {
  if (!_lessonBoard) return;
  if (_lpFired) { _lpFired = false; return; } // long-press already flagged
  const el = e.target.closest('.lexicon-cell');
  if (!el) return;
  const row = parseInt(el.dataset.row, 10);
  const col = parseInt(el.dataset.col, 10);
  const { board } = _lessonBoard;
  const cell = board[row]?.[col];
  if (!cell || cell.isRevealed) return;
  // A tap on a flagged square unflags it (flags never block proof —
  // the gate below recomputes from the clues alone).
  if (cell.isFlagged) { cell.isFlagged = false; _render(); return; }

  const frontier = findDeducibleFrontier(board, { respectFlags: false });
  const provablySafe = frontier.safe.some(s => s.row === row && s.col === col);

  if (!provablySafe) {
    // THE GATE: bounce, point at the clues that hold the next step, and
    // say in plain words what kind of thinking unlocks it.
    el.classList.remove('lexicon-bounce');
    void el.offsetWidth;
    el.classList.add('lexicon-bounce');
    const next = frontier.safe[0];
    if (next) {
      _pulse(next.sources);
      const ask = explainDeduction(board, next, { style: 'socratic', kind: 'safe' });
      if (ask) showToast(`🤔 Not that one yet. ${ask}`, 3600);
    }
    return;
  }

  // Provably safe — open it (flood zeros like the real game).
  const queue = [[row, col]];
  const { rows, cols } = _lessonBoard;
  while (queue.length > 0) {
    const [r, c] = queue.pop();
    const cc = board[r][c];
    if (cc.isRevealed || cc.isMine) continue;
    cc.isRevealed = true;
    if (cc.adjacentMines === 0) {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) queue.push([nr, nc]);
        }
      }
    }
  }
  _render();

  if (lessonComplete(_lessonBoard)) {
    // The naming moment — AFTER the player performed the technique.
    const naming = _overlay.querySelector('.lexicon-naming');
    naming.textContent = _lesson.naming;
    naming.classList.remove('hidden');
    _overlay.querySelector('.lexicon-actions').classList.remove('hidden');
  }
}
