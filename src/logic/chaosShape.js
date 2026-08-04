// Chaos board shapes.
//
// Chaos is the one mode outside the no-guess contract, and the one that says
// so on its own chip. Giving it the seven board shapes is therefore RENDERER
// REACH: nothing about certification changes, because chaos's modifiers
// already void the base board's certificate the moment they apply.
//
// Two decisions live here, both because chaos is unlike every other mode:
//
//  1. THE SHAPE IS ROLLED, not scheduled. The daily draws its shape from the
//     date so every player agrees; the ladder authors its shape per block so
//     difficulty is designed. Chaos has neither obligation — it is a private,
//     unrecorded run whose whole premise is that you do not know what is
//     coming — so the roll is per round off the session's own rng.
//
//  2. THE SIZE IS TRANSLATED, not authored. getChaosDifficulty ramps a
//     rectangle's side length and density by round, and a lattice has no
//     "side length": M and N mean different things on each of the six. So the
//     round's CELL COUNT is the currency, and each shape picks the (M, N)
//     landing nearest it, which keeps a round's board the same size in the
//     only sense that transfers.
//
// Pure: no DOM, no state, no clock. The generator does the work.

import { buildTiling, TILING_TYPES, containerIsStorable } from './tilingGeometry.js';

// How often a chaos round is a lattice rather than a square. Half, matching
// the daily rotation's ruled split — chaos should feel like the rest of the
// game got stranger, not like a different game.
export const CHAOS_TILING_PROB = 0.5;

// Rhombille and deltoidal are deliberately absent, for the same measured
// reason: chaos generates ON THE FIRST CLICK, with the player waiting and a
// clock about to start, which is the one place in the game where a
// multi-second stall is unacceptable. Rhombille's certifier has no Pass B and
// leans on Pass C for every board (worst measured 2.4s at 90 cells, and chaos
// reaches ~150); deltoidal measured 3.7s at a round-12 board. Both stay on the
// authored ladder and in the endless pool, where their specs are proven at
// particular sizes and generation happens behind a level card rather than
// under a click.
export const CHAOS_SHAPES = Object.freeze(
  TILING_TYPES.filter((t) => t !== 'rhombille' && t !== 'deltoidal'),
);

// The cell count above which a chaos lattice stops growing. Chaos ramps to
// ~196 cells on a rectangle; the tilings pay more per cell to generate, and a
// first-click stall is the failure mode this whole file has to avoid.
export const CHAOS_MAX_TILING_CELLS = 150;

/**
 * The shape for a chaos round: null for a rectangle, else a CHAOS_SHAPES
 * entry. Rolled, not scheduled (see the header).
 *
 * Spends exactly two rng() calls on a lattice round and one on a square, so a
 * caller sharing the stream can reason about it.
 *
 * @param {number} round
 * @param {() => number} rng
 * @returns {string|null}
 */
export function resolveChaosShape(round, rng = Math.random) {
  if (!(round >= 1)) return null;
  if (rng() >= CHAOS_TILING_PROB) return null;
  return CHAOS_SHAPES[Math.floor(rng() * CHAOS_SHAPES.length)] || null;
}

/**
 * The (M, N) for a shape landing nearest a target cell count, and the count
 * it actually lands on.
 *
 * Searched rather than tabulated because each builder's M and N mean
 * something different (4.8.8 cells are `2MN-M-N+1`, floret's are `6MN`, and
 * the hexagon's are plain `M*N`), so one table would be six tables. The
 * search is tiny and runs once per round.
 *
 * Candidates must be STORABLE: a prime cell count forces a 1xN container,
 * which is outside the canonical dimension bounds. Chaos boards are never
 * stored, but the same containerFor drives the DOM grid, and a 1x149
 * container would render as a single row.
 *
 * @param {string} type a CHAOS_SHAPES entry
 * @param {number} targetCells
 * @returns {{M: number, N: number, cells: number}|null}
 */
const _dimsMemo = new Map();

export function chaosTilingDims(type, targetCells) {
  const want = Math.min(Math.max(targetCells, 24), CHAOS_MAX_TILING_CELLS);
  const key = `${type}:${want}`;
  if (_dimsMemo.has(key)) return _dimsMemo.get(key);

  let best = null;
  for (let M = 2; M <= 14; M++) {
    for (let N = 2; N <= 14; N++) {
      let cells;
      try {
        cells = buildTiling(type, M, N).total;
      } catch { continue; }
      // Cell count rises monotonically in N for every builder here, so once
      // this row is over the cap the rest of it is too. Without the break the
      // search builds all 169 patches per call, and a 14x14 floret is 1,176
      // cells of geometry to throw away.
      if (cells > CHAOS_MAX_TILING_CELLS) break;
      if (cells < 24) continue;
      if (!containerIsStorable(cells)) continue;
      // Distance to the target, PENALISED for a lopsided patch. A pure
      // nearest-count search picks exact strips: the 4.8.8 hits 63 cells
      // exactly at M=3, N=13, which renders as a long ribbon, while its
      // squarer 72-cell patch is only eight cells further from a 64 target.
      // The penalty is in cell-count units so the two are comparable.
      const score = Math.abs(cells - want) + Math.abs(M - N) * 2.5;
      if (!best || score < best.score) best = { M, N, cells, score };
    }
  }
  const out = best ? { M: best.M, N: best.N, cells: best.cells } : null;
  // Memoised because the answer is a pure function of (type, target) and the
  // search is the expensive part: a chaos round asks once, but the tests ask
  // hundreds of times and the geometry is identical every time.
  _dimsMemo.set(key, out);
  return out;
}

/**
 * The full board plan for a chaos round: the shape, its dimensions, and the
 * mine count scaled to whatever cell count the lattice could actually land
 * on. Returns null when the round is rectangular, so the caller keeps its
 * existing path untouched.
 *
 * The mine count is rescaled rather than carried over because a lattice
 * rarely lands exactly on the round's cell count; keeping the round's DENSITY
 * is what makes a lattice round as hard as the square one it replaced.
 *
 * @param {{rows: number, cols: number, mines: number}} rectDiff the round's
 *   rectangular difficulty, from getChaosDifficulty
 * @param {string|null} shape from resolveChaosShape
 * @returns {{type: string, M: number, N: number, cells: number, mines: number}|null}
 */
export function chaosTilingPlan(rectDiff, shape) {
  if (!shape || !rectDiff) return null;
  const targetCells = rectDiff.rows * rectDiff.cols;
  const dims = chaosTilingDims(shape, targetCells);
  if (!dims) return null;
  const density = rectDiff.mines / targetCells;
  const mines = Math.max(2, Math.min(Math.round(dims.cells * density), dims.cells - 10));
  // Below the constructive threshold, tiling rejection sampling has a real
  // per-seed miss rate — the same finding the daily band configs carry — and
  // a miss here is a failed first click rather than a slow one.
  const constructive = mines / dims.cells < 0.22;
  return { type: shape, M: dims.M, N: dims.N, cells: dims.cells, mines, constructive };
}
