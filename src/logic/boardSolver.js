export function floodFillReveal(board, startRow, startCol) {
  const rows = board.length;
  const cols = board[0].length;
  const revealed = [];
  const visited = new Set();
  const queue = [{ row: startRow, col: startCol, distance: 0 }];
  visited.add(`${startRow},${startCol}`);

  while (queue.length > 0) {
    const { row, col, distance } = queue.shift();
    const cell = board[row][col];

    if (cell.isFlagged || cell.isMine) continue;

    cell.isRevealed = true;
    cell.revealAnimDelay = distance * 30;
    revealed.push(cell);

    if (cell.adjacentMines === 0) {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = row + dr;
          const nc = col + dc;
          const key = `${nr},${nc}`;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && !visited.has(key)) {
            visited.add(key);
            if (!board[nr][nc].isRevealed && !board[nr][nc].isFlagged) {
              queue.push({ row: nr, col: nc, distance: distance + 1 });
            }
          }
        }
      }
    }
  }

  return revealed;
}

export function checkWin(board) {
  for (const row of board) {
    for (const cell of row) {
      if (!cell.isMine && !cell.isRevealed) return false;
    }
  }
  return true;
}

export function revealAllMines(board) {
  const mines = [];
  for (const row of board) {
    for (const cell of row) {
      if (cell.isMine && !cell.isRevealed) {
        cell.isRevealed = true;
        mines.push(cell);
      }
    }
  }
  return mines;
}

export function countAdjacentFlags(board, row, col) {
  const rows = board.length;
  const cols = board[0].length;
  let count = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = row + dr;
      const nc = col + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && board[nr][nc].isFlagged) {
        count++;
      }
    }
  }
  return count;
}

export function chordReveal(board, row, col) {
  const cell = board[row][col];
  if (!cell.isRevealed || cell.adjacentMines === 0) return [];

  const flagCount = countAdjacentFlags(board, row, col);
  if (flagCount !== cell.adjacentMines) return [];

  const rows = board.length;
  const cols = board[0].length;
  const allRevealed = [];
  let hitMine = false;

  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = row + dr;
      const nc = col + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
        const neighbor = board[nr][nc];
        if (!neighbor.isRevealed && !neighbor.isFlagged) {
          if (neighbor.isMine) {
            hitMine = true;
            neighbor.isRevealed = true;
            allRevealed.push(neighbor);
          } else if (neighbor.adjacentMines === 0) {
            const filled = floodFillReveal(board, nr, nc);
            allRevealed.push(...filled);
          } else {
            neighbor.isRevealed = true;
            neighbor.revealAnimDelay = 0;
            allRevealed.push(neighbor);
          }
        }
      }
    }
  }

  return { revealed: allRevealed, hitMine };
}
