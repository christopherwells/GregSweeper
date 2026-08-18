// The marathon lane's size ceiling: how big an OVERSIZED board may be.
//
// His ruling (2026-08-17), verbatim after a fresh pixel derivation was
// offered and refused: "We've already figured out widths and lengths that
// work. Doubling that is all you need." So the ceiling is 2x the ESTABLISHED
// fit-legal dims per shape, straight from boardFit's own verdicts, never a
// new pixel calculation, clipped where a doubled dimension passes the
// canonical container's storage bounds. Classic: 17x11 is fit-legal, so the
// marathon ceiling is 34x22, storage-clipped to 30x22 = 660 cells. The
// principle: marathon is bigger, not boundless; the player is never more
// than one screen from anything.
//
// MECHANIZATION: the marathon region is the UNION of doubled fit-legal
// pairs; dims (M', N') are in the region when SOME fit-legal (M, N) has
// M' <= 2M and N' <= 2N. Doubling the per-axis maxima instead would be
// wrong on floret, whose fit-legal pairs are so aspect-constrained that its
// axis maxima come from thin strips (a 1x23 is legal), and a box over those
// maxima would admit 30x30 = 5400 cells of nonsense. The union construction
// is self-regulating the same way in the other direction: a 24x3 rect
// ribbon is NOT in the region, because no fit-legal pair reaches 12 rows at
// so few columns. Only the Pareto-maximal legal pairs matter to the union,
// so that frontier is what is cached.
//
// The lane is DISJOINT from the fit library by construction: fit-legal dims
// are excluded here, because a board that fits the phone belongs to the
// base lane and its contracts. Storability is the same bound generation has
// always lived under (containerIsStorable: the cell count must factor into
// a [CANONICAL_MIN_DIM, CANONICAL_MAX_DIM] container).
//
// This module answers SUPPLY questions (generation, validation, tests). The
// client never consults it: dealt rows carry their own `oversized` flag, and
// the camera engages on real rendered overflow, not on a dims table.

import { boardFitsPhone, rectFitsPhone } from './boardFit.js';
import { buildTiling, containerIsStorable, TILING_TYPES, CANONICAL_MAX_DIM } from './tilingGeometry.js';
import { BOARD_WIDTH_CAP } from './difficulty.js';

// Scan bound for fit-legal pairs. Nothing fit-legal is anywhere near it:
// rect rows top out at 17 and every lattice axis under 25; the margin only
// costs a one-time cached scan.
const LEGAL_SCAN = 34;

// No board of interest has more cells than the canonical container can hold
// (30x30 = 900), so a scan that has passed this is scanning nothing useful.
// Generous rather than tight: it exists to stop the biggest builds, not to
// express a rule, and every real bound is applied by name below.
const CELL_SCAN_CAP = 1000;

// ONE buildTiling per (shape, M, N) for the whole module. Measured before
// this cache: a single deltoidal board cost 67 SECONDS of the lane's budget,
// and none of it was generation. Every question here (is this pair legal,
// how many cells, what aspect) rebuilds the same lattice, and the frontier
// scan, the bound and the menu ask about overlapping pairs, so the module
// was building roughly three thousand tilings per shape. The results are
// pure functions of the arguments, so one memo serves all three.
const _tilingMemo = new Map();
function _tilingOf(shape, M, N) {
  const key = `${shape}|${M}|${N}`;
  if (_tilingMemo.has(key)) return _tilingMemo.get(key);
  let t = null;
  try { t = buildTiling(shape, M, N); } catch { t = null; }
  _tilingMemo.set(key, t);
  return t;
}

// The fit verdict, memoized alongside the tilings: boardFitsPhone builds its
// own lattice on every call, and the frontier scan and the bound both ask
// about the same pairs.
const _fitMemo = new Map();
function _fitsPhone(shape, M, N) {
  const key = `${shape}|${M}|${N}`;
  if (_fitMemo.has(key)) return _fitMemo.get(key);
  let ok = false;
  try {
    ok = shape === 'rect' ? rectFitsPhone(M, N) : boardFitsPhone(shape, M, N);
  } catch { ok = false; }
  _fitMemo.set(key, ok);
  return ok;
}

// Pareto-maximal fit-legal (M, N) pairs per shape (rect: rows, cols). Only
// these matter to the union of doubled boxes.
const _frontier = new Map();
export function fitLegalFrontier(shape) {
  const hit = _frontier.get(shape);
  if (hit) return hit;
  const legal = [];
  for (let M = 1; M <= LEGAL_SCAN; M++) {
    for (let N = 1; N <= LEGAL_SCAN; N++) {
      // Cell count rises monotonically with N at fixed M on every tiling
      // here, so once a pair is past the scan cap no larger N can come
      // back under it. Breaking is what keeps this scan affordable: the
      // floret is 6MN cells, and scanning it to the corner meant building
      // seven-thousand-cell lattices to learn they were far too big.
      if (_cellsOf(shape, M, N) > CELL_SCAN_CAP) break;
      if (_fitsPhone(shape, M, N)) legal.push([M, N]);
    }
  }
  const frontier = legal.filter(([m, n]) =>
    !legal.some(([m2, n2]) => (m2 >= m && n2 >= n) && (m2 > m || n2 > n)));
  _frontier.set(shape, frontier);
  return frontier;
}

function _cellsOf(shape, M, N) {
  if (shape === 'rect') return M * N;
  const t = _tilingOf(shape, M, N);
  return t ? t.total : 0;
}

/**
 * The most cells any fit-legal board of this shape can have. Two jobs, both
 * derived from the same frontier and so still boardFit's own verdicts: it is
 * the anchor size the out-of-support pricing extends from, and it is the
 * line between a board the par model has SEEN sizes like and one it has not
 * (inSupportCells below).
 */
const _ceilingCells = new Map();
export function fitCeilingCells(shape) {
  const hit = _ceilingCells.get(shape);
  if (hit != null) return hit;
  let best = 0;
  for (const [M, N] of fitLegalFrontier(shape)) {
    best = Math.max(best, _cellsOf(shape, M, N));
  }
  _ceilingCells.set(shape, best);
  return best;
}

/**
 * THE DEGENERACY LINE, measured (2026-08-17) rather than chosen. A board's
 * short side must reach this or the game stops being two-dimensional: at one
 * column a cell has at most 2 neighbors and the board is a path graph; at
 * two, at most 5, and NO cell has a full neighborhood; at three, a cell in
 * the middle column has all 8, and a 12x3 holds ten of them. The generator
 * says the same thing independently, which is what makes this a line rather
 * than a preference: probed plain at 18% mines, a 25x3 certified 3 draws of
 * 3 while a 25x2 certified none.
 */
export const MARATHON_MIN_SHORT_SIDE = 3;

/**
 * Is (M, N) a legal size for the SCROLLING lane? Inside the doubled region
 * of some fit-legal pair (clipped to the canonical container), NOT itself
 * fit-legal, storable, and not degenerately thin.
 *
 * WHAT THE LANE IS FOR, corrected 2026-08-17 after his "I was musing about
 * the merits of a 25x3 board myself". The toggle promises boards the SCREEN
 * cannot hold, and that is TWO things, where the first cut of this built
 * only one: too BIG (the marathon giants) and wrong PROPORTION at an
 * ordinary size (a 6x20, a 25x3), which his original words asked for all
 * along ("sparse long boards and other fills"). The old rule here demanded
 * more cells than the shape's fit ceiling, which blocked the whole second
 * category. Failing the fit rules IS the qualification, because that is
 * exactly what the toggle is opting into; the short-side floor above is what
 * keeps the honest thin boards and drops the degenerate ones.
 *
 * @param {string} shape 'rect' or a TILING_TYPES entry
 * @param {number} M rows for rect, lattice M otherwise
 * @param {number} N cols for rect, lattice N otherwise
 * @returns {boolean}
 */
export function marathonFits(shape, M, N) {
  if (!Number.isInteger(M) || !Number.isInteger(N) || M < 1 || N < 1) return false;
  if (M > CANONICAL_MAX_DIM || N > CANONICAL_MAX_DIM) return false;
  if (Math.min(M, N) < MARATHON_MIN_SHORT_SIDE) return false;
  const covered = fitLegalFrontier(shape)
    .some(([m, n]) => M <= 2 * m && N <= 2 * n);
  if (!covered) return false;
  if (_fitsPhone(shape, M, N)) return false;
  const cells = _cellsOf(shape, M, N);
  if (cells <= 0 || !containerIsStorable(cells)) return false;
  // THE SHAPE MUST BE THE REASON IT DOES NOT FIT: longer, wider, or bigger
  // than any board a phone can hold. Failing the fit rules is necessary and
  // not sufficient, because a board can fail them on a RENDERING margin
  // alone: a 10x3 at thirty cells fails only because the renderer would give
  // it 48px cells and overflow the visible area by about 36 pixels. Dealing
  // that to somebody who asked for scrolling boards is an annoyance, not a
  // feature, and at the small end of the menu those marginal boards would
  // crowd out the corridors and wide boards the toggle is actually for.
  const { maxM, maxN } = fitAxisMaxima(shape);
  return M > maxM || N > maxN || cells > fitCeilingCells(shape);
}

/**
 * Is a board of this many cells inside the par model's own support for this
 * shape? The fit has seen boards up to the shape's fit ceiling and nothing
 * larger, so at or below it predictPar speaks from data and the lane uses it
 * verbatim; past it the model extrapolates, badly and in both directions
 * (hex at 600 cells prices 17s, cairo at 325 prices 4.9 hours), and the lane
 * prices provisionally instead. Stated per SHAPE rather than as one cell
 * count, because each shape's data ends in a different place.
 */
export function inSupportCells(shape, cells) {
  return Number.isFinite(cells) && cells > 0 && cells <= fitCeilingCells(shape);
}

/**
 * The longest fit-legal extent on each axis for this shape. The lane's
 * qualification reads these: a board belongs here when it is LONGER, WIDER
 * or BIGGER than any board a phone can hold, which is a statement about its
 * shape rather than about a rendering margin.
 */
const _axisMax = new Map();
export function fitAxisMaxima(shape) {
  const hit = _axisMax.get(shape);
  if (hit) return hit;
  let maxM = 0;
  let maxN = 0;
  for (const [M, N] of fitLegalFrontier(shape)) {
    maxM = Math.max(maxM, M);
    maxN = Math.max(maxN, N);
  }
  const out = Object.freeze({ maxM, maxN });
  _axisMax.set(shape, out);
  return out;
}

/**
 * The board's true SCREEN proportion (long side over short), from the
 * geometry rather than from lattice units: rect cells are square, so it is
 * the dims; a lattice's real extent is its wUnits x hUnits, which is what a
 * player sees and what M and N only proxy for (a 29x6 hex and a 6x29 hex
 * are not mirror images).
 */
function _aspect(shape, M, N) {
  if (shape === 'rect') return Math.max(M, N) / Math.min(M, N);
  const t = _tilingOf(shape, M, N);
  if (!t) return Infinity;
  const w = t.wUnits;
  const h = t.hUnits;
  if (!(w > 0) || !(h > 0)) return Infinity;
  return Math.max(w, h) / Math.min(w, h);
}

/**
 * Every size the lane will BUILD for a shape, one entry per DISTINCT cell
 * count (the biggest counts first), each carrying the dims that produce it.
 * The generator's menu, the synthBigEnd analog for the lane. Among dims
 * sharing a cell count the squarer pair wins, so a count reachable both as a
 * corridor and as a broad board is offered broad.
 *
 * THE ASPECT CAP IS GONE (2026-08-17). It was a taste, set at twice as long
 * as wide, and it was refusing exactly the boards the toggle exists to
 * unlock: his 25x3, a 5x25, a 6x20. What actually goes wrong on a thin board
 * is not proportion but the loss of a second dimension, and
 * MARATHON_MIN_SHORT_SIDE now states that in the place a bound belongs, with
 * a measurement behind it. Squarest-per-count survives as the tie-break,
 * which is a preference among equals rather than a refusal.
 * @param {string} shape
 * @returns {Array<{shape: string, M?: number, N?: number, rows?: number,
 *   cols?: number, cells: number}>}
 */
const _dimsCache = new Map();
export function marathonDims(shape) {
  const hit = _dimsCache.get(shape);
  if (hit) return hit;
  const byCells = new Map();
  for (let M = 1; M <= CANONICAL_MAX_DIM; M++) {
    for (let N = 1; N <= CANONICAL_MAX_DIM; N++) {
      // Same monotone break as the frontier scan, for the same reason.
      if (_cellsOf(shape, M, N) > CELL_SCAN_CAP) break;
      if (!marathonFits(shape, M, N)) continue;
      const squareness = Math.abs(M - N);
      const cells = _cellsOf(shape, M, N);
      const prev = byCells.get(cells);
      if (!prev || squareness < prev.squareness) byCells.set(cells, { M, N, squareness });
    }
  }
  const out = [...byCells.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([cells, { M, N }]) => (shape === 'rect'
      ? { shape, rows: M, cols: N, cells }
      : { shape, M, N, cells }));
  _dimsCache.set(shape, out);
  return out;
}

/** Shapes the lane may generate for: rect plus every registered tiling.
 * (Which of them the lane ACTUALLY generates for is the generator's own
 * cost decision; rhombille and deltoidal carry known per-shape generation
 * caps in the endless build, and the same caution applies here.) */
export function marathonShapes() {
  return ['rect', ...TILING_TYPES];
}

/**
 * `n` sizes SPREAD across a shape's menu, biggest first, rather than the n
 * biggest.
 *
 * The menu is ordered by size and the generator walks it until a cell is
 * full, so taking the head means the lane only ever builds its own giants.
 * That was survivable while every lane board was a giant by definition; now
 * that an ordinary-sized wide board qualifies, a generator walking from the
 * head would never reach one, and the whole second category would exist in
 * the rules and never on disk. Evenly spaced indices give a cell a big
 * board, a middling one and a small one instead of three of a size.
 *
 * @param {string} shape
 * @param {number} n how many sizes the caller intends to build
 */
export function marathonDimsSpread(shape, n) {
  const dims = marathonDims(shape);
  const want = Math.max(0, Math.floor(n));
  if (want === 0 || dims.length === 0) return [];
  if (want >= dims.length) return dims.slice();
  const out = [];
  for (let i = 0; i < want; i++) {
    out.push(dims[Math.round((i * (dims.length - 1)) / (want - 1 || 1))]);
  }
  return out;
}

// ── Provisional pricing (his scheme, 2026-08-17) ────────────────────────
//
// predictPar is exp(log-linear) and the fit has never seen a board past
// ~190 cells, so raw extrapolation at marathon dims is unusable: probed the
// same day, hex collapsed (600 cells priced 17s, which would band a monster
// as Quick) and cairo exploded (325 cells priced 4.9 hours), while rect and
// the rest looked merely unverifiable. The scheme he chose prices an
// out-of-support board from the model's OWN EDGE, extended linearly:
//
//   par = max(anchorPar * cells / anchorCells, FLOOR_PPC * cells)
//
// where the anchor is a REAL certified board at the shape's fit-ceiling
// dims wearing the same modifier set at the same density (so the anchor par
// is the model in support, never a synthetic feature vector), and the floor
// is the traversal cost no fit row has ever carried, the time to work a
// board bigger than one screen. Every priced row is flagged parProvisional;
// played marathon rows then teach the fit whatever the truth is, and the
// scheme retires when the model's support grows past the lane.

/**
 * The traversal floor, seconds per cell. The 0.4 figure is the arithmetic
 * he approved in the design check (hex 600c: max(66, 240) = 240s, Long
 * band); his number to move, one place to move it.
 */
export const MARATHON_TRAVERSAL_FLOOR_PPC = 0.4;

/**
 * The lane's provisional par. Pure: the caller supplies the anchor board's
 * par and cells (the generator builds the anchor; the nightly reprice
 * re-prices the STORED anchor features under the model of the day and calls
 * this again, so lane pars keep moving with the refit like everything
 * else). Degenerate anchors fall back to the floor alone rather than
 * fabricating a rate.
 *
 * @param {{cells: number, anchorPar: number, anchorCells: number}} p
 * @returns {number} seconds, rounded to 0.1
 */
export function marathonProvisionalPar(p) {
  const cells = Number(p && p.cells);
  if (!Number.isFinite(cells) || cells <= 0) return 0;
  const anchorPar = Number(p && p.anchorPar);
  const anchorCells = Number(p && p.anchorCells);
  const anchored = Number.isFinite(anchorPar) && anchorPar > 0
    && Number.isFinite(anchorCells) && anchorCells > 0
    ? anchorPar * (cells / anchorCells) : 0;
  const par = Math.max(anchored, MARATHON_TRAVERSAL_FLOOR_PPC * cells);
  return Math.round(par * 10) / 10;
}

// Re-exported so the lane's tests can pin the rect ceiling against his
// arithmetic without a second import path.
export { BOARD_WIDTH_CAP, CANONICAL_MAX_DIM };
