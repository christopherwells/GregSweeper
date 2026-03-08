import { isBoardSolvable } from './boardSolver.js';

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

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (board[r][c].isMine) continue;
      let count = 0;
      for (const dr of deltas) {
        for (const dc of deltas) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr;
          const nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && board[nr][nc].isMine) {
            count++;
          }
        }
      }
      board[r][c].adjacentMines = count;
    }
  }
}

// ── Anti-Zero-Cluster Redistribution ──────────────────
// Finds connected zero-cell clusters via BFS.
// If any cluster exceeds maxZeroCluster, relocates mines from
// dense areas into the zero region to break it up.

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

      // BFS to find connected zero cells
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
      // Pick a cell near the center of the cluster to place a mine nearby
      const center = cluster[Math.floor(cluster.length / 2)];

      // Find a non-mine cell within/adjacent to the cluster to place a mine
      const candidates = [];
      for (const cell of cluster) {
        // The zero-cell itself is a candidate (will split the cluster)
        if (Math.abs(cell.row - excludeRow) <= 1 && Math.abs(cell.col - excludeCol) <= 1) continue;
        candidates.push(cell);
      }

      if (candidates.length === 0) continue;

      // Pick a random candidate from the cluster interior
      const target = candidates[Math.floor(rng() * candidates.length)];

      // Find a mine from a "dense" area (cells with 3+ adjacent mines around it)
      // to relocate into the cluster
      let sourceMine = null;
      const mineList = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (board[r][c].isMine) {
            if (Math.abs(r - excludeRow) <= 1 && Math.abs(c - excludeCol) <= 1) continue;
            // Count how many adjacent mines this mine has
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

      // Sort by density (most adjacent mines first) — relocate from dense areas
      mineList.sort((a, b) => b.adjMines - a.adjMines);
      if (mineList.length > 0) {
        sourceMine = mineList[0];
      }

      if (sourceMine) {
        // Move the mine: remove from source, place at target
        board[sourceMine.row][sourceMine.col].isMine = false;
        board[target.row][target.col].isMine = true;

        // Recalculate adjacency for the whole board
        calculateAdjacency(board);
      }
    }
  }
}

export function generateBoard(rows, cols, mines, excludeRow, excludeCol, rng, options = {}) {
  const maxSolveAttempts = 50;

  for (let attempt = 0; attempt < maxSolveAttempts; attempt++) {
    const board = createEmptyBoard(rows, cols);
    placeMines(board, mines, excludeRow, excludeCol, rng);
    calculateAdjacency(board);

    // Anti-zero-cluster redistribution
    if (options.maxZeroCluster && options.maxZeroCluster < Infinity) {
      redistributeMines(board, options.maxZeroCluster, excludeRow, excludeCol, rng || Math.random);
    }

    // Check solvability — skip on last attempt (accept whatever we have)
    if (attempt < maxSolveAttempts - 1 &&
        !isBoardSolvable(board, rows, cols, excludeRow, excludeCol)) {
      // Advance RNG state so the next attempt produces a different layout
      if (rng) rng();
      continue;
    }

    return board;
  }

  // Fallback — should not reach here, but just in case
  const board = createEmptyBoard(rows, cols);
  placeMines(board, mines, excludeRow, excludeCol, rng);
  calculateAdjacency(board);
  return board;
}
