import { isBoardSolvable } from './boardSolver.js';
import { hasWallBetween } from './gimmicks.js';

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

export function calculateAdjacency(board) {
  const rows = board.length;
  const cols = board[0].length;
  const deltas = [-1, 0, 1];
  const wallEdges = board._wallEdges || null;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (board[r][c].isMine) continue;
      let count = 0;
      for (const dr of deltas) {
        for (const dc of deltas) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr;
          const nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
            if (wallEdges && hasWallBetween(wallEdges, r, c, nr, nc)) continue;
            if (board[nr][nc].isMine) count++;
          }
        }
      }
      board[r][c].adjacentMines = count;
    }
  }
}

// ── Anti-Zero-Cluster Redistribution ──────────────────

function findZeroClusters(board) {
  const rows = board.length;
  const cols = board[0].length;
  const visited = new Set();
  const clusters = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const key = `${r},${c}`;
      if (visited.has(key)) continue;
      if (board[r][c].isMine || board[r][c].adjacentMines !== 0) continue;

      const cluster = [];
      const queue = [{ row: r, col: c }];
      visited.add(key);

      while (queue.length > 0) {
        const { row, col } = queue.shift();
        cluster.push({ row, col });

        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = row + dr;
            const nc = col + dc;
            const nkey = `${nr},${nc}`;
            if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && !visited.has(nkey)) {
              visited.add(nkey);
              if (!board[nr][nc].isMine && board[nr][nc].adjacentMines === 0) {
                queue.push({ row: nr, col: nc });
              }
            }
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
        calculateAdjacency(board);
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

  calculateAdjacency(board);
}

// ── Constructive Solvable Board Generator ────────────────
// Builds boards guaranteed to be solvable by placing mines one at a time
// and verifying solvability after each placement. Falls back to rejection
// sampling for low-density boards where random generation works fine.

function generateConstructive(rows, cols, targetMines, excludeRow, excludeCol, rng, wallEdges) {
  const MAX_RESTARTS = 50;
  const totalCells = rows * cols;

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

      // Place mine tentatively
      board[mr][mc].isMine = true;
      minesPlaced++;
      calculateAdjacency(board);

      // Check solvability — but only do the full check periodically for performance
      // For the first ~60% of mines, skip most checks (they almost always pass)
      const checkThreshold = targetMines * 0.55;
      if (minesPlaced <= checkThreshold && minesPlaced % 3 !== 0) {
        consecutiveFails = 0;
        continue; // Skip check for early mines (very likely solvable)
      }

      const result = isBoardSolvable(board, rows, cols, excludeRow, excludeCol);
      cleanSolverArtifacts(board);

      if (result.solvable || result.remainingUnknowns === 0) {
        consecutiveFails = 0;
        continue; // Valid placement
      }

      // Unsolvable — undo
      board[mr][mc].isMine = false;
      minesPlaced--;
      calculateAdjacency(board);
      consecutiveFails++;

      // Backtrack: swap out an existing mine to escape dead ends
      if (consecutiveFails > 10 && backtrackBudget > 0 && minesPlaced > 0) {
        const existingMines = [];
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            if (board[r][c].isMine) existingMines.push({ row: r, col: c });
          }
        }
        // Remove 1-2 random existing mines
        const removeCount = Math.min(1 + Math.floor(rng() * 2), existingMines.length);
        for (let k = 0; k < removeCount; k++) {
          const vi = Math.floor(rng() * existingMines.length);
          const victim = existingMines[vi];
          board[victim.row][victim.col].isMine = false;
          minesPlaced--;
          existingMines.splice(vi, 1);
        }
        calculateAdjacency(board);
        consecutiveFails = 0;
        backtrackBudget--;

        // Reset candidate scan to find new positions
        candidateIdx = candidates.length; // triggers reshuffle on next iteration
      }

      // If we've failed too many times without backtrack budget, give up this restart
      if (consecutiveFails > candidates.length * 0.8) break;
    }

    if (minesPlaced === targetMines) {
      calculateAdjacency(board);
      const finalCheck = isBoardSolvable(board, rows, cols, excludeRow, excludeCol);
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

  // Fallback: rejection sampling for low density boards
  const maxSolveAttempts = density > 0.35 ? 500 : density > 0.30 ? 300 : density > 0.25 ? 200 : 50;
  const maxAcceptableUnknowns = 0; // no 50/50s ever

  let bestBoard = null;
  let bestUnknowns = Infinity;

  for (let attempt = 0; attempt < maxSolveAttempts; attempt++) {
    let board;

    if (attempt === 0 || attempt % 5 === 0) {
      board = createEmptyBoard(rows, cols);
      placeMines(board, mines, excludeRow, excludeCol, rng);
      calculateAdjacency(board);
    } else if (bestBoard) {
      board = createEmptyBoard(rows, cols);
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
      placeMines(board, mines, excludeRow, excludeCol, rng);
      calculateAdjacency(board);
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
    placeMines(board, mines, excludeRow, excludeCol, rng);
    calculateAdjacency(board);
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
