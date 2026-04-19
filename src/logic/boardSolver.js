// ── Solvability Checker ─────────────────────────────────────
// Multi-layer constraint solver that verifies a board can be completed
// without guessing (or with at most minimal guessing).
//
// Layers:
//   A. Simple constraint propagation (all-mine / all-safe rules)
//   B. Pairwise subset/superset analysis
//   C. Advanced solver (Gauss elimination + tank/partition enumeration)

import { solveConstraints } from './constraintSolver.js';
import { hasWallBetween } from './gimmicks.js';

// Sentinel: cell provides no usable number info to the solver
const UNKNOWN = 255;

// Returns the EXACT mine count a smart player can read from this cell.
// Returns UNKNOWN when the player can only deduce a range or set of values:
//   - mystery/sonar/compass/wormhole: hide or aggregate count, no per-cell exact constraint
//   - liar: display is true count ± 1, so it's one of two values, not a single number
//     (the disjunctive constraint is emitted separately in buildLiarConstraints)
// Mirror cells display the partner's count for visual deception; a player who
// recognises the pair can mentally un-swap and reason with the cell's TRUE
// adjacency (cell.adjacentMines).
function getPlayerVisibleCount(cell) {
  if (cell.isMystery || cell.isSonar || cell.isCompass || cell.isWormhole) return UNKNOWN;
  if (cell.isLiar) return UNKNOWN;
  return cell.adjacentMines;
}

// True when this cell contributes a "value is X-1 OR X+1" constraint to the
// solver (plain liar, possibly stacked with locked). Liar combined with a
// base-value or display-blocking gimmick produces too tangled a deduction
// path to model precisely — those cells contribute nothing.
function isPureLiar(cell) {
  return cell.isLiar
    && !cell.isMystery && !cell.isSonar && !cell.isCompass
    && !cell.isWormhole && !cell.mirrorPair;
}

/**
 * Pre-compute wall-aware neighbor lists for every cell.
 * Reuse across multiple isBoardSolvable() calls on the same board
 * to avoid redundant O(rows*cols*8) computation.
 */
export function buildNeighborCache(board, rows, cols) {
  const wallEdges = board._wallEdges || null;
  const cache = new Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const nbrs = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr;
          const nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
            if (wallEdges && hasWallBetween(wallEdges, r, c, nr, nc)) continue;
            nbrs.push(nr * cols + nc);
          }
        }
      }
      cache[r * cols + c] = nbrs;
    }
  }
  return cache;
}

/**
 * Check if a Minesweeper board is solvable without guessing.
 * Works on a simulation — does NOT mutate the original board.
 *
 * @param {Array<Array<Object>>} board  - 2D array of cell objects
 * @param {number} rows                 - board height
 * @param {number} cols                 - board width
 * @param {number} safeRow              - first click row
 * @param {number} safeCol              - first click column
 * @param {Array} [preNeighborCache]    - optional pre-built neighbor cache from buildNeighborCache()
 * @returns {{ solvable: boolean, remainingUnknowns: number }}
 */
export function isBoardSolvable(board, rows, cols, safeRow, safeCol, preNeighborCache) {
  // Build a lightweight simulation grid:
  // 0 = unrevealed unknown, 1 = revealed, 2 = flagged as mine
  const sim = new Uint8Array(rows * cols); // all 0 (unrevealed)
  const idx = (r, c) => r * cols + c;

  // Cache mine locations and player-visible adjacency counts.
  // liarBase[i] = displayed value for cells that contribute a {X-1, X+1}
  // disjunctive constraint (plain liar, possibly + locked); -1 otherwise.
  const isMine = new Uint8Array(rows * cols);
  const adjCount = new Uint8Array(rows * cols);
  const liarBase = new Int8Array(rows * cols).fill(-1);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = idx(r, c);
      const cell = board[r][c];
      if (cell.isMine) isMine[i] = 1;
      adjCount[i] = getPlayerVisibleCount(cell);
      if (isPureLiar(cell) && cell.displayedMines != null) {
        liarBase[i] = cell.displayedMines;
      }
    }
  }

  // Cascade count: the effective value for flood-fill purposes.
  // Mirror cells cascade based on displayedMines (what the player sees).
  const cascadeCount = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = idx(r, c);
      const cell = board[r][c];
      cascadeCount[i] = cell.displayedMines != null ? cell.displayedMines : cell.adjacentMines;
    }
  }

  // Count total non-mine cells — our target for "all revealed"
  let totalSafe = 0;
  for (let i = 0; i < rows * cols; i++) {
    if (!isMine[i]) totalSafe++;
  }
  let revealedCount = 0;

  // Pre-compute neighbor lists (or reuse provided cache)
  const neighborCache = preNeighborCache || buildNeighborCache(board, rows, cols);

  // Track locked cells
  const isLocked = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (board[r][c].isLocked) isLocked[idx(r, c)] = 1;
    }
  }

  // Check if a locked cell can unlock: all non-mine, non-locked neighbors must be revealed
  function canUnlock(i) {
    if (!isLocked[i]) return false;
    for (const ni of neighborCache[i]) {
      if (sim[ni] === 0 && !isMine[ni] && !isLocked[ni]) return false; // unrevealed non-mine non-locked neighbor
    }
    return true;
  }

  // Try to unlock locked cells whose conditions are met, cascading
  function tryUnlockAll() {
    let progress = true;
    while (progress) {
      progress = false;
      for (let i = 0; i < rows * cols; i++) {
        if (isLocked[i] && sim[i] === 0 && canUnlock(i)) {
          isLocked[i] = 0; // unlock
          if (!isMine[i]) {
            revealQueue.push(i);
            progress = true;
          }
          // Locked mines: unlocked but not revealed (player must flag)
        }
      }
      while (revealQueue.length > 0) {
        revealCell(revealQueue.pop());
      }
    }
  }

  // Reveal a cell (simulate); if it's a zero, flood-fill
  const revealQueue = [];
  let totalClicks = 0; // counts player clicks (cascades = 1 click)
  function revealCell(i) {
    if (sim[i] !== 0 || isMine[i] || isLocked[i]) return;
    sim[i] = 1;
    revealedCount++;
    if (cascadeCount[i] === 0) {
      for (const ni of neighborCache[i]) {
        if (sim[ni] === 0 && !isMine[ni] && !isLocked[ni]) {
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
  totalClicks++;
  revealQueue.push(idx(safeRow, safeCol));
  while (revealQueue.length > 0) {
    revealCell(revealQueue.pop());
  }
  tryUnlockAll(); // unlock any locked cells freed by the initial cascade

  if (revealedCount === totalSafe) return { solvable: true, remainingUnknowns: 0, totalClicks };

  // Step 2: Iterative multi-layer constraint solving
  const MAX_ITERATIONS = 1000;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let progress = false;

    // ── Pass A: Simple constraint propagation ──
    for (let i = 0; i < rows * cols; i++) {
      if (sim[i] !== 1 || adjCount[i] === 0 || adjCount[i] === UNKNOWN) continue;

      const nbrs = neighborCache[i];
      let unknowns = 0;
      let flagged = 0;
      for (const ni of nbrs) {
        if (sim[ni] === 0) unknowns++;
        else if (sim[ni] === 2) flagged++;
      }

      const remaining = adjCount[i] - flagged;

      if (remaining < 0 || remaining > unknowns) {
        return { solvable: false, remainingUnknowns: totalSafe - revealedCount, totalClicks };
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
            totalClicks++;
            revealQueue.push(ni);
            progress = true;
          }
        }
        while (revealQueue.length > 0) {
          revealCell(revealQueue.pop());
        }
      }
    }

    tryUnlockAll(); // check if reveals freed any locked cells
      if (revealedCount === totalSafe) return { solvable: true, remainingUnknowns: 0, totalClicks };
    if (progress) continue;

    // ── Pass B: Subset / superset constraint analysis ──
    // Subset arithmetic only works with single-value (exact) constraints, so
    // we skip Pass B for liar — its disjunctive constraints feed Pass C only.
    const constraints = buildConstraints(sim, adjCount, neighborCache, rows * cols);

    // Pre-build sets once per pass — avoids O(n) Array.includes / new Set() per pair
    const constraintSets = constraints.map(c => new Set(c.unknowns));

    let subsetProgress = false;
    for (let a = 0; a < constraints.length; a++) {
      const cA = constraints[a];
      const setA = constraintSets[a];
      for (let b = 0; b < constraints.length; b++) {
        if (a === b) continue;
        const cB = constraints[b];

        if (cA.unknowns.length >= cB.unknowns.length) continue;

        const setB = constraintSets[b];
        let isSubset = true;
        for (const x of cA.unknowns) {
          if (!setB.has(x)) { isSubset = false; break; }
        }
        if (!isSubset) continue;

        const diff = [];
        for (const x of cB.unknowns) {
          if (!setA.has(x)) diff.push(x);
        }
        const diffMines = cB.allowedMines[0] - cA.allowedMines[0];

        if (diffMines < 0 || diffMines > diff.length) continue;

        if (diffMines === diff.length && diff.length > 0) {
          for (const di of diff) {
            if (sim[di] === 0) {
              flagCell(di);
              subsetProgress = true;
            }
          }
        }

        if (diffMines === 0 && diff.length > 0) {
          for (const di of diff) {
            if (sim[di] === 0) {
              totalClicks++;
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

    tryUnlockAll();
      if (revealedCount === totalSafe) return { solvable: true, remainingUnknowns: 0, totalClicks };
    if (subsetProgress) continue;

    // ── Pass C: Advanced solver (Gauss + Tank) ──
    // Combine exact constraints from non-liar cells with disjunctive
    // constraints from plain-liar cells (each contributes "X-1 OR X+1" mines).
    const freshConstraints = buildConstraints(sim, adjCount, neighborCache, rows * cols);
    const liarCs = buildLiarConstraints(sim, liarBase, neighborCache, rows * cols);
    const solved = solveConstraints([...freshConstraints, ...liarCs]);

    let advancedProgress = false;

    for (const cellIdx of solved.mines) {
      if (sim[cellIdx] === 0) {
        flagCell(cellIdx);
        advancedProgress = true;
      }
    }

    for (const cellIdx of solved.safe) {
      if (sim[cellIdx] === 0) {
        totalClicks++;
        revealQueue.push(cellIdx);
        advancedProgress = true;
      }
    }
    while (revealQueue.length > 0) {
      revealCell(revealQueue.pop());
    }

    tryUnlockAll();
      if (revealedCount === totalSafe) return { solvable: true, remainingUnknowns: 0, totalClicks };
    if (advancedProgress) continue;

    // No progress from any layer — board requires guessing
    break;
  }

  const remaining = totalSafe - revealedCount;
  return { solvable: false, remainingUnknowns: remaining, totalClicks };
}

// ── Build constraints from current simulation state ──────────
// Each constraint: { unknowns: cellIdx[], allowedMines: number[] } where the
// final mine count among `unknowns` must equal one of the `allowedMines`
// values. Exact constraints (normal numbered cells) have a single-element
// `allowedMines`; liar cells contribute disjunctive 2-element sets.

function buildConstraints(sim, adjCount, neighborCache, totalCells) {
  const constraints = [];
  for (let i = 0; i < totalCells; i++) {
    if (sim[i] !== 1 || adjCount[i] === 0 || adjCount[i] === 255) continue; // 255 = mystery/unknown

    const nbrs = neighborCache[i];
    const unknownSet = [];
    let flagged = 0;
    for (const ni of nbrs) {
      if (sim[ni] === 0) unknownSet.push(ni);
      else if (sim[ni] === 2) flagged++;
    }
    const remaining = adjCount[i] - flagged;
    if (unknownSet.length > 0 && remaining >= 0) {
      unknownSet.sort((a, b) => a - b);
      constraints.push({ unknowns: unknownSet, allowedMines: [remaining] });
    }
  }
  return constraints;
}

// Liar cells contribute "true count is display - 1 OR display + 1" — a
// disjunctive constraint with two allowed mine counts. Values that are
// already infeasible given the current flagged count are filtered out;
// if both become infeasible the constraint is a contradiction (caller's
// deductions will then fail naturally and the board is reported unsolvable).
function buildLiarConstraints(sim, liarBase, neighborCache, totalCells) {
  const constraints = [];
  for (let i = 0; i < totalCells; i++) {
    if (sim[i] !== 1 || liarBase[i] < 0) continue;

    const nbrs = neighborCache[i];
    const unknownSet = [];
    let flagged = 0;
    for (const ni of nbrs) {
      if (sim[ni] === 0) unknownSet.push(ni);
      else if (sim[ni] === 2) flagged++;
    }
    if (unknownSet.length === 0) continue;
    unknownSet.sort((a, b) => a - b);

    const display = liarBase[i];
    const allowed = [];
    const v1 = display - 1 - flagged;
    const v2 = display + 1 - flagged;
    if (v1 >= 0 && v1 <= unknownSet.length) allowed.push(v1);
    if (v2 >= 0 && v2 <= unknownSet.length) allowed.push(v2);
    if (allowed.length > 0) {
      constraints.push({ unknowns: unknownSet, allowedMines: allowed });
    }
  }
  return constraints;
}

// ── Find Next Safe Move (for post-death analysis) ────────────
// Analyzes the current board state and returns a deducible safe cell,
// or null if the situation was a genuine 50/50.

export function findNextSafeMove(board) {
  const rows = board.length;
  const cols = board[0].length;
  const idx = (r, c) => r * cols + c;
  const totalCells = rows * cols;

  // Build simulation state from actual board — gimmick-aware (matches isBoardSolvable)
  const sim = new Uint8Array(totalCells);
  const adjCount = new Uint8Array(totalCells);
  const isMineArr = new Uint8Array(totalCells);
  const liarBase = new Int8Array(totalCells).fill(-1);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = idx(r, c);
      const cell = board[r][c];
      if (cell.isRevealed) sim[i] = 1;
      else if (cell.isFlagged) sim[i] = 2;
      if (cell.isMine) isMineArr[i] = 1;
      adjCount[i] = getPlayerVisibleCount(cell);
      if (isPureLiar(cell) && cell.displayedMines != null) {
        liarBase[i] = cell.displayedMines;
      }
    }
  }

  // Use wall-aware neighbor cache (matches isBoardSolvable)
  const neighborCache = buildNeighborCache(board, rows, cols);

  // Pass A: Simple rules — check for immediately deducible safe cells
  for (let i = 0; i < totalCells; i++) {
    if (sim[i] !== 1 || adjCount[i] === 0 || adjCount[i] === UNKNOWN) continue;
    const nbrs = neighborCache[i];
    let unknowns = 0;
    let flagged = 0;
    for (const ni of nbrs) {
      if (sim[ni] === 0) unknowns++;
      else if (sim[ni] === 2) flagged++;
    }
    const remaining = adjCount[i] - flagged;
    if (remaining === 0 && unknowns > 0) {
      for (const ni of nbrs) {
        if (sim[ni] === 0) {
          return { row: Math.floor(ni / cols), col: ni % cols };
        }
      }
    }
  }

  // Pass B: Build constraints (including liar disjunctions) and run full solver
  const constraints = buildConstraints(sim, adjCount, neighborCache, totalCells);
  const liarCs = buildLiarConstraints(sim, liarBase, neighborCache, totalCells);
  const solved = solveConstraints([...constraints, ...liarCs]);

  // Return first safe cell
  for (const cellIdx of solved.safe) {
    return { row: Math.floor(cellIdx / cols), col: cellIdx % cols };
  }

  // No deducible safe move — genuine 50/50 situation
  return null;
}

// ── Game-play reveal / chord functions ──────────────────────

export function floodFillReveal(board, startRow, startCol) {
  const rows = board.length;
  const cols = board[0].length;
  const wallEdges = board._wallEdges || null;
  const revealed = [];
  const visited = new Set();
  const queue = [{ row: startRow, col: startCol, distance: 0 }];
  visited.add(`${startRow},${startCol}`);

  while (queue.length > 0) {
    const { row, col, distance } = queue.shift();
    const cell = board[row][col];

    if (cell.isFlagged || cell.isMine || cell.isLocked) continue;

    cell.isRevealed = true;
    cell.revealAnimDelay = distance * 30;
    revealed.push(cell);

    // Cascade on displayed value (mirror cells show swapped numbers)
    const effectiveMines = cell.displayedMines != null ? cell.displayedMines : cell.adjacentMines;
    if (effectiveMines === 0) {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = row + dr;
          const nc = col + dc;
          // Don't propagate across wall edges
          if (wallEdges && hasWallBetween(wallEdges, row, col, nr, nc)) continue;
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

// Estimate how many cell reveals are needed to disarm a pressure plate
// (reveal all non-mine neighbors). Runs a lightweight solver simulation on a
// snapshot of the current board state without mutating the real board.
export function estimatePlateMovesToDisarm(board, plateRow, plateCol) {
  const rows = board.length, cols = board[0].length;
  const wallEdges = board._wallEdges || null;

  // Identify the safe neighbors we need revealed
  const targets = new Set();
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = plateRow + dr, nc = plateCol + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
        const adj = board[nr][nc];
        if (!adj.isMine && !adj.isRevealed) targets.add(`${nr},${nc}`);
      }
    }
  }
  if (targets.size === 0) return { moves: 0, steps: 0, unsolved: 0 };

  // Snapshot: track revealed/flagged state without mutating the board
  const revealed = new Set();
  const flagged = new Set();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (board[r][c].isRevealed) revealed.add(`${r},${c}`);
      if (board[r][c].isFlagged) flagged.add(`${r},${c}`);
    }
  }

  function getAdj(r, c) {
    return board[r][c].displayedMines != null ? board[r][c].displayedMines : board[r][c].adjacentMines;
  }

  let totalMoves = 0;
  let totalSteps = 0;
  let remaining = new Set(targets);

  for (let iter = 0; iter < 200 && remaining.size > 0; iter++) {
    const toReveal = new Set();
    const toFlag = new Set();

    for (const key of revealed) {
      const [r, c] = key.split(',').map(Number);
      const cell = board[r][c];
      // This estimator does single-cell Pass-A-style propagation only.
      // Skip cells whose value isn't a single integer for that purpose:
      //   - mystery/sonar/compass/wormhole give no per-cell constraint
      //   - liar's value is {display-1, display+1}; the bounds differ
      //     by 2, so no Pass-A rule can fire on it alone (the multi-
      //     constraint solver in solveConstraints/tankSolve DOES use the
      //     disjunctive constraint via buildLiarConstraints — we just
      //     can't use it here without that machinery).
      // Mirror cells use cell.adjacentMines directly: a smart player
      // decodes the swap and reasons with the true count.
      if (cell.isMystery || cell.isSonar || cell.isCompass || cell.isWormhole || cell.isLiar) continue;
      const adj = cell.adjacentMines;
      if (adj === 0) continue;

      let fCount = 0;
      const unknowns = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
          if (wallEdges && hasWallBetween(wallEdges, r, c, nr, nc)) continue;
          const nk = `${nr},${nc}`;
          if (flagged.has(nk)) fCount++;
          else if (!revealed.has(nk)) unknowns.push(nk);
        }
      }

      if (fCount === adj && unknowns.length > 0) {
        for (const nk of unknowns) toReveal.add(nk);
      }
      if (unknowns.length === adj - fCount && unknowns.length > 0) {
        for (const nk of unknowns) toFlag.add(nk);
      }
    }

    if (toReveal.size === 0 && toFlag.size === 0) break; // stuck

    for (const key of toFlag) flagged.add(key);

    let batchMoves = 0;
    for (const key of toReveal) {
      if (revealed.has(key)) continue;
      const [r, c] = key.split(',').map(Number);
      if (board[r][c].isMine) continue;
      revealed.add(key);
      remaining.delete(key);
      batchMoves++;

      // Simulate cascade for 0-cells
      const eff = getAdj(r, c);
      if (eff === 0) {
        const queue = [[r, c]];
        while (queue.length > 0) {
          const [cr, cc] = queue.shift();
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (dr === 0 && dc === 0) continue;
              const nr = cr + dr, nc = cc + dc;
              if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
              if (wallEdges && hasWallBetween(wallEdges, cr, cc, nr, nc)) continue;
              const nk = `${nr},${nc}`;
              if (revealed.has(nk) || flagged.has(nk)) continue;
              if (board[nr][nc].isMine) continue;
              revealed.add(nk);
              remaining.delete(nk);
              batchMoves++;
              if (getAdj(nr, nc) === 0) queue.push([nr, nc]);
            }
          }
        }
      }
    }

    totalMoves += batchMoves;
    if (batchMoves > 0) totalSteps++;
  }

  // If solver couldn't resolve all targets, estimate remaining as 2 steps each
  totalMoves += remaining.size * 2;
  totalSteps += remaining.size;

  return { moves: totalMoves, steps: totalSteps, unsolved: remaining.size };
}

export function checkWin(board) {
  for (const row of board) {
    for (const cell of row) {
      // Skip mines (don't need to be revealed to win)
      if (cell.isMine) continue;
      // Locked cells that aren't mines must eventually be revealed too
      if (!cell.isRevealed) return false;
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
  const effectiveCount = cell.displayedMines != null ? cell.displayedMines : cell.adjacentMines;
  if (!cell.isRevealed || effectiveCount === 0) return [];

  // Can't chord ON a liar or mystery cell — their displayed number is unreliable
  if (cell.isLiar || cell.isMystery) return [];

  const wallEdges = board._wallEdges || null;

  // Count adjacent flags (respecting wall edges)
  let flagCount = 0;
  const rows = board.length;
  const cols = board[0].length;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = row + dr, nc = col + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
        if (wallEdges && hasWallBetween(wallEdges, row, col, nr, nc)) continue;
        if (board[nr][nc].isFlagged) flagCount++;
      }
    }
  }

  if (flagCount !== effectiveCount) return [];

  const allRevealed = [];
  let hitMine = false;

  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = row + dr;
      const nc = col + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
        // Don't chord across wall edges
        if (wallEdges && hasWallBetween(wallEdges, row, col, nr, nc)) continue;
        const neighbor = board[nr][nc];
        // Don't chord-reveal locked cells (must unlock first)
        if (!neighbor.isRevealed && !neighbor.isFlagged && !neighbor.isLocked) {
          if (neighbor.isMine) {
            hitMine = true;
            neighbor.isRevealed = true;
            allRevealed.push(neighbor);
          } else if ((neighbor.displayedMines != null ? neighbor.displayedMines : neighbor.adjacentMines) === 0) {
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
