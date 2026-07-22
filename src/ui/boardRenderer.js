import { state } from '../state/gameState.js';
import { boardEl, zoomControls, boardScrollWrapper } from './domHelpers.js';
import { THEME_UNLOCKS } from './themeManager.js';
import { applyIcon, uiSpriteImgHTML } from './spriteLoader.js';
import { applyThemeEffects } from './themeEffects.js';
import {
  octagonClipPath, DIAMOND_CLIP_PATH, SQ_BOX_FRAC,
  HEXAGON_CLIP_PATH, HEX_R, HEX_BOX_H,
} from '../logic/tilingGeometry.js';
import { sonarScanCells, compassRayCells } from '../logic/adjacency.js';

// ── Board Rendering ────────────────────────────────────

// Cell-size clamp bounds are theme-overridable via --cell-min-size /
// --cell-max-size (responsive) and --cell-fit-max-size (fit-to-screen). JS owns
// --cell-size at runtime, so these tokens are the only way a theme can widen or
// tighten cells. Defaults preserve the original 18/50 and 18/40 clamps exactly.
function _cellBound(name, fallback) {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(v) ? v : fallback;
}

// Vertical space the board may fill before it has to scroll. Mirrors
// #board-scroll-wrapper's `max-height: 70vh` in global.css — read the resolved
// pixel value so the two never drift, falling back to 0.70·innerHeight when the
// computed value isn't expressed in px.
function _boardHeightBudget() {
  if (boardScrollWrapper) {
    const mh = getComputedStyle(boardScrollWrapper).maxHeight;
    if (mh && mh.endsWith('px')) {
      const px = parseFloat(mh);
      if (Number.isFinite(px) && px > 0) return px;
    }
  }
  return window.innerHeight * 0.70;
}

// Largest cell size (px) that fits state.cols across `widthBudget` AND
// state.rows down the board's vertical budget, clamped to [min, maxCap].
// Fitting by width alone overflows tall, narrow boards: weekly samples rows up
// to 14 but caps cols at 12, so a 14×8 board sized to its width gets cells big
// enough to push the board past the 70vh scroll wrapper, hiding the lower rows
// (the "too zoomed in, can't see where to play" report). The height term keeps
// the whole board on screen. `widthBudget` is already net of board border+pad.
function _fitCellSize(widthBudget, gap, maxCap) {
  const min = _cellBound('--cell-min-size', 18);
  const widthFit = Math.floor((widthBudget - (state.cols - 1) * gap) / state.cols);
  const heightBudget = _boardHeightBudget() - 8; // 2px border + 2px padding, top+bottom
  const heightFit = Math.floor((heightBudget - (state.rows - 1) * gap) / state.rows);
  return Math.min(maxCap, Math.max(min, Math.min(widthFit, heightFit)));
}

// A board declares a non-rectangular topology by carrying per-cell GEOMETRY
// (_cellPos) — Project Coastline's tiling boards. The renderer keys off the
// board itself, NOT the game mode, so the same layout path serves a test board
// today and daily/weekly/challenge tiling boards later.
function _isTiling() {
  return !!(state.board && state.board._cellPos);
}

// Largest octagon PITCH (px) that fits an M×N tiling in both the width and the
// height budget. The tiling spans N×pitch wide and M×pitch tall; the octagon
// flat width IS the pitch, so pitch plays the role of --cell-size for font
// scaling and the legibility clamp. Same [min, maxCap] band as a square cell.
function _fitTilingPitch(widthBudget, heightBudget, maxCap) {
  const min = _cellBound('--cell-min-size', 18);
  const { wUnits, hUnits } = _tilingExtent();
  const pw = Math.floor(widthBudget / wUnits);
  const ph = Math.floor(heightBudget / hUnits);
  return Math.min(maxCap, Math.max(min, Math.min(pw, ph)));
}

// The tiling's extent in PITCH UNITS (multiples of --cell-size). A 4.8.8 spans
// exactly N x M pitches, so its extent is its octagon-lattice size; a honeycomb
// is wider than N (odd rows are offset half a hex) and shorter than M (rows
// overlap vertically), so the extent has to come from the geometry rather than
// the cell counts. Falls back to the old N/M reading for any board that predates
// the descriptor.
function _tilingExtent() {
  const t = (state.board && state.board._tiling) || {};
  return {
    wUnits: t.wUnits || t.N || state.cols,
    hUnits: t.hUnits || t.M || state.rows,
  };
}

export function resizeCells() {
  const container = document.getElementById('board-container');
  if (!container || !state.cols || !state.rows) return;
  const borderPad = 8; // 2px border + 2px padding on each side
  const availableWidth = container.clientWidth - borderPad;
  if (_isTiling()) {
    const heightBudget = _boardHeightBudget() - 8;
    const pitch = _fitTilingPitch(availableWidth, heightBudget, _cellBound('--cell-max-size', 50));
    document.documentElement.style.setProperty('--cell-size', `${pitch}px`);
    return;
  }
  const gap = parseFloat(getComputedStyle(boardEl).gap) || 2;
  const capped = _fitCellSize(availableWidth, gap, _cellBound('--cell-max-size', 50));
  document.documentElement.style.setProperty('--cell-size', `${capped}px`);
}

export function renderBoard() {
  boardEl.innerHTML = '';
  resizeCells();

  if (_isTiling()) {
    _renderTilingBoard();
  } else {
    // Rectangular CSS grid. Reset any tiling inline layout a prior game set
    // (the surface swaps between board shapes within one session).
    boardEl.classList.remove('tiling-board');
    boardEl.style.display = '';
    boardEl.style.width = '';
    boardEl.style.height = '';
    boardEl.style.boxSizing = '';
    boardEl.style.padding = '';
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

  // `boardEl.innerHTML = ''` above destroyed the prior ambient-effects layer
  // (.theme-fx lives inside #board). Re-apply it so animations persist across
  // board rebuilds (new game / next level / resume) instead of vanishing until
  // the next theme switch — and so the previous particle loops get torn down
  // rather than firing forever into a detached node.
  applyThemeEffects(document.documentElement.getAttribute('data-theme') || 'classic');
}

// ── Tiling layout ────────────────────────────────────
// A non-rectangular (Archimedean tiling) board: cells stay DOM <div>s in
// flat-index order — so updateCell, getCellElement, setFocusedCell, the click
// handler (dataset.row/col), and the rect-reading overlays (walls, worms, the
// start-here label) all keep working unchanged — but they are POSITIONED
// absolutely from their unit-pitch geometry and shaped with a clip-path
// (octagon / diamond) instead of flowing in a CSS grid of uniform squares. All
// per-cell layout is INLINE style, which survives updateCell's className rebuilds.
function _renderTilingBoard() {
  const board = state.board;
  const { wUnits, hUnits } = _tilingExtent();
  const P = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell-size')) || 40;

  boardEl.classList.add('tiling-board');
  // content-box + no padding so the board's own width IS the tiling's extent
  // and the edge octagons land exactly inside it (no hairline overflow clip).
  boardEl.style.display = 'block';
  boardEl.style.boxSizing = 'content-box';
  boardEl.style.padding = '0';
  boardEl.style.gridTemplateColumns = '';
  boardEl.style.gridTemplateRows = '';
  boardEl.style.width = (wUnits * P) + 'px';
  boardEl.style.height = (hUnits * P) + 'px';
  boardEl.setAttribute('role', 'grid');
  boardEl.setAttribute('aria-label', 'Minesweeper board');

  const clipOct = octagonClipPath();
  const shouldAnimate = state._initialized;
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      const pos = board._cellPos[r * state.cols + c];
      const cellEl = document.createElement('div');
      cellEl.className = 'cell unrevealed';
      cellEl.dataset.row = r;
      cellEl.dataset.col = c;
      cellEl.setAttribute('role', 'gridcell');
      cellEl.setAttribute('aria-rowindex', r + 1);
      cellEl.setAttribute('aria-colindex', c + 1);
      cellEl.setAttribute('aria-label', 'Unrevealed cell');
      cellEl.tabIndex = (r === state.focusedRow && c === state.focusedCol) ? 0 : -1;

      cellEl.style.position = 'absolute';
      if (pos && pos.shape === 'sq') {
        const box = SQ_BOX_FRAC * P;
        cellEl.style.left = ((pos.cx - SQ_BOX_FRAC / 2) * P) + 'px';
        cellEl.style.top = ((pos.cy - SQ_BOX_FRAC / 2) * P) + 'px';
        cellEl.style.width = box + 'px';
        cellEl.style.height = box + 'px';
        cellEl.style.clipPath = DIAMOND_CLIP_PATH;
        cellEl.style.fontSize = (box * 0.5) + 'px';
      } else if (pos && pos.shape === 'hex') {
        // Pointy-top hexagon: the box is one pitch WIDE and 2R tall, centered on
        // the cell's geometric center, so the number lands dead center. Boxes of
        // neighboring hexes overlap, but the clip-paths tile exactly — which is
        // also what makes pointer hit-testing land on the right hexagon.
        cellEl.style.left = ((pos.cx - 0.5) * P) + 'px';
        cellEl.style.top = ((pos.cy - HEX_R) * P) + 'px';
        cellEl.style.width = P + 'px';
        cellEl.style.height = (HEX_BOX_H * P) + 'px';
        cellEl.style.clipPath = HEXAGON_CLIP_PATH;
        cellEl.style.fontSize = (P * 0.5) + 'px';
      } else if (pos) {
        cellEl.style.left = ((pos.cx - 0.5) * P) + 'px';
        cellEl.style.top = ((pos.cy - 0.5) * P) + 'px';
        cellEl.style.width = P + 'px';
        cellEl.style.height = P + 'px';
        cellEl.style.clipPath = clipOct;
        cellEl.style.fontSize = (P * 0.5) + 'px';
      }

      if (shouldAnimate) {
        const delay = (r + c) * 12;
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

  // Tiling boards sever graph edges (board._tilingWalls, flat index pairs)
  // instead of the rectangular "r,c-r,c" edge set — draw a bar across the shared
  // boundary of each severed pair rather than a horizontal/vertical grid line.
  if (state.board?._tilingWalls && state.board._tilingWalls.length > 0) {
    _renderTilingWalls(board);
    return;
  }

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

// Draw a wall bar on the TRUE shared edge of each severed pair. Each wall carries
// the edge's two endpoints in unit-pitch coords (board._tilingWalls, set by
// applyWallsTiling); the bar lies exactly along that segment, so octagon/octagon
// walls are axis-aligned and octagon/square walls sit on the real 45° boundary.
// Continuous walls share endpoints, so the bars connect end to end. Unit coords
// are anchored to octagon(0,0) = DOM cell 0 (whose box IS the pitch P), so this
// re-lays correctly on resize / theme refit like the other overlays.
function _renderTilingWalls(boardParent) {
  const walls = state.board._tilingWalls;
  boardParent.style.position = 'relative';
  const overlay = document.createElement('div');
  overlay.className = 'wall-overlay-container';

  const ref = boardEl.children[0];
  if (ref && ref.classList && ref.classList.contains('cell') && walls.length) {
    const boardRect = boardEl.getBoundingClientRect();
    const boardX = boardEl.offsetLeft, boardY = boardEl.offsetTop;
    const r0 = ref.getBoundingClientRect();
    const P = r0.width; // both tilings: cell 0's box is exactly one pitch wide
    // Anchor on cell 0's OWN geometric center rather than assuming unit
    // (0.5, 0.5). Every shape's box is centered on its cell center, but a
    // hexagon's box is taller than it is wide (its center sits at cy = R), so
    // hard-coding half a pitch vertically would offset every hex wall.
    const p0 = (state.board._cellPos && state.board._cellPos[0]) || { cx: 0.5, cy: 0.5 };
    const ox = (r0.left - boardRect.left + boardX) + r0.width / 2;
    const oy = (r0.top - boardRect.top + boardY) + r0.height / 2;
    const toPx = (x, y) => ({ x: ox + (x - p0.cx) * P, y: oy + (y - p0.cy) * P });

    const THICK = 4;
    for (const wl of walls) {
      const p1 = toPx(wl.x1, wl.y1), p2 = toPx(wl.x2, wl.y2);
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180 / Math.PI;
      const line = document.createElement('div');
      line.className = 'tiling-wall-line';
      line.style.left = (mx - len / 2) + 'px';
      line.style.top = (my - THICK / 2) + 'px';
      line.style.width = len + 'px';
      line.style.transform = `rotate(${angle}deg)`; // bar lies along the edge itself
      overlay.appendChild(line);
    }
  }
  boardParent.appendChild(overlay);
}

export function getThemeEmoji(type) {
  // Theme-owned objects only. Emoji packs (the old per-player override
  // layer) were cut with the Collection declutter — the theme IS the
  // object identity now, which also means theme sprites always match.
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'classic';
  const themeInfo = THEME_UNLOCKS[currentTheme];
  // "Classic mines & flags" setting: a player who likes the themed worlds
  // but not the recolored objects pins the mine, flag, and exploded-mine
  // (strike) back to the canonical glyphs — these resolve to the original
  // mine.png / flag.png / strike.png sprites on every theme. Numbers,
  // backgrounds, and Greg (smiley) stay themed.
  const classicObjects = document.documentElement.getAttribute('data-classic-objects') === 'true';
  if (type === 'mine') return classicObjects ? '💣' : (themeInfo?.mine || '💣');
  if (type === 'flag') return classicObjects ? '🚩' : (themeInfo?.flag || '🚩');
  if (type === 'smiley') return themeInfo?.smiley || '😊';
  if (type === 'smileyWin') return themeInfo?.smileyWin || '😎';
  if (type === 'smileyLoss') return themeInfo?.smileyLoss || '😵';
  // The "bomb you actually hit." A theme may give it a distinct glyph
  // (e.g. forest: acorn mine → fallen-tree strike) via `strikeCell`. Falling
  // back to the theme's mine keeps today's behavior (and the canonical 💣
  // still resolves to strike.png on Classic/Dark via the sprite path).
  if (type === 'strikeCell') return classicObjects ? '💣' : (themeInfo?.strikeCell || themeInfo?.mine || '💣');
  return '💣';
}

// ── ARIA Label Generation ────────────────────────────
function getCellAriaLabel(cell, r, c) {
  if (cell.isRevealed) {
    if (cell.isStrike) return 'Exploded mine';
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
      if (cell.mirrorPair) label += ', mirrored';
      if (cell.isSonar) label += ', sonar range';
      if (cell.isCompass) label += ', compass direction';
      if (cell.isPressurePlate) label += ', pressure plate';
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
    if (cell.isStrike) {
      // Strike cell renders for two distinct mechanics:
      //   1. Daily/weekly bomb-hit (cell.isMine flipped to false in
      //      handleDailyBombHit, isStrike marks the defused spot).
      //   2. Challenge/timed game-over cascade — every non-flagged mine
      //      gets isStrike via chainRevealMines.
      // In case 2 the hit mine needs to stand out from the rest of the
      // cascade so the player can see which mine ended the game. The
      // `.mine-hit` class adds the strong red background + glow on top
      // of the soft .strike-cell tint. state.hitMine is only set by
      // handleLoss (challenge/timed) and stays null in daily/weekly,
      // so the same check cleanly excludes the daily path.
      const isHit = state.hitMine && state.hitMine.row === r && state.hitMine.col === c;
      cellEl.className = `cell revealed strike-cell${isHit ? ' mine-hit' : ''}`;
      applyIcon(cellEl, 'strikeCell', getThemeEmoji('strikeCell'), { sizeClass: 'sprite-cell' });
    } else if (cell.isDefused) {
      cellEl.className = 'cell revealed defused';
      applyIcon(cellEl, 'mine', getThemeEmoji('mine'), { sizeClass: 'sprite-cell' });
    } else if (cell.isMine) {
      const isHit = state.hitMine && state.hitMine.row === r && state.hitMine.col === c;
      cellEl.className = `cell revealed mine${isHit ? ' mine-hit' : ''}`;
      applyIcon(cellEl, isHit ? 'strikeCell' : 'mine', getThemeEmoji(isHit ? 'strikeCell' : 'mine'), { sizeClass: 'sprite-cell' });
      if (cell.correctFlag) cellEl.classList.add('correct-flag');
    } else if (cell.adjacentMines > 0 || (cell.displayedMines != null && cell.displayedMines > 0)) {
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
          if (_isTiling()) {
            // Side-by-side sprite + number overran the small clipped cell, so
            // OVERLAP them: the sonar symbol as a centered watermark, the number
            // bold on top. Both the identity (the symbol) and the count survive,
            // and the combined footprint fits the clip — no new colors needed.
            cellEl.classList.add('sonar-tiling');
            cellEl.innerHTML = uiSpriteImgHTML('modSonar', 'sonar-bg')
              + `<span class="sonar-num">${displayNum}</span>`;
          } else {
            cellEl.innerHTML = uiSpriteImgHTML('modSonar', 'sonar-marker') + displayNum;
          }
        }
        if (cell.isCompass) {
          cellEl.classList.add('compass-cell');
          const arrow = cell.compassArrow || '';
          if (_isTiling() && arrow) {
            // A smaller arrow so the number + direction both fit inside the clip.
            cellEl.innerHTML = `${displayNum}<span class="compass-dir-sm">${arrow}</span>`;
          } else {
            cellEl.textContent = displayNum + arrow;
          }
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
        if (cell.mirrorPair) {
          cellEl.classList.add('mirror-cell');
          if (cell.mirrorPair.pairIndex != null) {
            cellEl.classList.add('mirror-pair-' + cell.mirrorPair.pairIndex);
          }
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
    }
    if (cell.revealAnimDelay > 0) {
      cellEl.style.animationDelay = `${cell.revealAnimDelay}ms`;
      cellEl.classList.add('revealing');
    }
  } else if (cell.isFlagged) {
    cellEl.className = 'cell unrevealed flagged';
    applyIcon(cellEl, 'flag', getThemeEmoji('flag'), { sizeClass: 'sprite-cell' });
    // Wrong flag overlay (post-death analysis)
    if (cell.wrongFlag) cellEl.classList.add('wrong-flag');
    if (cell.correctFlag) cellEl.classList.add('correct-flag');
  } else {
    cellEl.className = 'cell unrevealed';
    cellEl.textContent = '';
    // Locked cell indicator
    if (cell.isLocked) cellEl.classList.add('locked-cell');
    // Wormholes and mirrors: no indicator on unrevealed cells (revealed on discovery)
    // Suggested safe move overlay (post-death analysis)
    if (cell.suggestedMove) cellEl.classList.add('suggested-move');
    // Loss-receipt frontier: every provably-safe-at-death cell gets a
    // quiet outline so the explore view shows the WHOLE proof surface,
    // not just the one NEXT MOVE chip.
    if (cell.frontierSafe) cellEl.classList.add('frontier-safe');
    // Daily / weekly suggested start cell (shows when board is fresh or re-fogged)
    if (cell.suggestedStart && (state.gameMode === 'daily' || state.gameMode === 'weekly' || state.coastlinePractice) &&
        (state.status === 'idle' || (state.status === 'playing' && state.revealedCount <= 1))) {
      cellEl.classList.add('suggested-start');
    }
  }
  // Wall overlays rendered separately by renderWallOverlays()
  // Update ARIA label for screen readers
  cellEl.setAttribute('aria-label', getCellAriaLabel(cell, r, c));
}

export function updateAllCells() {
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
}

// Stores the suggested start position so it persists across re-fogs after bomb hits
let _dailySuggestedCell = null;

/** Set the cached daily suggested start cell (computed in gameActions.newGame) */
export function setDailySuggestedCell(cell) {
  _dailySuggestedCell = cell;
}

function _placeLabel(cellEl, id, text, className, position = "above") {
  const label = document.createElement("div");
  label.id = id;
  label.textContent = text;
  label.className = className;
  // Anchor INSIDE #board with board-relative coordinates so the label
  // tracks its cell through page scroll, the inner #board-scroll-wrapper
  // scroll (zoomed Quick Play boards), and resizes. The old
  // position:fixed captured viewport coords ONCE and nothing repositioned
  // on scroll — a phone player who scrolled before their first daily
  // click saw "Start here" (the certified no-guess entry marker) hovering
  // over the WRONG cell. The historical reason for fixed — a
  // non-positioned ancestor made board-relative math drift ~130 px — is
  // gone: #board itself is position:relative, and the label is absolute
  // within it (absolutely-positioned grid children take no grid slot, so
  // boardEl.children cell indexing is unaffected — labels append last).
  const cellRect = cellEl.getBoundingClientRect();
  const boardRect = boardEl.getBoundingClientRect();
  const cx = cellRect.left - boardRect.left + cellRect.width / 2;
  const cellTop = cellRect.top - boardRect.top;
  label.style.left = cx + "px";
  // #board is overflow:hidden, so an "above" label on a top-row cell
  // would be clipped — center those on the cell instead.
  const fitsAbove = cellTop >= 20;
  if (position === "on" || !fitsAbove) {
    label.style.top = (cellTop + cellRect.height / 2) + "px";
    label.classList.add("label-on-cell");
  } else {
    label.style.top = (cellTop - 6) + "px";
  }
  boardEl.appendChild(label);
  // Clamp horizontally: an edge-column label wider than its cell would
  // overhang the board and be clipped by the same overflow:hidden.
  const half = label.offsetWidth / 2;
  const clamped = Math.min(Math.max(cx, half + 2), boardRect.width - half - 2);
  if (clamped !== cx) label.style.left = clamped + "px";
}

function updateStartHereLabel() {
  // Always remove existing labels first so they don't double up on
  // re-render or stick around after the cell they pointed at is gone.
  document.getElementById("start-here-label")?.remove();
  document.getElementById("next-move-label")?.remove();

  // Daily "Start here" — pre-first-click marker for the solver's best
  // opener. Only shows on daily mode while the board is fresh.
  if ((state.gameMode === "daily" || state.coastlinePractice) &&
      (state.status === "idle" || (state.status === "playing" && state.revealedCount <= 1))) {
    const startCell = boardEl.querySelector(".suggested-start");
    if (startCell) _placeLabel(startCell, "start-here-label", "Start here", "start-here-label");
  }

  // Post-loss "NEXT MOVE" — the solver-suggested safe cell that would
  // have been the right click instead of the mine. Fires on any mode
  // that sets cell.suggestedMove (challenge + timed; handleLoss sets
  // it before the cascade reveals). Positioned ON the cell (centered)
  // rather than floating above, so the chip clearly anchors to the
  // blue-outlined square instead of looking detached.
  if (state.status === "lost") {
    const nextCell = boardEl.querySelector(".suggested-move");
    if (nextCell) _placeLabel(nextCell, "next-move-label", "NEXT MOVE", "next-move-label", "on");
  }
}

/** Update only the specified cells (array of {row, col} objects) */
export function updateCells(cells) {
  for (const c of cells) {
    updateCell(c.row, c.col);
  }
}

// ── Sonar / compass region reveal ────────────────────
// A sonar or compass number counts mines over a REGION the player can't always
// eyeball — a 5×5 block on a square grid, an irregular graph blob on a tiling.
// Hovering (desktop) or tapping (mobile) the cell lights up exactly the cells
// its number counts. Single-sourced from adjacency.js (sonarScanCells /
// compassRayCells), so the highlight shows precisely what the certifier proved
// from — it hands over the AREA, never which cells hold the mines.

/**
 * Flat indices of the cells a revealed sonar/compass cell's number counts, or
 * null if the cell references no region.
 */
export function gimmickRegionCells(row, col) {
  const cell = state.board?.[row]?.[col];
  if (!cell || !cell.isRevealed) return null;
  const { rows, cols } = state;
  if (cell.isSonar) return sonarScanCells(state.board, rows, cols, row, col);
  if (cell.isCompass) {
    // On an explicit topology the ray was precomputed and stored at generation
    // (compassRayCells throws there); a rectangle walks it from the direction.
    if (state.board._cellNeighbors) return cell.compassRay || null;
    if (cell.compassDir) return compassRayCells(state.board, rows, cols, row, col, cell.compassDir);
  }
  return null;
}

let _regionShown = null; // { row, col } currently highlighted, else null

/** Highlight the region a sonar/compass cell counts (no-op for other cells). */
export function showGimmickRegion(row, col) {
  clearGimmickRegion();
  const region = gimmickRegionCells(row, col);
  if (!region || region.length === 0) return;
  for (const idx of region) {
    const el = boardEl.children[idx];
    if (el && el.classList && el.classList.contains('cell')) el.classList.add('region-highlight');
  }
  const src = boardEl.children[row * state.cols + col];
  if (src && src.classList && src.classList.contains('cell')) src.classList.add('region-source');
  _regionShown = { row, col };
}

/** Remove any active region highlight. */
export function clearGimmickRegion() {
  // Nothing is highlighted → skip the board-wide DOM query. This runs on every
  // hover onto a non-region cell, so the early-out keeps cursor movement cheap.
  if (!boardEl || !_regionShown) return;
  for (const el of boardEl.querySelectorAll('.region-highlight, .region-source')) {
    el.classList.remove('region-highlight', 'region-source');
  }
  _regionShown = null;
}

/** The cell whose region is currently highlighted, or null. */
export function regionShownFor() {
  return _regionShown;
}

// Dynamically adjust cell size to fit the board on screen
export function adjustCellSize() {
  if (!state.cols || !state.rows) return;
  const maxWidth = Math.min(window.innerWidth * 0.88, 520);
  const widthBudget = maxWidth - 8; // 2px border + 2px padding, left+right
  if (_isTiling()) {
    const heightBudget = _boardHeightBudget() - 8;
    const pitch = _fitTilingPitch(widthBudget, heightBudget, _cellBound('--cell-fit-max-size', 40));
    document.documentElement.style.setProperty('--cell-size', pitch + 'px');
    return;
  }
  // Read the LIVE gap like resizeCells does — themes override --grid-gap
  // (candy 3px, matrix 1px), and the old hardcoded 2 oversized the fit by
  // (cols-1)px per extra gap pixel.
  const gap = parseFloat(getComputedStyle(boardEl).gap) || 2;
  const cellSize = _fitCellSize(widthBudget, gap, _cellBound('--cell-fit-max-size', 40));
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
