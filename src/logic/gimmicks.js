// ── Gimmick System ──────────────────────────────────────
// 7 gimmicks introduced at checkpoints after L10.
// Each gimmick has: apply (board setup), render hints, solver adjustments.

import { safeGet, safeSet, safeGetJSON, safeSetJSON } from '../storage/storageAdapter.js';

const GIMMICK_DEFS = {
  walls: {
    intro: 11, name: 'Walls', icon: '🧱',
    desc: 'Impassable wall edges block adjacency between cells.',
    longDesc: 'Walls appear as thick borders between cells. Numbers on either side of a wall don\'t count mines across it. Treat walls like the edge of the board — they split the grid into sections.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell revealed" style="border-right:3px solid #8B7355">1</div><div class="ge-cell revealed" style="border-left:3px solid #8B7355">0</div><div class="ge-cell revealed">0</div><div class="ge-cell revealed" style="border-right:3px solid #8B7355">1</div><div class="ge-cell revealed" style="border-left:3px solid #8B7355">0</div><div class="ge-cell revealed">0</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">0</div></div><div class="ge-caption">Thick borders = walls — numbers ignore neighbors across them</div>',
  },
  liar: {
    intro: 21, name: 'Liar Cells', icon: '🤥',
    desc: 'A few cells display a number that\'s off by 1. They have a colored border so you know which ones lie.',
    longDesc: 'Liar cells show a number that is exactly 1 higher or 1 lower than the true count. They are marked with a distinct colored border once revealed so you can spot them. Account for the offset when reasoning about nearby mines.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell revealed">1</div><div class="ge-cell revealed ge-liar">3</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">2</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">1</div><div class="ge-cell unrevealed"></div></div><div class="ge-caption">The orange-bordered "3" is really a 2 or 4</div>',
  },
  mystery: {
    intro: 31, name: 'Mystery Cells', icon: '❓',
    desc: 'Some numbered cells show "?" instead of their value.',
    longDesc: 'Certain safe cells hide their number behind a "?" symbol. You must deduce their value from surrounding clues. The cell is safe — it just won\'t tell you its count.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell revealed">1</div><div class="ge-cell revealed ge-mystery">?</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">1</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">0</div></div><div class="ge-caption">The "?" hides a number — use neighbors to figure it out</div>',
  },
  mineShift: {
    intro: 41, name: 'Mine Shift', icon: '💨', chaosOnly: true,
    desc: 'Every 30\u201345s, unflagged mines may shift to adjacent cells. Flagged mines stay put!',
    longDesc: 'Mines that you haven\'t flagged will periodically move to a neighboring cell. Numbers update to reflect new positions. Flag mines quickly to pin them in place — flagged mines never move.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell unrevealed"></div><div class="ge-cell unrevealed ge-mine-shift">💣➜</div><div class="ge-cell unrevealed ge-mine-dest"></div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">0</div></div><div class="ge-caption">Unflagged mines drift — flag them to pin them down!</div>',
  },
  locked: {
    intro: 41, name: 'Locked Cells', icon: '🔒',
    desc: 'Locked cells can\'t be opened until all safe neighbors are revealed.',
    longDesc: 'Cells with a lock icon cannot be clicked or flagged until every safe surrounding cell has been revealed. Locked cells may contain mines — be careful when they unlock! Work around them first, then come back once the area is clear.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell revealed">1</div><div class="ge-cell unrevealed"></div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">1</div><div class="ge-cell unrevealed ge-locked">🔒</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">1</div><div class="ge-cell unrevealed"></div></div><div class="ge-caption">Reveal all safe neighbors before the locked cell opens</div>',
  },
  wormhole: {
    intro: 51, name: 'Wormholes', icon: '🌀',
    desc: 'Paired cells share information \u2014 each shows the SUM of both cells\' real neighbor counts.',
    longDesc: 'Two cells linked by a wormhole both display the combined total of their individual mine counts. If cell A has 1 mine neighbor and cell B has 2, both show 3. Use surrounding cells to split the sum.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(5,32px)"><div class="ge-cell revealed">1</div><div class="ge-cell revealed ge-wormhole">🌀3</div><div class="ge-cell revealed">1</div><div class="ge-cell revealed ge-wormhole">🌀3</div><div class="ge-cell revealed">2</div></div><div class="ge-caption">Both 🌀 cells show 3 (sum of 1+2) — split the total</div>',
  },
  mirror: {
    intro: 61, name: 'Mirror Zone', icon: '🪞',
    desc: 'A marked zone displays mirrored adjacency values \u2014 numbers swap with their opposite cell in the zone.',
    longDesc: 'Inside the mirror zone, each cell\'s number is swapped with the cell at the opposite position. The zone is visually marked. To solve, mentally un-mirror each number to get the true count.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(2,32px)"><div class="ge-cell revealed ge-mirror">2🪞</div><div class="ge-cell revealed ge-mirror">1🪞</div><div class="ge-cell revealed ge-mirror">3🪞</div><div class="ge-cell revealed ge-mirror">0🪞</div></div><div class="ge-caption">Numbers are swapped diagonally within the zone</div>',
  },
  pressurePlate: {
    intro: 71, name: 'Pressure Plates', icon: '🔴',
    desc: 'Some cells start a 15-second countdown when revealed \u2014 flag an adjacent mine before time runs out!',
    longDesc: 'Pressure plate cells show their number like normal, but a countdown timer starts when revealed. You have 15 seconds to flag at least one adjacent mine or the plate detonates. The cell gives you full information \u2014 you just need to act fast.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell revealed">1</div><div class="ge-cell revealed ge-pressure" style="box-shadow:inset 0 0 6px rgba(255,50,50,0.5)">2\uD83D\uDD34</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">1</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">0</div></div><div class="ge-caption">Flag a mine next to the \uD83D\uDD34 before the timer runs out!</div>',
  },
  sonar: {
    intro: 81, name: 'Sonar', icon: '📡',
    desc: 'Some cells scan a wider area \u2014 they count mines within a 2-cell radius (5\u00d75 area).',
    longDesc: 'Sonar cells count all mines within 2 cells in every direction (a 5\u00d75 area centered on the cell) instead of the normal 3\u00d73. Their numbers are higher because they see more territory. Look for the \uD83D\uDCE1 icon to know which cells use the wider scan.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell revealed">1</div><div class="ge-cell revealed ge-sonar" style="color:#26c6da;font-weight:900">📡5</div><div class="ge-cell revealed">2</div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">1</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">0</div><div class="ge-cell unrevealed"></div></div><div class="ge-caption">The \uD83D\uDCE1 cell scans a 5\u00d75 area \u2014 "5" means 5 mines within 2 cells</div>',
  },
  compass: {
    intro: 91, name: 'Compass', icon: '🧭',
    desc: 'Cells with an arrow count ALL mines in the direction they point \u2014 across the entire board.',
    longDesc: 'Compass cells show an arrow (\u2190\u2192\u2191\u2193) and a number. The number counts every mine in that direction across the full row or column. A "4\u2190" means there are 4 mines to the left in that row. Powerful global information, but you need to cross-reference it with local numbers.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(5,32px)"><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">1</div><div class="ge-cell revealed ge-compass" style="color:#ffa726;font-weight:900">3\u2190</div><div class="ge-cell revealed">2</div><div class="ge-cell unrevealed"></div></div><div class="ge-caption">"3\u2190" = 3 mines to the left in this row</div>',
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

// Check if any NEW gimmick is being introduced at this level
function isAnyGimmickIntroBlock(level) {
  for (const g of Object.values(GIMMICK_DEFS)) {
    if (g.chaosOnly) continue;
    if (level >= g.intro && level <= g.intro + 4) return true;
  }
  return false;
}

// Check if THIS gimmick is the one being introduced at this level
function isThisGimmickIntro(gimmick, level) {
  const def = GIMMICK_DEFS[gimmick];
  return level >= def.intro && level <= def.intro + 4;
}

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
  let intensity = base + (rng() < 0.3 ? 1 : 0); // slight random boost

  // Breathing room: when a DIFFERENT gimmick is being introduced,
  // subtly reduce this old gimmick's intensity by 1
  if (isAnyGimmickIntroBlock(level) && !isThisGimmickIntro(gimmick, level)) {
    intensity = Math.max(1, intensity - 1);
  }

  return intensity;
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
      case 'pressurePlate':
        applied.pressurePlate = applyPressurePlates(board, rows, cols, intensity, rng);
        break;
      case 'sonar':
        applied.sonar = applySonar(board, rows, cols, intensity, rng);
        break;
      case 'compass':
        applied.compass = applyCompass(board, rows, cols, intensity, rng);
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
      // Allow mines AND numbered cells to be locked
      if (cell.isMine || cell.adjacentMines > 0) {
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

// ── Wall Edge Helpers ─────────────────────────────────

function wallKey(r1, c1, r2, c2) {
  // Normalize so smaller coordinate comes first
  if (r1 < r2 || (r1 === r2 && c1 < c2)) return `${r1},${c1}-${r2},${c2}`;
  return `${r2},${c2}-${r1},${c1}`;
}

export function hasWallBetween(wallEdges, r1, c1, r2, c2) {
  if (!wallEdges || wallEdges.size === 0) return false;

  const dr = r2 - r1;
  const dc = c2 - c1;

  // Cardinal move: check direct edge
  if (dr === 0 || dc === 0) {
    return wallEdges.has(wallKey(r1, c1, r2, c2));
  }

  // Diagonal move: check the 4 edges of the 2×2 square the diagonal passes through.
  // Blocked if ANY pair of adjacent edges both exist — forming an L-corner
  // or a continuous wall segment across the diagonal's path.
  //
  // Example: two adjacent horizontal walls block a diagonal through them:
  //   X  A  F       walls: X-B and A-Y (e3 and e4)
  //   -- --         X cannot see Y diagonally (continuous barrier)
  //   B  Y  G       but A can see G (only one wall on that side)
  //
  const e1 = wallEdges.has(wallKey(r1, c1, r1, c2));  // horiz edge at source row
  const e2 = wallEdges.has(wallKey(r2, c1, r2, c2));  // horiz edge at dest row
  const e3 = wallEdges.has(wallKey(r1, c1, r2, c1));  // vert edge at source col
  const e4 = wallEdges.has(wallKey(r1, c2, r2, c2));  // vert edge at dest col

  return (e1 && e3)    // L-corner at source cell
      || (e2 && e4)    // L-corner at dest cell
      || (e3 && e4)    // continuous wall spanning the row boundary
      || (e1 && e2);   // continuous wall spanning the column boundary
}

// ── Walls: edges between adjacent cells ──────────────

export function applyWalls(board, rows, cols, segmentCount, rng) {
  const wallEdges = new Set();
  // Difficulty scales both count and length of wall segments
  const maxSegments = Math.min(segmentCount, 6);
  const baseLength = Math.min(2 + Math.floor(segmentCount / 2), 5); // 2-5

  for (let s = 0; s < maxSegments; s++) {
    const length = baseLength + Math.floor(rng() * 2);

    // Starting orientation: horizontal = edges between rows, vertical = edges between cols
    let horiz = rng() < 0.5;
    // Bend at a random midpoint (~40% chance of a bend)
    const bendAt = rng() < 0.4 ? -1 : (1 + Math.floor(rng() * Math.max(1, length - 1)));

    // Pick a starting edge position
    // For horizontal: wall between row r and r+1, starting at column c, extending c++
    // For vertical: wall between col c and c+1, starting at row r, extending r++
    let r = 1 + Math.floor(rng() * Math.max(1, rows - 3));
    let c = 1 + Math.floor(rng() * Math.max(1, cols - 3));
    // Extension direction along the wall line (+1 or -1)
    let dir = rng() < 0.5 ? 1 : -1;

    const segment = [];

    for (let i = 0; i < length; i++) {
      // Bend: switch orientation at the bend point
      if (i === bendAt) {
        horiz = !horiz;
        dir = rng() < 0.5 ? 1 : -1;
      }

      let key = null;
      if (horiz) {
        // Edge between (r, c) and (r+1, c) — horizontal wall at this column
        if (r >= 0 && r < rows - 1 && c >= 0 && c < cols) {
          key = wallKey(r, c, r + 1, c);
        }
        c += dir; // extend along columns
      } else {
        // Edge between (r, c) and (r, c+1) — vertical wall at this row
        if (r >= 0 && r < rows && c >= 0 && c < cols - 1) {
          key = wallKey(r, c, r, c + 1);
        }
        r += dir; // extend along rows
      }

      if (key) segment.push(key);
    }

    if (segment.length >= 2) {
      for (const key of segment) {
        wallEdges.add(key);
      }
    }
  }

  // Store wall edges on the board for easy access by other modules
  board._wallEdges = wallEdges;

  // Recalculate adjacency respecting wall edges
  if (wallEdges.size > 0) {
    recalcAllAdjacency(board, rows, cols);
  }

  return wallEdges;
}

// ── Wormholes: paired cells show summed adjacency ──────

function applyWormholes(board, rows, cols, pairCount, rng) {
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
      if (!board[r][c].isMine) {
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
      if (board[r][c].isMine && !board[r][c].isFlagged && !board[r][c].isRevealed) {
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
          if (!dest.isMine && !dest.isRevealed && !dest.isFlagged) {
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

// ── Pressure Plates: timed cells that must be flagged ──

function applyPressurePlates(board, rows, cols, count, rng) {
  // Select non-mine cells with adjacentMines >= 1 (must have at least one mine neighbor to flag)
  const candidates = [];
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const cell = board[r][c];
      if (!cell.isMine && cell.adjacentMines >= 1 && !cell.isLocked && !cell.isMystery && !cell.isLiar) {
        candidates.push(cell);
      }
    }
  }
  shuffle(candidates, rng);
  const applied = [];
  for (let i = 0; i < Math.min(count, candidates.length); i++) {
    candidates[i].isPressurePlate = true;
    candidates[i].plateTimer = 15; // seconds
    applied.push({ row: candidates[i].row, col: candidates[i].col });
  }
  return applied;
}

// ── Sonar: 2-cell radius mine counting ────────────────

function applySonar(board, rows, cols, count, rng) {
  const candidates = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (!cell.isMine && !cell.isLocked && !cell.isMystery && !cell.isLiar && !cell.isPressurePlate) {
        candidates.push(cell);
      }
    }
  }
  shuffle(candidates, rng);
  const wallEdges = board._wallEdges || null;
  const applied = [];
  for (let i = 0; i < Math.min(count, candidates.length); i++) {
    const cell = candidates[i];
    cell.isSonar = true;
    // Count mines within 2-cell radius (5×5 area), respecting walls
    let sonarCount = 0;
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = cell.row + dr, nc = cell.col + dc;
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
          // For sonar, walls only block if directly between the sonar cell and target
          // (simplified: check cardinal wall for adjacent cells, no wall check for 2-away cells)
          if (Math.abs(dr) <= 1 && Math.abs(dc) <= 1 && wallEdges && hasWallBetween(wallEdges, cell.row, cell.col, nr, nc)) continue;
          if (board[nr][nc].isMine) sonarCount++;
        }
      }
    }
    cell.sonarCount = sonarCount;
    cell.displayedMines = sonarCount; // Override displayed number
    applied.push({ row: cell.row, col: cell.col, sonarCount });
  }
  return applied;
}

// ── Compass: directional mine counting across full row/col ──

const COMPASS_DIRS = [
  { arrow: '←', dr: 0, dc: -1 },
  { arrow: '→', dr: 0, dc: 1 },
  { arrow: '↑', dr: -1, dc: 0 },
  { arrow: '↓', dr: 1, dc: 0 },
];

function applyCompass(board, rows, cols, count, rng) {
  const candidates = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (!cell.isMine && !cell.isLocked && !cell.isMystery && !cell.isLiar && !cell.isPressurePlate && !cell.isSonar) {
        candidates.push(cell);
      }
    }
  }
  shuffle(candidates, rng);
  const applied = [];
  for (let i = 0; i < Math.min(count, candidates.length); i++) {
    const cell = candidates[i];
    const dir = COMPASS_DIRS[Math.floor(rng() * COMPASS_DIRS.length)];
    cell.isCompass = true;
    cell.compassDir = dir;
    // Count all mines in the direction
    let compassCount = 0;
    let r = cell.row + dir.dr, c = cell.col + dir.dc;
    while (r >= 0 && r < rows && c >= 0 && c < cols) {
      if (board[r][c].isMine) compassCount++;
      r += dir.dr;
      c += dir.dc;
    }
    cell.compassCount = compassCount;
    cell.displayedMines = compassCount; // Override displayed number
    cell.compassArrow = dir.arrow;
    applied.push({ row: cell.row, col: cell.col, arrow: dir.arrow, compassCount });
  }
  return applied;
}

// ── Locked Cell Check ──────────────────────────────────

export function isLockedCell(board, row, col) {
  const cell = board[row][col];
  if (!cell.isLocked) return false;

  const rows = board.length;
  const cols = board[0].length;

  // Check if all safe neighbors are revealed (mines and wall-edges don't block unlock)
  const wallEdges = board._wallEdges || null;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = row + dr, nc = col + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
        // Wall edge between these cells = treat as satisfied
        if (wallEdges && hasWallBetween(wallEdges, row, col, nr, nc)) continue;
        const neighbor = board[nr][nc];
        // Mines don't block unlock — only unrevealed safe cells do
        if (!neighbor.isRevealed && !neighbor.isMine) return true; // Still locked
      }
    }
  }

  return false; // All safe neighbors revealed — unlocked!
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
  const wallEdges = board._wallEdges || null;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (board[r][c].isMine) {
        board[r][c].adjacentMines = 0;
        continue;
      }
      let count = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
            // Skip neighbors separated by a wall edge
            if (wallEdges && hasWallBetween(wallEdges, r, c, nr, nc)) continue;
            if (board[nr][nc].isMine) count++;
          }
        }
      }
      board[r][c].adjacentMines = count;
    }
  }
}
