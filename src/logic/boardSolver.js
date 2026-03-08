// ── Solvability Checker ─────────────────────────────────────
// Constraint-based solver that verifies a board can be completed
// without guessing, using only logical deduction from the first click.

/**
 * Check if a Minesweeper board is solvable without guessing.
 * Works on a simulation — does NOT mutate the original board.
 *
 * @param {Array<Array<Object>>} board  - 2D array of cell objects
 * @param {number} rows                 - board height
 * @param {number} cols                 - board width
 * @param {number} safeRow              - first click row
 * @param {number} safeCol              - first click column
 * @returns {boolean} true if every non-mine cell can be deduced
 */
export function isBoardSolvable(board, rows, cols, safeRow, safeCol) {
  // Build a lightweight simulation grid:
  // 0 = unrevealed unknown, 1 = revealed, 2 = flagged as mine
  const sim = new Uint8Array(rows * cols); // all 0 (unrevealed)
  const idx = (r, c) => r * cols + c;

  // Cache mine locations and adjacency counts for fast lookup
  const isMine = new Uint8Array(rows * cols);
  const adjCount = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = idx(r, c);
      if (board[r][c].isMine) isMine[i] = 1;
      adjCount[i] = board[r][c].adjacentMines;
    }
  }

  // Count total non-mine cells — our target for "all revealed"
  let totalSafe = 0;
  for (let i = 0; i < rows * cols; i++) {
    if (!isMine[i]) totalSafe++;
  }
  let revealedCount = 0;

  // Helper: get neighbor indices
  function neighbors(r, c) {
    const result = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
          result.push(idx(nr, nc));
        }
      }
    }
    return result;
  }

  // Pre-compute neighbor lists for every cell
  const neighborCache = new Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      neighborCache[idx(r, c)] = neighbors(r, c);
    }
  }

  // Reveal a cell (simulate); if it's a zero, flood-fill
  const revealQueue = [];
  function revealCell(i) {
    if (sim[i] !== 0 || isMine[i]) return;
    sim[i] = 1;
    revealedCount++;
    if (adjCount[i] === 0) {
      // Flood-fill: queue all unrevealed neighbors
      for (const ni of neighborCache[i]) {
        if (sim[ni] === 0 && !isMine[ni]) {
          revealQueue.push(ni);
        }
      }
    }
  }

  function flagCell(i) {
    if (sim[i] !== 0) return;
    sim[i] = 2; // flagged
  }

  // Step 1: Simulate first click — reveal safeRow, safeCol and flood-fill zeros
  revealQueue.push(idx(safeRow, safeCol));
  while (revealQueue.length > 0) {
    revealCell(revealQueue.pop());
  }

  if (revealedCount === totalSafe) return true;

  // Step 2: Iterative constraint propagation with subset analysis
  const MAX_ITERATIONS = 1000;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let progress = false;

    // ── Pass A: Simple constraint propagation ──
    // For each revealed numbered cell, check its unrevealed neighbors.
    for (let i = 0; i < rows * cols; i++) {
      if (sim[i] !== 1 || adjCount[i] === 0) continue;

      const nbrs = neighborCache[i];
      let unknowns = 0;
      let flagged = 0;
      for (const ni of nbrs) {
        if (sim[ni] === 0) unknowns++;
        else if (sim[ni] === 2) flagged++;
      }

      const remaining = adjCount[i] - flagged;

      if (remaining < 0 || remaining > unknowns) {
        // Inconsistent state — should not happen on a valid board
        return false;
      }

      // Rule 1: All unknowns must be mines
      if (remaining === unknowns && unknowns > 0) {
        for (const ni of nbrs) {
          if (sim[ni] === 0) {
            flagCell(ni);
            progress = true;
          }
        }
      }

      // Rule 2: All mines accounted for — remaining unknowns are safe
      if (remaining === 0 && unknowns > 0) {
        for (const ni of nbrs) {
          if (sim[ni] === 0) {
            revealQueue.push(ni);
            progress = true;
          }
        }
        // Process flood-fill immediately
        while (revealQueue.length > 0) {
          revealCell(revealQueue.pop());
        }
      }
    }

    if (revealedCount === totalSafe) return true;
    if (progress) continue; // Simple rules made progress; loop again

    // ── Pass B: Subset / superset constraint analysis ──
    // Build constraints: for each revealed numbered cell, collect its
    // set of unknown neighbor indices and the remaining mine count.
    const constraints = [];
    for (let i = 0; i < rows * cols; i++) {
      if (sim[i] !== 1 || adjCount[i] === 0) continue;

      const nbrs = neighborCache[i];
      const unknownSet = [];
      let flagged = 0;
      for (const ni of nbrs) {
        if (sim[ni] === 0) unknownSet.push(ni);
        else if (sim[ni] === 2) flagged++;
      }
      const remaining = adjCount[i] - flagged;
      if (unknownSet.length > 0) {
        // Sort for consistent comparison
        unknownSet.sort((a, b) => a - b);
        constraints.push({ unknowns: unknownSet, mines: remaining });
      }
    }

    // Compare every pair of constraints looking for subset relationships
    let subsetProgress = false;
    for (let a = 0; a < constraints.length; a++) {
      for (let b = 0; b < constraints.length; b++) {
        if (a === b) continue;
        const cA = constraints[a];
        const cB = constraints[b];

        // Check if A's unknowns are a subset of B's unknowns
        if (cA.unknowns.length >= cB.unknowns.length) continue;

        // Quick check: A must be smaller than B
        const setB = new Set(cB.unknowns);
        const isSubset = cA.unknowns.every(x => setB.has(x));
        if (!isSubset) continue;

        // A is a subset of B.
        // The cells in B but not in A (the "difference") must contain
        // exactly (cB.mines - cA.mines) mines.
        const diff = cB.unknowns.filter(x => !cA.unknowns.includes(x));
        const diffMines = cB.mines - cA.mines;

        if (diffMines < 0 || diffMines > diff.length) continue;

        // If diffMines === diff.length, all difference cells are mines
        if (diffMines === diff.length && diff.length > 0) {
          for (const di of diff) {
            if (sim[di] === 0) {
              flagCell(di);
              subsetProgress = true;
            }
          }
        }

        // If diffMines === 0, all difference cells are safe
        if (diffMines === 0 && diff.length > 0) {
          for (const di of diff) {
            if (sim[di] === 0) {
              revealQueue.push(di);
              subsetProgress = true;
            }
          }
          while (revealQueue.length > 0) {
            revealCell(revealQueue.pop());
          }
        }
      }
    }

    if (revealedCount === totalSafe) return true;
    if (subsetProgress) continue; // Subset analysis found something; loop again

    // No progress from either pass — board requires guessing
    return false;
  }

  // Hit max iterations — treat as unsolvable to be safe
  return false;
}

// ── Game-play reveal / chord functions ──────────────────────

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
