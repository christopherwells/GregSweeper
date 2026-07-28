// ── Tiling board generator (Project Coastline, Phase 2) ────────────────────
//
// Builds a certified no-guess board on a tiling topology. The pure topology +
// geometry live in the leaf module tilingGeometry.js (which the renderer and
// the Phase 1 fixture also import, without pulling the solver); this module is
// the SOLVER-using half — it exists to place mines and prove the board.
//
// Nothing here is per-tiling: the type is a string it hands to buildTiling and
// stamps into the RNG seeds, so the six shipped lattices (two Archimedean,
// 4.8.8 and 6.6.6, plus their four Laves cousins) run byte-identical code and a
// seventh costs a builder, not a branch.
//
// A tiling board is otherwise an ordinary board: createEmptyBoard's container +
// gatedCert flag, recalcAllAdjacency's topology-aware numbers, and the shipped
// isBoardSolvable as its acceptance oracle. The two board layers:
//   - TOPOLOGY (`board._cellNeighbors`): the certifier's geometry-free adjacency.
//   - GEOMETRY (`board._cellPos` + `board._tiling`): read only by the renderer
//     (and later the compass ray + worm momentum), never by the certifier.

import { createEmptyBoard, cleanSolverArtifacts, generateConstructive } from './boardGenerator.js';
import { recalcAllAdjacency, applyGimmicks } from './gimmicks.js';
import { defineCellNeighbors } from './adjacency.js';
import { isBoardSolvable, findDecorativeGimmicks, TESTABLE_GIMMICK_TYPES } from './boardSolver.js';
import { createDailyRNG } from './seededRandom.js';
import { buildTiling, buildTiling488, containerFor } from './tilingGeometry.js';

// Gimmicks that work on a tiling. Mystery/liar/locked/sonar/mirror ride Phase
// 1's topology-aware placement + number recompute; compass rides its Phase 2
// geometric ray (computeCompassRay); worm crawls the neighbor graph with
// geometric momentum (stepWorm's tiling branch); walls SEVER edges from the
// graph (applyWallsTiling), so the certifier sees a smaller graph and needs no
// wall logic. Every modifier has a tiling story.
//
// The list stays one list for six lattices, and that was measured rather than
// assumed when the four Laves tilings landed: every modifier here was run on
// every lattice, 30 seeds each singly plus sonar+walls and liar+mystery+locked
// stacked. All 1800 runs returned a CERTIFIED board (this function returns one
// only when the shipped certifier cleared it), and every modifier appeared in
// the `applied` payload on every lattice, so none of them silently placed
// nothing.
//
// The one thing per-lattice is the COMPASS's direction set, and it lives in
// gimmicks.js beside the other direction tables. Picking the wrong set does not
// fail here, it returns short rays that read as plausible, which is what
// test/tilingCompass.test.mjs exists to catch.
export const TILING_SAFE_GIMMICKS = ['mystery', 'liar', 'locked', 'sonar', 'mirror', 'compass', 'worm', 'walls'];

// Density above which mine placement CONSTRUCTS rather than samples. Matches
// generateBoard's own rectangular threshold so the two shapes switch strategy
// at the same difficulty, rather than a tiling silently getting a weaker
// generator than a square board at identical density.
//
// The four Laves lattices need the constructive path far MORE than the two
// Archimedean ones do, not less: measured over 12 seeds on the sampling side,
// floret certifies 7/12 at density 0.208, deltoidal 8/12 at 0.181 and rhombille
// 0/12 at 0.211, while the same boards go 30/30 on the constructive side. The
// threshold is therefore left where it is and the practice boards are sized to
// sit above it (see COASTLINE_BOARDS in coastlineLink.js). Lowering it for
// their sake would change every rectangular board's generator too.
export const CONSTRUCTIVE_DENSITY_THRESHOLD = 0.22;

// Attempts that must produce a board whose every testable modifier is
// LOAD-BEARING before the requirement is dropped. Mirrors the daily play
// path's own LOAD_BEARING_BUDGET (gameActions.js) exactly, including its
// reason: better to ship a board with a decorative modifier than to spin
// forever, so the bar is a preference with a bound, never a hard gate.
export const TILING_LOAD_BEARING_BUDGET = 25;

export { buildTiling, buildTiling488, containerFor };

/**
 * Generate a certified no-guess tiling board by seeded search — the same way the
 * Phase 1 fixture was found, and the same way a rectangular daily is accepted:
 * try seeded mine layouts, keep the first the SHIPPED certifier clears with no
 * guesses from the fixed center-cell opener.
 *
 * Frozen-board contract (like daily/weekly): mines are placed at generation and
 * the first click never relocates one. The center cell and its neighbors are
 * kept mine-free so the opener cascades.
 *
 * @param {{type?:string, M:number, N:number, mines:number, seed:string,
 *          gimmicks?:string[], techniqueFloor?:number, maxAttempts?:number,
 *          loadBearingBudget?:number}} opts
 *          type names the tiling: any entry of TILING_TYPES, defaulting to the
 *          4.8.8. M and N are that tiling's LATTICE dimensions, which are not
 *          the container's and mean something different per tiling (its own
 *          cell-count formula is in containerIsStorable's note).
 *          loadBearingBudget: attempts that must ALSO have every testable
 *          modifier load-bearing; 0 disables the requirement entirely.
 * @returns {{board:Array, rows:number, cols:number, firstClick:number,
 *            tiling:object, check:object, activeGimmicks:string[],
 *            applied:object} | null}  null if nothing certified
 */
export function generateTilingBoard({
  type = '4.8.8', M, N, mines, seed, gimmicks = [], techniqueFloor = 0, maxAttempts = 600,
  loadBearingBudget = TILING_LOAD_BEARING_BUDGET,
}) {
  const T = buildTiling(type, M, N);
  const total = T.total;
  const { rows, cols } = containerFor(total);

  // The middle cell is the fixed opener. centerIndex is the tiling's OWN center
  // (the cell nearest its patch's center of mass), never the container's middle
  // slot. A container is an arbitrary exact factorization, so whether the two
  // coincide is arithmetic luck that varies with M and N.
  const firstClick = T.centerIndex;
  const fr = Math.floor(firstClick / cols);
  const fc = firstClick % cols;

  // Keep the opener + its neighbors mine-free so the first click opens ground.
  const excluded = new Set([firstClick, ...T.adj[firstClick]]);
  const placeable = [];
  for (let i = 0; i < total; i++) if (!excluded.has(i)) placeable.push(i);
  const nMines = Math.min(mines, placeable.length);

  // Stamping a fresh tiling board is needed by both placement paths.
  const makeBoard = () => {
    const b = createEmptyBoard(rows, cols);
    defineCellNeighbors(b, rows, cols, T.adj);
    b._cellPos = T.cellPos;
    // The renderer reads wUnits/hUnits (pitch-unit board extent) off _tiling;
    // applyWallsTiling reads type/M/N to rebuild the wireframe.
    b._tiling = { type: T.type, M, N, wUnits: T.wUnits, hUnits: T.hUnits };
    return b;
  };

  // Above this density, random layouts almost never certify and the search has
  // to CONSTRUCT instead — mirroring generateBoard's own `density > 0.22 ||
  // hasGimmicks` rule, which is why a rectangle ships at 30% density and a
  // tiling did not. Measured on 4.8.8 before this path existed: per-layout
  // certification falls to ~0.7% at density 0.22 and to zero in 363,000
  // layouts at 0.30, so rejection sampling was not slow there, it was
  // asymptotically dead. Below the threshold random layouts certify readily and
  // are much cheaper, so the cheap path stays the default exactly as it does
  // for rectangles.
  const density = nMines / total;
  const useConstructive = density > CONSTRUCTIVE_DENSITY_THRESHOLD;
  const hasTestableGimmick = gimmicks.some((g) => TESTABLE_GIMMICK_TYPES.includes(g));
  const topo = { neighborCache: T.adj, excluded, makeBoard };

  let best = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const rng = createDailyRNG(`${seed}:tiling:${T.type}:${attempt}`);
    let board;

    if (useConstructive) {
      // Place mines one at a time, keeping the board solvable, with
      // backtracking. `excluded` is the opener plus its true GRAPH neighbors,
      // which is what the rectangular 3x3 safe zone means on a lattice that
      // has one. A null here means this attempt found nothing; fall through to
      // the next seed rather than giving up, same as a failed random layout.
      board = generateConstructive(rows, cols, nMines, fr, fc, rng, null, topo);
      if (!board) continue;
    } else {
      board = makeBoard();
      // Fisher-Yates over the placeable set, then take the first nMines.
      const pool = placeable.slice();
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      const at = (i) => board[(i / cols) | 0][i % cols];
      for (let k = 0; k < nMines; k++) at(pool[k]).isMine = true;
    }

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
    if (certified) {
      // MODIFIER LOAD-BEARING FILTER — the same bar the daily play path holds
      // rectangular boards to, which a tiling was never asked to clear. A
      // modifier is decorative on this layout when stripping its information
      // leaves the board solvable at the same difficulty; shipping one is a
      // promise the board does not keep. Measured on tilings before this gate
      // existed, over 40 seeds each: sonar was decorative on 45-60% of boards
      // and compass on 40-88%, so roughly half of those dailies would have
      // carried a modifier that did nothing.
      //
      // The topology needs no special handling: findDecorativeGimmicks threads
      // its cache into isBoardSolvable, and buildNeighborCache reads
      // `board._cellNeighbors` when present, so the tiling's own adjacency is
      // used whether or not a cache is passed. It is passed anyway, to skip
      // rebuilding it on every strip-test. That held when the four Laves
      // lattices landed, with no edit here: measured across all six over 25
      // seeds each, the filter takes sonar / compass / liar / mirror from 0-96%
      // decorative with the budget disabled to 0% with it on. The one exception
      // is rhombille (3/25 sonar, 6/25 compass), and it is the budget below
      // expiring rather than the filter missing: a rhombille attempt is the
      // dearest of the six, so a run has time for fewer of them.
      //
      // Budgeted, not absolute (mirrors LOAD_BEARING_BUDGET): past the budget
      // the requirement drops so generation cannot spin forever, and a
      // certified-but-decorative board is still kept as `best` so exhaustion
      // returns a real board rather than null. We never trade the no-guess
      // contract for this — only the modifier-means-something one.
      // Only worth asking when a modifier on this board is actually testable —
      // the filter opens with a baseline solve, so a walls/locked/mystery/worm
      // board would pay a second full solve per attempt to be told what the
      // exemption list already says.
      let decorative = [];
      if (hasTestableGimmick && attempt < loadBearingBudget) {
        decorative = findDecorativeGimmicks(
          board, rows, cols, fr, fc, gimmicks, board._cellNeighbors,
        );
        cleanSolverArtifacts(board);
      }
      const result = { board, rows, cols, firstClick, tiling: T, check, activeGimmicks: gimmicks.slice(), applied };
      if (decorative.length === 0 && (check.techniqueLevel || 0) >= techniqueFloor) {
        return result;
      }
      if (!best) best = result;
    }
  }
  // A certified board below the technique floor beats nothing; the caller
  // decides what to do with a null (a precompute throws, a practice board
  // warns). We never silently return an uncertified board.
  return best;
}
