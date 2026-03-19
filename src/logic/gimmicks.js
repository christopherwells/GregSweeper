// ── Gimmick System ──────────────────────────────────────
// 7 gimmicks introduced at checkpoints after L10.
// Each gimmick has: apply (board setup), render hints, solver adjustments.

import { safeGet, safeSet, safeGetJSON, safeSetJSON } from '../storage/storageAdapter.js';

const GIMMICK_DEFS = {
  mystery: {
    intro: 11, name: 'Mystery Cells', icon: '❓',
    desc: 'Some numbered cells show "?" instead of their value.',
    longDesc: 'Certain safe cells hide their number behind a "?" symbol. You must deduce their value from surrounding clues. The cell is safe — it just won\'t tell you its count.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell revealed">1</div><div class="ge-cell revealed ge-mystery">?</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">1</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">0</div></div><div class="ge-caption">The "?" hides a number — use neighbors to figure it out</div>',
  },
  locked: {
    intro: 21, name: 'Locked Cells', icon: '🔒',
    desc: 'Locked cells can\'t be opened until all neighbors are revealed.',
    longDesc: 'Cells with a lock icon cannot be clicked until every one of their 8 surrounding cells has been revealed. Work around them first, then come back once the area is clear.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell revealed">1</div><div class="ge-cell unrevealed"></div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">1</div><div class="ge-cell unrevealed ge-locked">🔒</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">1</div><div class="ge-cell unrevealed"></div></div><div class="ge-caption">Reveal all 8 neighbors before the locked cell opens</div>',
  },
  liar: {
    intro: 31, name: 'Liar Cells', icon: '🤥',
    desc: 'A few cells display a number that\'s off by 1. They have a colored border so you know which ones lie.',
    longDesc: 'Liar cells show a number that is exactly 1 higher or 1 lower than the true count. They are marked with a distinct colored border so you can spot them. Account for the offset when reasoning about nearby mines.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell revealed">1</div><div class="ge-cell revealed ge-liar">3</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">2</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">1</div><div class="ge-cell unrevealed"></div></div><div class="ge-caption">The orange-bordered "3" is really a 2 or 4</div>',
  },
  mineShift: {
    intro: 41, name: 'Mine Shift', icon: '💨', chaosOnly: true,
    desc: 'Every 30\u201345s, unflagged mines may shift to adjacent cells. Flagged mines stay put!',
    longDesc: 'Mines that you haven\'t flagged will periodically move to a neighboring cell. Numbers update to reflect new positions. Flag mines quickly to pin them in place — flagged mines never move.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell unrevealed"></div><div class="ge-cell unrevealed ge-mine-shift">💣➜</div><div class="ge-cell unrevealed ge-mine-dest"></div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">0</div></div><div class="ge-caption">Unflagged mines drift — flag them to pin them down!</div>',
  },
  walls: {
    intro: 51, name: 'Walls', icon: '🧱',
    desc: 'Impassable wall cells block the grid. They don\'t count as neighbors.',
    longDesc: 'Brick wall cells divide the board into sections. Walls cannot be revealed or flagged, and they do not count as neighbors for adjacent numbers. Treat them like the edge of the board.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell revealed">1</div><div class="ge-cell ge-wall">🧱</div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">1</div><div class="ge-cell ge-wall">🧱</div><div class="ge-cell revealed">0</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">0</div></div><div class="ge-caption">Walls split the board — numbers ignore wall neighbors</div>',
  },
  wormhole: {
    intro: 61, name: 'Wormholes', icon: '🌀',
    desc: 'Paired cells share information \u2014 each shows the SUM of both cells\' real neighbor counts.',
    longDesc: 'Two cells linked by a wormhole both display the combined total of their individual mine counts. If cell A has 1 mine neighbor and cell B has 2, both show 3. Use surrounding cells to split the sum.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(5,32px)"><div class="ge-cell revealed">1</div><div class="ge-cell revealed ge-wormhole">🌀3</div><div class="ge-cell revealed">1</div><div class="ge-cell revealed ge-wormhole">🌀3</div><div class="ge-cell revealed">2</div></div><div class="ge-caption">Both 🌀 cells show 3 (sum of 1+2) — split the total</div>',
  },
  mirror: {
    intro: 71, name: 'Mirror Zone', icon: '🪞',
    desc: 'A marked zone displays mirrored adjacency values \u2014 numbers swap with their opposite cell in the zone.',
    longDesc: 'Inside the mirror zone, each cell\'s number is swapped with the cell at the opposite position. The zone is visually marked. To solve, mentally un-mirror each number to get the true count.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(2,32px)"><div class="ge-cell revealed ge-mirror">2🪞</div><div class="ge-cell revealed ge-mirror">1🪞</div><div class="ge-cell revealed ge-mirror">3🪞</div><div class="ge-cell revealed ge-mirror">0🪞</div></div><div class="ge-caption">Numbers are swapped diagonally within the zone</div>',
  },
};

const SEEN_KEY = 'minesweeper_seen_gimmicks';
const POPUP_DISABLED_KEY = 'minesweeper_modifier_popup_disabled';

// ── Daily-safe gimmick subset ──────────────────────────
const DAILY_SAFE_GIMMICKS = ['mystery', 'locked', 'walls', 'liar'];

// ── Modifier popup preference ──────────────────────────

export function isModifierPopupDisabled() {
  return safeGet(POPUP_DISABLED_KEY) === 'true';
}

export function setModifierPopupDisabled(disabled) {
  safeSet(POPUP_DISABLED_KEY, disabled ? 'true' : 'false');
}

// ── Daily gimmick selection (seeded, ~35% of days) ─────

export function getDailyGimmick(dailySeed, createRNG) {
  const rng = createRNG(dailySeed + '-gimmick');
  if (rng() > 0.35) return []; // 65% of days: no gimmick
  const idx = Math.floor(rng() * DAILY_SAFE_GIMMICKS.length);
  return [DAILY_SAFE_GIMMICKS[idx]];
}

// ── Which gimmicks are active for a given level ────────

export function getGimmicksForLevel(level, rng = Math.random) {
  if (level <= 10) return [];

  const allTypes = Object.keys(GIMMICK_DEFS);
  // Filter out chaosOnly gimmicks (e.g., mineShift) from Challenge mode
  const introduced = allTypes.filter(g => level >= GIMMICK_DEFS[g].intro && !GIMMICK_DEFS[g].chaosOnly);
  if (introduced.length === 0) return [];

  const active = [];

  for (const g of introduced) {
    const def = GIMMICK_DEFS[g];
    const introEnd = def.intro + 4; // 5-level introduction block

    if (level >= def.intro && level <= introEnd) {
      // Always present during introduction block
      active.push(g);
    } else if (level > introEnd) {
      // ~50% chance after introduction
      if (rng() < 0.5) active.push(g);
    }
  }

  // At least one gimmick after L10
  if (active.length === 0) {
    // Force the most recently introduced one
    const latest = introduced[introduced.length - 1];
    active.push(latest);
  }

  return active;
}

// ── Chaos mode: random gimmick selection (includes all types) ──

export function getChaosGimmicks(count, rng = Math.random) {
  const allTypes = Object.keys(GIMMICK_DEFS);
  const shuffled = [...allTypes].sort(() => rng() - 0.5);
  return shuffled.slice(0, Math.min(count, allTypes.length));
}

// ── Gimmick intensity (count of affected cells) ────────

function getIntensity(gimmick, level, rng) {
  const def = GIMMICK_DEFS[gimmick];
  const introEnd = def.intro + 4;

  if (level >= def.intro && level <= introEnd) {
    // Introduction block: ramp from 1 to block position
    const blockPos = level - def.intro; // 0-4
    return 1 + blockPos;
  }

  // After introduction: slowly ramp toward level 100
  const progress = (level - introEnd) / (100 - introEnd);
  const base = 1 + Math.floor(progress * 3); // 1-4
  return base + (rng() < 0.3 ? 1 : 0); // slight random boost
}

// ── Apply gimmicks to a generated board ────────────────

export function applyGimmicks(board, level, activeGimmicks, rng = Math.random) {
  const rows = board.length;
  const cols = board[0].length;
  const applied = {};

  for (const g of activeGimmicks) {
    const intensity = getIntensity(g, level, rng);

    switch (g) {
      case 'mystery':
        applied.mystery = applyMystery(board, rows, cols, intensity, rng);
        break;
      case 'locked':
        applied.locked = applyLocked(board, rows, cols, intensity, rng);
        break;
      case 'liar':
        applied.liar = applyLiar(board, rows, cols, intensity, rng);
        // Compute liar zone: all cells within 1 cell of any liar cell
        computeLiarZone(board, rows, cols);
        break;
      case 'walls':
        applied.walls = applyWalls(board, rows, cols, intensity, rng);
        break;
      case 'wormhole':
        applied.wormhole = applyWormholes(board, rows, cols, Math.min(intensity, 3), rng);
        break;
      case 'mirror':
        applied.mirror = applyMirrorZone(board, rows, cols, rng);
        break;
      case 'mineShift':
        applied.mineShift = { interval: 30 + Math.floor(rng() * 16) }; // 30-45s
        break;
    }
  }

  return applied;
}

// ── Mystery Cells: show '?' instead of number ──────────

function applyMystery(board, rows, cols, count, rng) {
  const candidates = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (!cell.isMine && cell.adjacentMines > 0) {
        candidates.push(cell);
      }
    }
  }
  shuffle(candidates, rng);
  const applied = [];
  for (let i = 0; i < Math.min(count, candidates.length); i++) {
    candidates[i].isMystery = true;
    applied.push({ row: candidates[i].row, col: candidates[i].col });
  }
  return applied;
}

// ── Locked Cells: can't reveal until all 8 neighbors revealed ──

function applyLocked(board, rows, cols, count, rng) {
  const candidates = [];
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const cell = board[r][c];
      if (!cell.isMine && cell.adjacentMines > 0) {
        candidates.push(cell);
      }
    }
  }
  shuffle(candidates, rng);
  const applied = [];
  for (let i = 0; i < Math.min(count, candidates.length); i++) {
    candidates[i].isLocked = true;
    applied.push({ row: candidates[i].row, col: candidates[i].col });
  }
  return applied;
}

// ── Liar Cells: adjacentMines display is off by ±1 ────

function applyLiar(board, rows, cols, count, rng) {
  const candidates = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      // Only cells with adjacentMines >= 2 can be liars (±1 stays ≥ 1)
      if (!cell.isMine && cell.adjacentMines >= 2) {
        candidates.push(cell);
      }
    }
  }
  shuffle(candidates, rng);
  const applied = [];
  for (let i = 0; i < Math.min(count, candidates.length); i++) {
    const cell = candidates[i];
    const offset = rng() < 0.5 ? -1 : 1;
    cell.isLiar = true;
    cell.displayedMines = cell.adjacentMines + offset;
    applied.push({ row: cell.row, col: cell.col, offset });
  }
  return applied;
}

// ── Liar Zone Computation ────────────────────────────────
// Marks all cells within 1 cell of any liar cell as inLiarZone.
// This gives players a visual cue about which area has unreliable numbers.

function computeLiarZone(board, rows, cols) {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!board[r][c].isLiar) continue;
      // Mark this cell and all its neighbors
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
            board[nr][nc].inLiarZone = true;
          }
        }
      }
    }
  }
}

// ── Walls: inert cells that block grid ─────────────────

function applyWalls(board, rows, cols, segmentCount, rng) {
  const wallCells = [];
  const maxSegments = Math.min(segmentCount, 5);

  for (let s = 0; s < maxSegments; s++) {
    const length = 2 + Math.floor(rng() * 3); // 2-4 cells
    const startR = 1 + Math.floor(rng() * (rows - 2));
    const startC = 1 + Math.floor(rng() * (cols - 2));

    // Random walk with one possible bend
    const dirs = [[0, 1], [1, 0], [0, -1], [-1, 0]];
    let dir = dirs[Math.floor(rng() * dirs.length)];
    let r = startR, c = startC;
    const segment = [];
    let bendAt = 1 + Math.floor(rng() * (length - 1));

    for (let i = 0; i < length; i++) {
      if (r < 0 || r >= rows || c < 0 || c >= cols) break;
      if (board[r][c].isMine || board[r][c].isWall) break;

      // Don't wall the very edges (leave border cells for gameplay)
      if (r === 0 || r === rows - 1 || c === 0 || c === cols - 1) break;

      segment.push({ row: r, col: c });

      if (i === bendAt) {
        // Bend perpendicular
        const perpDirs = dir[0] === 0 ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
        dir = perpDirs[Math.floor(rng() * perpDirs.length)];
      }

      r += dir[0];
      c += dir[1];
    }

    if (segment.length >= 2) {
      for (const pos of segment) {
        board[pos.row][pos.col].isWall = true;
        board[pos.row][pos.col].isMine = false;
        wallCells.push(pos);
      }
    }
  }

  // Recalculate adjacency excluding wall cells
  if (wallCells.length > 0) {
    recalcAllAdjacency(board, rows, cols);
  }

  return wallCells;
}

// ── Wormholes: paired cells show summed adjacency ──────

function applyWormholes(board, rows, cols, pairCount, rng) {
  const candidates = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (!cell.isMine && !cell.isWall && cell.adjacentMines > 0) {
        candidates.push(cell);
      }
    }
  }
  shuffle(candidates, rng);

  const pairs = [];
  const used = new Set();
  for (let p = 0; p < Math.min(pairCount, Math.floor(candidates.length / 2)); p++) {
    let a = null, b = null;
    for (const cell of candidates) {
      const key = `${cell.row},${cell.col}`;
      if (used.has(key)) continue;
      if (!a) { a = cell; used.add(key); continue; }
      // Ensure they're not adjacent (at least 3 cells apart)
      if (Math.abs(cell.row - a.row) + Math.abs(cell.col - a.col) >= 3) {
        b = cell;
        used.add(key);
        break;
      }
    }
    if (a && b) {
      const summed = a.adjacentMines + b.adjacentMines;
      const pairIndex = pairs.length; // 0, 1, 2 for color matching
      a.wormholePair = { row: b.row, col: b.col };
      a.displayedMines = summed;
      a.isWormhole = true;
      a.wormholePairIndex = pairIndex;
      b.wormholePair = { row: a.row, col: a.col };
      b.displayedMines = summed;
      b.isWormhole = true;
      b.wormholePairIndex = pairIndex;
      pairs.push({ a: { row: a.row, col: a.col }, b: { row: b.row, col: b.col }, summed });
    }
  }
  return pairs;
}

// ── Mirror Zone: cells display swapped adjacency ───────

function applyMirrorZone(board, rows, cols, rng) {
  const size = 2 + Math.floor(rng() * 2); // 2x2 or 3x3
  const startR = 1 + Math.floor(rng() * (rows - size - 1));
  const startC = 1 + Math.floor(rng() * (cols - size - 1));

  const zone = [];
  for (let r = startR; r < startR + size; r++) {
    for (let c = startC; c < startC + size; c++) {
      if (!board[r][c].isMine && !board[r][c].isWall) {
        board[r][c].mirrorZone = { id: 0, centerRow: startR + (size - 1) / 2, centerCol: startC + (size - 1) / 2 };
        zone.push({ row: r, col: c });
      }
    }
  }

  // Swap displayed values with mirror opposite
  for (const pos of zone) {
    const cell = board[pos.row][pos.col];
    const mirrorR = Math.round(2 * cell.mirrorZone.centerRow - pos.row);
    const mirrorC = Math.round(2 * cell.mirrorZone.centerCol - pos.col);
    if (mirrorR >= 0 && mirrorR < rows && mirrorC >= 0 && mirrorC < cols) {
      const mirrorCell = board[mirrorR][mirrorC];
      if (mirrorCell.mirrorZone) {
        cell.displayedMines = mirrorCell.adjacentMines;
      }
    }
  }

  return { startR, startC, size, cells: zone };
}

// ── Mine Shift (runtime) ───────────────────────────────

export function performMineShift(board, rng = Math.random) {
  const rows = board.length;
  const cols = board[0].length;

  // Find unflagged, unrevealed mines
  const shiftable = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (board[r][c].isMine && !board[r][c].isFlagged && !board[r][c].isRevealed && !board[r][c].isWall) {
        shiftable.push({ row: r, col: c });
      }
    }
  }

  if (shiftable.length === 0) return [];

  // Pick 1-2 mines to shift
  shuffle(shiftable, rng);
  const toShift = shiftable.slice(0, 1 + (rng() < 0.3 ? 1 : 0));
  const shifted = [];

  for (const mine of toShift) {
    // Find adjacent unrevealed non-mine non-flagged non-wall cells
    const dests = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = mine.row + dr, nc = mine.col + dc;
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
          const dest = board[nr][nc];
          if (!dest.isMine && !dest.isRevealed && !dest.isFlagged && !dest.isWall) {
            dests.push({ row: nr, col: nc });
          }
        }
      }
    }

    if (dests.length > 0) {
      const dest = dests[Math.floor(rng() * dests.length)];
      board[mine.row][mine.col].isMine = false;
      board[dest.row][dest.col].isMine = true;
      shifted.push({ from: mine, to: dest });
    }
  }

  if (shifted.length > 0) {
    recalcAllAdjacency(board, rows, cols);
  }

  return shifted;
}

// ── Locked Cell Check ──────────────────────────────────

export function isLockedCell(board, row, col) {
  const cell = board[row][col];
  if (!cell.isLocked) return false;

  const rows = board.length;
  const cols = board[0].length;

  // Check if all 8 neighbors are revealed (or wall/out-of-bounds)
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = row + dr, nc = col + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
        const neighbor = board[nr][nc];
        if (!neighbor.isRevealed && !neighbor.isWall) return true; // Still locked
      }
    }
  }

  return false; // All neighbors revealed — unlocked!
}

// ── First-encounter popup tracking ─────────────────────

export function hasSeenGimmick(gimmick) {
  const seen = safeGetJSON(SEEN_KEY, []);
  return seen.includes(gimmick);
}

export function markGimmickSeen(gimmick) {
  const seen = safeGetJSON(SEEN_KEY, []);
  if (!seen.includes(gimmick)) {
    seen.push(gimmick);
    safeSetJSON(SEEN_KEY, seen);
  }
}

export function getGimmickDef(gimmick) {
  return GIMMICK_DEFS[gimmick] || null;
}

export function getActiveGimmickNames(activeGimmicks) {
  return activeGimmicks.map(g => GIMMICK_DEFS[g]?.name || g);
}

// ── Helpers ────────────────────────────────────────────

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function recalcAllAdjacency(board, rows, cols) {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (board[r][c].isMine || board[r][c].isWall) {
        board[r][c].adjacentMines = 0;
        continue;
      }
      let count = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && board[nr][nc].isMine && !board[nr][nc].isWall) {
            count++;
          }
        }
      }
      board[r][c].adjacentMines = count;
    }
  }
}
