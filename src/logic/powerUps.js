export function findSafeCell(board) {
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
  // Recalculate adjacency for neighbors
  recalcAreaAdjacency(board, row, col);
}

/** Shield defuse: marks cell as defused (visual distinction from regular reveal) */
export function shieldDefuse(board, row, col) {
  board[row][col].isMine = false;
  board[row][col].isDefused = true;
  recalcAreaAdjacency(board, row, col);
}

// Recalculate adjacency counts in area around (centerRow, centerCol)
function recalcAreaAdjacency(board, centerRow, centerCol) {
  const rows = board.length;
  const cols = board[0].length;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const nr = centerRow + dr;
      const nc = centerCol + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && !board[nr][nc].isMine) {
        let count = 0;
        for (let ddr = -1; ddr <= 1; ddr++) {
          for (let ddc = -1; ddc <= 1; ddc++) {
            if (ddr === 0 && ddc === 0) continue;
            const nnr = nr + ddr;
            const nnc = nc + ddc;
            if (nnr >= 0 && nnr < rows && nnc >= 0 && nnc < cols && board[nnr][nnc].isMine) {
              count++;
            }
          }
        }
        board[nr][nc].adjacentMines = count;
      }
    }
  }
}

// ── Magnet Power-Up ──────────────────────────────────

export function magnetPull(board, centerRow, centerCol) {
  const rows = board.length;
  const cols = board[0].length;
  const movedMines = [];

  // Find mines in the 3x3 area
  const minesInArea = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const nr = centerRow + dr;
      const nc = centerCol + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
        if (board[nr][nc].isMine && !board[nr][nc].isFlagged && !board[nr][nc].isRevealed) {
          minesInArea.push({ row: nr, col: nc });
        }
      }
    }
  }

  if (minesInArea.length === 0) return { movedMines: [], affectedArea: [] };

  // Find destinations: unrevealed non-mine non-flagged cells outside 3x3, prefer edges
  const candidates = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (Math.abs(r - centerRow) <= 1 && Math.abs(c - centerCol) <= 1) continue;
      if (board[r][c].isMine || board[r][c].isRevealed || board[r][c].isFlagged) continue;
      const edgeScore = (r === 0 || r === rows - 1 ? 1 : 0) + (c === 0 || c === cols - 1 ? 1 : 0);
      candidates.push({ row: r, col: c, score: edgeScore });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  // Relocate mines
  for (let i = 0; i < minesInArea.length && i < candidates.length; i++) {
    const from = minesInArea[i];
    const to = candidates[i];
    board[from.row][from.col].isMine = false;
    board[to.row][to.col].isMine = true;
    movedMines.push({ from, to });
  }

  // Full adjacency recalculation
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (board[r][c].isMine) { board[r][c].adjacentMines = 0; continue; }
      let count = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && board[nr][nc].isMine) count++;
        }
      }
      board[r][c].adjacentMines = count;
    }
  }

  const affectedArea = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const nr = centerRow + dr, nc = centerCol + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) affectedArea.push({ row: nr, col: nc });
    }
  }

  return { movedMines, affectedArea };
}

// ── X-Ray Power-Up ────────────────────────────────────

/**
 * X-Ray Scan: Returns mine positions in a 5×5 area around (row, col).
 */
export function xRayScan(board, row, col) {
  const rows = board.length;
  const cols = board[0].length;
  const mines = [];

  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && board[nr][nc].isMine) {
        mines.push({ row: nr, col: nc });
      }
    }
  }

  return mines;
}

