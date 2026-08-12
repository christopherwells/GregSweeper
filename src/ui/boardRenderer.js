import { state } from '../state/gameState.js';
import { boardEl, zoomControls, boardScrollWrapper } from './domHelpers.js';
import { THEME_UNLOCKS } from './themeManager.js';
import { applyIcon, uiSpriteImgHTML } from './spriteLoader.js';
import { applyThemeEffects } from './themeEffects.js';
import { buildTiling, buildWireframe, cellOutline, SQ_BOX_FRAC } from '../logic/tilingGeometry.js';
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
// #board-scroll-wrapper's `max-height: 70vh` in global.css, read the resolved
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
// enough to push the board past the 70vh scroll wrapper, with the lower rows out of view
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
// (_cellPos), Project Coastline's tiling boards. The renderer keys off the
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

// The live pitch in px. JS owns --cell-size at runtime (resizeCells /
// adjustCellSize set it), so every tiling surface that converts unit coords to
// pixels reads it through here rather than keeping its own copy, the cell
// layout and the wall overlay have to agree on it exactly or the bars land off
// their edges.
function _pitch() {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell-size')) || 40;
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
    // A tiling cell's position/size is INLINE px computed from the pitch, so a
    // new pitch means nothing until the cells are re-laid, the rectangular
    // board gets this free because its cells read var(--cell-size) through the
    // grid. Without this the board kept its old geometry through every resize
    // and phone rotation while its container changed size around it.
    layoutTilingCells();
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
    // (the surface swaps between shapes within one session).
    boardEl.classList.remove('tiling-board');
    document.getElementById('tiling-seams')?.remove();
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
  // the next theme switch, and so the previous particle loops get torn down
  // rather than firing forever into a detached node.
  applyThemeEffects(document.documentElement.getAttribute('data-theme') || 'classic');

  // The rebuild also destroyed any live sonar/compass region highlight, which
  // must only die by clearGimmickRegion (mid-game rebuilds: resume, theme
  // switch). Re-deriving through showGimmickRegion rather than repainting the
  // cached set is deliberate, it re-checks the cell against the CURRENT board,
  // so a highlight carried from a PREVIOUS game (its cell no longer a revealed
  // sonar/compass) clears itself instead of lighting a region nobody asked for.
  if (_regionShown) showGimmickRegion(_regionShown.row, _regionShown.col);
}

// ── Tiling layout ────────────────────────────────────
// A non-rectangular tiling board: cells stay DOM <div>s in flat-index order,
// so updateCell, getCellElement, setFocusedCell, the click handler
// (dataset.row/col), and the rect-reading overlays (worms, the start-here
// label) all keep working unchanged, but they are POSITIONED absolutely from
// their unit-pitch geometry and shaped with a clip-path instead of flowing in a
// CSS grid of uniform squares. All per-cell layout is INLINE style, which
// survives updateCell's className rebuilds.

// Every cell's own box and clip-path, in PITCH UNITS, the pitch-independent
// half of the layout, so a resize only has to multiply.
//
// This used to be a per-SHAPE constant plus a hand-inlined box, which holds only
// while every cell of a shape is identical up to TRANSLATION: true of the 4.8.8
// octagon and interstitial diamond and of the hexagon, false of all four Laves
// tilings, whose single cell shape appears in several ROTATIONS (cairo 4, floret
// 6, rhombille 3, deltoidal 6). Box size does not identify the rotation either,
// rhombille's 0° and 60° rhombi share a 1 × 1.732 box and need different
// clip-paths, so anything keyed on the shape name or the box dimensions
// mis-shapes half the board without erroring. cellOutline derives both from the
// cell's own polygon, which is the rule those three branches were hand-inlined
// cases of (SQ_BOX_FRAC IS the diamond's bbox width, HEX_BOX_H IS the hexagon's
// bbox height). Verified in Chromium against the branch it replaced: every cell
// of a 4.8.8 and of a honeycomb, plain and modifier-laden, keeps a byte-identical
// inline style string AND computed clip-path / box / font-size. The octagon's
// string does differ before the browser sees it, octagonClipPath() mixed
// toFixed(3) with bare 0%/100% literals, but Chromium normalizes 37.000% to 37%,
// so nothing that can read a clip-path can tell.
//
// The polygons do not ride the board, the canonical payload carries cellPos and
// the {type, M, N} descriptor, not the vertex list, so they are rebuilt through
// buildTiling, exactly as applyWallsTiling rebuilds the wall wireframe. One
// memo slot is enough: a single board is on screen at a time, and this is asked
// again on every resize.
let _outlineKey = null;
let _outlines = null;
function _tilingOutlines(tiling) {
  const key = `${tiling.type}|${tiling.M}|${tiling.N}`;
  if (_outlineKey !== key) {
    const T = buildTiling(tiling.type, tiling.M, tiling.N);
    _outlines = T.cellVerts.map((cv) => cellOutline(T.verts, cv));
    _outlineKey = key;
  }
  return _outlines;
}

// Number size in PITCH units, by cell shape. Half a pitch everywhere but the
// 4.8.8's interstitial diamond, whose box is only SQ_BOX_FRAC of a pitch across
// and whose number is half of THAT.
//
// For the hexagon and the four Laves tilings half a pitch is exactly half the
// INSCRIBED-CIRCLE diameter, the largest circle the cell can hold, which is
// what tilingGeometry normalizes each of them to, and the right measure for
// "will a digit plus a modifier watermark fit". The 4.8.8 is not on that rule
// and deliberately stays off it: OCT_CUT cuts well past the regular-octagon
// value, so the shipped octagon's inscribed diameter is 0.820 pitch rather than
// a full one (0.891 before the cut was raised to 0.42), and applying the
// inscribed rule to the 4.8.8 would shrink the octagon's number 18% and the
// diamond's 29% on boards that read correctly today. So this is two tunings that
// agree everywhere except the diamond, not one rule with an exception. Raising
// the cut narrows the gap on its own: the diamond's number is half its own box,
// so it went from 74% of the octagon's to 84% without touching this rule.
const FONT_UNITS = 0.5;
const FONT_UNITS_SQ = SQ_BOX_FRAC * 0.5;

// Below this the drawn center IS the box center and no padding is emitted. It
// is a float-noise floor, not a design tolerance: on a centrally symmetric cell
// the two coincide exactly in real arithmetic and disagree by ~1e-15px in
// doubles, while the smallest real offset (cairo, at the minimum pitch) is
// still most of a pixel.
const ANCHOR_EPS = 1e-6; // px

// Move a cell's CONTENT (the number, the sprite, the modifier watermark) off the
// box center by (dx, dy) px. `.cell` centers its content with flex, so a
// one-sided pad shifts it by half the pad; box-sizing is border-box globally, so
// the border box, and with it the clip-path, does not move at all.
function _anchorPadding(dx, dy) {
  if (Math.abs(dx) < ANCHOR_EPS && Math.abs(dy) < ANCHOR_EPS) return '';
  const top = dy > 0 ? 2 * dy : 0, bottom = dy < 0 ? -2 * dy : 0;
  const left = dx > 0 ? 2 * dx : 0, right = dx < 0 ? -2 * dx : 0;
  return `${top}px ${right}px ${bottom}px ${left}px`;
}

// Position every tiling cell (and the board box) from the unit-pitch geometry at
// the CURRENT --cell-size. Split out of _renderTilingBoard so a pitch change can
// re-lay the EXISTING cells: rebuilding the board instead would drop keyboard
// focus, restart the cascade animation, and detach the wall/worm overlays'
// reference cell. Safe to call before the cells exist (it no-ops).
export function layoutTilingCells() {
  const board = state.board;
  if (!board || !board._cellPos || !board._tiling || !boardEl || !boardEl.children.length) return;
  const { wUnits, hUnits } = _tilingExtent();
  const P = _pitch();

  boardEl.style.width = (wUnits * P) + 'px';
  boardEl.style.height = (hUnits * P) + 'px';

  const outlines = _tilingOutlines(board._tiling);
  const total = state.rows * state.cols;
  for (let i = 0; i < total; i++) {
    const cellEl = boardEl.children[i];
    // #board also contains the .theme-fx layer, which is appended after the cells.
    if (!cellEl || !cellEl.classList || !cellEl.classList.contains('cell')) continue;
    const pos = board._cellPos[i];
    const box = outlines[i];
    if (!pos || !box) continue;

    // Boxes of neighboring cells OVERLAP (a hexagon's does with all six of its
    // neighbors, a kite's with most of them) while the clip-paths tile exactly.
    // That is also what makes pointer hit-testing land on the right cell:
    // clip-path clips pointer events, so the part of a box outside its own
    // polygon is not a hit target at all.
    const w = box.width * P, h = box.height * P;
    cellEl.style.position = 'absolute';
    cellEl.style.left = (box.left * P) + 'px';
    cellEl.style.top = (box.top * P) + 'px';
    cellEl.style.width = w + 'px';
    cellEl.style.height = h + 'px';
    cellEl.style.clipPath = box.clipPath;
    cellEl.style.fontSize = ((pos.shape === 'sq' ? FONT_UNITS_SQ : FONT_UNITS) * P) + 'px';
    // The number is drawn at the cell's own VISUAL center, cellPos.cx/cy, the
    // incircle center, never at the box center, and never at the compass RAY
    // ANCHOR (cellPos.ax/ay), which is a different point on cairo and deltoidal
    // on purpose. The two centers coincide on every centrally symmetric cell
    // (both shipped tilings, and rhombille) and separate on the asymmetric ones:
    // measured worst-case over all orientations, 0.25 of a pitch on a floret
    // pentagon, 0.21 on a deltoidal kite, 0.04 on a cairo pentagon. Against an
    // inscribed radius of half a pitch, the first two read as a number shoved
    // toward the point.
    cellEl.style.padding = _anchorPadding(
      (pos.cx - box.left) * P - w / 2,
      (pos.cy - box.top) * P - h / 2,
    );
  }
}

function _renderTilingBoard() {
  boardEl.classList.add('tiling-board');
  // content-box + no padding so the board's own width IS the tiling's extent
  // and the edge octagons land exactly inside it (no hairline overflow clip).
  boardEl.style.display = 'block';
  boardEl.style.boxSizing = 'content-box';
  boardEl.style.padding = '0';
  boardEl.style.gridTemplateColumns = '';
  boardEl.style.gridTemplateRows = '';
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
      cellEl.tabIndex = (r === state.focusedRow && c === state.focusedCol) ? 0 : -1;

      if (shouldAnimate) {
        const delay = (r + c) * 12;
        cellEl.classList.add('cascade-in');
        cellEl.style.animationDelay = `${delay}ms`;
        setTimeout(() => cellEl.classList.remove('cascade-in'), 300 + delay);
      }
      boardEl.appendChild(cellEl);
    }
  }
  _renderTilingSeams();
  layoutTilingCells();
}

// ── Tiling seam overlay ──────────────────────────────
// The clip-paths tile EXACTLY, so two neighboring cells share a mathematical
// edge with no gap, and nothing draws it. On a rectangle the CSS grid's
// --grid-gap shows --color-border between cells; a tiling had no equivalent,
// and the cost is real legibility, worst on the Laves lattices: a floret
// rosette's six petals read as ONE solid hexagon, and a revealed region is
// an undivided sheet whose numbers cannot be attributed to their cells
// (Christopher's report, 2026-08-02, off Par Lab board 25). Neither a border
// nor an outline can fix it, both follow the BOX and are clipped away
// except where the polygon touches it (the keyboard-focus lesson).
//
// So the seams are DRAWN, from the same wireframe applyWallsTiling severs
// edges from: one SVG holding every shared polygon edge as a single path, in
// UNIT coordinates with the tiling's extent as its viewBox. CSS sizes the
// svg to 100% of #board, so every re-lay (resize, rotation, theme refit)
// rescales it for free with no re-render hook, and vector-effect:
// non-scaling-stroke keeps the line width in screen pixels at every pitch.
// Color and width are theme tokens (--tiling-seam-color defaulting to the
// theme's own --color-border, the same color a rectangle's gaps show, and
// --tiling-seam-width). z-index 2: above cell bodies (including the .fx-on
// lift) so the seam reads across REVEALED regions too, below walls (3) and
// worms (4), so a wall still dominates the edge it sits on.
const SVG_NS = 'http://www.w3.org/2000/svg';
let _seamKey = null;
let _seamPathD = null;

function _renderTilingSeams() {
  document.getElementById('tiling-seams')?.remove();
  const t = state.board && state.board._tiling;
  if (!t || !t.type) return;

  const key = `${t.type}|${t.M}|${t.N}`;
  if (_seamKey !== key) {
    const T = buildTiling(t.type, t.M, t.N);
    const { edges } = buildWireframe(T);
    _seamPathD = edges.map((e) => {
      const a = T.verts[e.v1], b = T.verts[e.v2];
      return `M${a.x.toFixed(4)} ${a.y.toFixed(4)}L${b.x.toFixed(4)} ${b.y.toFixed(4)}`;
    }).join('');
    _seamKey = key;
  }

  const { wUnits, hUnits } = _tilingExtent();
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.id = 'tiling-seams';
  svg.setAttribute('viewBox', `0 0 ${wUnits} ${hUnits}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', _seamPathD);
  svg.appendChild(path);
  boardEl.appendChild(svg);
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
  // instead of the rectangular "r,c-r,c" edge set, draw a bar across the shared
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
// Continuous walls share endpoints, so the bars connect end to end.
//
// Unit coords map straight from #board's own content-box origin, which is where
// layoutTilingCells places every cell box, so this re-lays correctly on resize /
// theme refit like the other overlays. It used to go through DOM cell 0's rect
// instead, taking its WIDTH as the pitch and its rect center as unit cellPos[0].
// Both assumptions are properties of the shipped two rather than of a tiling:
// cell 0's box is one pitch wide on 4.8.8 and hex, but 1.366 on cairo and
// deltoidal, 1.155 on floret and a full 2.000 on rhombille, so every wall would
// be scaled by up to DOUBLE and land nowhere near its edge. And a cell's rect
// center IS its cellPos only
// while the cell is centrally symmetric, which the Laves kite and pentagons are
// not. Reading the origin instead removes both rather than patching them.
function _renderTilingWalls(boardParent) {
  const walls = state.board._tilingWalls;
  boardParent.style.position = 'relative';
  const overlay = document.createElement('div');
  overlay.className = 'wall-overlay-container';

  if (walls.length) {
    // #board keeps its border in tiling mode (only the padding is zeroed), so
    // the content-box origin the cells are laid out from sits one border width
    // inside the board's own offset position.
    const P = _pitch();
    const ox = boardEl.offsetLeft + boardEl.clientLeft;
    const oy = boardEl.offsetTop + boardEl.clientTop;
    const toPx = (x, y) => ({ x: ox + x * P, y: oy + y * P });

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
  // layer) were cut with the Collection declutter, the theme IS the
  // object identity now, which also means theme sprites always match.
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'classic';
  const themeInfo = THEME_UNLOCKS[currentTheme];
  // "Classic mines & flags" setting: a player who likes the themed worlds
  // but not the recolored objects pins the mine, flag, and exploded-mine
  // (strike) back to the canonical glyphs, these resolve to the original
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
      //   2. Challenge/timed game-over cascade, every non-flagged mine
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
            // and the combined footprint fits the clip, no new colors needed.
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
    // Frozen-board suggested start cell (daily / weekly / coastline /
    // the Climb / a Challenge match, every mode that certifies from a
    // marked opener; shows while the board is fresh or re-fogged)
    if (cell.suggestedStart && (state.gameMode === 'daily' || state.gameMode === 'weekly'
        || state.gameMode === 'normal' || state.gameMode === 'match'
        || state.coastlinePractice) &&
        (state.status === 'idle' || (state.status === 'playing' && state.revealedCount <= 1))) {
      cellEl.classList.add('suggested-start');
    }
  }
  // Wall overlays rendered separately by renderWallOverlays()
  // An active sonar/compass region highlight survives this rebuild, every
  // branch above assigns className wholesale, which is what used to strip the
  // highlight from a cell the moment it was flagged.
  _reapplyRegionClasses(cellEl, r * state.cols + c);
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
  // on scroll, a phone player who scrolled before their first daily
  // click saw "Start here" (the certified no-guess entry marker) hovering
  // over the WRONG cell. The historical reason for fixed, a
  // non-positioned ancestor made board-relative math drift ~130 px, is
  // gone: #board itself is position:relative, and the label is absolute
  // within it (absolutely-positioned grid children take no grid slot, so
  // boardEl.children cell indexing is unaffected, labels append last).
  const cellRect = cellEl.getBoundingClientRect();
  const boardRect = boardEl.getBoundingClientRect();
  const cx = cellRect.left - boardRect.left + cellRect.width / 2;
  const cellTop = cellRect.top - boardRect.top;
  label.style.left = cx + "px";
  // #board is overflow:hidden, so an "above" label on a top-row cell
  // would be clipped, center those on the cell instead.
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

  // "Start here", pre-first-click marker for the certified opener. Shows
  // on daily, coastline practice, and the Challenge 250 ladder (every
  // fresh-frozen board whose certificate runs from the marked cell) while
  // the board is fresh. Weekly keeps its historical no-label behavior,
  // the cell class alone marks it there.
  if ((state.gameMode === "daily" || state.gameMode === "normal" || state.coastlinePractice) &&
      (state.status === "idle" || (state.status === "playing" && state.revealedCount <= 1))) {
    const startCell = boardEl.querySelector(".suggested-start");
    if (startCell) _placeLabel(startCell, "start-here-label", "Start here", "start-here-label");
  }

  // Post-loss "NEXT MOVE", the solver-suggested safe cell that would
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
// eyeball, a 5×5 block on a square grid, an irregular graph blob on a tiling.
// Hovering (desktop) or tapping (mobile) the cell lights up exactly the cells
// its number counts. Single-sourced from adjacency.js (sonarScanCells /
// compassRayCells), so the highlight shows precisely what the certifier proved
// from, it hands over the AREA, never which cells hold the mines.

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

let _regionShown = null;     // { row, col } currently highlighted, else null
let _regionCellSet = null;   // Set<flat index> of the shown region's members
let _regionSourceIdx = null; // flat index of the sonar/compass cell itself

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
  // Membership is CACHED so updateCell can restore the class in O(1). The
  // classes live on cell elements, and every targeted re-render rebuilds
  // className wholesale, so before this cache existed, flagging a cell inside
  // a pinned region quietly stripped the highlight from exactly the cell the
  // player was counting (the flag-counting use is the point of pinning;
  // Christopher's report, 2026-08-01). The highlight must outlive every
  // re-render and die only by clearGimmickRegion.
  _regionCellSet = new Set(region);
  _regionSourceIdx = row * state.cols + col;
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
  _regionCellSet = null;
  _regionSourceIdx = null;
}

/**
 * Restore a live region highlight onto one just-rebuilt cell element. Called
 * from updateCell's shared tail, so every path that rewrites a cell's className
 * (flag, unflag, reveal, strike, re-fog) puts the highlight back before the
 * frame paints.
 */
function _reapplyRegionClasses(cellEl, flatIdx) {
  if (!_regionShown) return;
  if (_regionCellSet.has(flatIdx)) cellEl.classList.add('region-highlight');
  if (flatIdx === _regionSourceIdx) cellEl.classList.add('region-source');
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
  // Read the LIVE gap like resizeCells does, themes override --grid-gap
  // (candy 3px, matrix 1px), and the old hardcoded 2 oversized the fit by
  // (cols-1)px per extra gap pixel.
  const gap = parseFloat(getComputedStyle(boardEl).gap) || 2;
  const cellSize = _fitCellSize(widthBudget, gap, _cellBound('--cell-fit-max-size', 40));
  document.documentElement.style.setProperty('--cell-size', cellSize + 'px');
}

// ── Zoom (for Timed mode large boards) ────────────────

export function needsZoom() {
  return state.gameMode === 'match' && (state.cols > 13 || state.rows > 13);
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
