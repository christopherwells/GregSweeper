import { isBoardSolvable, buildNeighborCache } from './boardSolver.js';
import { recalcAllAdjacency } from './gimmicks.js';

// ── Incremental adjacency updates ────────────────────────────
// Recomputing the entire board's adjacency on every mine place/remove
// during constructive generation is O(rows*cols*8). These helpers update
// only the 8 neighbors of the changed cell, which is what actually changes.
//
// Both functions assume the neighbor cache is wall-aware (built from the
// same wallEdges that recalcAllAdjacency would respect), so the resulting
// adjacentMines counts match a full recomputation exactly.

function placeMineIncremental(board, r, c, neighborCache) {
  const cols = board[0].length;
  const idx = r * cols + c;
  board[r][c].isMine = true;
  board[r][c].adjacentMines = 0; // mines don't display a number
  for (const ni of neighborCache[idx]) {
    const nr = (ni / cols) | 0;
    const nc = ni - nr * cols;
    if (!board[nr][nc].isMine) board[nr][nc].adjacentMines++;
  }
}

function removeMineIncremental(board, r, c, neighborCache) {
  const cols = board[0].length;
  const idx = r * cols + c;
  // Decrement neighbors first (they're losing this mine)
  for (const ni of neighborCache[idx]) {
    const nr = (ni / cols) | 0;
    const nc = ni - nr * cols;
    if (!board[nr][nc].isMine) board[nr][nc].adjacentMines--;
  }
  // Now (r, c) is no longer a mine — compute its own adjacency from scratch
  board[r][c].isMine = false;
  let count = 0;
  for (const ni of neighborCache[idx]) {
    const nr = (ni / cols) | 0;
    const nc = ni - nr * cols;
    if (board[nr][nc].isMine) count++;
  }
  board[r][c].adjacentMines = count;
}

export function createEmptyBoard(rows, cols) {
  const board = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      row.push({
        row: r,
        col: c,
        isMine: false,
        isRevealed: false,
        isFlagged: false,
        adjacentMines: 0,
        revealAnimDelay: 0,
      });
    }
    board.push(row);
  }
  // Reveal-gated certification contract: every board created by this
  // code certifies with sonar / compass / wormhole constraints gated on
  // their origin cell being revealed (boardSolver reads this flag as its
  // default). The flag TRAVELS WITH THE BOARD — serialized into canonical
  // payloads and game saves — so historical boards certified ungated
  // (no flag) keep their original contract on every solver surface.
  board._gatedCert = true;
  return board;
}

export function placeMines(board, count, excludeRow, excludeCol, rng = Math.random) {
  const rows = board.length;
  const cols = board[0].length;
  const candidates = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (Math.abs(r - excludeRow) <= 1 && Math.abs(c - excludeCol) <= 1) continue;
      candidates.push({ row: r, col: c });
    }
  }

  // Fisher-Yates shuffle with provided rng
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  const mineCount = Math.min(count, candidates.length);
  for (let i = 0; i < mineCount; i++) {
    const { row, col } = candidates[i];
    board[row][col].isMine = true;
  }
}


// ── Anti-Zero-Cluster Redistribution ──────────────────

function findZeroClusters(board) {
  const rows = board.length;
  const cols = board[0].length;
  // Deliberately WALL-BLIND: this BFS walks zero clusters straight through
  // wall edges, and has since walls shipped. It is a generation heuristic
  // (how big is the largest opening?), not adjacency truth, and changing it
  // would change which boards the generator accepts on every walls date. The
  // `ignoreWalls` cache preserves that behavior exactly while still routing
  // the traversal through the board's topology rather than r/c arithmetic.
  // Whether it SHOULD be wall-aware is a real open question, filed separately.
  const neighborCache = buildNeighborCache(board, rows, cols, { ignoreWalls: true });
  const visited = new Set();
  const clusters = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (visited.has(i)) continue;
      if (board[r][c].isMine || board[r][c].adjacentMines !== 0) continue;

      const cluster = [];
      const queue = [{ row: r, col: c }];
      visited.add(i);

      while (queue.length > 0) {
        const { row, col } = queue.shift();
        cluster.push({ row, col });

        for (const ni of neighborCache[row * cols + col]) {
          if (visited.has(ni)) continue;
          visited.add(ni);
          const nr = (ni / cols) | 0;
          const nc = ni % cols;
          if (!board[nr][nc].isMine && board[nr][nc].adjacentMines === 0) {
            queue.push({ row: nr, col: nc });
          }
        }
      }

      if (cluster.length > 1) {
        clusters.push(cluster);
      }
    }
  }

  return clusters;
}

function redistributeMines(board, maxZeroCluster, excludeRow, excludeCol, rng = Math.random) {
  const rows = board.length;
  const cols = board[0].length;
  const maxAttempts = 10;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const clusters = findZeroClusters(board);
    const oversized = clusters.filter(c => c.length > maxZeroCluster);
    if (oversized.length === 0) break;

    for (const cluster of oversized) {
      const candidates = [];
      for (const cell of cluster) {
        if (Math.abs(cell.row - excludeRow) <= 1 && Math.abs(cell.col - excludeCol) <= 1) continue;
        candidates.push(cell);
      }

      if (candidates.length === 0) continue;

      const target = candidates[Math.floor(rng() * candidates.length)];

      let sourceMine = null;
      const mineList = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (board[r][c].isMine) {
            if (Math.abs(r - excludeRow) <= 1 && Math.abs(c - excludeCol) <= 1) continue;
            let adjMines = 0;
            for (let dr = -1; dr <= 1; dr++) {
              for (let dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) continue;
                const nr = r + dr;
                const nc = c + dc;
                if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && board[nr][nc].isMine) {
                  adjMines++;
                }
              }
            }
            mineList.push({ row: r, col: c, adjMines });
          }
        }
      }

      mineList.sort((a, b) => b.adjMines - a.adjMines);
      if (mineList.length > 0) {
        sourceMine = mineList[0];
      }

      if (sourceMine) {
        board[sourceMine.row][sourceMine.col].isMine = false;
        board[target.row][target.col].isMine = true;
        recalcAllAdjacency(board);
      }
    }
  }
}

// ── Smarter retry: swap 1-3 mine positions instead of full regeneration ──

function swapMines(board, swapCount, excludeRow, excludeCol, rng) {
  const rows = board.length;
  const cols = board[0].length;

  const mines = [];
  const safeCells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (Math.abs(r - excludeRow) <= 1 && Math.abs(c - excludeCol) <= 1) continue;
      if (board[r][c].isMine) mines.push({ row: r, col: c });
      else safeCells.push({ row: r, col: c });
    }
  }

  const swaps = Math.min(swapCount, mines.length, safeCells.length);
  for (let i = 0; i < swaps; i++) {
    const mi = Math.floor(rng() * mines.length);
    const si = Math.floor(rng() * safeCells.length);
    const mine = mines[mi];
    const safe = safeCells[si];

    board[mine.row][mine.col].isMine = false;
    board[safe.row][safe.col].isMine = true;

    mines[mi] = safe;
    safeCells[si] = mine;
  }

  recalcAllAdjacency(board);
}

// ── Constructive Solvable Board Generator ────────────────
// Builds boards guaranteed to be solvable by placing mines one at a time
// and verifying solvability after each placement. Falls back to rejection
// sampling for low-density boards where random generation works fine.

function generateConstructive(rows, cols, targetMines, excludeRow, excludeCol, rng, wallEdges) {
  const MAX_RESTARTS = 50;
  const totalCells = rows * cols;

  // Wall-aware neighbor cache depends only on dimensions and walls (not mine
  // positions), so build it once here and reuse it across every solver call
  // and every incremental adjacency update for all restarts.
  const neighborCache = buildNeighborCache({ _wallEdges: wallEdges || null }, rows, cols);

  for (let restart = 0; restart < MAX_RESTARTS; restart++) {
    const board = createEmptyBoard(rows, cols);
    // Apply pre-existing wall edges so adjacency is wall-aware from the start
    if (wallEdges) board._wallEdges = wallEdges;

    // Build shuffled candidate list (excluding first-click safe zone)
    const candidates = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (Math.abs(r - excludeRow) <= 1 && Math.abs(c - excludeCol) <= 1) continue;
        candidates.push({ row: r, col: c });
      }
    }
    // Shuffle candidates
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    let minesPlaced = 0;
    let candidateIdx = 0;
    let consecutiveFails = 0;
    let backtrackBudget = 8; // max times we'll remove+retry existing mines

    while (minesPlaced < targetMines) {
      // Ran out of candidates to try — reshuffle the non-mine cells
      if (candidateIdx >= candidates.length) {
        // Rebuild candidate list from current non-mine, non-safe-zone cells
        candidates.length = 0;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            if (board[r][c].isMine) continue;
            if (Math.abs(r - excludeRow) <= 1 && Math.abs(c - excludeCol) <= 1) continue;
            candidates.push({ row: r, col: c });
          }
        }
        for (let i = candidates.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
        }
        candidateIdx = 0;
        if (candidates.length === 0) break; // no more positions possible
      }

      const { row: mr, col: mc } = candidates[candidateIdx];
      candidateIdx++;

      if (board[mr][mc].isMine) continue;

      // Place mine tentatively (incremental — only updates 8 neighbors)
      placeMineIncremental(board, mr, mc, neighborCache);
      minesPlaced++;

      // Check solvability — but only do the full check periodically for performance
      // For the first ~60% of mines, skip most checks (they almost always pass)
      const checkThreshold = targetMines * 0.55;
      if (minesPlaced <= checkThreshold && minesPlaced % 3 !== 0) {
        consecutiveFails = 0;
        continue; // Skip check for early mines (very likely solvable)
      }

      const result = isBoardSolvable(board, rows, cols, excludeRow, excludeCol, neighborCache);
      cleanSolverArtifacts(board);

      if (result.solvable || result.remainingUnknowns === 0) {
        consecutiveFails = 0;
        continue; // Valid placement
      }

      // Unsolvable — undo (incremental — only updates 8 neighbors)
      removeMineIncremental(board, mr, mc, neighborCache);
      minesPlaced--;
      consecutiveFails++;

      // Backtrack: swap out an existing mine to escape dead ends
      if (consecutiveFails > 10 && backtrackBudget > 0 && minesPlaced > 0) {
        const existingMines = [];
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            if (board[r][c].isMine) existingMines.push({ row: r, col: c });
          }
        }
        // Remove 1-2 random existing mines (incremental adjacency)
        const removeCount = Math.min(1 + Math.floor(rng() * 2), existingMines.length);
        for (let k = 0; k < removeCount; k++) {
          const vi = Math.floor(rng() * existingMines.length);
          const victim = existingMines[vi];
          removeMineIncremental(board, victim.row, victim.col, neighborCache);
          minesPlaced--;
          existingMines.splice(vi, 1);
        }
        consecutiveFails = 0;
        backtrackBudget--;

        // Reset candidate scan to find new positions
        candidateIdx = candidates.length; // triggers reshuffle on next iteration
      }

      // If we've failed too many times without backtrack budget, give up this restart
      if (consecutiveFails > candidates.length * 0.8) break;
    }

    if (minesPlaced === targetMines) {
      // Incremental updates kept adjacency consistent — no full recompute needed
      const finalCheck = isBoardSolvable(board, rows, cols, excludeRow, excludeCol, neighborCache);
      cleanSolverArtifacts(board);
      if (finalCheck.solvable || finalCheck.remainingUnknowns === 0) {
        return board;
      }
    }
  }

  return null; // Failed after all restarts
}

export function generateBoard(rows, cols, mines, excludeRow, excludeCol, rng, options = {}) {
  // Default rng to Math.random if not provided
  if (!rng) rng = Math.random;
  const density = mines / (rows * cols);
  const hasGimmicks = options.hasGimmicks || false;

  // Pre-generated wall edges (applied before mine placement for wall-aware solvability)
  const wallEdges = options.wallEdges || null;

  // For high density (>22%) or gimmick levels, use constructive generator
  if (density > 0.22 || hasGimmicks) {
    // Try constructive approach up to 3 times (each attempt does 50 internal restarts)
    for (let outerTry = 0; outerTry < 3; outerTry++) {
      const constructiveBoard = generateConstructive(rows, cols, mines, excludeRow, excludeCol, rng, wallEdges);
      if (constructiveBoard) {
        // Apply anti-zero-cluster if needed (skip if it breaks solvability)
        if (options.maxZeroCluster && options.maxZeroCluster < Infinity) {
          const clone = createEmptyBoard(rows, cols);
          // Carry the walls: redistributeMines recalculates adjacency and
          // the acceptance solve below verifies THIS clone, so a wall-less
          // copy would (a) rewrite every number non-wall-aware and (b)
          // certify a board other than the one shipped — the caller
          // re-attaches the walls afterwards, but the numbers stay stale
          // (applyGimmicks keeps pre-applied walls without a recalc) and
          // the certifier can then "prove" cells the real topology doesn't.
          if (constructiveBoard._wallEdges) clone._wallEdges = constructiveBoard._wallEdges;
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              clone[r][c].isMine = constructiveBoard[r][c].isMine;
              clone[r][c].adjacentMines = constructiveBoard[r][c].adjacentMines;
            }
          }
          redistributeMines(clone, options.maxZeroCluster, excludeRow, excludeCol, rng);
          const after = isBoardSolvable(clone, rows, cols, excludeRow, excludeCol);
          cleanSolverArtifacts(clone);
          if (after.solvable || after.remainingUnknowns === 0) {
            return clone; // Redistributed version is still solvable
          }
          // Redistribution broke it — return original constructive board
        }
        return constructiveBoard;
      }
    }
  }

  // Fallback: rejection sampling for low density boards. Every board built
  // here carries the caller's walls BEFORE any adjacency pass — recalc /
  // redistribute / swap all read board._wallEdges, and the acceptance solve
  // must certify the board the player actually gets (this path also runs
  // when the constructive generator exhausts its tries on a walls level).
  const maxSolveAttempts = density > 0.35 ? 500 : density > 0.30 ? 300 : density > 0.25 ? 200 : 50;
  const maxAcceptableUnknowns = 0; // no 50/50s ever

  let bestBoard = null;
  let bestUnknowns = Infinity;

  for (let attempt = 0; attempt < maxSolveAttempts; attempt++) {
    let board;

    if (attempt === 0 || attempt % 5 === 0) {
      board = createEmptyBoard(rows, cols);
      if (wallEdges) board._wallEdges = wallEdges;
      placeMines(board, mines, excludeRow, excludeCol, rng);
      recalcAllAdjacency(board);
    } else if (bestBoard) {
      board = createEmptyBoard(rows, cols);
      if (wallEdges) board._wallEdges = wallEdges;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          board[r][c].isMine = bestBoard[r][c].isMine;
          board[r][c].adjacentMines = bestBoard[r][c].adjacentMines;
        }
      }
      const swapCount = 1 + Math.floor(rng() * 3);
      swapMines(board, swapCount, excludeRow, excludeCol, rng);
    } else {
      board = createEmptyBoard(rows, cols);
      if (wallEdges) board._wallEdges = wallEdges;
      placeMines(board, mines, excludeRow, excludeCol, rng);
      recalcAllAdjacency(board);
    }

    if (options.maxZeroCluster && options.maxZeroCluster < Infinity) {
      redistributeMines(board, options.maxZeroCluster, excludeRow, excludeCol, rng);
    }

    const result = isBoardSolvable(board, rows, cols, excludeRow, excludeCol);

    if (result.solvable) {
      cleanSolverArtifacts(board);
      return board;
    }

    if (result.remainingUnknowns < bestUnknowns) {
      bestUnknowns = result.remainingUnknowns;
      bestBoard = board;
    }

    if (result.remainingUnknowns <= maxAcceptableUnknowns) {
      cleanSolverArtifacts(board);
      return board;
    }

    if (rng) rng();
  }

  const finalBoard = bestBoard || (() => {
    const board = createEmptyBoard(rows, cols);
    if (wallEdges) board._wallEdges = wallEdges;
    placeMines(board, mines, excludeRow, excludeCol, rng);
    recalcAllAdjacency(board);
    return board;
  })();
  cleanSolverArtifacts(finalBoard);
  return finalBoard;
}

// The board solver's isBoardSolvable sets isRevealed/revealAnimDelay on
// board cells during its analysis. Clean these up so the returned board
// is pristine (all cells unrevealed).
export function cleanSolverArtifacts(board) {
  for (const row of board) {
    for (const cell of row) {
      cell.isRevealed = false;
      cell.revealAnimDelay = 0;
    }
  }
}
