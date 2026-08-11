import { recomputeDisplayedMines, recalcAllAdjacency, countAdjacentMines } from './gimmicks.js';
import { buildNeighborCache, sonarScanCells } from './adjacency.js';
import { findDeducibleFrontier } from './boardSolver.js';
// tilingGeometry is a LEAF: scanLines rebuilds the polygon geometry from the
// board's own _tiling descriptor (the renderer's rebuild pattern) to trace
// its horizontal/vertical sweep lines.
import { buildTiling } from './tilingGeometry.js';

// ── Tiling area ports (Christopher's ruling, challenge-250 interview
// 2026-08-03: "each area effect generalizes the way sonar did") ─────────
// On an explicit topology the container's rows/cols are pure storage, so a
// rectangular blast shape lands on scattered, geometrically meaningless
// cells (his petals report, 2026-08-03: "the sonar and scan for petals
// doesn't look right", Scan was sweeping a container row/column). The
// ports follow the MINE-INFORMATION adjacency, corner-inclusive, the same
// `sonarScanCells` the sonar modifier displays and the certifier proves
// from, because these are information tools: Scan and X-Ray read the
// depth-2 ball, Magnet extracts over the depth-1 neighborhood. Only the
// worm (a physical crawler) is side-only. Rectangular boards keep their
// row+column / 5×5 / 3×3 shapes verbatim.

// The depth-2 ball around (row, col), INCLUDING the target cell itself,
// the aimed cell counts, exactly as the rectangular shapes include their
// center. Flat indices, target first.
function ballArea2(board, rows, cols, row, col) {
  return [row * cols + col, ...sonarScanCells(board, rows, cols, row, col)];
}

/**
 * Scan on an explicit topology: the tiling counterpart of scanRowCol.
 * Scan's identity is the CROSSING SWEEP, "move in some reasonable way
 * horizontally and vertically, not a blob" (his correction, 2026-08-03,
 * rejecting the first-cut depth-2 ball), so the region is the horizontal
 * and vertical LINES through the target's center: every cell whose polygon
 * the line passes through. Cells are convex, so "the horizontal line
 * y = cy0 crosses this cell" is exactly "the cell's vertex y-range spans
 * cy0", an exact, parameter-free test that reproduces the rectangular
 * row/column when applied to unit squares. STRICT spanning (not ≤) so a
 * line grazing a vertex tip does not drag a neighboring row in (on the
 * 4.8.8, the line through a diamond's center touches the adjacent
 * octagons' tips exactly).
 *
 * @returns {{across: number[], down: number[], acrossMines: number,
 *            downMines: number}} flat indices of the horizontal and
 *          vertical line cells (target in both, as the rect row and
 *          column both contain it) and their mine counts
 */
export function scanLines(board, rows, cols, row, col) {
  const t = board._tiling;
  const tiling = buildTiling(t.type, t.M, t.N);
  const origin = row * cols + col;
  const { cx, cy } = tiling.cellPos[origin];

  const across = [], down = [];
  let acrossMines = 0, downMines = 0;
  for (let i = 0; i < tiling.total; i++) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const vi of tiling.cellVerts[i]) {
      const v = tiling.verts[vi];
      if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
    }
    const isMine = board[Math.floor(i / cols)][i % cols].isMine;
    if (i === origin || (minY < cy && cy < maxY)) {
      across.push(i);
      if (isMine) acrossMines++;
    }
    if (i === origin || (minX < cx && cx < maxX)) {
      down.push(i);
      if (isMine) downMines++;
    }
  }
  return { across, down, acrossMines, downMines };
}

export function findSafeCell(board) {
  // Deduction-first: prefer the next PROVABLY-safe cell (flags-blind) so
  // every Reveal Safe use is a worked example the player could have
  // reasoned to, instead of an oracle read of the true mine layout.
  // Falls back to the old random safe pick only when nothing is
  // deducible, a genuine frontier, where the oracle IS the power-up's
  // legitimate value.
  try {
    const frontier = findDeducibleFrontier(board, { respectFlags: false });
    for (const s of frontier.safe) {
      const cell = board[s.row][s.col];
      if (cell && !cell.isFlagged) return cell;
    }
  } catch {
    // fall through to the random pick
  }
  const candidates = [];
  for (const row of board) {
    for (const cell of row) {
      if (!cell.isMine && !cell.isRevealed) {
        candidates.push(cell);
      }
    }
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

export function scanRowCol(board, row, col) {
  const rows = board.length;
  const cols = board[0].length;

  let rowMines = 0;
  for (let c = 0; c < cols; c++) {
    if (board[row][c].isMine) rowMines++;
  }

  let colMines = 0;
  for (let r = 0; r < rows; r++) {
    if (board[r][col].isMine) colMines++;
  }

  return { row, col, rowMines, colMines };
}

export function defuseMine(board, row, col) {
  board[row][col].isMine = false;
  // Recalculate adjacency for neighbors, then refresh any gimmick cells
  // (wormhole/liar/mirror/sonar/compass) whose displayed numbers are
  // derived from the mine layout.
  recalcAreaAdjacency(board, row, col);
  recomputeDisplayedMines(board);
}

/** Shield defuse: marks cell as defused (visual distinction from regular reveal) */
export function shieldDefuse(board, row, col) {
  board[row][col].isMine = false;
  board[row][col].isDefused = true;
  recalcAreaAdjacency(board, row, col);
  recomputeDisplayedMines(board);
}

// Recalculate adjacency counts around a cell whose mine was just removed,
// the scoped version of recalcAllAdjacency, used after a single-cell defuse so
// we don't walk the whole board. Shares gimmicks.countAdjacentMines, so it can
// never drift from the full recompute (walls block adjacency; a mine carries
// no number and reads 0).
//
// The cells that can have changed are the removed mine itself and EXACTLY its
// neighbors: adjacency is symmetric, so a cell counted the origin if and only
// if the origin counts it. The visit set is therefore derived from the same
// neighbor cache that answers "what touches what" (the sonarScanCells /
// plateDisarmCells precedent), not from a container walk.
//
// It used to walk the container 3x3, which IS the neighborhood on a rectangle
// and is not one on a tiling, where (row, col) is pure storage, measured, a
// shield break there left 2 to 8 cells still counting a mine that is off the
// board, on every lattice but the honeycomb, whose own escape rate is 38.5%
// of cells and so was luck rather than safety.
function recalcAreaAdjacency(board, centerRow, centerCol) {
  const rows = board.length;
  const cols = board[0].length;
  // One cache for the whole area: countAdjacentMines derives the board's
  // neighbor lists when it isn't handed any, so calling it bare in a loop
  // would rebuild them on every iteration.
  const nbrCache = buildNeighborCache(board, rows, cols);
  const origin = centerRow * cols + centerCol;
  for (const idx of [origin, ...nbrCache[origin]]) {
    const r = Math.floor(idx / cols);
    const c = idx % cols;
    board[r][c].adjacentMines = board[r][c].isMine ? 0 : countAdjacentMines(board, r, c, nbrCache);
  }
}

// ── Magnet Power-Up ──────────────────────────────────

export function magnetPull(board, centerRow, centerCol) {
  const rows = board.length;
  const cols = board[0].length;

  // The magnet's reach: the 3x3 block on a rectangle, the depth-1 graph
  // neighborhood (target + its neighbors, corner-inclusive) on an explicit
  // topology, the sonar-precedent port, one step instead of two because
  // extraction is the strongest effect in the kit.
  const reach = [];
  if (board._cellNeighbors) {
    const origin = centerRow * cols + centerCol;
    for (const idx of [origin, ...board._cellNeighbors[origin]]) {
      reach.push({ row: Math.floor(idx / cols), col: idx % cols });
    }
  } else {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const nr = centerRow + dr;
        const nc = centerCol + dc;
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) reach.push({ row: nr, col: nc });
      }
    }
  }

  const minesInArea = [];
  for (const { row, col } of reach) {
    if (board[row][col].isMine && !board[row][col].isFlagged && !board[row][col].isRevealed) {
      minesInArea.push({ row, col });
    }
  }

  // An empty pull is a clean no-op (pinned in test/magnetExtract.test.mjs):
  // no extraction, no highlight, the same contract on every shape.
  if (minesInArea.length === 0) return { extractedMines: [], affectedArea: [] };

    // EXTRACTION, not relocation (redesigned 2026-06-11): the magnet
  // pulls mines OFF the board entirely. Removal is information-
  // monotone - numbers only drop, no mine ever lands on a cell the
  // player had proven safe - so the no-guess certificate survives.
  // (The old relocation could certify a safe cell as a provable mine
  // via the liar display clamp; that whole class of bug is gone.)
  // Extracted cells reveal as defused markers, the same treatment as
  // shield defuse, so the player sees exactly what the magnet took.
  const extractedMines = [];
  for (const m of minesInArea) {
    const cell = board[m.row][m.col];
    cell.isMine = false;
    cell.isDefused = true;
    cell.isRevealed = true;
    extractedMines.push(m);
  }

  // Full adjacency recalculation (wall-aware), then refresh gimmick cells
  // whose displayed numbers depend on the mine layout.
  recalcAllAdjacency(board);
  recomputeDisplayedMines(board);

  return { extractedMines, affectedArea: reach };
}

// ── X-Ray Power-Up ────────────────────────────────────

/**
 * X-Ray: mine positions in the effect area around (row, col), the 5×5
 * block on a rectangle, the depth-2 ball on an explicit topology. Returns
 * the AREA alongside the mines so the action layer highlights exactly what
 * the logic read (its old inline ±2 loop was a second copy of this
 * geometry, one refactor away from drifting).
 * @returns {{mines: Array<{row,col}>, area: Array<{row,col}>}}
 */
export function xRayScan(board, row, col) {
  const rows = board.length;
  const cols = board[0].length;
  const area = [];

  if (board._cellNeighbors) {
    for (const idx of ballArea2(board, rows, cols, row, col)) {
      area.push({ row: Math.floor(idx / cols), col: idx % cols });
    }
  } else {
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const nr = row + dr;
        const nc = col + dc;
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) area.push({ row: nr, col: nc });
      }
    }
  }

  const mines = area.filter(({ row: r, col: c }) => board[r][c].isMine)
    .map(({ row: r, col: c }) => ({ row: r, col: c }));
  return { mines, area };
}

