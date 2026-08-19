// How big a board may be before a phone makes it unplayable.
//
// Christopher's report, 2026-08-06: "the width of some of the tilings can get
// too wide for playing on mobile. It hasn't been a problem with hex, but it
// certainly is a problem with the floor tiles." Measured, he is describing a
// property that every tiling board in the game shares and only some are far
// enough along to feel: they are all WIDTH-bound on a phone and none is ever
// height-bound. At the 360x740 reference the board gets 314px of width against
// 510px of height, while five of the six lattices lay out square-or-wider
// (aspect <= 1.0; only the floret is taller than it is wide). So the width
// crushes the pitch while a third of the vertical budget sits unused. The
// widest shipped Paving Stones daily was 4 rows by 10 columns: a 345 x 141px
// letterbox strip with 25px cells and 440px of height going spare.
//
// WHAT THE PITCH MEANS, per shape. assembleTiling normalizes the hexagon and
// all four Laves tilings so a cell's INSCRIBED DIAMETER is exactly one pitch,
// which makes the pitch directly comparable to --cell-size on a rectangle: it
// IS the click target. The 4.8.8 is the one exception and keeps its own tuning,
// so at OCT_CUT 0.38 its octagon is 0.877 pitch and its interstitial diamond
// only 0.537. Those numbers are DERIVED here from the shipped geometry rather
// than written down, because OCT_CUT is tuned by eye and has moved twice
// (0.37 -> 0.42 on 2026-07-28, 0.42 -> 0.38 on 2026-08-17, his "the small
// sides are too small"); a hardcoded ratio would have gone quietly wrong both
// days, and would be wrong again for a seventh tiling nobody thought to add
// to a table. clip-path gates pointer events, so the polygon really is the
// target and its inscribed circle really is what you can be sure of hitting.
//
// THE FLOORS are Christopher's (2026-08-06), and the reference phone is his
// too. The majority cell of a board must clear MIN_TAP_MAJORITY; a minority
// cell class may go down to MIN_TAP_MINORITY. On the five isohedral tilings
// there is only one cell class and both reduce to the majority floor. The split
// exists for the 4.8.8, whose two cell sizes differ by 39% and whose diamonds
// are ~45% of the board, a single floor there either lets the diamonds shrink
// to 21px (majority-only) or removes the shape from the end game
// (28px on the diamond removes Octagons from the ladder above L50 and from the
// endless pool entirely). 24px on the minority is the middle he chose.
//
// WHERE 24 CAME FROM (his ruling 2026-08-19, superseding the 28). The floor
// measures the PRESSING SURFACE: the diameter of the circle that fits inside
// the cell polygon. That is not a proxy here, it is verified geometry: the
// pitch normalization makes inscribed diameter exactly one pitch on every
// isohedral lattice (measured 1.000 against the shipped vertices for the
// hexagon, both pentagons, the rhombus, and the kite), and the 4.8.8's two
// classes carry their own measured inscribed diameters (0.877 / 0.537 of
// pitch). With the unit verified as the true press, he set the floor at the
// pressing surface itself: 24px, every shape. The felt-experience data that
// produced the old 28 still sorts identically under it (the one config he
// reported as too wide measured 23.0px and is still refused), and the
// Octagons are unmoved because their squares' 24px minority floor already
// binds the shape (~45px pitch). The frontier growth this bought, measured
// the night of the ruling: hex 170 -> 252 ceiling cells, cairo 172 -> 212,
// floret 138 -> 216, rhombille 135 -> 180, deltoidal 90 -> 168; rect and
// 4.8.8 unchanged.
//
// WHERE 28 CAME FROM, kept as history. Scored by delivered tap diameter at
// 360px, the configs shipping before this module clustered with a clean gap:
// everything either <= 25.5px or >= 28.5px. Honeycomb's worst board (which
// he reported as fine) sat at 29.9 and Octagons' at 28.6; Paving Stones'
// worst (too wide, his report) at 23.0. Any floor in [26, 28] sorted those
// boards identically and 28 was the middle he chose; the 2026-08-19 ruling
// re-anchored the number on the verified pressing-circle geometry instead.
// For scale, the rectangular game's own floor is --cell-min-size 18px, but
// that is a last-resort clamp for Expert Quick Play, which has zoom controls
// as its escape hatch; a tiling board has none.
//
// WHAT CONSTRAINING COSTS: nothing in difficulty. The largest legal board of
// every shape still prices far past the 240s daily band ceiling, so each
// lattice keeps its full reach, the violating configs were not big, they were
// sideways, and most are fixed by swapping M and N at an identical cell count.
//
// This module is the ONE definition. Authored tables (TILING_BAND_CONFIGS,
// CHALLENGE_BLOCKS, ENDLESS_SPECS, COASTLINE_BOARDS) carry hand-picked
// dimensions and are held to it by test/boardFit.test.mjs rather than importing
// it, which keeps challenge250.js the leaf it is documented to be. Only chaos
// consults it at runtime, because chaos derives its dimensions from a target
// cell count instead of authoring them.

import { buildTiling, containerIsStorable } from './tilingGeometry.js';
// The rectangular WIDTH rule, kept in difficulty.js where the search reads it.
import { BOARD_WIDTH_CAP } from './difficulty.js';

/**
 * The phone the caps are sized for: the modal Android width, which also covers
 * every current iPhone (375-430). Christopher's call, 2026-08-06, against the
 * measured alternative: sizing for a 320px legacy iPhone SE costs real
 * difficulty reach (3D Cubes would cap at 84 cells, ~160s, unable to reach the
 * top of the daily band at all) to serve a device almost nobody plays on. A
 * 320px phone still gets ~25px cells on the worst board, which is the size the
 * whole game shipped with before this.
 */
export const FIT_REFERENCE = Object.freeze({ width: 360, height: 740 });

/** Minimum tap diameter (px) for the board's majority cell class: the
 * diameter of the pressing circle (his 2026-08-19 ruling; the WHERE 24 CAME
 * FROM block above). */
export const MIN_TAP_MAJORITY = 24;

/**
 * Minimum tap diameter (px) for a minority cell class. Only the 4.8.8 has one;
 * everywhere else this is unreachable because min === median.
 */
export const MIN_TAP_MINORITY = 24;

// MEASURED in headless Chromium (four viewports, 320-430), reproduced exactly
// by these two formulas:
//   #app is width:95% with 10px of horizontal padding a side on phones, and
//   #board has a 2px border plus 2px padding a side.
// Verified: 320 -> 276, 360 -> 314, 390 -> 343, 430 -> 381.
const APP_WIDTH_FRACTION = 0.95;
const APP_PADDING_X = 20;   // 10px a side, the <=480px media query
const BOARD_BORDER_PAD = 8; // (2px border + 2px padding) x 2

// #board-scroll-wrapper's max-height in global.css. Kept as a number here and
// asserted against the stylesheet by the test, so the two cannot drift.
const BOARD_HEIGHT_VH = 0.70;

/**
 * Pixels of width a board may occupy at a given viewport width.
 * @param {number} viewportWidth
 */
export function widthBudget(viewportWidth = FIT_REFERENCE.width) {
  return viewportWidth * APP_WIDTH_FRACTION - APP_PADDING_X - BOARD_BORDER_PAD;
}

/**
 * Pixels of height a board may occupy at a given viewport height. Mirrors what
 * the RENDERER actually does, so the tap sizes derived from it are the ones on
 * screen.
 * @param {number} viewportHeight
 */
export function heightBudget(viewportHeight = FIT_REFERENCE.height) {
  return viewportHeight * BOARD_HEIGHT_VH - BOARD_BORDER_PAD;
}

// MEASURED in headless Chromium: the fixed furniture stacked around the board
// inside #app, game header and info bar above, bottom nav below, comes to
// ~168px, and #app is vertically centered in the viewport.
const APP_CHROME_Y = 168;
// A phone browser's own URL bar and bottom toolbar. A board sized against a
// standalone PWA viewport can overflow once these are showing, because `vh`
// resolves against the LARGE viewport in mobile Safari and Chrome.
const BROWSER_UI_Y = 110;

/**
 * The height a board should AIM to stay within when its dimensions are being
 * chosen, as opposed to the height the renderer will let it have.
 *
 * These differ on purpose. heightBudget mirrors #board-scroll-wrapper's 70vh
 * and is what the tap-size caps must be derived from, because the renderer
 * really will shrink the pitch to fit it. But 70vh is more height than a phone
 * showing browser chrome can display once the header and nav are counted, and
 * the wrapper resolves the overflow by scrolling. That is tolerable for a board
 * that happens to be tall; it is not a thing to deliberately aim for, so the
 * chooser works to the tighter number and leaves the slack unspent.
 *
 * @param {number} viewportHeight
 */
export function comfortHeightBudget(viewportHeight = FIT_REFERENCE.height) {
  return Math.min(
    heightBudget(viewportHeight),
    viewportHeight - APP_CHROME_Y - BROWSER_UI_Y,
  );
}

// Distance from a point to a segment; the inscribed-radius search below walks
// every edge of a cell rather than assuming a regular polygon, because three of
// these six lattices have cells that are not centrally symmetric.
function _distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// A representative patch. Every one of these tilings is edge-to-edge with whole
// cells at the boundary (the floret's crop is at CELL granularity), so a cell's
// shape does not depend on the patch size and 5x5 answers for every board.
const RATIO_PATCH = 5;
const _ratioMemo = new Map();

/**
 * The inscribed diameter of a cell, as a multiple of the pitch, what a player
 * can be sure of hitting. Returns the MEDIAN over the patch (the majority cell
 * class) and the MIN (the smallest class present).
 *
 * Both are 1.000 for the hexagon and all four Laves tilings, by construction:
 * assembleTiling normalizes to exactly this. The 4.8.8 returns 0.877 / 0.537.
 *
 * @param {string} type a TILING_TYPES entry
 * @returns {{median: number, min: number}}
 */
export function tapRatios(type) {
  const hit = _ratioMemo.get(type);
  if (hit) return hit;

  const tiling = buildTiling(type, RATIO_PATCH, RATIO_PATCH);
  const diameters = [];
  for (let i = 0; i < tiling.cellPos.length; i++) {
    const verts = tiling.cellVerts[i].map((vi) => tiling.verts[vi]);
    const { cx, cy } = tiling.cellPos[i];
    let inradius = Infinity;
    for (let k = 0; k < verts.length; k++) {
      const a = verts[k];
      const b = verts[(k + 1) % verts.length];
      inradius = Math.min(inradius, _distToSegment(cx, cy, a.x, a.y, b.x, b.y));
    }
    diameters.push(2 * inradius);
  }
  diameters.sort((a, b) => a - b);

  const out = Object.freeze({
    median: diameters[Math.floor(diameters.length / 2)],
    min: diameters[0],
  });
  _ratioMemo.set(type, out);
  return out;
}

/**
 * The largest extent, in PITCH UNITS, a board of this shape may have and still
 * clear both floors. Compare against a tiling's own wUnits / hUnits.
 *
 * Both floors are applied and the tighter wins, which is what makes the rule
 * shape-generic: on a single-cell-class lattice the minority term is slack, and
 * on the 4.8.8 it binds.
 *
 * @param {string} type
 * @param {{width?: number, height?: number}} [viewport]
 * @returns {{wUnits: number, hUnits: number}}
 */
export function maxExtentUnits(type, viewport = FIT_REFERENCE) {
  const { median, min } = tapRatios(type);
  const w = widthBudget(viewport.width ?? FIT_REFERENCE.width);
  const h = heightBudget(viewport.height ?? FIT_REFERENCE.height);
  return {
    wUnits: Math.min(w * median / MIN_TAP_MAJORITY, w * min / MIN_TAP_MINORITY),
    hUnits: Math.min(h * median / MIN_TAP_MAJORITY, h * min / MIN_TAP_MINORITY),
  };
}

// Floating-point slack: an extent is compared against a cap derived through
// several divisions, and a board sitting exactly on the cap must pass.
const FIT_EPSILON = 1e-9;

/**
 * The least of the width budget a board should occupy. Below this it is a tall
 * ribbon: legal by the tap floor, and wrong on screen.
 *
 * Christopher, 2026-08-07, on the Paving Stones blocks: "too long for the
 * screen but definitely could've been wider." Measured, that board was
 * 204 x 510px on a 360px phone, 65% of the width used and 10% past the
 * comfortable height. The first pass at the phone cap turned Paving Stones'
 * 4x10 letterbox into a 10x4 ribbon, which fixed the tap size (23px -> 37px)
 * and broke the proportion in the other direction, because a cap on the
 * MAXIMUM extents says nothing about a board being needlessly small in one.
 */
const MIN_WIDTH_USE = 0.75;

/**
 * Does an M x N patch of this shape fit a phone with tappable cells, AND sit
 * sensibly in the space?
 *
 * Three conditions, and the last two exist because the first is not enough:
 *   1. every cell class clears its tap floor (the caps)
 *   2. the board fits the COMFORTABLE height, not merely the renderer's 70vh,
 *      so it does not need scrolling on a phone showing browser chrome
 *   3. it uses at least MIN_WIDTH_USE of the width it is given
 *
 * A board can pass (1) trivially by being small in one axis, which is how a
 * 2.5:1 ribbon shipped. Conditions (2) and (3) are the same defect seen from
 * its two ends, too tall, and needlessly narrow.
 *
 * @param {string} type
 * @param {number} M
 * @param {number} N
 * @param {{width?: number, height?: number}} [viewport]
 * @returns {boolean}
 */
export function boardFitsPhone(type, M, N, viewport = FIT_REFERENCE) {
  let tiling;
  try {
    tiling = buildTiling(type, M, N);
  } catch {
    return false;
  }
  const cap = maxExtentUnits(type, viewport);
  if (tiling.wUnits > cap.wUnits + FIT_EPSILON) return false;
  if (tiling.hUnits > cap.hUnits + FIT_EPSILON) return false;

  const { pitch } = tapSizeAt(type, M, N, viewport);
  const comfort = comfortHeightBudget(viewport.height ?? FIT_REFERENCE.height);
  if (tiling.hUnits * pitch > comfort + HEIGHT_SLACK_PX) return false;

  const w = widthBudget(viewport.width ?? FIT_REFERENCE.width);
  return tiling.wUnits * pitch >= w * MIN_WIDTH_USE - FIT_EPSILON;
}

// The comfortable height is an ESTIMATE, measured app chrome plus an assumed
// browser-UI allowance, so it is not a figure to enforce to the pixel. A board
// a hair over is not what anyone is complaining about; one 10% over is.
const HEIGHT_SLACK_PX = 12;

// The renderer's own cell-size clamp and gap, from global.css. Mirrored here
// so a rect board's delivered cell size is computed the way boardRenderer's
// _fitCellSize computes it, rather than approximated.
const RECT_GAP_PX = 2;
const RECT_CELL_MIN = 18;
const RECT_CELL_MAX = 50;

/**
 * The cell size (px) a rect board would actually be given, mirroring
 * boardRenderer._fitCellSize: fit to width AND height, then clamp.
 *
 * Fitting to the RENDER height (70vh) rather than the comfort height on
 * purpose, because that is what the renderer really does. The rule below is
 * what compares the result against what a phone can actually show.
 */
export function rectCellSizeAt(rows, cols, viewport = FIT_REFERENCE) {
  const wb = widthBudget(viewport.width ?? FIT_REFERENCE.width);
  const hb = heightBudget(viewport.height ?? FIT_REFERENCE.height) - BOARD_BORDER_PAD;
  const widthFit = Math.floor((wb - (cols - 1) * RECT_GAP_PX) / cols);
  const heightFit = Math.floor((hb - (rows - 1) * RECT_GAP_PX) / rows);
  return Math.min(RECT_CELL_MAX, Math.max(RECT_CELL_MIN, Math.min(widthFit, heightFit)));
}

/**
 * Does a RECT board fit a phone, on the same terms boardFitsPhone holds the
 * lattices to?
 *
 * THIS DID NOT EXIST UNTIL 2026-08-14, and its absence is a bug players saw.
 * `BOARD_WIDTH_CAP` caps COLUMNS and nothing capped rows, so rect specs aimed
 * at nothing vertically. Two budgets are in play and the gap between them is
 * exactly where those boards sat: the renderer sizes cells to 70vh (502px
 * at the reference) while a phone showing its own URL bar and toolbar displays
 * 462px. Measured on the shipped Climb library: 299 of 767 rect boards, 39%,
 * stood 1.1 to 1.6 cells taller than the visible area, which is his report
 * ("one cell too long, maybe 2") to within a cell.
 *
 * boardFit's own note already says 70vh is more than a phone can show and that
 * the CHOOSER should work to the tighter number. The lattices obey it through
 * boardFitsPhone. This is the same rule, for the shape that never got one.
 *
 * WIDTH is his column cap, not the tap floor (his ruling 2026-08-14: eleven
 * columns max). The two disagree and he chose: 314px of width over 11 columns
 * delivers 26px cells, under the tap floor every lattice is held to. That
 * asymmetry is deliberate. Rect is the shape people know, its cells are square
 * so the whole 26px is tappable where a hexagon's inscribed circle is not, and
 * capping rect at the tap floor would mean 10 columns and a Classic board
 * smaller than the one the game shipped with. `BOARD_WIDTH_CAP` carries the
 * number; this reads it rather than keeping a second copy.
 *
 * HEIGHT is the rule that was missing entirely, and it is enforced against
 * what a phone SHOWS rather than what the renderer sizes to.
 */
export function rectFitsPhone(rows, cols, viewport = FIT_REFERENCE) {
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) return false;
  if (cols > BOARD_WIDTH_CAP) return false;
  const cell = rectCellSizeAt(rows, cols, viewport);
  const height = rows * cell + (rows - 1) * RECT_GAP_PX;
  const comfort = comfortHeightBudget(viewport.height ?? FIT_REFERENCE.height);
  return height <= comfort + HEIGHT_SLACK_PX;
}

/**
 * The tap diameter (px) a board would actually deliver at a viewport, the
 * majority cell's, and the smallest class's. Diagnostic: the audit and the
 * tests report these so a failure says how far off it is, not merely that it
 * failed.
 *
 * Mirrors boardRenderer's _fitTilingPitch, including its [min, max] clamp, so
 * the number here is the number on screen.
 *
 * @param {string} type
 * @param {number} M
 * @param {number} N
 * @param {{width?: number, height?: number}} [viewport]
 * @returns {{pitch: number, majority: number, minority: number}}
 */
export function tapSizeAt(type, M, N, viewport = FIT_REFERENCE) {
  const tiling = buildTiling(type, M, N);
  const w = widthBudget(viewport.width ?? FIT_REFERENCE.width);
  const h = heightBudget(viewport.height ?? FIT_REFERENCE.height);
  // CELL_PITCH_MIN / MAX mirror --cell-min-size / --cell-max-size.
  const pitch = Math.min(50, Math.max(18, Math.min(w / tiling.wUnits, h / tiling.hUnits)));
  const { median, min } = tapRatios(type);
  return { pitch, majority: pitch * median, minority: pitch * min };
}

// How far from the best available cell count a patch may sit and still be
// considered, so that a slightly-off count with visibly bigger cells can win.
// In cells, matching the units the old chaos search scored in, its comment
// noted the 4.8.8's squarer 72-cell patch sat "only eight cells further" from a
// 64 target than the 63-cell ribbon that beat it.
const CELL_SLACK = 8;

/**
 * The best legal (M, N) for a shape at a target cell count.
 *
 * Two stages, because the two goals are not commensurable and pretending they
 * are is how the first cut of this went wrong. First: get near the target cell
 * count. Then, among the patches within CELL_SLACK of the best count available,
 * take the one that DELIVERS THE LARGEST PITCH.
 *
 * Maximizing the pitch is the whole objective of this module, and it also
 * subsumes the aspect penalty the chaos search used to carry: a patch that is
 * too wide has its pitch set by the width budget and a patch that is too tall
 * has it set by the height budget, so a ribbon in either direction loses on its
 * own terms. Scoring |M - N| the way the old code did was reaching for this but
 * measuring it in the wrong space, since a step in M and a step in N cover
 * different distances on screen for four of the six lattices.
 *
 * @param {string} type
 * @param {number} targetCells
 * @param {{maxCells?: number, minCells?: number, minM?: number, minN?: number,
 *   maxM?: number, maxN?: number, viewport?: object,
 *   requireStorable?: boolean}} [opts]
 * @returns {{M: number, N: number, cells: number}|null}
 */
export function fittingDims(type, targetCells, opts = {}) {
  const {
    maxCells = Infinity,
    minCells = 1,
    minM = 1,
    minN = 1,
    maxM = 30,
    maxN = 20,
    viewport = FIT_REFERENCE,
    requireStorable = true,
  } = opts;

  const cap = maxExtentUnits(type, viewport);
  const w = widthBudget(viewport.width ?? FIT_REFERENCE.width);
  // The chooser works to the comfortable height, not the renderer's 70vh, see
  // comfortHeightBudget. A patch is still legal up to the cap; this only stops
  // the search from PREFERRING one that fills the scroll wrapper edge to edge.
  const h = comfortHeightBudget(viewport.height ?? FIT_REFERENCE.height);

  const candidates = [];
  for (let M = minM; M <= maxM; M++) {
    for (let N = minN; N <= maxN; N++) {
      let tiling;
      try {
        tiling = buildTiling(type, M, N);
      } catch {
        continue;
      }
      if (tiling.wUnits > cap.wUnits + FIT_EPSILON) break; // wUnits rises with N
      const cells = tiling.total;
      if (cells < minCells || cells > maxCells) continue;
      if (requireStorable && !containerIsStorable(cells)) continue;
      // The FULL predicate, not just the caps: a candidate has to be
      // proportioned for the screen too, or the search happily returns the
      // tall ribbons the caps alone allow (2026-08-07).
      if (!boardFitsPhone(type, M, N, viewport)) continue;
      candidates.push({
        M, N, cells,
        distance: Math.abs(cells - targetCells),
        pitch: Math.min(w / tiling.wUnits, h / tiling.hUnits),
      });
    }
  }
  if (!candidates.length) return null;

  const nearest = Math.min(...candidates.map((c) => c.distance));
  const shortlist = candidates.filter((c) => c.distance <= nearest + CELL_SLACK);
  shortlist.sort((a, b) => b.pitch - a.pitch || a.distance - b.distance);
  const best = shortlist[0];
  return { M: best.M, N: best.N, cells: best.cells };
}
