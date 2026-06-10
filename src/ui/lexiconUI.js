// ── Lexicon overlay: the deducibility click-gate ───────
// A lesson board where clicking a cell that is not currently PROVABLY
// safe does nothing except pulse the proving region of a deduction that
// IS available. The player cannot luck through — completing the lesson
// means performing the technique, and the pattern is named only at the
// end. Dynamically imported from the title-screen button; never touches
// game state, scores, or the par pipeline.

import { findDeducibleFrontier } from '../logic/boardSolver.js';
import { explainDeduction } from '../logic/proofExplainer.js';
import { LESSONS, generateLessonBoard, applyLessonOpening, lessonComplete } from '../logic/lexicon.js';
import { showToast } from './toastManager.js';

let _overlay = null;
let _lessonBoard = null;
let _lesson = null;
let _boardsDone = 0;
let _pulseTimer = null;

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
        <span class="lexicon-title">The Lexicon</span>
        <button class="lexicon-close" aria-label="Close">&times;</button>
      </div>
      <p class="lexicon-instruction">Only squares the clues can settle will open. If a click bounces, watch where the board points — the answer is in those squares.</p>
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
  _overlay.querySelector('.lexicon-grid').addEventListener('click', _onCellClick);
}

export function closeLexicon() {
  if (_pulseTimer) { clearTimeout(_pulseTimer); _pulseTimer = null; }
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
      }
      grid.appendChild(el);
    }
  }
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
  const el = e.target.closest('.lexicon-cell');
  if (!el) return;
  const row = parseInt(el.dataset.row, 10);
  const col = parseInt(el.dataset.col, 10);
  const { board } = _lessonBoard;
  const cell = board[row]?.[col];
  if (!cell || cell.isRevealed) return;

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
