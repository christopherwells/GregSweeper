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
import { playReveal, playCascade, playFlag, playUnflag, playWin, playGateBounce } from '../audio/sounds.js';

let _overlay = null;
let _lessonBoard = null;
let _lesson = null;
let _boardsDone = 0;
let _pulseTimer = null;
let _lpTimer = null;   // long-press flag timer (touch)
let _lpFired = false;  // swallow the click that follows a long-press
// Per-board coaching state: the first pattern move of a board carries
// the recognition tip; later ones get short rotating affirmations.
let _tier1Count = 0;
let _flagTipShown = false;
let _chordTipShown = false;

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
      <p class="lexicon-instruction">Open every safe square to finish the board. A square only opens when the clues prove it is safe. If it bounces, look at the clues that light up. Right-click or hold to flag a proven mine, then tap a number whose mines are all flagged to open the rest around it.</p>
      <div class="lexicon-status">
        <span class="lexicon-mines-left"></span>
        <span class="lexicon-board-count"></span>
      </div>
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
  _tier1Count = 0;
  _flagTipShown = false;
  _chordTipShown = false;
  _lessonBoard = generateLessonBoard(_lesson, `s${_boardsDone}`);
  if (!_lessonBoard) {
    showToast('Could not build a lesson board. Please try again', 2500);
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
  let mines = 0;
  let flags = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (cell.isMine) mines++;
      if (cell.isFlagged) flags++;
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
  // The same anchor the main game's LCD gives: how many mines are
  // unaccounted for. Without it the player has no idea what the board
  // even holds.
  _overlay.querySelector('.lexicon-mines-left').textContent = `💣 ${mines - flags} left`;
  _overlay.querySelector('.lexicon-board-count').textContent = `Board ${_boardsDone}`;
}

// Open a provably-safe square, flooding zeros like the real game.
// Returns how many cells opened so the caller can voice it.
function _floodOpen(row, col) {
  const { board, rows, cols } = _lessonBoard;
  let opened = 0;
  const queue = [[row, col]];
  while (queue.length > 0) {
    const [r, c] = queue.pop();
    const cc = board[r][c];
    if (cc.isRevealed || cc.isMine) continue;
    cc.isRevealed = true;
    opened++;
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
  return opened;
}

// Voice the move, repaint, and handle the naming moment. Returns true
// when the board just completed, so callers can skip per-move coaching
// and let the naming moment own the screen.
function _finishMove(opened) {
  if (opened > 1) playCascade(opened);
  else if (opened === 1) playReveal();
  _render();
  if (lessonComplete(_lessonBoard)) {
    playWin();
    const naming = _overlay.querySelector('.lexicon-naming');
    naming.textContent = _lesson.naming;
    naming.classList.remove('hidden');
    _overlay.querySelector('.lexicon-actions').classList.remove('hidden');
    return true;
  }
  return false;
}

// ── In-the-moment coaching ──────────────────────────────
// The gate teaches on FAILURE (Socratic bounce); these notes teach on
// SUCCESS, naming the move the player just made and reinforcing how to
// spot it. Pacing rules so it never becomes noise: pattern moves
// (tier 1, the technique the gym exists for) are celebrated every time,
// the FIRST one per board carrying the recognition tip; proven-mine
// flags get their reasoning spelled out once per board, then a short
// nod; trivial single-clue reveals stay silent.

const TIER1_OPENERS = [
  '💪 Excellent use of the {p} pattern!',
  '💪 A clean {p} read.',
  '💪 Textbook {p}.',
  '💪 The {p} again. You are getting quick at this.',
];

// Recognition tips, grounded in the classic pattern vocabulary: the
// overlap subtraction, and where each pattern tends to live.
function _recognitionTip(pairName) {
  if (pairName === '1-2') {
    return 'How to spot it: when a 1 and a 2 share squares, the 2\'s leftover square holds its second mine and the 1\'s leftover square is safe. It shows up constantly along walls.';
  }
  if (pairName === '1-1') {
    return 'How to spot it: when two 1s share squares, the second 1 is already accounted for, so its leftover square is safe. Watch for it marching along walls.';
  }
  return 'How to spot it: where two clues overlap, subtract the smaller from the larger. The leftover squares carry the leftover mines. Flagged mines reduce a number, so a 2-3 plays like a 1-2.';
}

// "1-2", "1-1", "2-3"... — named from the two clue digits on screen.
function _pairName(ded) {
  const digits = ded.sources
    .map(s => _lessonBoard.board[s.row]?.[s.col]?.adjacentMines)
    .filter(n => typeof n === 'number')
    .sort((a, b) => a - b);
  return digits.length >= 2 ? `${digits[0]}-${digits[1]}` : 'overlap';
}

function _celebrate(ded, kind) {
  if (!ded) return;
  if (ded.tier === 1) {
    const pair = _pairName(ded);
    const opener = TIER1_OPENERS[_tier1Count % TIER1_OPENERS.length].replace('{p}', pair);
    _tier1Count++;
    if (_tier1Count === 1) {
      showToast(`${opener} ${_recognitionTip(pair)}`, 5200);
    } else {
      showToast(opener, 2200);
    }
    return;
  }
  if (kind === 'mine') {
    // A flag in the gym is a worked deduction — say the reasoning once,
    // then keep it to a nod.
    if (!_flagTipShown) {
      _flagTipShown = true;
      const why = explainDeduction(_lessonBoard.board, ded, { style: 'full', kind: 'mine' });
      showToast(why ? `📌 Proven mine. ${why}` : '📌 Proven mine.', 4200);
    } else {
      showToast('📌 Proven mine.', 1600);
    }
  }
  // Tier-0 safe reveals stay silent: they are plain propagation, and
  // voicing every one would bury the pattern moments that matter.
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
    playUnflag();
    _render();
    return;
  }
  const frontier = findDeducibleFrontier(board, { respectFlags: false });
  const provablyMine = frontier.mines.some(m => m.row === row && m.col === col);
  if (!provablyMine) {
    _bounce(row, col);
    const hit = _lowestTier(frontier.mines) || _lowestTier(frontier.safe);
    if (hit) {
      _pulse(hit.sources);
      const ask = explainDeduction(board, hit, {
        style: 'socratic',
        kind: frontier.mines.includes(hit) ? 'mine' : 'safe',
      });
      if (ask) showToast(`🤔 The clues can't pin that square yet. ${ask}`, 3600);
    } else {
      showToast('🤔 The clues can\'t pin that square as a mine yet', 2600);
    }
    return;
  }
  cell.isFlagged = true;
  playFlag();
  _render();
  const ded = frontier.mines.find(m => m.row === row && m.col === col);
  _celebrate(ded, 'mine');
}

function _bounce(row, col) {
  const el = _cellEl(row, col);
  if (el) {
    el.classList.remove('lexicon-bounce');
    void el.offsetWidth;
    el.classList.add('lexicon-bounce');
  }
  playGateBounce();
}

function _cellEl(row, col) {
  return _overlay.querySelector(`.lexicon-cell[data-row="${row}"][data-col="${col}"]`);
}

// Teach the simplest available step.
function _lowestTier(list) {
  return list.reduce((best, d) => (!best || d.tier < best.tier ? d : best), null);
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
  if (!cell) return;
  // Tap on an open number: chord, just like the real game.
  if (cell.isRevealed) { _tryChord(row, col); return; }
  // A tap on a flagged square unflags it (flags never block proof —
  // the gate below recomputes from the clues alone).
  if (cell.isFlagged) { cell.isFlagged = false; playUnflag(); _render(); return; }

  const frontier = findDeducibleFrontier(board, { respectFlags: false });
  const provablySafe = frontier.safe.some(s => s.row === row && s.col === col);

  if (!provablySafe) {
    // THE GATE: bounce, point at the clues that hold the SIMPLEST next
    // step, and say in plain words what kind of thinking unlocks it.
    _bounce(row, col);
    const next = _lowestTier(frontier.safe);
    if (next) {
      _pulse(next.sources);
      const ask = explainDeduction(board, next, { style: 'socratic', kind: 'safe' });
      if (ask) showToast(`🤔 Not that one yet. ${ask}`, 3600);
    }
    return;
  }

  const ded = frontier.safe.find(s => s.row === row && s.col === col);
  const completed = _finishMove(_floodOpen(row, col));
  if (!completed) _celebrate(ded, 'safe');
}

// Chord on an open number. Gym flags are gate-proven mines, so a number
// whose flags match it has PROVEN its remaining neighbors safe — the
// chord is the physical shortcut for exactly the deduction the gym
// teaches, and it can never hit a mine here.
function _tryChord(row, col) {
  const { board, rows, cols } = _lessonBoard;
  const cell = board[row][col];
  if (!cell.adjacentMines) return;
  let flags = 0;
  const hidden = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = row + dr, nc = col + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const n = board[nr][nc];
      if (n.isFlagged) flags++;
      else if (!n.isRevealed) hidden.push([nr, nc]);
    }
  }
  if (hidden.length === 0) return;
  // An idle tap on a number with no flags around it stays silent; a
  // half-flagged chord attempt gets the teaching bounce.
  if (flags !== cell.adjacentMines) {
    if (flags > 0) {
      _bounce(row, col);
      showToast('🤔 Flag all of this number\'s mines first, then tap it to open the rest', 2800);
    }
    return;
  }
  let opened = 0;
  for (const [nr, nc] of hidden) opened += _floodOpen(nr, nc);
  const completed = _finishMove(opened);
  // Teach the mechanic the first time it lands on each board; after
  // that the cascade sound is feedback enough.
  if (!completed && opened > 0 && !_chordTipShown) {
    _chordTipShown = true;
    showToast(`⚡ Chorded: the ${cell.adjacentMines} was fully flagged, so everything else around it opened at once`, 2600);
  }
}
