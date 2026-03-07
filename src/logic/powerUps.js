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

// ── New Power-Ups (Challenge Mode) ────────────────────

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

/**
 * Lucky Guess: Defuses a random unrevealed mine on the board.
 * Returns the defused cell, or null if no mines remain.
 * The cell displays 🍀 and adjacency is recalculated.
 */
export function luckyGuess(board) {
  const candidates = [];
  for (const row of board) {
    for (const cell of row) {
      if (cell.isMine && !cell.isRevealed && !cell.isFlagged) {
        candidates.push(cell);
      }
    }
  }

  if (candidates.length === 0) return null;
  const target = candidates[Math.floor(Math.random() * candidates.length)];

  // Defuse the mine
  target.isMine = false;
  target.isLucky = true; // Special marker for 🍀 display
  target.isRevealed = true;
  target.revealAnimDelay = 0;

  // Recalculate adjacency around the defused cell
  recalcAreaAdjacency(board, target.row, target.col);

  return target;
}
