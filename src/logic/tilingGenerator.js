// ── Archimedean tiling board generator (Project Coastline, Phase 2) ─────────
//
// Builds a certified no-guess board on a tiling topology. The pure topology +
// geometry live in the leaf module tilingGeometry.js (which the renderer and
// the Phase 1 fixture also import, without pulling the solver); this module is
// the SOLVER-using half — it exists to place mines and prove the board.
//
// A tiling board is otherwise an ordinary board: createEmptyBoard's container +
// gatedCert flag, recalcAllAdjacency's topology-aware numbers, and the shipped
// isBoardSolvable as its acceptance oracle. The two board layers:
//   - TOPOLOGY (`board._cellNeighbors`): the certifier's geometry-free adjacency.
//   - GEOMETRY (`board._cellPos` + `board._tiling`): read only by the renderer
//     (and later the compass ray + worm momentum), never by the certifier.

import { createEmptyBoard, cleanSolverArtifacts } from './boardGenerator.js';
import { recalcAllAdjacency, applyGimmicks } from './gimmicks.js';
import { defineCellNeighbors } from './adjacency.js';
import { isBoardSolvable } from './boardSolver.js';
import { createDailyRNG } from './seededRandom.js';
import { buildTiling, buildTiling488, containerFor } from './tilingGeometry.js';

// Gimmicks that work on a tiling. Mystery/liar/locked/sonar/mirror ride Phase
// 1's topology-aware placement + number recompute; compass rides its Phase 2
// geometric ray (computeCompassRay); worm crawls the neighbor graph with
// geometric momentum (stepWorm's tiling branch); walls SEVER edges from the
// graph (applyWallsTiling), so the certifier sees a smaller graph and needs no
// wall logic. Every modifier now has a tiling story.
export const TILING_SAFE_GIMMICKS = ['mystery', 'liar', 'locked', 'sonar', 'mirror', 'compass', 'worm', 'walls'];

export { buildTiling, buildTiling488, containerFor };

/**
 * Generate a certified no-guess 4.8.8 tiling board by seeded search — the same
 * way the Phase 1 fixture was found, and the same way a rectangular daily is
 * accepted: try seeded mine layouts, keep the first the SHIPPED certifier clears
 * with no guesses from the fixed center-octagon opener.
 *
 * Frozen-board contract (like daily/weekly): mines are placed at generation and
 * the first click never relocates one. The center octagon and its neighbors are
 * kept mine-free so the opener cascades.
 *
 * @param {{type?:string, M:number, N:number, mines:number, seed:string,
 *          gimmicks?:string[], techniqueFloor?:number, maxAttempts?:number}} opts
 *          type selects the tiling ('4.8.8' default, 'hex' for 6.6.6).
 * @returns {{board:Array, rows:number, cols:number, firstClick:number,
 *            tiling:object, check:object, activeGimmicks:string[],
 *            applied:object} | null}  null if nothing certified
 */
export function generateTilingBoard({ type = '4.8.8', M, N, mines, seed, gimmicks = [], techniqueFloor = 0, maxAttempts = 600 }) {
  const T = buildTiling(type, M, N);
  const total = T.total;
  const { rows, cols } = containerFor(total);

  // The middle cell is the fixed opener (centerIndex is tiling-specific: the
  // center octagon for 4.8.8, the center hexagon for 6.6.6).
  const firstClick = T.centerIndex;
  const fr = Math.floor(firstClick / cols);
  const fc = firstClick % cols;

  // Keep the opener + its neighbors mine-free so the first click opens ground.
  const excluded = new Set([firstClick, ...T.adj[firstClick]]);
  const placeable = [];
  for (let i = 0; i < total; i++) if (!excluded.has(i)) placeable.push(i);
  const nMines = Math.min(mines, placeable.length);

  let best = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const rng = createDailyRNG(`${seed}:tiling:${T.type}:${attempt}`);
    const board = createEmptyBoard(rows, cols);
    defineCellNeighbors(board, rows, cols, T.adj);
    board._cellPos = T.cellPos;
    // The renderer reads wUnits/hUnits (pitch-unit board extent) off _tiling;
    // applyWallsTiling reads type/M/N to rebuild the wireframe.
    board._tiling = { type: T.type, M, N, wUnits: T.wUnits, hUnits: T.hUnits };

    // Fisher-Yates over the placeable set, then take the first nMines.
    const pool = placeable.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const at = (i) => board[(i / cols) | 0][i % cols];
    for (let k = 0; k < nMines; k++) at(pool[k]).isMine = true;

    recalcAllAdjacency(board);

    // Apply gimmicks (if any) on the pre-numbered board — applyGimmicks reads
    // the board's own topology (_cellNeighbors) for placement and recomputes
    // displayed numbers through it, so sonar/mirror/liar etc. certify against
    // exactly what the player sees.
    let applied = {};
    if (gimmicks.length > 0) {
      const gRng = createDailyRNG(`${seed}:tiling-gimmick:${T.type}:${attempt}`);
      applied = applyGimmicks(board, 1, gimmicks, gRng);
    }

    // Certify from the opener against the board's LIVE topology (a wall gimmick
    // would have severed edges from _cellNeighbors before this point).
    const check = isBoardSolvable(board, rows, cols, fr, fc, board._cellNeighbors);
    cleanSolverArtifacts(board);

    const certified = check.solvable && check.remainingUnknowns === 0;
    if (certified && (check.techniqueLevel || 0) >= techniqueFloor) {
      return { board, rows, cols, firstClick, tiling: T, check, activeGimmicks: gimmicks.slice(), applied };
    }
    if (certified && !best) {
      best = { board, rows, cols, firstClick, tiling: T, check, activeGimmicks: gimmicks.slice(), applied };
    }
  }
  // A certified board below the technique floor beats nothing; the caller
  // decides what to do with a null (a precompute throws, a practice board
  // warns). We never silently return an uncertified board.
  return best;
}
