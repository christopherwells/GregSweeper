import { recomputeDisplayedMines, hasWallBetween } from './gimmicks.js';
import { findDeducibleFrontier } from './boardSolver.js';

export function findSafeCell(board) {
  // Deduction-first: prefer the next PROVABLY-safe cell (flags-blind) so
  // every Reveal Safe use is a worked example the player could have
  // reasoned to, instead of an oracle read of the true mine layout.
  // Falls back to the old random safe pick only when nothing is
  // deducible — a genuine frontier, where the oracle IS the power-up's
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

// Recalculate adjacency counts in area around (centerRow, centerCol).
// Walls block adjacency: a mine on the other side of a wall edge is not
// counted, matching gimmicks.recalcAllAdjacency behaviour. Without this,
// defuse/shield-defuse on walled boards leaves cells showing counts that
// are off by however many wall-separated mines surround them.
function recalcAreaAdjacency(board, centerRow, centerCol) {
  const rows = board.length;
  const cols = board[0].length;
  const wallEdges = board._wallEdges || null;
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
            if (nnr < 0 || nnr >= rows || nnc < 0 || nnc >= cols) continue;
            if (wallEdges && hasWallBetween(wallEdges, nr, nc, nnr, nnc)) continue;
            if (board[nnr][nnc].isMine) count++;
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

  // Full adjacency recalculation (wall-aware).
  const wallEdges = board._wallEdges || null;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (board[r][c].isMine) { board[r][c].adjacentMines = 0; continue; }
      let count = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
          if (wallEdges && hasWallBetween(wallEdges, r, c, nr, nc)) continue;
          if (board[nr][nc].isMine) count++;
        }
      }
      board[r][c].adjacentMines = count;
    }
  }

  // Refresh gimmick cells whose displayed numbers depend on mine layout
  recomputeDisplayedMines(board);

  const affectedArea = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const nr = centerRow + dr, nc = centerCol + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) affectedArea.push({ row: nr, col: nc });
    }
  }

  return { extractedMines, affectedArea };
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

