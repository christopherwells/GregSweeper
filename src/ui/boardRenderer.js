import { state } from '../state/gameState.js';
import { boardEl, zoomControls, zoomLevelDisplay, boardScrollWrapper } from './domHelpers.js';
import { THEME_UNLOCKS } from './themeManager.js';
import { loadEmojiPack, getActiveEmojiPack } from './collectionManager.js';
import { isBoardSolvable } from '../logic/boardSolver.js';

// ── Emoji Cache (avoid per-cell localStorage reads) ────
let _emojiCache = null;
let _emojiCacheValid = false;

export function invalidateEmojiCache() {
  _emojiCacheValid = false;
}

function getCachedEmoji() {
  if (!_emojiCacheValid) {
    const packId = loadEmojiPack();
    _emojiCache = packId !== 'default' ? getActiveEmojiPack() : null;
    _emojiCacheValid = true;
  }
  return _emojiCache;
}

// ── Board Rendering ────────────────────────────────────

export function resizeCells() {
  const container = document.getElementById('board-container');
  if (!container || !state.cols) return;
  const gap = 2; // --grid-gap
  const borderPad = 8; // 2px border + 2px padding on each side
  const availableWidth = container.clientWidth - borderPad;
  const cellSize = Math.floor((availableWidth - (state.cols - 1) * gap) / state.cols);
  const capped = Math.min(50, Math.max(24, cellSize));
  document.documentElement.style.setProperty('--cell-size', `${capped}px`);
}

export function renderBoard() {
  boardEl.innerHTML = '';
  resizeCells();
  boardEl.style.gridTemplateColumns = `repeat(${state.cols}, var(--cell-size))`;
  boardEl.style.gridTemplateRows = `repeat(${state.rows}, var(--cell-size))`;

  // ARIA grid semantics
  boardEl.setAttribute('role', 'grid');
  boardEl.setAttribute('aria-label', 'Minesweeper board');

  const shouldAnimate = state._initialized;
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      const cellEl = document.createElement('div');
      cellEl.className = 'cell unrevealed';
      cellEl.dataset.row = r;
      cellEl.dataset.col = c;
      cellEl.setAttribute('role', 'gridcell');
      cellEl.setAttribute('aria-rowindex', r + 1);
      cellEl.setAttribute('aria-colindex', c + 1);
      cellEl.setAttribute('aria-label', 'Unrevealed cell');
      // Roving tabindex: focused cell = 0, all others = -1
      cellEl.tabIndex = (r === state.focusedRow && c === state.focusedCol) ? 0 : -1;
      if (shouldAnimate) {
        const delay = (r + c) * 12; // diagonal wave
        cellEl.classList.add('cascade-in');
        cellEl.style.animationDelay = `${delay}ms`;
        setTimeout(() => cellEl.classList.remove('cascade-in'), 300 + delay);
      }
      boardEl.appendChild(cellEl);
    }
  }
}

export function getThemeEmoji(type) {
  // Check for active emoji pack override (cached to avoid per-cell localStorage reads)
  const pack = getCachedEmoji();
  if (pack && pack[type]) return pack[type];

  // Fall through to theme-based emoji
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'classic';
  const themeInfo = THEME_UNLOCKS[currentTheme];
  if (type === 'mine') return themeInfo?.mine || '💣';
  if (type === 'flag') return themeInfo?.flag || '🚩';
  if (type === 'smiley') return themeInfo?.smiley || '😊';
  if (type === 'smileyWin') return themeInfo?.smileyWin || '😎';
  if (type === 'smileyLoss') return themeInfo?.smileyLoss || '😵';
  return '💣';
}

// ── ARIA Label Generation ────────────────────────────
function getCellAriaLabel(cell, r, c) {
  if (cell.isWall) return 'Wall';
  if (cell.isRevealed) {
    if (cell.isDefused) return 'Defused mine';
    if (cell.isMine) {
      const isHit = state.hitMine && state.hitMine.row === r && state.hitMine.col === c;
      return isHit ? 'Mine, hit' : 'Mine';
    }
    if (cell.adjacentMines > 0) {
      const displayNum = cell.displayedMines != null ? cell.displayedMines
        : cell.isMystery ? null : cell.adjacentMines;
      let label = (cell.isMystery && displayNum == null) ? 'Mystery cell'
        : displayNum + (displayNum === 1 ? ' mine nearby' : ' mines nearby');
      if (cell.isLiar) label += ', liar cell';
      if (cell.isWormhole) label += ', wormhole';
      if (cell.mirrorZone) label += ', mirrored';
      return label;
    }
    return 'Empty, safe';
  }
  if (cell.isFlagged) return 'Flagged';
  let label = 'Unrevealed';
  if (cell.isLocked) label += ', locked';
  if (cell.inLiarZone) label += ', in liar zone';
  if (cell.isWormhole) label += ', wormhole';
  if (cell.mirrorZone) label += ', mirror zone';
  return label;
}

export function updateCell(r, c) {
  const cell = state.board[r]?.[c];
  if (!cell) return;
  const cellEl = boardEl.children[r * state.cols + c];
  if (!cellEl) return;

  // Wall cells are always inert
  if (cell.isWall) {
    cellEl.className = 'cell wall';
    cellEl.textContent = '';
    return;
  }

  if (cell.isRevealed) {
    if (cell.isDefused) {
      cellEl.className = 'cell revealed defused';
      cellEl.textContent = getThemeEmoji('mine');
    } else if (cell.isMine) {
      const isHit = state.hitMine && state.hitMine.row === r && state.hitMine.col === c;
      cellEl.className = `cell revealed mine${isHit ? ' mine-hit' : ''}`;
      cellEl.textContent = getThemeEmoji('mine');
    } else if (cell.adjacentMines > 0) {
      if (cell.isHiddenNumber) {
        cellEl.className = 'cell revealed hidden-number';
        cellEl.textContent = '?';
      } else {
        // Determine displayed number (may differ from real adjacentMines for gimmick cells)
        const displayNum = cell.displayedMines != null ? cell.displayedMines
          : cell.isMystery ? null : cell.adjacentMines;

        if (cell.isMystery && displayNum == null) {
          cellEl.className = 'cell revealed mystery-cell';
          cellEl.textContent = '?';
        } else {
          cellEl.className = `cell revealed num-${displayNum}`;
          cellEl.textContent = displayNum;
        }

        // Gimmick markers
        if (cell.isLiar) cellEl.classList.add('liar-cell');
        if (cell.isWormhole) {
          cellEl.classList.add('wormhole-cell');
          if (cell.wormholePairIndex != null) {
            cellEl.classList.add('wormhole-pair-' + cell.wormholePairIndex);
          }
        }
        if (cell.mirrorZone) cellEl.classList.add('mirror-cell');

        // Pop-in animation for numbered cells during cascade reveals
        if (cell.revealAnimDelay > 0) {
          cellEl.classList.add('num-pop', 'number-glow');
          cellEl.style.animationDelay = `${cell.revealAnimDelay}ms`;
        }
      }
    } else {
      cellEl.className = 'cell revealed empty';
      cellEl.textContent = '';
    }
    if (cell.revealAnimDelay > 0) {
      cellEl.style.animationDelay = `${cell.revealAnimDelay}ms`;
      cellEl.classList.add('revealing');
    }
  } else if (cell.isFlagged) {
    cellEl.className = 'cell unrevealed flagged';
    cellEl.textContent = getThemeEmoji('flag');
    // Wrong flag overlay (post-death analysis)
    if (cell.wrongFlag) cellEl.classList.add('wrong-flag');
  } else {
    cellEl.className = 'cell unrevealed';
    cellEl.textContent = '';
    // Locked cell indicator
    if (cell.isLocked) cellEl.classList.add('locked-cell');
    // Liar zone indicator on unrevealed cells
    if (cell.inLiarZone) cellEl.classList.add('liar-zone');
    // Wormhole indicator on unrevealed cells
    if (cell.isWormhole) {
      cellEl.classList.add('wormhole-unrevealed');
      if (cell.wormholePairIndex != null) {
        cellEl.classList.add('wormhole-pair-' + cell.wormholePairIndex);
      }
    }
    // Mirror zone indicator on unrevealed cells
    if (cell.mirrorZone) cellEl.classList.add('mirror-unrevealed');
    // Suggested safe move overlay (post-death analysis)
    if (cell.suggestedMove) cellEl.classList.add('suggested-move');
    // Daily suggested start cell (disappears once timer starts)
    if (cell.suggestedStart && state.gameMode === 'daily' && state.status === 'idle') {
      cellEl.classList.add('suggested-start');
    }
  }
  // Update ARIA label for screen readers
  cellEl.setAttribute('aria-label', getCellAriaLabel(cell, r, c));
}

export function updateAllCells() {
  // For daily mode before timer starts, compute and mark the best starting cell
  if (state.gameMode === "daily" && state.status === "idle" && state.board?.length > 0) {
    markDailySuggestedStart();
  }
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      updateCell(r, c);
    }
  }
  // Add "Start here" label near the suggested start cell
  updateStartHereLabel();
}

function markDailySuggestedStart() {
  const board = state.board, rows = state.rows, cols = state.cols;
  // Clear any previous mark
  for (const row of board) for (const cell of row) cell.suggestedStart = false;

  // Collect non-mine, non-wall, non-locked candidates
  let candidates = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (!cell.isMine && !cell.isWall && !cell.isLocked) {
        candidates.push({ r, c, adj: cell.adjacentMines });
      }
    }
  }

  // Use the board solver to find which starting cell gives the most
  // logically solvable board (fewest remaining unknowns / guesses).
  // Test zero-cells first (big cascades = more info), then others.
  const zeroCells = candidates.filter(c => c.adj === 0);
  const nonZeroCells = candidates.filter(c => c.adj > 0);
  const ordered = [...zeroCells, ...nonZeroCells];

  let bestCell = null;
  let bestUnknowns = Infinity;

  for (const cand of ordered) {
    const result = isBoardSolvable(board, rows, cols, cand.r, cand.c);
    if (result.solvable && result.remainingUnknowns === 0) {
      // Fully solvable from this cell — use it immediately
      bestCell = cand;
      bestUnknowns = 0;
      break;
    }
    if (result.remainingUnknowns < bestUnknowns) {
      bestUnknowns = result.remainingUnknowns;
      bestCell = cand;
    }
  }

  if (bestCell) {
    board[bestCell.r][bestCell.c].suggestedStart = true;
  }
}

function updateStartHereLabel() {
  // Remove any existing label
  const old = document.getElementById("start-here-label");
  if (old) old.remove();

  if (state.gameMode !== "daily" || state.status !== "idle") return;

  const cellEl = boardEl.querySelector(".suggested-start");
  if (!cellEl) return;

  const label = document.createElement("div");
  label.id = "start-here-label";
  label.textContent = "Start here";
  label.className = "start-here-label";

  // Position relative to the board container
  const boardRect = boardEl.getBoundingClientRect();
  const cellRect = cellEl.getBoundingClientRect();
  const x = cellRect.left - boardRect.left + cellRect.width / 2;
  const y = cellRect.top - boardRect.top - 6;

  label.style.left = x + "px";
  label.style.top = y + "px";
  boardEl.parentElement.appendChild(label);
}

/** Update only the specified cells (array of {row, col} objects) */
export function updateCells(cells) {
  for (const c of cells) {
    updateCell(c.row, c.col);
  }
}

// Dynamically adjust cell size to fit the board on screen
export function adjustCellSize() {
  const maxWidth = Math.min(window.innerWidth * 0.88, 520);
  const gapSpace = (state.cols - 1) * 2 + 8; // grid gaps + padding
  const maxCellSize = Math.floor((maxWidth - gapSpace) / state.cols);
  const cellSize = Math.min(40, Math.max(24, maxCellSize));
  document.documentElement.style.setProperty('--cell-size', cellSize + 'px');
}

// ── Zoom (for Timed mode large boards) ────────────────

export function needsZoom() {
  return state.gameMode === 'timed' && (state.cols > 13 || state.rows > 13);
}

export function updateZoom() {
  if (needsZoom()) {
    zoomControls.classList.remove('hidden');
    boardScrollWrapper.classList.add('zoomed');
    const scale = state.zoomLevel / 100;
    boardEl.style.transform = `scale(${scale})`;
    boardEl.style.transformOrigin = 'top left';
    zoomLevelDisplay.textContent = `${state.zoomLevel}%`;
  } else {
    zoomControls.classList.add('hidden');
    boardScrollWrapper.classList.remove('zoomed');
    boardEl.style.transform = '';
    boardEl.style.transformOrigin = '';
    state.zoomLevel = 100;
  }
}

export function zoomIn() {
  state.zoomLevel = Math.min(200, state.zoomLevel + 25);
  updateZoom();
}

export function zoomOut() {
  state.zoomLevel = Math.max(50, state.zoomLevel - 25);
  updateZoom();
}

// ── Keyboard Navigation ──────────────────────────────

/** Move focus to a specific cell (roving tabindex pattern) */
export function setFocusedCell(r, c) {
  // Clamp to board bounds
  r = Math.max(0, Math.min(state.rows - 1, r));
  c = Math.max(0, Math.min(state.cols - 1, c));

  // Skip wall cells — find next non-wall in direction of movement
  const cell = state.board[r]?.[c];
  if (cell && cell.isWall) return; // caller should handle wall skipping

  // Remove tabindex from old focused cell
  const oldIdx = state.focusedRow * state.cols + state.focusedCol;
  const oldEl = boardEl.children[oldIdx];
  if (oldEl) oldEl.tabIndex = -1;

  // Set new focus
  state.focusedRow = r;
  state.focusedCol = c;
  const newIdx = r * state.cols + c;
  const newEl = boardEl.children[newIdx];
  if (newEl) {
    newEl.tabIndex = 0;
    newEl.focus();
  }
}

/** Get the DOM element for a specific cell */
export function getCellElement(r, c) {
  return boardEl.children[r * state.cols + c] || null;
}

// ── Screen Reader Announcements ──────────────────────

let _liveRegion = null;

/** Announce a message to screen readers via aria-live region */
export function announceGame(message) {
  if (!_liveRegion) {
    _liveRegion = document.getElementById('sr-announcements');
    if (!_liveRegion) {
      _liveRegion = document.createElement('div');
      _liveRegion.id = 'sr-announcements';
      _liveRegion.setAttribute('role', 'status');
      _liveRegion.setAttribute('aria-live', 'polite');
      _liveRegion.setAttribute('aria-atomic', 'true');
      _liveRegion.className = 'sr-only';
      document.body.appendChild(_liveRegion);
    }
  }
  // Clear then set to trigger announcement even for repeated messages
  _liveRegion.textContent = '';
  setTimeout(() => { _liveRegion.textContent = message; }, 100);
}
