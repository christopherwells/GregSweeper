// Interactive Tutorial
// Guided 5x5 mini-board that teaches minesweeper basics:
// 1. Tap to reveal  2. Numbers explained  3. Flag  4. Chord  5. Win

import { playReveal, playFlag, playWin } from '../audio/sounds.js?v=1.0';
import { setOnboarded } from '../storage/statsStorage.js?v=1.0';

const ROWS = 5;
const COLS = 5;
const MINES = [[1,1], [3,3]];

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
    text: 'Tap the glowing cell to reveal it. Safe cells with no nearby mines will open up automatically!',
    targetCell: [0, 4],
    action: 'reveal',
  },
  {
    id: 'numbers',
    title: 'Step 2: Read the Numbers',
    text: 'Each number tells you how many mines touch that cell (including diagonals). Use them to figure out where mines are hiding.',
    action: 'next',
    buttonText: 'Got it!',
  },
  {
    id: 'flag',
    title: 'Step 3: Flag a Mine',
    text: "The 1 at the top only touches one hidden cell \u2014 that must be a mine! Tap the glowing cell to flag it.",
    targetCell: [1, 1],
    action: 'flag',
  },
  {
    id: 'chord',
    title: 'Step 4: Chord Reveal',
    text: "When all mines around a number are flagged, tap the number to reveal the rest. Tap the glowing 1!",
    targetCell: [0, 2],
    action: 'chord',
  },
  {
    id: 'flag2',
    title: 'Step 5: Flag the Last Mine',
    text: "One mine left! The 2 shows two adjacent mines \u2014 one is flagged, so the last hidden cell must be the other. Flag it!",
    targetCell: [3, 3],
    action: 'flag',
  },
  {
    id: 'complete',
    title: 'You did it! \uD83C\uDF89',
    text: "You\u2019ve mastered the basics! Reveal safe cells, use numbers to find mines, flag them, and chord to clear fast.",
    action: 'finish',
    buttonText: "Let\u2019s Play!",
  },
];

let _board = null;
let _stepIndex = 0;
let _overlay = null;
let _onComplete = null;

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
          cellEl.textContent = '\uD83D\uDCA3';
          cellEl.classList.add('mine');
        } else if (cell.adjacentMines > 0) {
          cellEl.textContent = cell.adjacentMines;
          cellEl.classList.add('num-' + cell.adjacentMines);
        } else {
          cellEl.classList.add('empty');
        }
      } else if (cell.isFlagged) {
        cellEl.classList.add('flagged');
        cellEl.textContent = '\uD83D\uDEA9';
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
    if (r !== tr || c !== tc) return;
    _board[r][c].isFlagged = true;
    playFlag();
    // If this is the last flag, auto-reveal all remaining safe cells
    if (step.id === 'flag2') {
      for (let ar = 0; ar < ROWS; ar++) {
        for (let ac = 0; ac < COLS; ac++) {
          const cell = _board[ar][ac];
          if (!cell.isRevealed && !cell.isFlagged && !cell.isMine) {
            cell.isRevealed = true;
          }
        }
      }
    }
    updateBoardDisplay();
    setTimeout(advanceStep, 500);
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
  const step = STEPS[_stepIndex];
  if (!step || !step.targetCell) return;

  if (step.action === 'flag') {
    const [tr, tc] = step.targetCell;
    if (r !== tr || c !== tc) return;
    _board[r][c].isFlagged = true;
    playFlag();
    updateBoardDisplay();
    setTimeout(advanceStep, 500);
  }
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
