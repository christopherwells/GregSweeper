// ── Gimmick System ──────────────────────────────────────
// 7 gimmicks introduced at checkpoints after L10.
// Each gimmick has: apply (board setup), render hints, solver adjustments.

import { safeGet, safeSet, safeGetJSON, safeSetJSON } from '../storage/storageAdapter.js';
import { MAX_LEVEL } from './difficulty.js';

// Reset all gimmick-related properties on a single cell.
// Used when retrying gimmick placement to avoid stale markers.
export function clearGimmickProperties(cell) {
  cell.isMystery = false;
  cell.isLiar = false;
  cell.inLiarZone = false;
  cell.displayedMines = undefined;
  cell.mirrorZone = undefined;
  cell.mirrorPair = undefined;
  cell.isWormhole = false;
  cell.wormholePair = undefined;
  cell.wormholePairIndex = undefined;
  cell.isLocked = false;
  cell.isPressurePlate = false;
  cell.plateTimer = undefined;
  cell.plateDisarmed = false;
  cell.isSonar = false;
  cell.sonarCount = undefined;
  cell.isCompass = false;
  cell.compassDir = undefined;
  cell.compassArrow = undefined;
  cell.compassCount = undefined;
  cell.liarOffset = undefined;
}

const GIMMICK_DEFS = {
  walls: {
    intro: 11, name: 'Walls', icon: '🧱',
    desc: 'Impassable wall edges block adjacency between cells.',
    longDesc: 'Walls appear as thick borders between cells. Numbers on either side of a wall don\'t count mines across it. Treat walls like the edge of the board — they split the grid into sections.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell revealed" style="border-right:3px solid #8B7355">1</div><div class="ge-cell revealed" style="border-left:3px solid #8B7355">0</div><div class="ge-cell revealed">0</div><div class="ge-cell revealed" style="border-right:3px solid #8B7355">1</div><div class="ge-cell revealed" style="border-left:3px solid #8B7355">0</div><div class="ge-cell revealed">0</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">0</div></div><div class="ge-caption">Thick borders = walls — numbers ignore neighbors across them</div>',
  },
  liar: {
    intro: 21, name: 'Liar Cells', icon: '🤥',
    desc: 'A few cells display a number that\'s off by 1. Their numbers are italic and underlined.',
    longDesc: 'Liar cells show a number that is exactly 1 higher or 1 lower than the true count. They are shown in italic with an underline so you can spot them. Account for the offset when reasoning about nearby mines.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell revealed">1</div><div class="ge-cell revealed ge-liar" style="font-style:italic;text-decoration:underline"><em>3</em></div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">2</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">1</div><div class="ge-cell unrevealed"></div></div><div class="ge-caption">The underlined italic "3" is really a 2 or 4</div>',
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
    intro: 61, name: 'Mirror Cells', icon: '🪞',
    desc: 'Pairs of adjacent cells swap their numbers with each other.',
    longDesc: 'Two neighboring cells swap displayed mine counts. If cell A has 1 mine and cell B has 3, A shows 3 and B shows 1. The swapped pair shares a colored tint so you can spot which cells are linked.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell revealed">1</div><div class="ge-cell revealed ge-mirror">3🪞</div><div class="ge-cell revealed ge-mirror">1🪞</div><div class="ge-cell revealed">2</div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">0</div></div><div class="ge-caption">The two 🪞 cells swapped their numbers (really 1 and 3)</div>',
  },
  pressurePlate: {
    intro: 71, name: 'Pressure Plates', icon: '🔴',
    desc: 'Some cells start a countdown when revealed \u2014 reveal all safe neighbors before time runs out!',
    longDesc: 'Pressure plate cells show their number like normal, but a countdown timer starts when revealed. You must reveal every non-mine neighbor before time runs out or the plate detonates. Solve the area around the plate fast!',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell revealed">1</div><div class="ge-cell revealed ge-pressure" style="box-shadow:inset 0 0 6px rgba(255,50,50,0.5)">2\uD83D\uDD34</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">1</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">0</div></div><div class="ge-caption">Reveal all safe cells around the \uD83D\uDD34 before the timer runs out!</div>',
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

// ── Daily-safe gimmick subset (no dynamic board changes, no timers) ──
const DAILY_SAFE_GIMMICKS = ['mystery', 'locked', 'walls', 'liar', 'wormhole', 'mirror', 'sonar', 'compass'];

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
  if (rng() > 0.55) return []; // 45% of days: no gimmick
  const idx = Math.floor(rng() * DAILY_SAFE_GIMMICKS.length);
  const gimmicks = [DAILY_SAFE_GIMMICKS[idx]];
  // ~20% of gimmick days get a second modifier
  if (rng() < 0.20) {
    const idx2 = Math.floor(rng() * DAILY_SAFE_GIMMICKS.length);
    if (DAILY_SAFE_GIMMICKS[idx2] !== gimmicks[0]) {
      gimmicks.push(DAILY_SAFE_GIMMICKS[idx2]);
    }
  }
  return gimmicks;
}

// ── Which gimmicks are active for a given level ────────

export function getGimmicksForLevel(level, rng = Math.random) {
  if (level <= 10) return [];

  const allTypes = Object.keys(GIMMICK_DEFS);
  // Filter out chaosOnly gimmicks (e.g., mineShift) from Challenge mode
  const introduced = allTypes.filter(g => level >= GIMMICK_DEFS[g].intro && !GIMMICK_DEFS[g].chaosOnly);
  if (introduced.length === 0) return [];

  // Find the gimmick whose intro block contains this level (10-level blocks)
  const primaryGimmick = introduced.find(g => {
    const intro = GIMMICK_DEFS[g].intro;
    return level >= intro && level <= intro + 9;
  });

  // Old gimmicks = all introduced EXCEPT the current primary
  const oldGimmicks = introduced.filter(g => g !== primaryGimmick);

  if (level < 91 || (level >= 91 && level <= 100)) {
    // During intro blocks (L11-90) or compass intro (L91-100):
    // Primary is always present, secondary 60%, tertiary 10%
    const active = [];

    // Primary: 100% always present
    if (primaryGimmick) active.push(primaryGimmick);

    // Secondary: one old gimmick at 60% chance
    if (oldGimmicks.length > 0 && rng() < 0.60) {
      const pick = oldGimmicks[Math.floor(rng() * oldGimmicks.length)];
      active.push(pick);

      // Tertiary: another old gimmick at 10% chance
      const remaining = oldGimmicks.filter(g => g !== pick);
      if (remaining.length > 0 && rng() < 0.10) {
        active.push(remaining[Math.floor(rng() * remaining.length)]);
      }
    }

    // Guarantee at least one gimmick
    if (active.length === 0 && introduced.length > 0) {
      active.push(introduced[introduced.length - 1]);
    }

    return active;
  }

  // L101-120: Post-intro ramp — all gimmicks equal, ramp to guaranteed 3
  const progress = (level - 100) / 20; // 0.0 at L101, 1.0 at L120
  const shuffled = [...introduced].sort(() => rng() - 0.5);
  const active = [shuffled[0]]; // always at least 1

  // Second gimmick: ramp from 80% to 100%
  if (shuffled.length > 1 && rng() < 0.80 + progress * 0.20) {
    active.push(shuffled[1]);
  }
  // Third gimmick: ramp from 40% to 100%
  if (shuffled.length > 2 && rng() < 0.40 + progress * 0.60) {
    active.push(shuffled[2]);
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
    if (level >= g.intro && level <= g.intro + 9) return true;
  }
  return false;
}

// Check if THIS gimmick is the one being introduced at this level
function isThisGimmickIntro(gimmick, level) {
  const def = GIMMICK_DEFS[gimmick];
  return level >= def.intro && level <= def.intro + 9;
}

function getIntensity(gimmick, level, rng) {
  const def = GIMMICK_DEFS[gimmick];
  const introEnd = def.intro + 9;

  if (level >= def.intro && level <= introEnd) {
    // Introduction block: ramp from 1 over 10 levels
    const blockPos = level - def.intro; // 0-9
    return 1 + Math.floor(blockPos / 2); // 1-5 over the block
  }

  // Below intro (daily/chaos at low levels): moderate fixed intensity
  if (level < def.intro) {
    return 2 + (rng() < 0.3 ? 1 : 0);
  }

  // After introduction: slowly ramp toward max level
  const progress = (level - introEnd) / (MAX_LEVEL - introEnd);
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

  // Order matters: walls first (affects adjacency), then cell markers that
  // hide/lock cells, then base-value gimmicks (wormhole/mirror/sonar/compass)
  // which are mutually exclusive with each other, then liar LAST so it can
  // stack its offset on top of whatever base value is already assigned.
  const ORDER = [
    'walls', 'mineShift',
    'mystery', 'locked', 'pressurePlate',
    'wormhole', 'mirror', 'sonar', 'compass',
    'liar',
  ];
  const ordered = ORDER.filter(g => activeGimmicks.includes(g));

  for (const g of ordered) {
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
        applied.mirror = applyMirrorPairs(board, rows, cols, Math.min(intensity, 3), rng);
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

  // Single source of truth for displayed numbers — runs after every gimmick
  // has marked its cells, so liar offsets stack correctly on top of
  // wormhole/mirror/sonar/compass base values.
  recomputeDisplayedMines(board);

  return applied;
}

// True if a cell already owns the base displayed number (i.e. any other
// base-value gimmick must not be placed on it). Liar is NOT in this list —
// liar stacks on top of a base value via its offset.
function hasBaseValueGimmick(cell) {
  return cell.isWormhole || !!cell.mirrorPair || cell.isSonar || cell.isCompass;
}

// True if the cell's displayed value is replaced by something other than a
// mine-count number — stacking a base-value gimmick on top would be wasted.
// Locked cells are intentionally NOT included here: the lock is a temporary
// gate, and once unlocked the cell displays whatever the base/liar layers
// dictate. That lets locked stack with wormhole/mirror/sonar/compass/liar.
function hasDisplayBlockingGimmick(cell) {
  return cell.isMystery || cell.isPressurePlate;
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
  // Compute the current would-be base display value for a candidate so we
  // can sanity-check that offset ±1 stays non-negative. At this point in
  // applyGimmicks, wormhole/mirror/sonar/compass have already marked their
  // cells but recomputeDisplayedMines hasn't run yet, so pull the base the
  // same way it will later.
  const baseValue = (cell) => {
    if (cell.isSonar && typeof cell.sonarCount === 'number') return cell.sonarCount;
    if (cell.isCompass && typeof cell.compassCount === 'number') return cell.compassCount;
    if (cell.isWormhole && cell.wormholePair) {
      const p = board[cell.wormholePair.row]?.[cell.wormholePair.col];
      return cell.adjacentMines + (p ? p.adjacentMines : 0);
    }
    if (cell.mirrorPair) {
      const m = board[cell.mirrorPair.row]?.[cell.mirrorPair.col];
      return m ? m.adjacentMines : cell.adjacentMines;
    }
    return cell.adjacentMines;
  };

  const candidates = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (cell.isMine) continue;
      // Liar cannot share a cell with anything that hides the number.
      if (hasDisplayBlockingGimmick(cell)) continue;
      // Need base >= 2 so that offset -1 still leaves a positive number.
      if (baseValue(cell) < 2) continue;
      candidates.push(cell);
    }
  }
  shuffle(candidates, rng);
  const applied = [];
  for (let i = 0; i < Math.min(count, candidates.length); i++) {
    const cell = candidates[i];
    const offset = rng() < 0.5 ? -1 : 1;
    cell.isLiar = true;
    cell.liarOffset = offset;
    // displayedMines is set by recomputeDisplayedMines so the offset stacks
    // on top of any base-value gimmick present on this cell.
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

  // Verify walls don't create isolated regions — every cell must be
  // reachable from every other cell through wall-respecting paths.
  // If walls partition the board, remove the last segment and retry.
  board._wallEdges = wallEdges;
  if (wallEdges.size > 0) {
    const visited = new Set();
    const queue = ['0,0'];
    visited.add('0,0');
    while (queue.length > 0) {
      const [cr, cc] = queue.shift().split(',').map(Number);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = cr + dr, nc = cc + dc;
          const key = `${nr},${nc}`;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && !visited.has(key)) {
            if (!hasWallBetween(wallEdges, cr, cc, nr, nc)) {
              visited.add(key);
              queue.push(key);
            }
          }
        }
      }
    }
    // If any cell is unreachable, clear all walls and start over
    let isolated = false;
    for (let r = 0; r < rows && !isolated; r++) {
      for (let c = 0; c < cols && !isolated; c++) {
        if (!visited.has(`${r},${c}`)) isolated = true;
      }
    }
    if (isolated) {
      wallEdges.clear();
      board._wallEdges = wallEdges;
    }
  }

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
      if (cell.isMine || cell.adjacentMines <= 0) continue;
      if (hasBaseValueGimmick(cell) || hasDisplayBlockingGimmick(cell)) continue;
      candidates.push(cell);
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
      // Ensure they're not adjacent (at least 2 cells apart on small boards, 3 on larger)
      const minDist = Math.min(rows, cols) <= 8 ? 2 : 3;
      if (Math.abs(cell.row - a.row) + Math.abs(cell.col - a.col) >= minDist) {
        b = cell;
        used.add(key);
        break;
      }
    }
    if (a && b) {
      const summed = a.adjacentMines + b.adjacentMines;
      const pairIndex = pairs.length; // 0, 1, 2 for color matching
      a.wormholePair = { row: b.row, col: b.col };
      a.isWormhole = true;
      a.wormholePairIndex = pairIndex;
      b.wormholePair = { row: a.row, col: a.col };
      b.isWormhole = true;
      b.wormholePairIndex = pairIndex;
      // displayedMines is set by recomputeDisplayedMines
      pairs.push({ a: { row: a.row, col: a.col }, b: { row: b.row, col: b.col }, summed });
    }
  }
  return pairs;
}

// ── Mirror Pairs: two adjacent cells display each other's adjacency ──

function applyMirrorPairs(board, rows, cols, pairCount, rng) {
  // Each pair is two adjacent (8-connected) non-mine numbered cells. The
  // pair swaps displayed adjacency: each cell shows the partner's true
  // adjacentMines. Numbers must differ so the swap is actually informative.
  const wallEdges = board._wallEdges || null;

  const candidates = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (cell.isMine || cell.adjacentMines <= 0) continue;
      if (hasBaseValueGimmick(cell) || hasDisplayBlockingGimmick(cell)) continue;
      candidates.push(cell);
    }
  }
  shuffle(candidates, rng);

  const pairs = [];
  const used = new Set();
  for (const a of candidates) {
    if (pairs.length >= pairCount) break;
    const aKey = `${a.row},${a.col}`;
    if (used.has(aKey)) continue;

    // Look for an adjacent partner with a different adjacentMines value.
    const partners = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = a.row + dr, nc = a.col + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        if (wallEdges && hasWallBetween(wallEdges, a.row, a.col, nr, nc)) continue;
        const b = board[nr][nc];
        if (b.isMine || b.adjacentMines <= 0) continue;
        if (hasBaseValueGimmick(b) || hasDisplayBlockingGimmick(b)) continue;
        if (used.has(`${nr},${nc}`)) continue;
        if (b.adjacentMines === a.adjacentMines) continue; // swap would be a no-op
        partners.push(b);
      }
    }
    if (partners.length === 0) continue;

    const b = partners[Math.floor(rng() * partners.length)];
    const pairIndex = pairs.length % 2;
    a.mirrorPair = { row: b.row, col: b.col, pairIndex };
    b.mirrorPair = { row: a.row, col: a.col, pairIndex };
    used.add(aKey);
    used.add(`${b.row},${b.col}`);
    pairs.push({ a: { row: a.row, col: a.col }, b: { row: b.row, col: b.col } });
  }
  return pairs;
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
    recomputeDisplayedMines(board);
  }

  return shifted;
}

// ── Pressure Plates: timed cells that must be flagged ──

function applyPressurePlates(board, rows, cols, count, rng) {
  // Select non-mine cells with adjacentMines >= 2
  // Must have enough safe neighbors (>= 4) so the plate isn't trivially solved
  // by a cascade revealing most of the area
  const candidates = [];
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const cell = board[r][c];
      if (cell.isMine || cell.adjacentMines < 2 || cell.isLocked || cell.isMystery || cell.isLiar) continue;
      // Count non-mine neighbors (these must be revealed to disarm)
      let safeNeighbors = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && !board[nr][nc].isMine) {
            safeNeighbors++;
          }
        }
      }
      // Require >= 4 safe neighbors so the plate needs real work to disarm
      if (safeNeighbors >= 4) {
        candidates.push({ cell, safeNeighbors });
      }
    }
  }
  // Prefer cells with MORE safe neighbors (harder to disarm)
  candidates.sort((a, b) => b.safeNeighbors - a.safeNeighbors);
  shuffle(candidates, rng);

  const maxPlates = Math.min(count, 2);
  const applied = [];
  for (let i = 0; i < Math.min(maxPlates, candidates.length); i++) {
    const cell = candidates[i].cell;
    cell.isPressurePlate = true;
    cell.plateTimer = 15; // placeholder — dynamic timer computed at reveal time
    applied.push({ row: cell.row, col: cell.col });
  }
  return applied;
}

// ── Sonar: 2-cell radius mine counting ────────────────

function applySonar(board, rows, cols, count, rng) {
  const candidates = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (cell.isMine) continue;
      if (hasBaseValueGimmick(cell) || hasDisplayBlockingGimmick(cell)) continue;
      candidates.push(cell);
    }
  }
  shuffle(candidates, rng);
  const applied = [];
  for (let i = 0; i < Math.min(count, candidates.length); i++) {
    const cell = candidates[i];
    cell.isSonar = true;
    // sonarCount + displayedMines are set by recomputeDisplayedMines
    applied.push({ row: cell.row, col: cell.col });
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
      if (cell.isMine) continue;
      if (hasBaseValueGimmick(cell) || hasDisplayBlockingGimmick(cell)) continue;
      candidates.push(cell);
    }
  }
  shuffle(candidates, rng);
  const applied = [];
  for (let i = 0; i < Math.min(count, candidates.length); i++) {
    const cell = candidates[i];
    const dir = COMPASS_DIRS[Math.floor(rng() * COMPASS_DIRS.length)];
    cell.isCompass = true;
    cell.compassDir = dir;
    cell.compassArrow = dir.arrow;
    // compassCount + displayedMines are set by recomputeDisplayedMines
    applied.push({ row: cell.row, col: cell.col, arrow: dir.arrow });
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
        // Mines and other locked cells don't block unlock
        // (prevents circular deadlock between adjacent locked cells)
        if (!neighbor.isRevealed && !neighbor.isMine && !neighbor.isLocked) return true; // Still locked
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

export function getGimmickDefs() { return GIMMICK_DEFS; }

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

// Recompute displayedMines for every gimmick cell that overrides it.
// Call after any mine removal/shift so liar/wormhole/mirror/sonar/compass
// numbers match the current mine layout.
//
// Two-pass: first compute the base value (wormhole sum / mirror partner /
// sonar count / compass count / plain adjacentMines), then apply the liar
// offset on top. This is what makes a liar stacked on a wormhole lie
// about the wormhole number rather than about the raw local adjacency.
export function recomputeDisplayedMines(board) {
  const rows = board.length;
  const cols = board[0].length;
  const wallEdges = board._wallEdges || null;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (cell.isMine) continue;

      // ── Pass 1: base value ─────────────────────────────
      let base;
      if (cell.isSonar) {
        let count = 0;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
            if (Math.abs(dr) <= 1 && Math.abs(dc) <= 1 && wallEdges && hasWallBetween(wallEdges, r, c, nr, nc)) continue;
            if (board[nr][nc].isMine) count++;
          }
        }
        cell.sonarCount = count;
        base = count;
      } else if (cell.isCompass && cell.compassDir) {
        let count = 0;
        let rr = r + cell.compassDir.dr;
        let cc = c + cell.compassDir.dc;
        while (rr >= 0 && rr < rows && cc >= 0 && cc < cols) {
          if (board[rr][cc].isMine) count++;
          rr += cell.compassDir.dr;
          cc += cell.compassDir.dc;
        }
        cell.compassCount = count;
        base = count;
      } else if (cell.isWormhole && cell.wormholePair) {
        const partner = board[cell.wormholePair.row]?.[cell.wormholePair.col];
        base = cell.adjacentMines + (partner ? partner.adjacentMines : 0);
      } else if (cell.mirrorPair) {
        const partner = board[cell.mirrorPair.row]?.[cell.mirrorPair.col];
        base = partner ? partner.adjacentMines : cell.adjacentMines;
      } else {
        base = cell.adjacentMines;
      }

      // ── Pass 2: liar offset on top of base ─────────────
      if (cell.isLiar && typeof cell.liarOffset === 'number') {
        cell.displayedMines = Math.max(0, base + cell.liarOffset);
      } else if (cell.isSonar || cell.isCompass || cell.isWormhole || cell.mirrorPair) {
        cell.displayedMines = base;
      } else {
        cell.displayedMines = undefined; // plain number cell — render uses adjacentMines
      }
    }
  }
}

export function recalcAllAdjacency(board, rows, cols) {
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
