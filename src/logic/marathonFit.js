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
 * The most cells any fit-legal board of this shape can have: the size the
 * lane must EXCEED. Derived from the same frontier, so still boardFit's own
 * verdicts and no new pixel arithmetic.
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
 * Is (M, N) a legal MARATHON size for this shape? In the doubled region of
 * some fit-legal pair (clipped to the canonical container's dimension cap),
 * NOT itself fit-legal (a board that fits the phone belongs to the base
 * lane), and storable.
 * @param {string} shape 'rect' or a TILING_TYPES entry
 * @param {number} M rows for rect, lattice M otherwise
 * @param {number} N cols for rect, lattice N otherwise
 * @returns {boolean}
 */
export function marathonFits(shape, M, N) {
  if (!Number.isInteger(M) || !Number.isInteger(N) || M < 1 || N < 1) return false;
  if (M > CANONICAL_MAX_DIM || N > CANONICAL_MAX_DIM) return false;
  const covered = fitLegalFrontier(shape)
    .some(([m, n]) => M <= 2 * m && N <= 2 * n);
  if (!covered) return false;
  if (_fitsPhone(shape, M, N)) return false;
  const cells = _cellsOf(shape, M, N);
  if (cells <= 0 || !containerIsStorable(cells)) return false;
  // MARATHON MEANS BIGGER, in the only currency a player feels: cells. The
  // doubled-dims bound alone admits shapes that are merely TALL, because
  // rectFitsPhone tolerates a thin board (a 17x1 passes it) and failing it
  // by height says nothing about size. Unbounded, the menu offered a 25x1
  // at twenty-five cells as a "marathon" board. Requiring more cells than
  // the shape's own fit ceiling is the same doubling ruling read in the
  // currency it was about, and it takes every small ribbon out at once.
  return cells > fitCeilingCells(shape);
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
 * The most lopsided board the lane will BUILD. A bound is not a taste:
 * marathonFits inherits rectFitsPhone's tolerance for thin boards (a 17x1
 * passes that), so corridors sit inside the region just above each shape's
 * ceiling, and the menu is where they are refused, exactly as the base
 * library refuses them in synthBigEnd rather than in rectFitsPhone. Twice as
 * long as it is wide is the limit because the camera scrolls BOTH axes: past
 * that a player is panning a corridor, and a glide from one end spends most
 * of its travel in one direction.
 */
export const MARATHON_MAX_ASPECT = 2;

/**
 * Every marathon size the lane will BUILD for a shape, one entry per
 * DISTINCT cell count (the biggest counts first), each carrying the dims
 * that produce it. The generator's menu, the synthBigEnd analog for the
 * lane. Among dims sharing a cell count the squarer pair wins, and a count
 * whose squarest option is still a corridor is dropped entirely.
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
      const aspect = _aspect(shape, M, N);
      if (!(aspect <= MARATHON_MAX_ASPECT)) continue;
      const cells = _cellsOf(shape, M, N);
      const prev = byCells.get(cells);
      if (!prev || aspect < prev.aspect) byCells.set(cells, { M, N, aspect });
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
