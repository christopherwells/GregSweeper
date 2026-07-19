// ── Adjacency: the single source of truth for "what touches what" ──────────
//
// The flood, the chord, the zero-cluster BFS and the mine counters all answer
// "which cells neighbor this one?" through this module. That used to be four
// separate implementations (buildNeighborCache in boardSolver,
// countAdjacentMines in gimmicks, plus inline 8-neighbor loops in the flood,
// the chord, and the zero-cluster BFS), which is how they drifted apart — see
// the mine-carries-no-number incident in CLAUDE.md, where a stale count
// serialized into a canonical board.
//
// It is NOT yet every such site. The plate estimator, the locked-cell and
// mirror-pair placement checks, and sonar's/compass's scans still derive
// neighbors from coordinates; CLAUDE.md's "still rectangular" list under Board
// Topology is the authoritative inventory. Do not read this module as a
// guarantee that a board's topology is honored everywhere.
//
// This is a LEAF module: it imports nothing. gimmicks.js and boardSolver.js
// both depend on it, which is what breaks the cycle that kept the adjacency
// primitive split across those two files in the first place.
//
// ── The topology contract ──────────────────────────────────────────────────
//
// A board's adjacency is a GRAPH, not a geometry. Two boards can share the
// same rows/cols container and have completely different neighbor structure.
// There are two ways a board declares its topology:
//
//   1. Implicitly (every board shipped today): a rectangular grid with
//      8-neighborhood adjacency, minus any edges severed by walls. Derived
//      on demand from `rows`, `cols`, and `board._wallEdges`.
//
//   2. Explicitly, via `board._cellNeighbors`: a per-cell edge list stamped by
//      defineCellNeighbors(). When present it IS the topology, full stop —
//      rows/cols degrade to pure container indexing and walls do not enter,
//      because a severed link is simply absent from the list.
//
// Form 2 is what lets the no-guess certifier run on a non-rectangular board
// (Archimedean tilings, Project Coastline) without the certifier learning any
// new geometry. isBoardSolvable already consumes nothing but flat indices and
// a neighbor list, so handing it form 2 is the whole port.
//
// Both forms produce the SAME data shape, so no consumer can tell them apart:
//   Array<number[]>, outer length rows*cols, outer index r*cols+c,
//   inner entries flat neighbor indices. No self, no duplicates, symmetric.

/**
 * A board is a rows × cols array of cells with a few properties stamped on the
 * array itself. `_cellNeighbors` is the explicit topology (form 2 above);
 * `_wallEdges` the severed-edge set of an implicit rectangular one (form 1).
 *
 * @typedef {Array<Array<any>> & {
 *   _wallEdges?: Set<string>,
 *   _cellNeighbors?: Array<number[]>,
 *   _gatedCert?: boolean,
 * }} Board
 */

/**
 * Canonical key for the wall edge between two ORTHOGONALLY adjacent cells.
 * Normalized so the smaller endpoint comes first, making the key
 * direction-free.
 *
 * This string format is a stored contract: it is what lands in the `wallEdges`
 * array of every canonical `dailyBoard`/`weeklyBoard` payload (inside the
 * signed bytes), in the `walls` array of every `cruxes/{date}` payload, and in
 * every in-flight game save. Changing the format silently un-walls every board
 * already written — hasWallBetween would build a key the stored Set does not
 * contain and find nothing, which reads as "no wall" rather than as an error.
 */
export function wallKey(r1, c1, r2, c2) {
  // Normalize so smaller coordinate comes first
  if (r1 < r2 || (r1 === r2 && c1 < c2)) return `${r1},${c1}-${r2},${c2}`;
  return `${r2},${c2}-${r1},${c1}`;
}

export function hasWallBetween(wallEdges, r1, c1, r2, c2) {
  if (!wallEdges || wallEdges.size === 0) return false;

  const dr = r2 - r1;
  const dc = c2 - c1;

  // Cardinal move: check direct edge
  if (dr === 0 || dc === 0) {
    return wallEdges.has(wallKey(r1, c1, r2, c2));
  }

  // Diagonal move: check the 4 edges of the 2×2 square the diagonal passes through.
  // Blocked if ANY pair of adjacent edges both exist — forming an L-corner
  // or a continuous wall segment across the diagonal's path.
  //
  // Example: two adjacent horizontal walls block a diagonal through them:
  //   X  A  F       walls: X-B and A-Y (e3 and e4)
  //   -- --         X cannot see Y diagonally (continuous barrier)
  //   B  Y  G       but A can see G (only one wall on that side)
  //
  // NOTE: this rule is irreducibly rectangular — it presumes a diagonal step
  // crosses exactly one 2×2 block bounded by exactly four orthogonal edges.
  // That is precisely why walls are baked INTO the neighbor list rather than
  // consulted alongside it: on a non-rectangular topology there are no
  // diagonals to disambiguate, so a severed link is just a missing edge.
  const e1 = wallEdges.has(wallKey(r1, c1, r1, c2));  // horiz edge at source row
  const e2 = wallEdges.has(wallKey(r2, c1, r2, c2));  // horiz edge at dest row
  const e3 = wallEdges.has(wallKey(r1, c1, r2, c1));  // vert edge at source col
  const e4 = wallEdges.has(wallKey(r1, c2, r2, c2));  // vert edge at dest col

  return (e1 && e3)    // L-corner at source cell
      || (e2 && e4)    // L-corner at dest cell
      || (e3 && e4)    // continuous wall spanning the row boundary
      || (e1 && e2);   // continuous wall spanning the column boundary
}

/**
 * The board's neighbor lists: for each flat cell index, the flat indices of
 * the cells it touches.
 *
 * Returns `board._cellNeighbors` verbatim when the board declares an explicit
 * topology; otherwise derives the rectangular 8-neighborhood, minus wall-severed
 * edges. Depends only on dimensions, walls, and topology — never on mine
 * positions — which is why generateConstructive can build one cache from a
 * synthetic `{_wallEdges}` object and reuse it across every placement restart.
 *
 * @param {Board} board
 * @param {number} rows
 * @param {number} cols
 * @param {{ignoreWalls?: boolean}} [options]
 *   ignoreWalls — derive the plain 8-neighborhood, ignoring `board._wallEdges`.
 *   Only meaningful for an implicit rectangular topology; a board carrying an
 *   explicit `_cellNeighbors` has already resolved its walls into the edge
 *   list, so there is nothing left to ignore and the flag is a no-op.
 * @returns {Array<number[]>}
 */
export function buildNeighborCache(board, rows, cols, options) {
  const explicit = board && board._cellNeighbors;
  if (explicit) return explicit;

  const wallEdges = (options && options.ignoreWalls) ? null : (board && board._wallEdges) || null;
  const cache = new Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const nbrs = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr;
          const nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
            if (wallEdges && hasWallBetween(wallEdges, r, c, nr, nc)) continue;
            nbrs.push(nr * cols + nc);
          }
        }
      }
      cache[r * cols + c] = nbrs;
    }
  }
  return cache;
}

/**
 * Validate an explicit topology, returning a defensive copy.
 *
 * The validation is the point. A malformed edge list does not crash — it
 * quietly certifies a board nobody can actually solve, because the solver
 * trusts its neighbor lists absolutely. The invariant that matters most is
 * SYMMETRY: if A counts a mine at B, then B's own clue must count back toward
 * A, or the constraint system describes a board that cannot exist and every
 * downstream proof is meaningless.
 *
 * Runs at board construction and on restore from a save, never in a hot loop,
 * so it can afford to be thorough.
 *
 * @param {number} rows
 * @param {number} cols
 * @param {Array<number[]>} neighbors
 * @returns {Array<number[]>}
 * @throws {Error} naming the specific violation
 */
function validateCellNeighbors(rows, cols, neighbors) {
  const total = rows * cols;
  if (!Array.isArray(neighbors) || neighbors.length !== total) {
    throw new Error(`cellNeighbors: expected ${total} entries, got ${Array.isArray(neighbors) ? neighbors.length : typeof neighbors}`);
  }

  const copy = new Array(total);
  for (let i = 0; i < total; i++) {
    const list = neighbors[i];
    if (!Array.isArray(list)) {
      throw new Error(`cellNeighbors: entry ${i} is not an array`);
    }
    const seen = new Set();
    for (const n of list) {
      if (!Number.isInteger(n) || n < 0 || n >= total) {
        throw new Error(`cellNeighbors: cell ${i} lists out-of-range neighbor ${n}`);
      }
      if (n === i) {
        throw new Error(`cellNeighbors: cell ${i} lists itself as a neighbor`);
      }
      if (seen.has(n)) {
        throw new Error(`cellNeighbors: cell ${i} lists neighbor ${n} twice`);
      }
      seen.add(n);
    }
    copy[i] = list.slice();
  }

  // Symmetry, checked both ways so the error names the missing direction.
  for (let i = 0; i < total; i++) {
    for (const n of copy[i]) {
      if (!copy[n].includes(i)) {
        throw new Error(`cellNeighbors: adjacency is not symmetric — ${i} lists ${n}, but ${n} does not list ${i}`);
      }
    }
  }

  return copy;
}

/**
 * Boolean form, for callers deciding whether to TRUST a topology that arrived
 * from outside the process — a game save, a stored payload. A save whose
 * topology is truncated or corrupt must be dropped, not resumed: restoring it
 * would hand the player a board whose adjacency disagrees with the one it was
 * certified under, which is the no-guess promise breaking silently.
 *
 * @param {number} rows
 * @param {number} cols
 * @param {any} neighbors
 * @returns {boolean}
 */
export function isValidCellNeighbors(rows, cols, neighbors) {
  try {
    validateCellNeighbors(rows, cols, neighbors);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stamp a validated explicit topology onto a board.
 *
 * @param {Board} board                 the container (rows × cols)
 * @param {number} rows
 * @param {number} cols
 * @param {Array<number[]>} neighbors   flat index -> flat neighbor indices
 * @returns {Board} the same board, with _cellNeighbors stamped
 */
export function defineCellNeighbors(board, rows, cols, neighbors) {
  board._cellNeighbors = validateCellNeighbors(rows, cols, neighbors);
  return board;
}
