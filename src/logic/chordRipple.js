// The chord ripple's schedule: when each revealed cell animates in, and how
// long input stays locked while it does.
//
// HIS REPORT (2026-08-21): "the lag one experiences when playing all of the
// shape game modes... an odd reveal the cells lag which doesn't happen with
// classic", and later, decisively, "This doesn't seem to be a ms problem. It
// is taking closer to a full second to render."
//
// THE BUG. Both numbers were computed as Manhattan distance over CONTAINER
// indices:
//
//     const dist = Math.abs(c.row - row) + Math.abs(c.col - col);
//
// On a rectangle (row, col) IS the geometry, so a chord's neighbours sit 1 or
// 2 away and the lock came to a flat 480ms. On a tiling, rows/cols are pure
// container indexing, an arbitrary factorization of the cell list, and two
// cells that touch on the lattice can sit many container rows apart. Measured
// on a plain 98-cell 4.8.8 stored as 7x14: every one of its 53 chordable cells
// locked input for at least 500ms, the median was 840ms and the worst 1040ms,
// against a flat 480ms for a comparable rectangle.
//
// So a chord on a tiling froze input for roughly a second while its cells
// straggled in in a scattered order, and NO FRAME WAS EVER SLOW. That is why
// this survived so long: frame-time probes, timeline traces and paint
// measurements all reported the board as healthy, because it was. The main
// thread was idle. The game was simply ignoring the player.
//
// THE RULE, which the rest of the codebase already follows: distance between
// cells is a question about the GRAPH, never about container arithmetic. The
// rectangular branch is preserved VERBATIM, because classic was never wrong
// and is the baseline every fix here is measured against (his ruling).
//
// The bound is the second half. The cascade path was given one when it had
// this same class of bug (CASCADE_STAGGER_MAX_MS, 2026-08-21); without one
// here, any future lattice whose graph runs deeper re-creates a multi-second
// freeze silently. A correct metric that is also bounded cannot.

import { buildNeighborCache } from './adjacency.js';

/** Per-hop stagger, and the ripple animation's own duration. */
export const CHORD_STEP_MS = 40;
export const CHORD_BASE_MS = 350;
/** Slack past the last animation before input comes back. */
export const CHORD_UNLOCK_BUFFER_MS = 50;
/**
 * The most stagger any chord may schedule, mirroring CASCADE_STAGGER_MAX_MS.
 * A shallow chord keeps the historic 40ms step exactly; a deep one compresses,
 * so the input lock can never run away from the player again.
 */
export const CHORD_STAGGER_MAX_MS = 200;

/**
 * Hop distance from (r, c) to every cell in `cells`.
 *
 * On an explicit topology this is a breadth-first walk of the real adjacency
 * graph. On a rectangle it stays container Manhattan distance, which there is
 * the true geometry and keeps classic byte-identical.
 *
 * @returns {Map<number, number>} flat index -> hops
 */
export function chordRippleDistances(board, rows, cols, r, c, cells) {
  const origin = r * cols + c;
  const out = new Map();

  if (!board._cellNeighbors) {
    // RECTANGULAR, VERBATIM: (row, col) is the geometry here.
    for (const cell of cells) {
      out.set(cell.row * cols + cell.col, Math.abs(cell.row - r) + Math.abs(cell.col - c));
    }
    return out;
  }

  const want = new Set(cells.map((cell) => cell.row * cols + cell.col));
  const adj = buildNeighborCache(board, rows, cols);
  const seen = new Set([origin]);
  let frontier = [origin];
  let hops = 0;
  if (want.has(origin)) out.set(origin, 0);
  // Walk out until every requested cell is priced. A cell the walk cannot
  // reach (a walled-off island) keeps no entry and is read as 0 by the
  // caller, which shows it immediately rather than stalling the unlock on a
  // cell that will never arrive.
  while (frontier.length && out.size < want.size) {
    hops++;
    const next = [];
    for (const idx of frontier) {
      for (const n of adj[idx] || []) {
        if (seen.has(n)) continue;
        seen.add(n);
        next.push(n);
        if (want.has(n)) out.set(n, hops);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * The whole schedule for one chord: each cell's animation delay, and the
 * single lock duration that covers them.
 *
 * ONE SOURCE for both, deliberately. They were computed from two separate
 * copies of the same expression, so a fix to one could silently leave the
 * other wrong, which is the drift class this codebase keeps paying for.
 *
 * @returns {{delays: Map<number, number>, lockMs: number, maxHops: number}}
 */
export function chordRippleSchedule(board, rows, cols, r, c, cells) {
  const hops = chordRippleDistances(board, rows, cols, r, c, cells);
  let maxHops = 0;
  for (const h of hops.values()) if (h > maxHops) maxHops = h;

  // Compress only when the honest schedule would overrun the bound.
  const step = maxHops * CHORD_STEP_MS > CHORD_STAGGER_MAX_MS
    ? CHORD_STAGGER_MAX_MS / maxHops
    : CHORD_STEP_MS;

  const delays = new Map();
  for (const [idx, h] of hops) delays.set(idx, Math.round(h * step));

  let maxDelay = 0;
  for (const d of delays.values()) if (d > maxDelay) maxDelay = d;
  return {
    delays,
    maxHops,
    lockMs: CHORD_BASE_MS + maxDelay + CHORD_UNLOCK_BUFFER_MS,
  };
}
