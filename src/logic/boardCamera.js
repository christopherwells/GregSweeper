// The marathon camera's pure geometry: where the view sits over a board that
// is bigger than the screen, and how it gets there.
//
// His design (2026-08-17): a board larger than the phone fit is unlocked by
// NAVIGATION, not by shrinking cells forever. Double-tapping a number the
// player is finished with (unchordable: already chorded, or its flag count
// does not satisfy it; chordHasWork in boardSolver.js is the one judge of
// that) centers the view on it with a smooth glide, and zoom accompanies it.
// The minimum cell size is a player PREFERENCE (CELL_SIZE_PREFS below), which
// replaces the tap-protection job of boardFit's 28/24px floors ONLY. It never
// touches their supply-legality job: every mode's board-choosing contracts
// (boardFitsPhone, rectFitsPhone, the band tables) are untouched by anything
// in this module, which is why it imports nothing.
//
// The clamping rule, his words: "It wouldn't vertically center on a cell
// that's on the top or bottom edge, so the screen is still full of cells."
// clampedScroll is that sentence as arithmetic: the desired scroll is the
// cell's center minus half a viewport, clamped to [0, content - viewport], so
// an edge cell parks the view flush against the edge instead of dragging
// empty space on screen.
//
// Coordinate convention: cell centers and board extents are LAYOUT pixels
// (untransformed offset geometry). The renderer scales the board with a
// top-left-origin CSS transform, so a layout point p maps to p * scale in the
// scroll container's content space. All functions here take that scale
// explicitly; nothing reads the DOM.

/**
 * The Settings presets for the minimum cell size. `px: 0` means "fit to
 * screen", today's behavior and the default: the renderer's own fit result
 * stands and the camera never engages. A nonzero px is a floor UNDER the fit
 * result; when the floor wins, the board no longer fits and scrolls instead.
 * Keys are stored in localStorage, so they are a contract: never rename one.
 */
export const CELL_SIZE_PREFS = Object.freeze([
  Object.freeze({ key: 'fit', label: 'Fit to screen', px: 0 }),
  Object.freeze({ key: 'comfortable', label: 'Comfortable', px: 32 }),
  Object.freeze({ key: 'large', label: 'Large', px: 40 }),
]);

/**
 * The pixel floor a stored preference key asks for. Unknown or absent keys
 * read as 'fit' (0): absence of a choice is today's behavior, never a guess.
 * @param {string|null|undefined} key
 * @returns {number}
 */
export function prefMinPx(key) {
  const p = CELL_SIZE_PREFS.find((e) => e.key === key);
  return p ? p.px : 0;
}

/**
 * The scale at which the WHOLE board is visible at once, the survey view the
 * same-cell double-tap toggles out to. Never above 1 (a board that already
 * fits is shown at natural size), and degenerate inputs answer 1 rather than
 * 0/Infinity so a caller can always multiply by it.
 * @param {number} boardW layout px
 * @param {number} boardH layout px
 * @param {number} viewW  scroll-container client px
 * @param {number} viewH  scroll-container client px
 * @returns {number}
 */
export function cameraFitScale(boardW, boardH, viewW, viewH) {
  if (!(boardW > 0) || !(boardH > 0) || !(viewW > 0) || !(viewH > 0)) return 1;
  return Math.min(1, viewW / boardW, viewH / boardH);
}

/**
 * The scroll position that centers the point (cx, cy), a cell's center in
 * layout px, in the view, clamped so the screen stays full of cells.
 * `originX`/`originY` are the board's own layout offset inside the scroll
 * container's content (the auto-centering margin when the board is narrower
 * than the wrapper), and `scale` is the live camera scale.
 *
 * Clamp per axis: a top- or bottom-edge cell does not vertically center (his
 * ruling verbatim); a left- or right-edge cell does not horizontally center.
 * Content smaller than the view clamps to 0, never a negative scroll.
 *
 * @param {{cx: number, cy: number, scale: number,
 *   boardW: number, boardH: number, viewW: number, viewH: number,
 *   originX?: number, originY?: number}} p
 * @returns {{left: number, top: number}}
 */
export function clampedScroll(p) {
  const ox = p.originX || 0;
  const oy = p.originY || 0;
  const maxLeft = Math.max(0, ox + p.boardW * p.scale - p.viewW);
  const maxTop = Math.max(0, oy + p.boardH * p.scale - p.viewH);
  return {
    left: Math.min(maxLeft, Math.max(0, ox + p.cx * p.scale - p.viewW / 2)),
    top: Math.min(maxTop, Math.max(0, oy + p.cy * p.scale - p.viewH / 2)),
  };
}

/** Ease-out cubic: fast start, gentle landing, the glide's whole feel. */
export function easeOutCubic(t) {
  const c = Math.min(1, Math.max(0, t));
  return 1 - (1 - c) * (1 - c) * (1 - c);
}

/**
 * One frame of the glide: the view center (layout px) and scale, eased from
 * `from` to `to` at progress t in [0, 1]. The center is interpolated in BOARD
 * layout space and the scroll derived from it afterward (by clampedScroll at
 * the frame's own scale), which keeps the path stable while the scale is
 * changing under it. Interpolating raw scroll offsets instead drifts,
 * because the same offset means different board points at different scales.
 *
 * @param {{cx: number, cy: number, scale: number}} from
 * @param {{cx: number, cy: number, scale: number}} to
 * @param {number} t
 * @returns {{cx: number, cy: number, scale: number}}
 */
export function glideFrame(from, to, t) {
  const e = easeOutCubic(t);
  return {
    cx: from.cx + (to.cx - from.cx) * e,
    cy: from.cy + (to.cy - from.cy) * e,
    scale: from.scale + (to.scale - from.scale) * e,
  };
}

/**
 * What a double-tap on a navigable (unchordable) cell does, given where the
 * camera already is. His ruling: double-tap centers and zooms in; double-
 * tapping the cell the view is ALREADY centered on toggles back out to the
 * survey view (pinch and the +/- buttons work throughout).
 *
 * - Not centered on this cell: glide to it. Scale target is at least natural
 *   size (1); a player who pinched in past natural keeps their zoom.
 * - Centered on this cell at play scale: survey (the fit scale).
 * - Centered but currently BELOW natural size (survey-ish): dive back in on
 *   the same cell at natural size, so survey, pick, dive also works on the
 *   cell you left from.
 *
 * @param {{sameCell: boolean, scale: number, fitScale: number}} p
 * @returns {{scale: number, survey: boolean}}
 */
export function cameraTapPlan(p) {
  if (p.sameCell && p.scale >= 1) return { scale: p.fitScale, survey: true };
  return { scale: Math.max(1, p.scale), survey: false };
}
