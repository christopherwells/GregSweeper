import { state } from '../state/gameState.js';
import { boardEl, zoomControls, zoomLevelDisplay, boardScrollWrapper } from './domHelpers.js';
import { THEME_UNLOCKS } from './themeManager.js';
import { loadEmojiPack, getActiveEmojiPack } from './collectionManager.js';
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
  const gap = parseFloat(getComputedStyle(boardEl).gap) || 2;
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

// ── Wall Overlay Rendering ──────────────────────────
// Renders continuous wall lines between cells as absolutely-positioned divs
// so walls visually connect across grid gaps.

export function renderWallOverlays() {
  // Remove old wall overlay container
  const board = boardEl.parentElement;
  if (!board) return;
  const oldOverlay = board.querySelector('.wall-overlay-container');
  if (oldOverlay) oldOverlay.remove();

  const wallEdges = state.board?._wallEdges;
  if (!wallEdges || wallEdges.size === 0) return;

  // Make board container position:relative for absolute overlay positioning
  board.style.position = 'relative';

  const overlay = document.createElement('div');
  overlay.className = 'wall-overlay-container';

  // Use actual cell positions from the DOM for pixel-perfect wall placement
  const cols = state.cols;
  const boardRect = boardEl.getBoundingClientRect();
  const boardX = boardEl.offsetLeft;
  const boardY = boardEl.offsetTop;

  // Cache cell rects (relative to board parent)
  function getCellPos(r, c) {
    const el = boardEl.children[r * cols + c];
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      left: rect.left - boardRect.left + boardX,
      top: rect.top - boardRect.top + boardY,
      right: rect.right - boardRect.left + boardX,
      bottom: rect.bottom - boardRect.top + boardY,
      width: rect.width,
      height: rect.height,
    };
  }

  for (const key of wallEdges) {
    const [from, to] = key.split('-');
    const [r1, c1] = from.split(',').map(Number);
    const [r2, c2] = to.split(',').map(Number);

    const pos1 = getCellPos(r1, c1);
    const pos2 = getCellPos(r2, c2);
    if (!pos1 || !pos2) continue;

    const line = document.createElement('div');
    line.className = 'wall-line';

    if (r1 === r2) {
      // Vertical wall between two columns at same row
      const midX = (Math.max(pos1.right, pos2.right) + Math.min(pos1.left, pos2.left)) / 2;
      // Actually: midpoint between the right edge of left cell and left edge of right cell
      const leftCell = c1 < c2 ? pos1 : pos2;
      const rightCell = c1 < c2 ? pos2 : pos1;
      const x = (leftCell.right + rightCell.left) / 2;
      line.classList.add('wall-line-v');
      line.style.left = x + 'px';
      line.style.top = pos1.top + 'px';
      line.style.height = pos1.height + 'px';
    } else {
      // Horizontal wall between two rows at same column
      const topCell = r1 < r2 ? pos1 : pos2;
      const bottomCell = r1 < r2 ? pos2 : pos1;
      const y = (topCell.bottom + bottomCell.top) / 2;
      line.classList.add('wall-line-h');
      line.style.left = pos1.left + 'px';
      line.style.top = y + 'px';
      line.style.width = pos1.width + 'px';
    }

    overlay.appendChild(line);
  }

  board.appendChild(overlay);
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
  return label;
}

export function updateCell(r, c) {
  const cell = state.board[r]?.[c];
  if (!cell) return;
  const cellEl = boardEl.children[r * state.cols + c];
  if (!cellEl) return;

  if (cell.isRevealed) {
    if (cell.isDefused) {
      cellEl.className = 'cell revealed defused';
      cellEl.textContent = getThemeEmoji('mine');
    } else if (cell.isMine) {
      const isHit = state.hitMine && state.hitMine.row === r && state.hitMine.col === c;
      cellEl.className = `cell revealed mine${isHit ? ' mine-hit' : ''}`;
      cellEl.textContent = getThemeEmoji('mine');
      if (cell.correctFlag) cellEl.classList.add('correct-flag');
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
        if (cell.isSonar) {
          cellEl.classList.add('sonar-cell');
          cellEl.textContent = '📡' + displayNum;
        }
        if (cell.isCompass) {
          cellEl.classList.add('compass-cell');
          cellEl.textContent = displayNum + (cell.compassArrow || '');
        }
        if (cell.isPressurePlate && !cell.plateDisarmed) {
          cellEl.classList.add('pressure-plate');
        }
        if (cell.isWormhole) {
          cellEl.classList.add('wormhole-cell');
          if (cell.wormholePairIndex != null) {
            cellEl.classList.add('wormhole-pair-' + cell.wormholePairIndex);
          }
        }
        if (cell.mirrorZone) {
          cellEl.classList.add('mirror-cell');
          if (cell.mirrorZone.top) cellEl.classList.add('mirror-zone-top');
          if (cell.mirrorZone.bottom) cellEl.classList.add('mirror-zone-bottom');
          if (cell.mirrorZone.left) cellEl.classList.add('mirror-zone-left');
          if (cell.mirrorZone.right) cellEl.classList.add('mirror-zone-right');
          if (cell.mirrorZone.pairIndex >= 0) cellEl.classList.add('mirror-pair-' + cell.mirrorZone.pairIndex);
        }

        // Pop-in animation for numbered cells during cascade reveals
        if (cell.revealAnimDelay > 0) {
          cellEl.classList.add('num-pop', 'number-glow');
          cellEl.style.animationDelay = `${cell.revealAnimDelay}ms`;
        }
      }
    } else {
      cellEl.className = 'cell revealed empty';
      cellEl.textContent = '';
      if (cell.mirrorZone) {
        cellEl.classList.add('mirror-cell');
        if (cell.mirrorZone.top) cellEl.classList.add('mirror-zone-top');
        if (cell.mirrorZone.bottom) cellEl.classList.add('mirror-zone-bottom');
        if (cell.mirrorZone.left) cellEl.classList.add('mirror-zone-left');
        if (cell.mirrorZone.right) cellEl.classList.add('mirror-zone-right');
        if (cell.mirrorZone.pairIndex >= 0) cellEl.classList.add('mirror-pair-' + cell.mirrorZone.pairIndex);
      }
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
    if (cell.correctFlag) cellEl.classList.add('correct-flag');
  } else {
    cellEl.className = 'cell unrevealed';
    cellEl.textContent = '';
    // Locked cell indicator
    if (cell.isLocked) cellEl.classList.add('locked-cell');
    // Wormholes: no indicator on unrevealed cells (revealed on discovery)
    // Mirror zone indicator on unrevealed cells
    if (cell.mirrorZone) {
      const zoneVisible = _mirrorZoneVisible != null ? _mirrorZoneVisible
        : state.board.some(row => row.some(c => c.mirrorZone && c.isRevealed));
      if (zoneVisible) {
        cellEl.classList.add('mirror-unrevealed');
        if (cell.mirrorZone.top) cellEl.classList.add('mirror-zone-top');
        if (cell.mirrorZone.bottom) cellEl.classList.add('mirror-zone-bottom');
        if (cell.mirrorZone.left) cellEl.classList.add('mirror-zone-left');
        if (cell.mirrorZone.right) cellEl.classList.add('mirror-zone-right');
      }
    }
    // Suggested safe move overlay (post-death analysis)
    if (cell.suggestedMove) cellEl.classList.add('suggested-move');
    // Daily suggested start cell (shows when board is fresh or re-fogged)
    if (cell.suggestedStart && state.gameMode === 'daily' &&
        (state.status === 'idle' || (state.status === 'playing' && state.revealedCount <= 1))) {
      cellEl.classList.add('suggested-start');
    }
  }
  // Wall overlays rendered separately by renderWallOverlays()
  // Update ARIA label for screen readers
  cellEl.setAttribute('aria-label', getCellAriaLabel(cell, r, c));
}

// Cached per updateAllCells pass to avoid O(n^2) mirror zone scan
let _mirrorZoneVisible = null;

export function updateAllCells() {
  _mirrorZoneVisible = state.board.some(row => row.some(c => c.mirrorZone && c.isRevealed));
  // For daily mode: apply cached suggested start position (computed in newGame)
  const dailyNeedsStart = state.gameMode === "daily" && state.board?.length > 0 &&
    (state.status === "idle" || (state.status === "playing" && state.revealedCount <= 1));
  if (dailyNeedsStart && _dailySuggestedCell) {
    for (const row of state.board) for (const cell of row) cell.suggestedStart = false;
    state.board[_dailySuggestedCell.r][_dailySuggestedCell.c].suggestedStart = true;
  }
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      updateCell(r, c);
    }
  }
  updateStartHereLabel();
  _mirrorZoneVisible = null;
}

// Stores the suggested start position so it persists across re-fogs after bomb hits
let _dailySuggestedCell = null;

/** Set the cached daily suggested start cell (computed in gameActions.newGame) */
export function setDailySuggestedCell(cell) {
  _dailySuggestedCell = cell;
}

function updateStartHereLabel() {
  // Remove any existing label
  const old = document.getElementById("start-here-label");
  if (old) old.remove();

  if (state.gameMode !== "daily") return;
  if (state.status !== "idle" && !(state.status === "playing" && state.revealedCount <= 1)) return;

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
