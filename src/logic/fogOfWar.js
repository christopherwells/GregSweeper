export function computeVisibleCells(revealedCells, fogRadius, rows, cols) {
  const visible = new Set();

  for (const { row, col } of revealedCells) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const dist = Math.sqrt((r - row) ** 2 + (c - col) ** 2);
        if (dist <= fogRadius) {
          visible.add(`${r},${c}`);
        }
      }
    }
  }

  return visible;
}

// ── Hidden Numbers ────────────────────────────────────
// After revealing cells, ~X% of numbered cells show "?" instead of their number.
// Percentage ramps with level: L1: 5%, L5: 16%, L10: 30%

export function getHiddenNumberRate(level) {
  // Linear ramp: 5% at L1, +2.8% per level
  return Math.min(0.30, 0.05 + (level - 1) * 0.028);
}

/**
 * After a group of cells is revealed, mark some numbered cells as hidden.
 * Zero-cells are never hidden (cascades always work normally).
 */
export function applyHiddenNumbers(cells, rate) {
  const hidden = [];
  for (const cell of cells) {
    if (cell.adjacentMines > 0 && !cell.isMine && Math.random() < rate) {
      cell.isHiddenNumber = true;
      hidden.push(cell);
    }
  }
  return hidden;
}

/**
 * When a cell at (row, col) is revealed, decode all adjacent "?" cells
 * (set isHiddenNumber = false so they show their real number).
 */
export function decodeAdjacentHidden(board, row, col) {
  const rows = board.length;
  const cols = board[0].length;
  const decoded = [];

  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = row + dr;
      const nc = col + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
        const neighbor = board[nr][nc];
        if (neighbor.isHiddenNumber && neighbor.isRevealed) {
          neighbor.isHiddenNumber = false;
          decoded.push(neighbor);
        }
      }
    }
  }

  return decoded;
}

/**
 * Decode ALL hidden number cells on the board (for Decode power-up).
 */
export function decodeAllHidden(board) {
  const decoded = [];
  for (const row of board) {
    for (const cell of row) {
      if (cell.isHiddenNumber && cell.isRevealed) {
        cell.isHiddenNumber = false;
        decoded.push(cell);
      }
    }
  }
  return decoded;
}

// ── Creeping Fog ──────────────────────────────────────
// Edge cells re-fog after a timeout. Timer ramps with level:
// L1: 45s, L5: 34s, L10: 20s (formula: max(20000, 45000 - (level-1)*2800))

export function getRefogTimeout(level) {
  return Math.max(20000, 45000 - (level - 1) * 2800);
}

/**
 * Compute which revealed cells should re-fog.
 * An "edge cell" is a revealed non-mine cell with at least one
 * unrevealed/fogged neighbor. Only edge cells can be re-fogged.
 */
export function computeRefogCells(board, cellTimestamps, now, refogTimeout) {
  const rows = board.length;
  const cols = board[0].length;
  const toRefog = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (!cell.isRevealed || cell.isMine) continue;

      const key = `${r},${c}`;
      const lastActivity = cellTimestamps[key];
      if (!lastActivity) continue;
      if (now - lastActivity < refogTimeout) continue;

      // Check if this is an edge cell (has an unrevealed neighbor)
      let isEdge = false;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr;
          const nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
            if (!board[nr][nc].isRevealed) {
              isEdge = true;
              break;
            }
          }
        }
        if (isEdge) break;
      }

      if (isEdge) {
        toRefog.push(cell);
      }
    }
  }

  return toRefog;
}
