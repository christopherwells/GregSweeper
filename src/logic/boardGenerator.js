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

export function generateBoard(rows, cols, mines, excludeRow, excludeCol, rng) {
  const board = createEmptyBoard(rows, cols);
  placeMines(board, mines, excludeRow, excludeCol, rng);
  calculateAdjacency(board);
  return board;
}
