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
// in this module. It imports exactly one thing, the tap floor, because the
// preference ladder is DEFINED against it; it reaches for no supply rule, and
// nothing here can move which boards a mode is allowed to build.
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

import { MIN_TAP_MAJORITY } from './tapFloor.js';

// THE SIZE LADDER IS DERIVED FROM THE TAP FLOOR (his ruling 2026-08-21: "The
// tap floor is 24 px. No argument there. Beyond that, the sizes should be 10%
// more, 25% more, and 50% more").
//
// Derived rather than written out, for the reason the width cap taught on
// 2026-08-20: a number sitting beside the number it depends on goes stale the
// first time either moves, and this ladder depends on MIN_TAP_MAJORITY twice
// over, as its base and as its unit.
//
// It also closes the gap he found: "Fit to screen" used to mean px 0, "no
// preference floor", which let the renderer's own --cell-min-size of 18px take
// over. 18 is a last-resort RENDER clamp for boards meant to exceed the screen;
// 24 is the PRESSING SURFACE, and a player who has expressed no preference
// should still get a cell they can hit. Fit now asks for the floor itself.
/**
 * The default preset's key: no preference expressed. It is still a FLOOR (the
 * tap floor), but unlike the other three it is not a request to enlarge, so
 * surfaces that quote a delivered size must read the live board rather than
 * quoting this entry's px.
 */
export const CELL_SIZE_DEFAULT_KEY = 'fit';

const SIZE_STEPS = Object.freeze([
  { key: 'fit', label: 'Fit to screen', mult: 1.00 },
  { key: 'comfortable', label: 'Comfortable', mult: 1.10 },
  { key: 'large', label: 'Large', mult: 1.25 },
  { key: 'largest', label: 'Largest', mult: 1.50 },
]);

/**
 * The Settings presets for the minimum cell size. Each is a floor UNDER the
 * renderer's fit result: while the fit is the larger number the board still
 * fits and the camera never engages, and when the floor wins the board
 * overflows and scrolls instead. 'fit' is the default and asks for the bare
 * tap floor, so it behaves as "fit to screen" on every board that can hold a
 * 24px cell, which is every board the supply rules allow.
 * Keys are stored in localStorage, so they are a contract: never rename one.
 */
export const CELL_SIZE_PREFS = Object.freeze(SIZE_STEPS.map((s) => Object.freeze({
  key: s.key,
  label: s.label,
  px: Math.round(MIN_TAP_MAJORITY * s.mult),
})));

/**
 * The floor the RENDERER should actually apply for a stored preference, which
 * is not the same question as what the preset is worth.
 *
 * The default contributes NOTHING (issue #421). His two rulings meet here:
 * "No dailies should be scrolled", and "boards shouldn't be scrollable at
 * 24 px in the dailies. If people use more zoomed in, then they may get a
 * scroll board." An explicit choice may push a board off the screen, because
 * the player asked for bigger cells; the default may not, because they asked
 * for nothing.
 *
 * Applying it to the default could only ever cause scrolling and could never
 * do anything else: the fit result is already the largest size that fits, so
 * a 24px floor is a no-op wherever a board naturally reaches 24 (every
 * supply-legal board at the 360px reference, by construction) and binds ONLY
 * where the board cannot reach 24 without leaving the screen.
 *
 * @param {string|null|undefined} key
 * @returns {number} px floor, or 0 for "apply no floor"
 */
export function renderFloorPx(key) {
  const k = normalizeCellPref(key);
  return k === CELL_SIZE_DEFAULT_KEY ? 0 : prefMinPx(k);
}

/**
 * The preset a stored key actually selects. Membership decides it, NEVER the
 * key's px: every preset now carries a nonzero floor, so a truthiness test on
 * the pixels would wave through whatever string localStorage happened to hold
 * and write it straight back (the bug this replaced, 2026-08-21).
 * @param {string|null|undefined} key
 * @returns {string} a key that is guaranteed to be in CELL_SIZE_PREFS
 */
export function normalizeCellPref(key) {
  return CELL_SIZE_PREFS.some((e) => e.key === key)
    ? /** @type {string} */ (key)
    : CELL_SIZE_DEFAULT_KEY;
}

/**
 * The pixel floor a stored preference key asks for. Unknown or absent keys
 * read as 'fit' (0): absence of a choice is today's behavior, never a guess.
 * @param {string|null|undefined} key
 * @returns {number}
 */
export function prefMinPx(key) {
  const p = CELL_SIZE_PREFS.find((e) => e.key === key);
  // An unknown or absent key reads as the FLOOR, not as zero. Zero meant "no
  // preference, let the render clamp decide", and the render clamp is 18px,
  // which is below the pressing surface he set.
  return p ? p.px : MIN_TAP_MAJORITY;
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

/**
 * How long after the VIEW MOVES a tap may not reveal a cell.
 *
 * HIS REPORT, 2026-08-21: "I've hit several mines because I tripled clicked by
 * accident, revealing a cell that was a mine. The first two clicks moved the
 * view and the third revealed." That is the double-tap centering gesture doing
 * exactly what it is meant to: taps one and two pan the board, the cells slide
 * under the finger, and tap three lands on a cell that was somewhere else when
 * the gesture began. The player never chose that cell.
 *
 * 200ms is his number. It is deliberately a REVEAL-only refusal: panning,
 * flagging and chording are all still allowed, because none of them can lose a
 * run. Only the irreversible action waits for the view to settle.
 */
export const VIEW_MOVE_GRACE_MS = 200;

/**
 * Is a reveal still inside the grace period after the view last moved?
 *
 * Pure so the rule is testable without a browser. A null or unset stamp means
 * the view has never moved, which is not a grace period; a stamp in the future
 * (a clock that jumped) is treated as active rather than ignored, because the
 * safe direction here is to make the player tap again.
 *
 * @param {number|null} lastMoveAt  performance.now() when the view last moved
 * @param {number} now              performance.now()
 * @param {number} [graceMs]
 */
export function withinViewMoveGrace(lastMoveAt, now, graceMs = VIEW_MOVE_GRACE_MS) {
  if (typeof lastMoveAt !== 'number' || !Number.isFinite(lastMoveAt)) return false;
  if (!Number.isFinite(now)) return false;
  return now - lastMoveAt < graceMs;
}
