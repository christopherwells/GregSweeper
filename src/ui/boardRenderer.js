import { state } from '../state/gameState.js?v=0.9.2';
import { boardEl, zoomControls, zoomLevelDisplay, boardScrollWrapper } from './domHelpers.js?v=0.9.2';
import { THEME_UNLOCKS } from './themeManager.js?v=0.9.2';
import { loadEmojiPack, getActiveEmojiPack } from './collectionManager.js?v=0.9.2';

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

  const shouldAnimate = state._initialized;
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      const cellEl = document.createElement('div');
      cellEl.className = 'cell unrevealed';
      cellEl.dataset.row = r;
      cellEl.dataset.col = c;
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
        if (cell.isWormhole) cellEl.classList.add('wormhole-cell');
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
    // Wormhole indicator on unrevealed cells
    if (cell.isWormhole) cellEl.classList.add('wormhole-unrevealed');
    // Mirror zone indicator on unrevealed cells
    if (cell.mirrorZone) cellEl.classList.add('mirror-unrevealed');
    // Suggested safe move overlay (post-death analysis)
    if (cell.suggestedMove) cellEl.classList.add('suggested-move');
  }
}

export function updateAllCells() {
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      updateCell(r, c);
    }
  }
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
  const cellSize = Math.min(40, Math.max(16, maxCellSize));
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
