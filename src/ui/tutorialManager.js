// Interactive Tutorial
// Guided 5x5 mini-board that teaches minesweeper basics:
// 1. Tap to reveal  2. Numbers explained  3. Flag  4. Chord  5. Win

import { playReveal, playFlag, playWin } from '../audio/sounds.js';
import { setOnboarded } from '../storage/statsStorage.js';
import { applyIcon } from './spriteLoader.js';
import { getThemeEmoji } from './boardRenderer.js';

const ROWS = 5;
const COLS = 5;
// Mine #1 sits in the top-left board corner so it is boxed in by three
// 1s whose ONLY shared hidden cell is that corner — an unambiguous
// "inside corner" deduction for a beginner. Mine #2 at (3,3) is pinned
// the same way by a single adjacent 1.
const MINES = [[0,0], [3,3]];

function buildTutorialBoard() {
  const mineSet = new Set(MINES.map(([r,c]) => r * 100 + c));
  const board = [];
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++) {
      const isMine = mineSet.has(r * 100 + c);
      let adj = 0;
      if (!isMine) {
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            const nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && mineSet.has(nr * 100 + nc)) adj++;
          }
        }
      }
      row.push({ isMine, adjacentMines: adj, isRevealed: false, isFlagged: false });
    }
    board.push(row);
  }
  return board;
}

function floodFill(board, r, c, revealed) {
  if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return;
  const key = r * 100 + c;
  if (revealed.has(key)) return;
  const cell = board[r][c];
  if (cell.isMine || cell.isFlagged) return;
  revealed.add(key);
  cell.isRevealed = true;
  if (cell.adjacentMines === 0) {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        floodFill(board, r + dr, c + dc, revealed);
      }
    }
  }
}

const STEPS = [
  {
    id: 'welcome',
    title: 'Welcome to GregSweeper!',
    text: "Let\u2019s learn the basics with a quick practice round.",
    action: 'next',
    buttonText: 'Start Tutorial',
  },
  {
    id: 'reveal',
    title: 'Step 1: Reveal a Cell',
    text: 'Tap the glowing cell. It has no mines beside it, so a whole safe area opens up at once.',
    targetCell: [4, 0],
    action: 'reveal',
  },
  {
    id: 'numbers',
    title: 'Step 2: Read the Numbers',
    text: 'Each number counts the mines touching that cell, diagonals included. Blank cells were safe; the numbers are your clues.',
    action: 'next',
    buttonText: 'Got it!',
  },
  {
    id: 'flag',
    title: 'Step 3: Flag a Mine',
    text: "The top-left corner is boxed in by 1s, and the only hidden cell they all touch is that corner. A 1 means exactly one mine, so the corner has to be one. Long-press it to flag it (right-click on desktop).",
    targetCell: [0, 0],
    action: 'flag',
  },
  {
    id: 'flag2',
    title: 'Step 4: Flag the Last Mine',
    text: "Same trick: a nearby 1 touches only one hidden cell, the glowing one. So it is the last mine. Long-press it to flag it. (On a phone you can also tap the \ud83d\udea9 toggle, then tap cells to flag.)",
    targetCell: [3, 3],
    action: 'flag',
  },
  {
    id: 'chord',
    title: 'Step 5: Chord Reveal',
    text: "Both mines are flagged. Tap the glowing number to chord it. A chord opens only the hidden cells touching that one number.",
    targetCell: [2, 4],
    action: 'chord',
  },
  {
    id: 'chord2',
    title: 'Step 6: Finish the Board',
    text: "See? The chord opened only its own neighbor, not the whole board. Two safe cells are still hidden. Chord the glowing 1 to open the last of them.",
    targetCell: [3, 4],
    action: 'chord',
  },
  {
    id: 'complete',
    title: 'You did it! \uD83C\uDF89',
    text: "That\u2019s it, you know how to play. Some boards add Modifiers: special cells that bend the rules. GregSweeper explains each one the first time it shows up. Today\u2019s daily is waiting, same puzzle for everyone, leaderboard inside.",
    action: 'finish',
    buttonText: "Let\u2019s go \u2192",
  },
];

let _board = null;
let _stepIndex = 0;
let _overlay = null;
let _onComplete = null;
let _lpTimer = null; // long-press timer for the flag steps

export function startTutorial(onComplete) {
  _board = buildTutorialBoard();
  _stepIndex = 0;
  _onComplete = onComplete || (() => {});
  renderOverlay();
  renderStep();
}

function renderOverlay() {
  const existing = document.getElementById('tutorial-overlay');
  if (existing) existing.remove();

  _overlay = document.createElement('div');
  _overlay.id = 'tutorial-overlay';
  _overlay.className = 'tutorial-overlay';

  const html = '<div class="tutorial-container">'
    + '<div class="tutorial-instruction" id="tutorial-instruction">'
    + '<h3 id="tutorial-title"></h3>'
    + '<p id="tutorial-text"></p>'
    + '<button id="tutorial-next-btn" class="action-btn primary hidden">Next</button>'
    + '</div>'
    + '<div class="tutorial-board-wrapper">'
    + '<div id="tutorial-board" class="tutorial-board"></div>'
    + '</div>'
    + '<div class="tutorial-footer">'
    + '<button id="tutorial-skip-btn" class="tutorial-skip-btn">Skip Tutorial</button>'
    + '<div class="tutorial-progress" id="tutorial-progress"></div>'
    + '</div>'
    + '</div>';

  _overlay.innerHTML = html;
  document.body.appendChild(_overlay);

  _overlay.querySelector('#tutorial-skip-btn').addEventListener('click', finishTutorial);
  _overlay.querySelector('#tutorial-next-btn').addEventListener('click', advanceStep);

  renderBoard();
}

function renderBoard() {
  const boardEl = _overlay.querySelector('#tutorial-board');
  boardEl.innerHTML = '';
  boardEl.style.gridTemplateColumns = 'repeat(' + COLS + ', var(--tutorial-cell-size, 48px))';
  boardEl.style.gridTemplateRows = 'repeat(' + ROWS + ', var(--tutorial-cell-size, 48px))';

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cellEl = document.createElement('div');
      cellEl.className = 'tutorial-cell unrevealed';
      cellEl.dataset.row = r;
      cellEl.dataset.col = c;
      boardEl.appendChild(cellEl);
    }
  }

  boardEl.addEventListener('click', handleCellClick);
  boardEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    handleCellRightClick(e);
  });
  boardEl.addEventListener('touchstart', handleTouchStart, { passive: true });
  boardEl.addEventListener('touchend', clearLongPress);
  boardEl.addEventListener('touchmove', clearLongPress, { passive: true });
  boardEl.addEventListener('touchcancel', clearLongPress);
}

function updateBoardDisplay() {
  const boardEl = _overlay ? _overlay.querySelector('#tutorial-board') : null;
  if (!boardEl) return;

  const step = STEPS[_stepIndex];
  const targetCell = step ? step.targetCell : null;

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cell = _board[r][c];
      const cellEl = boardEl.children[r * COLS + c];
      if (!cellEl) continue;

      cellEl.className = 'tutorial-cell';
      cellEl.textContent = '';

      if (cell.isRevealed) {
        cellEl.classList.add('revealed');
        if (cell.isMine) {
          applyIcon(cellEl, 'mine', getThemeEmoji('mine'), { sizeClass: 'sprite-cell' });
          cellEl.classList.add('mine');
        } else if (cell.adjacentMines > 0) {
          cellEl.textContent = cell.adjacentMines;
          cellEl.classList.add('num-' + cell.adjacentMines);
        } else {
          cellEl.classList.add('empty');
        }
      } else if (cell.isFlagged) {
        cellEl.classList.add('flagged');
        applyIcon(cellEl, 'flag', getThemeEmoji('flag'), { sizeClass: 'sprite-cell' });
      } else {
        cellEl.classList.add('unrevealed');
      }

      if (targetCell && targetCell[0] === r && targetCell[1] === c) {
        cellEl.classList.add('tutorial-highlight');
      }
    }
  }
}

function renderStep() {
  clearLongPress();
  const step = STEPS[_stepIndex];
  if (!step) return;

  const titleEl = _overlay.querySelector('#tutorial-title');
  const textEl = _overlay.querySelector('#tutorial-text');
  const nextBtn = _overlay.querySelector('#tutorial-next-btn');
  const progressEl = _overlay.querySelector('#tutorial-progress');

  titleEl.textContent = step.title;
  textEl.textContent = step.text;

  if (step.action === 'next' || step.action === 'finish') {
    nextBtn.classList.remove('hidden');
    nextBtn.textContent = step.buttonText || 'Next';
  } else {
    nextBtn.classList.add('hidden');
  }

  const totalSteps = STEPS.length;
  let dots = '';
  for (let i = 0; i < totalSteps; i++) {
    if (i < _stepIndex) dots += '<span class="tutorial-dot completed"></span>';
    else if (i === _stepIndex) dots += '<span class="tutorial-dot active"></span>';
    else dots += '<span class="tutorial-dot"></span>';
  }
  progressEl.innerHTML = dots;

  updateBoardDisplay();
}

// Single source of truth for flagging in the tutorial. Long-press
// (touch), right-click (desktop), and the plain-tap fallback all route
// here so every input path behaves identically, including the flag2
// auto-reveal, which the old right-click path silently skipped.
function doFlag(r, c) {
  const step = STEPS[_stepIndex];
  if (!step || step.action !== 'flag' || !step.targetCell) return;
  const [tr, tc] = step.targetCell;
  if (r !== tr || c !== tc) return;
  if (_board[r][c].isFlagged) return; // long-press already handled it; ignore the trailing tap
  _board[r][c].isFlagged = true;
  playFlag();
  updateBoardDisplay();
  setTimeout(advanceStep, 500);
}

function clearLongPress() {
  if (_lpTimer) {
    clearTimeout(_lpTimer);
    _lpTimer = null;
  }
}

function handleTouchStart(e) {
  const cellEl = e.target.closest('.tutorial-cell');
  if (!cellEl) return;
  const step = STEPS[_stepIndex];
  if (!step || step.action !== 'flag') return; // long-press is the taught flag gesture
  const r = parseInt(cellEl.dataset.row, 10);
  const c = parseInt(cellEl.dataset.col, 10);
  clearLongPress();
  _lpTimer = setTimeout(() => {
    _lpTimer = null;
    doFlag(r, c);
  }, 500);
}

function handleCellClick(e) {
  const cellEl = e.target.closest('.tutorial-cell');
  if (!cellEl) return;
  const r = parseInt(cellEl.dataset.row, 10);
  const c = parseInt(cellEl.dataset.col, 10);
  const step = STEPS[_stepIndex];
  if (!step || !step.targetCell) return;

  const [tr, tc] = step.targetCell;

  if (step.action === 'reveal') {
    if (r !== tr || c !== tc) return;
    const revealed = new Set();
    floodFill(_board, r, c, revealed);
    playReveal();
    setTimeout(() => {
      updateBoardDisplay();
      setTimeout(advanceStep, 600);
    }, 100);
  } else if (step.action === 'flag') {
    doFlag(r, c);
  } else if (step.action === 'chord') {
    if (r !== tr || c !== tc) return;
    const cell = _board[r][c];
    if (!cell.isRevealed || cell.adjacentMines === 0) return;
    const revealed = new Set();
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
          const neighbor = _board[nr][nc];
          if (!neighbor.isRevealed && !neighbor.isFlagged) {
            floodFill(_board, nr, nc, revealed);
          }
        }
      }
    }
    playReveal();
    updateBoardDisplay();
    setTimeout(advanceStep, 500);
  }
}

function handleCellRightClick(e) {
  const cellEl = e.target.closest('.tutorial-cell');
  if (!cellEl) return;
  const r = parseInt(cellEl.dataset.row, 10);
  const c = parseInt(cellEl.dataset.col, 10);
  doFlag(r, c);
}

function advanceStep() {
  const step = STEPS[_stepIndex];
  if (step && step.action === 'finish') {
    finishTutorial();
    return;
  }
  _stepIndex++;
  if (_stepIndex >= STEPS.length) {
    finishTutorial();
    return;
  }
  renderStep();
}

function finishTutorial() {
  clearLongPress();
  setOnboarded();
  if (_overlay) {
    _overlay.classList.add('tutorial-exit');
    setTimeout(() => {
      if (_overlay && _overlay.parentNode) {
        _overlay.parentNode.removeChild(_overlay);
      }
      _overlay = null;
      _board = null;
      if (_onComplete) _onComplete();
    }, 300);
  }
}

// ── Warm-up: one free-play Beginner board after the tutorial ────────
// Bridges the gap between the 5x5 scripted tutorial and a full Daily.
// Self-contained: its own overlay/state, reuses the tutorial overlay
// styling and applyIcon sprites. Free-play (reveal/flag/chord anywhere)
// on a classic 9x9/10-mine board, first click guaranteed safe. A mine
// hit is a gentle re-fog ("just practice"), never a game-over. Touches
// nothing in the real game / score / daily / leaderboard pipelines.

const WU_ROWS = 9;
const WU_COLS = 9;
const WU_MINES = 10;

let _wuOverlay = null;
let _wuBoard = null;
let _wuPlaced = false;   // mines laid (deferred until first click)
let _wuFinished = false; // onComplete fired / skipped (guards double-call)
let _wuOnComplete = null;
let _wuLpTimer = null;

export function startWarmup(onComplete) {
  _wuOnComplete = onComplete || (() => {});
  _wuFinished = false;
  _wuPlaced = false;
  _wuBoard = [];
  for (let r = 0; r < WU_ROWS; r++) {
    const row = [];
    for (let c = 0; c < WU_COLS; c++) {
      row.push({ isMine: false, adjacentMines: 0, isRevealed: false, isFlagged: false });
    }
    _wuBoard.push(row);
  }
  wuRenderOverlay();
}

function wuPlaceMines(safeR, safeC) {
  // Ban the first-clicked cell and its 8 neighbors so the opening click
  // always cracks open a region (classic first-click-safe).
  const banned = new Set();
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const nr = safeR + dr, nc = safeC + dc;
      if (nr >= 0 && nr < WU_ROWS && nc >= 0 && nc < WU_COLS) banned.add(nr * 100 + nc);
    }
  }
  let placed = 0;
  while (placed < WU_MINES) {
    const r = Math.floor(Math.random() * WU_ROWS);
    const c = Math.floor(Math.random() * WU_COLS);
    if (banned.has(r * 100 + c) || _wuBoard[r][c].isMine) continue;
    _wuBoard[r][c].isMine = true;
    placed++;
  }
  for (let r = 0; r < WU_ROWS; r++) {
    for (let c = 0; c < WU_COLS; c++) {
      if (_wuBoard[r][c].isMine) continue;
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < WU_ROWS && nc >= 0 && nc < WU_COLS && _wuBoard[nr][nc].isMine) n++;
        }
      }
      _wuBoard[r][c].adjacentMines = n;
    }
  }
  _wuPlaced = true;
}

function wuFlood(r, c) {
  if (r < 0 || r >= WU_ROWS || c < 0 || c >= WU_COLS) return;
  const cell = _wuBoard[r][c];
  if (cell.isRevealed || cell.isFlagged || cell.isMine) return;
  cell.isRevealed = true;
  if (cell.adjacentMines === 0) {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        wuFlood(r + dr, c + dc);
      }
    }
  }
}

function wuRenderOverlay() {
  const existing = document.getElementById('warmup-overlay');
  if (existing) existing.remove();

  _wuOverlay = document.createElement('div');
  _wuOverlay.id = 'warmup-overlay';
  _wuOverlay.className = 'tutorial-overlay';
  _wuOverlay.innerHTML = '<div class="tutorial-container">'
    + '<div class="tutorial-instruction">'
    + '<h3>Warm-up</h3>'
    + '<p id="warmup-text">A real board, no modifiers, no clock. Clear every safe cell. Long-press (or right-click) to flag a mine.</p>'
    + '</div>'
    + '<div class="tutorial-board-wrapper"><div id="warmup-board" class="tutorial-board"></div></div>'
    + '<div class="tutorial-footer">'
    + '<button id="warmup-skip-btn" class="tutorial-skip-btn">Skip to menu</button>'
    + '</div>'
    + '</div>';
  document.body.appendChild(_wuOverlay);
  _wuOverlay.querySelector('#warmup-skip-btn').addEventListener('click', () => wuFinish());

  const boardEl = _wuOverlay.querySelector('#warmup-board');
  boardEl.style.gridTemplateColumns = 'repeat(' + WU_COLS + ', var(--tutorial-cell-size, 48px))';
  boardEl.style.gridTemplateRows = 'repeat(' + WU_ROWS + ', var(--tutorial-cell-size, 48px))';
  for (let r = 0; r < WU_ROWS; r++) {
    for (let c = 0; c < WU_COLS; c++) {
      const cellEl = document.createElement('div');
      cellEl.className = 'tutorial-cell unrevealed';
      cellEl.dataset.row = r;
      cellEl.dataset.col = c;
      boardEl.appendChild(cellEl);
    }
  }
  boardEl.addEventListener('click', wuClick);
  boardEl.addEventListener('contextmenu', (e) => { e.preventDefault(); wuRightClick(e); });
  boardEl.addEventListener('touchstart', wuTouchStart, { passive: true });
  boardEl.addEventListener('touchend', wuClearLp);
  boardEl.addEventListener('touchmove', wuClearLp, { passive: true });
  boardEl.addEventListener('touchcancel', wuClearLp);
  wuRender();
}

function wuRender() {
  const boardEl = _wuOverlay && _wuOverlay.querySelector('#warmup-board');
  if (!boardEl) return;
  for (let r = 0; r < WU_ROWS; r++) {
    for (let c = 0; c < WU_COLS; c++) {
      const cell = _wuBoard[r][c];
      const el = boardEl.children[r * WU_COLS + c];
      if (!el) continue;
      el.className = 'tutorial-cell';
      el.textContent = '';
      if (cell.isRevealed) {
        el.classList.add('revealed');
        if (cell.isMine) {
          applyIcon(el, 'mine', getThemeEmoji('mine'), { sizeClass: 'sprite-cell' });
          el.classList.add('mine');
        } else if (cell.adjacentMines > 0) {
          el.textContent = cell.adjacentMines;
          el.classList.add('num-' + cell.adjacentMines);
        } else {
          el.classList.add('empty');
        }
      } else if (cell.isFlagged) {
        el.classList.add('flagged');
        applyIcon(el, 'flag', getThemeEmoji('flag'), { sizeClass: 'sprite-cell' });
      } else {
        el.classList.add('unrevealed');
      }
    }
  }
}

function wuSetMsg(t) {
  const el = _wuOverlay && _wuOverlay.querySelector('#warmup-text');
  if (el) el.textContent = t;
}

function wuClearLp() {
  if (_wuLpTimer) { clearTimeout(_wuLpTimer); _wuLpTimer = null; }
}

function wuTouchStart(e) {
  const el = e.target.closest('.tutorial-cell');
  if (!el) return;
  const r = parseInt(el.dataset.row, 10);
  const c = parseInt(el.dataset.col, 10);
  wuClearLp();
  _wuLpTimer = setTimeout(() => { _wuLpTimer = null; wuToggleFlag(r, c); }, 500);
}

function wuRightClick(e) {
  const el = e.target.closest('.tutorial-cell');
  if (!el) return;
  wuToggleFlag(parseInt(el.dataset.row, 10), parseInt(el.dataset.col, 10));
}

function wuToggleFlag(r, c) {
  if (_wuFinished) return;
  const cell = _wuBoard[r][c];
  if (cell.isRevealed) return;
  cell.isFlagged = !cell.isFlagged;
  playFlag();
  wuRender();
}

function wuClick(e) {
  if (_wuFinished) return;
  const el = e.target.closest('.tutorial-cell');
  if (!el) return;
  const r = parseInt(el.dataset.row, 10);
  const c = parseInt(el.dataset.col, 10);
  const cell = _wuBoard[r][c];
  if (cell.isFlagged) return;
  if (!_wuPlaced) wuPlaceMines(r, c);
  if (cell.isRevealed) {
    if (cell.adjacentMines > 0) wuChord(r, c); // chord only on a satisfied number
    return;
  }
  if (cell.isMine) { wuHitMine(); return; }
  wuFlood(r, c);
  playReveal();
  wuAfterMove();
}

function wuChord(r, c) {
  const cell = _wuBoard[r][c];
  let flags = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < WU_ROWS && nc >= 0 && nc < WU_COLS && _wuBoard[nr][nc].isFlagged) flags++;
    }
  }
  if (flags !== cell.adjacentMines) return; // real chord rule: only when satisfied
  let hitMine = false;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= WU_ROWS || nc < 0 || nc >= WU_COLS) continue;
      const n = _wuBoard[nr][nc];
      if (n.isRevealed || n.isFlagged) continue;
      if (n.isMine) { hitMine = true; continue; }
      wuFlood(nr, nc);
    }
  }
  if (hitMine) { wuHitMine(); return; }
  playReveal();
  wuAfterMove();
}

function wuHitMine() {
  // Practice has no game-over. Briefly surface the mines so the player
  // sees what happened, then re-fog and let them keep going. Flags are
  // left in place so the re-explore is not from scratch.
  for (let r = 0; r < WU_ROWS; r++) {
    for (let c = 0; c < WU_COLS; c++) {
      if (_wuBoard[r][c].isMine) _wuBoard[r][c].isRevealed = true;
    }
  }
  wuSetMsg('That was a mine. In a real game it ends there. This is just practice, so the board re-hides. Keep going.');
  wuRender();
  setTimeout(() => {
    if (_wuFinished || !_wuBoard) return;
    for (let r = 0; r < WU_ROWS; r++) {
      for (let c = 0; c < WU_COLS; c++) _wuBoard[r][c].isRevealed = false;
    }
    wuSetMsg('Just practice. Keep clearing; long-press to flag suspected mines.');
    wuRender();
  }, 1300);
}

function wuIsWon() {
  for (let r = 0; r < WU_ROWS; r++) {
    for (let c = 0; c < WU_COLS; c++) {
      const cell = _wuBoard[r][c];
      if (!cell.isMine && !cell.isRevealed) return false;
    }
  }
  return true;
}

function wuAfterMove() {
  wuRender();
  if (wuIsWon()) {
    _wuFinished = true;
    playWin();
    wuSetMsg('Cleared. That is the whole game. You are ready for the Daily.');
    setTimeout(() => wuFinish(), 1500);
  }
}

function wuFinish() {
  if (_wuFinished && !_wuOverlay) return;
  _wuFinished = true;
  wuClearLp();
  const ov = _wuOverlay;
  _wuOverlay = null;
  _wuBoard = null;
  if (ov) {
    ov.classList.add('tutorial-exit');
    setTimeout(() => { if (ov.parentNode) ov.parentNode.removeChild(ov); }, 300);
  }
  const cb = _wuOnComplete;
  _wuOnComplete = null;
  if (cb) cb();
}
