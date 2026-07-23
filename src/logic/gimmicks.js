// ── Gimmick System ──────────────────────────────────────
// 7 gimmicks introduced at checkpoints after L10.
// Each gimmick has: apply (board setup), render hints, solver adjustments.

import { safeGet, safeSet, safeGetJSON, safeSetJSON } from '../storage/storageAdapter.js';
import { MAX_LEVEL } from './difficulty.js';
import { WORM_MAX_PER_BOARD } from './worms.js';
import { wallKey, hasWallBetween, buildNeighborCache, sonarScanCells, compassRayCells, cellAt, defineCellNeighbors } from './adjacency.js';
import { computeCompassRay, buildTiling, buildWireframe, HEX_ROW_H } from './tilingGeometry.js';

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
  cell.compassRay = undefined;
  cell.liarOffset = undefined;
  cell.isWormEgg = false;
}

const GIMMICK_DEFS = {
  walls: {
    intro: 11, name: 'Walls', icon: '🧱',
    desc: 'Impassable wall edges block adjacency between cells.',
    longDesc: 'Walls appear as thick borders between cells. Numbers on either side of a wall don\'t count mines across it. Treat walls like the edge of the board: they split the grid into sections.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell revealed" style="border-right:3px solid #8B7355">1</div><div class="ge-cell revealed" style="border-left:3px solid #8B7355">0</div><div class="ge-cell revealed">0</div><div class="ge-cell revealed" style="border-right:3px solid #8B7355">1</div><div class="ge-cell revealed" style="border-left:3px solid #8B7355">0</div><div class="ge-cell revealed">0</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">0</div></div><div class="ge-caption">Thick borders are walls. Numbers ignore neighbors across them</div>',
  },
  liar: {
    intro: 21, name: 'Liar Cells', icon: '🤥',
    desc: 'A few cells display a number that\'s off by 1. They have a rose-pink background and their numbers are italic + underlined.',
    longDesc: 'Liar cells show a number that is exactly 1 higher or 1 lower than the true count. They are tinted rose-pink with italic, underlined numbers so you can spot them at a glance. Account for the offset when reasoning about nearby mines.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell revealed">1</div><div class="ge-cell revealed" style="font-style:italic;text-decoration:underline;background:rgba(231,76,60,0.22)">3</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">2</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">1</div><div class="ge-cell unrevealed"></div></div><div class="ge-caption">The pink-tinted italic "3" is really a 2 or 4</div>',
  },
  mystery: {
    intro: 31, name: 'Mystery Cells', icon: '❓',
    desc: 'Some numbered cells show "?" instead of their value.',
    longDesc: 'Certain safe cells hide their number behind a "?" symbol. You must deduce their value from surrounding clues. The cell is safe, it just won\'t tell you its count.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell revealed">1</div><div class="ge-cell revealed ge-mystery">?</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">1</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">0</div></div><div class="ge-caption">The "?" hides a number. Use neighbors to figure it out</div>',
  },
  mineShift: {
    intro: 41, name: 'Mine Shift', icon: '💨', chaosOnly: true,
    desc: 'Every 30\u201345s, unflagged mines may shift to adjacent cells. Flagged mines stay put!',
    longDesc: 'Mines that you haven\'t flagged will periodically move to a neighboring cell. Numbers update to reflect new positions. Flag mines quickly to pin them in place. Flagged mines never move.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell unrevealed"></div><div class="ge-cell unrevealed ge-mine-shift"><img class="ge-piece" src="assets/sprites/mine.png" alt="">➜</div><div class="ge-cell unrevealed ge-mine-dest"></div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">0</div></div><div class="ge-caption">Unflagged mines drift. Flag them to pin them down!</div>',
  },
  locked: {
    intro: 41, name: 'Locked Cells', icon: '🔒',
    desc: 'Locked cells can\'t be opened until all safe neighbors are revealed.',
    longDesc: 'Cells with a lock icon cannot be clicked or flagged until every safe surrounding cell has been revealed. Locked cells may contain mines, so be careful when they unlock! Work around them first, then come back once the area is clear.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell revealed">1</div><div class="ge-cell unrevealed"></div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">1</div><div class="ge-cell unrevealed ge-locked"><img class="ge-piece" src="assets/sprites/mod-locked.svg" alt=""></div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">1</div><div class="ge-cell unrevealed"></div></div><div class="ge-caption">Reveal all safe neighbors before the locked cell opens</div>',
  },
  wormhole: {
    intro: 51, name: 'Wormholes', icon: '🌀',
    desc: 'Paired cells share information \u2014 each shows the SUM of both cells\' real neighbor counts.',
    longDesc: 'Two cells linked by a wormhole both display the combined total of their individual mine counts. If cell A has 1 mine neighbor and cell B has 2, both show 3. Linked cells share the same colored background tint (amber, magenta, or green) so you can spot the pair. Use surrounding cells to split the sum.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(5,32px)"><div class="ge-cell revealed">1</div><div class="ge-cell revealed" style="background:rgba(255,140,0,0.35)">3</div><div class="ge-cell revealed">1</div><div class="ge-cell revealed" style="background:rgba(255,140,0,0.35)">3</div><div class="ge-cell revealed">2</div></div><div class="ge-caption">The two amber-tinted cells share a sum of 3 (really 1+2). Split it using their neighbors</div>',
  },
  mirror: {
    intro: 61, name: 'Mirror Cells', icon: '🪞',
    desc: 'Pairs of adjacent cells swap their numbers with each other.',
    longDesc: 'Two neighboring cells swap displayed mine counts. If cell A has 1 mine and cell B has 3, A shows 3 and B shows 1. The swapped pair shares a dashed colored outline (blue, purple, or green) so you can spot which cells are linked.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell revealed">1</div><div class="ge-cell revealed" style="border:2.5px dashed rgba(52,152,219,0.85)">3</div><div class="ge-cell revealed" style="border:2.5px dashed rgba(52,152,219,0.85)">1</div><div class="ge-cell revealed">2</div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">0</div></div><div class="ge-caption">The two outlined cells swapped their numbers (really 1 and 3)</div>',
  },
  pressurePlate: {
    intro: 71, name: 'Pressure Plates', icon: '🔴',
    desc: 'Some cells start a countdown when revealed \u2014 reveal all safe neighbors before time runs out!',
    longDesc: 'Pressure plate cells show their number like normal, but a countdown timer starts when revealed. You must reveal every non-mine neighbor before time runs out or the plate detonates. Solve the area around the plate fast!',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell revealed">1</div><div class="ge-cell revealed ge-pressure" style="box-shadow:inset 0 0 6px rgba(255,50,50,0.5)">2<img class="ge-piece" src="assets/sprites/mod-pressure.svg" alt=""></div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">1</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">0</div></div><div class="ge-caption">Reveal all safe cells around the plate before the timer runs out!</div>',
  },
  sonar: {
    intro: 81, name: 'Sonar', icon: '📡',
    desc: 'Some cells scan a wider area \u2014 they count mines within a 2-cell radius (5\u00d75 area).',
    longDesc: 'Sonar cells count all mines within 2 cells in every direction (a 5\u00d75 area centered on the cell) instead of the normal 3\u00d73. Their numbers are higher because they see more territory. Look for the sonar icon to know which cells use the wider scan.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell revealed">1</div><div class="ge-cell revealed ge-sonar" style="color:#26c6da;font-weight:900"><img class="ge-piece" src="assets/sprites/mod-sonar.svg" alt="">5</div><div class="ge-cell revealed">2</div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">1</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">0</div><div class="ge-cell unrevealed"></div></div><div class="ge-caption">The sonar cell scans a 5\u00d75 area \u2014 "5" means 5 mines within 2 cells</div>',
  },
  compass: {
    intro: 91, name: 'Compass', icon: '🧭',
    desc: 'Cells with an arrow count ALL mines in the direction they point \u2014 across the entire board.',
    longDesc: 'Compass cells show an arrow (\u2190\u2192\u2191\u2193) and a number. The number counts every mine in that direction across the full row or column. A "4\u2190" means there are 4 mines to the left in that row. Powerful global information, but you need to cross-reference it with local numbers.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(5,32px)"><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">1</div><div class="ge-cell revealed ge-compass" style="color:#ffa726;font-weight:900">3\u2190</div><div class="ge-cell revealed">2</div><div class="ge-cell unrevealed"></div></div><div class="ge-caption">"3\u2190" = 3 mines to the left in this row</div>',
  },
  // Sprite-only modifier: no `icon` emoji field, by design. Every icon
  // surface renders assets/sprites/mod-worm.svg; def.icon consumers carry
  // a missing-icon guard.
  worm: {
    intro: 101, name: 'Worm Tiles',
    desc: 'Some cells hide a worm egg. Revealing one hatches a worm that crawls over your numbers.',
    longDesc: 'A few safe cells hold a buried worm egg. Revealing one hatches a worm that wanders across your revealed cells, hiding the numbers it sits on for a moment. It prefers open ground and shies away from big numbers. It never changes the board and it can\'t hurt you: the numbers underneath stay exactly as they were, and the worm burrows away on its own. Remember what you read, or wait for it to move along.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell revealed">1</div><div class="ge-cell revealed ge-worm-covered">2<span class="ge-worm-seg"></span></div><div class="ge-cell revealed ge-worm-covered">1<span class="ge-worm-seg ge-worm-head"></span></div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">1</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">1</div><div class="ge-cell unrevealed"></div></div><div class="ge-caption">The worm hides numbers as it crawls. They come back when it moves on</div>',
  },
};

const SEEN_KEY = 'minesweeper_seen_gimmicks';
const POPUP_DISABLED_KEY = 'minesweeper_modifier_popup_disabled';

// ── Daily-safe gimmick subset ──
// The bar: the BOARD DATA must be static and canonical (no mine movement,
// no deadline that ends the game) so every player on the date plays the
// byte-identical layout. Excludes mineShift (mines move) and pressurePlate
// (a countdown can lose the game). Worm qualifies: its eggs are static
// canonical cells and the crawling worm is a render-time overlay that
// delays information without ever changing the board.
const DAILY_SAFE_GIMMICKS = ['mystery', 'locked', 'walls', 'liar', 'wormhole', 'mirror', 'sonar', 'compass', 'worm'];

// ── Modifier popup preference ──────────────────────────

export function isModifierPopupDisabled() {
  return safeGet(POPUP_DISABLED_KEY) === 'true';
}

export function setModifierPopupDisabled(disabled) {
  safeSet(POPUP_DISABLED_KEY, disabled ? 'true' : 'false');
}

// ── Daily gimmick selection (seeded, ~35% of days) ─────
// `forcedGimmick`, when provided and member of DAILY_SAFE_GIMMICKS,
// guarantees that gimmick is the primary on every seed — used by the
// adaptive-experiment path so the candidate-seed loop competes on
// target-cell count rather than presence.
//
// `singleOnly`, when true, suppresses the natural-rate second-gimmick
// roll. Used by coverage-mission slots in the multi-objective candidate
// selection: those slots are intentionally dedicated to a single
// undersampled feature, and adding a random second gimmick would
// muddy the signal we're trying to fill in.
//
// Default double-gimmick rate is 10% (down from the original 20%) —
// the coverage missions absorb most of the "make boards more varied"
// goal, so we don't need natural double-gimmick days to do as much
// of the work, and lower noise = cleaner per-feature deltas.
const DOUBLE_GIMMICK_PROB = 0.10;

export function getDailyGimmick(dailySeed, createRNG, forcedGimmick = null, singleOnly = false) {
  const rng = createRNG(dailySeed + '-gimmick');

  if (forcedGimmick && DAILY_SAFE_GIMMICKS.includes(forcedGimmick)) {
    const gimmicks = [forcedGimmick];
    if (!singleOnly && rng() < DOUBLE_GIMMICK_PROB) {
      const idx2 = Math.floor(rng() * DAILY_SAFE_GIMMICKS.length);
      if (DAILY_SAFE_GIMMICKS[idx2] !== forcedGimmick) {
        gimmicks.push(DAILY_SAFE_GIMMICKS[idx2]);
      }
    }
    return gimmicks;
  }

  if (rng() > 0.55) return []; // 45% of days: no gimmick
  const idx = Math.floor(rng() * DAILY_SAFE_GIMMICKS.length);
  const gimmicks = [DAILY_SAFE_GIMMICKS[idx]];
  if (!singleOnly && rng() < DOUBLE_GIMMICK_PROB) {
    const idx2 = Math.floor(rng() * DAILY_SAFE_GIMMICKS.length);
    if (DAILY_SAFE_GIMMICKS[idx2] !== gimmicks[0]) {
      gimmicks.push(DAILY_SAFE_GIMMICKS[idx2]);
    }
  }
  return gimmicks;
}

// Weekly puzzle: 2 or 3 modifiers stacked. Same daily-safe pool, picked
// without replacement so we never duplicate. Originally 2–4 but four
// stacked modifiers is technically solvable (the solver verifies it)
// but humanly miserable — recognising disjunctive liar constraints
// while tracking compass arrows and wormhole partners and wall-aware
// adjacency in the same play makes the board feel unsolvable even
// when it isn't. Capping at 3 is the playable ceiling.
export function getWeeklyGimmicks(weeklySeed, createRNG) {
  const rng = createRNG(weeklySeed + '-weekly-gimmicks');
  const count = 2 + Math.floor(rng() * 2); // 2 or 3
  const pool = [...DAILY_SAFE_GIMMICKS];
  const picked = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(rng() * pool.length);
    picked.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return picked;
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

  if (primaryGimmick) {
    // Inside some gimmick's 10-level intro block (L11-110 with worm as the
    // L101-110 capstone intro): primary is always present, secondary 60%,
    // tertiary 10%
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

  // L111-120: Post-intro ramp — all gimmicks equal, ramp to guaranteed 3
  const progress = (level - 110) / 10; // 0.1 at L111, 1.0 at L120
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

export function getIntensity(gimmick, level, rng) {
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
  // which are mutually exclusive with each other, then liar so it can stack
  // its offset on top of whatever base value is already assigned. Worm goes
  // LAST: eggs sit only on plain cells, so its candidate filter must see
  // every other gimmick already placed.
  const ORDER = [
    'walls', 'mineShift',
    'mystery', 'locked', 'pressurePlate',
    'wormhole', 'mirror', 'sonar', 'compass',
    'liar',
    'worm',
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
        // If walls are already on the board (challenge mode pre-applies
        // them so the constructive generator can build a wall-aware mine
        // layout), don't re-roll them — the new random walls would
        // invalidate the solver-verified board. Just keep the existing set.
        if (board._wallEdges && board._wallEdges.size > 0) {
          applied.walls = Array.from(board._wallEdges);
        } else {
          applied.walls = applyWalls(board, rows, cols, intensity, rng);
        }
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
      case 'worm':
        applied.worm = applyWorm(board, rows, cols, Math.min(intensity, WORM_MAX_PER_BOARD), rng);
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
//
// Exported because the solver needs it too: a cell whose number the player
// can never read must never become a certifier constraint (boardSolver's
// buildStaticGimmickConstraints).
export function hasDisplayBlockingGimmick(cell) {
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

// ── Worm Tiles: eggs that hatch crawling worms on reveal ──
// Eggs go on PLAIN numbered safe cells only — no mine, no other gimmick on
// the cell — so the post-hatch cell shows an ordinary number and the solver
// stays worm-blind. Runs LAST in ORDER, so every other gimmick's flags are
// already set when the filter runs. Hidden eggs render as normal cells (a
// telegraphed safe-only egg would leak "this cell is safe").
function applyWorm(board, rows, cols, count, rng) {
  const candidates = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (!cell.isMine && cell.adjacentMines > 0 &&
          !cell.isMystery && !cell.isPressurePlate && !cell.isLocked &&
          !cell.isLiar && !hasBaseValueGimmick(cell)) {
        candidates.push(cell);
      }
    }
  }
  shuffle(candidates, rng);
  const applied = [];
  for (let i = 0; i < Math.min(count, candidates.length); i++) {
    candidates[i].isWormEgg = true;
    applied.push({ row: candidates[i].row, col: candidates[i].col });
  }
  return applied;
}

// ── Locked Cells: can't reveal until all 8 neighbors revealed ──

function applyLocked(board, rows, cols, count, rng) {
  // Filter candidates whose unlock path is reachable. A locked cell
  // unlocks once all its non-mine wall-accessible neighbors are revealed.
  // If walls fully isolate a cell from any safe neighbor (mines only, or
  // every safe neighbor lives behind a wall), the cell can never unlock —
  // dead end for the player. Pre-filter out those placements so the
  // generator never ships an undeadlockable locked cell.
  //
  // Walls are applied before locked in ORDER, so the cache is final here.
  // buildNeighborCache walks dr/dc in the same order the hand-rolled loop
  // did, so candidates land in the same sequence and the seeded shuffle
  // consumes the RNG identically — same board, same seed, as before.
  const nbrs = buildNeighborCache(board, rows, cols);
  const explicitTopology = !!board._cellNeighbors;
  const candidates = [];
  for (let i = 0; i < rows * cols; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    // Rectangular boards keep the interior-only rule verbatim. On an explicit
    // topology it means nothing: the container's border is an arbitrary set of
    // cells with respect to the graph (and on a degenerate N x 1 container it
    // is EVERY cell, so locked would silently place nothing at all). The
    // accessible-safe-neighbor test below is the constraint that actually
    // matters, and it applies either way.
    if (!explicitTopology && (r === 0 || r === rows - 1 || c === 0 || c === cols - 1)) continue;
    const cell = board[r][c];
    // Allow mines AND numbered cells to be locked
    if (!(cell.isMine || cell.adjacentMines > 0)) continue;
    // Confirm at least one accessible safe neighbor exists. Walls are already
    // absent from the neighbor list, so only mines need filtering here.
    if (!nbrs[i].some((ni) => !cellAt(board, cols, ni).isMine)) continue;
    candidates.push(cell);
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

export function applyLiar(board, rows, cols, count, rng) {
  // Liar runs LAST in applyGimmicks (stacking rules), so no cell is isLiar
  // yet — running the recompute here fills every cell's PRE-LIE display
  // value (sonar/compass region counts, wormhole pair sums, mirror swaps),
  // exactly the base the final recompute will stack the offset on. The old
  // hand-rolled base closure read cell.sonarCount / cell.compassCount —
  // fields ONLY recomputeDisplayedMines populates — so the base-≥2 guard
  // below silently evaluated raw adjacentMines for sonar/compass cells. A
  // compass with a 0-mine ray but ≥2 adjacent mines then took offset −1 and
  // clamped to displayed 0 = the TRUE value: a liar that tells the truth,
  // breaking the ±1 contract every player deduction on the cell rests on.
  recomputeDisplayedMines(board);
  const baseValue = (cell) => (cell.displayedMines != null ? cell.displayedMines : cell.adjacentMines);

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

export function computeLiarZone(board, rows, cols) {
  // On a TILING the container's (row, col) is pure storage — it says nothing
  // about what a cell touches — so a coordinate walk marks cells that are not
  // the liar's neighbours and misses ones that are. Follow the board's own
  // neighbour graph instead (walls there are simply absent edges).
  if (board._cellNeighbors) {
    const cache = buildNeighborCache(board, rows, cols);
    const total = rows * cols;
    for (let i = 0; i < total; i++) {
      const cell = cellAt(board, cols, i);
      if (!cell || !cell.isLiar) continue;
      cell.inLiarZone = true;
      for (const ni of cache[i]) cellAt(board, cols, ni).inLiarZone = true;
    }
    return;
  }

  // Rectangular boards keep the literal 8-neighbourhood walk VERBATIM. It is
  // deliberately wall-BLIND: the zone is a spatial cue ("numbers around here are
  // unreliable"), not an adjacency claim, and a liar's tint has always spilled
  // across a wall. Routing this through the wall-aware buildNeighborCache would
  // silently restyle every walled square board.
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

// ── Walls: edges between adjacent cells ──────────────

// Walls on a TILING (Coastline Phase 2): a wall SEVERS an edge from the
// neighbor graph — both directions, so symmetry holds — in contiguous "reef"
// chains that snake between cells. The certifier and recalcAllAdjacency then see
// a graph with fewer edges and need NO wall logic at all: a severed link is
// simply absent (the memory's "walls baked into the neighbor list"), with none
// of the rectangular diagonal ambiguity and no "r,c-r,c" string contract. The
// removed pairs ride a render-only board._tilingWalls so the renderer can draw a
// bar on each shared edge. Isolation is all-or-nothing, like the rectangular
// path: a wall set that disconnects the board ships as no walls.
function applyWallsTiling(board, rows, cols, segmentCount, rng) {
  const total = rows * cols;
  // The wireframe gives every cell-boundary edge tagged with the two cells it
  // separates, so a wall is a CONTINUOUS run of edges sharing vertices — the
  // bars connect end to end, and each sits on the TRUE shared boundary
  // (including the 45° octagon/square edges).
  // Rebuild the SAME tiling the board was generated on — the wireframe (and so
  // every wall segment) is geometry-specific, and a 4.8.8 wireframe over a
  // honeycomb would draw walls on edges that do not exist.
  const tiling = buildTiling(board._tiling.type, board._tiling.M, board._tiling.N);
  const { edges, vertEdges } = buildWireframe(tiling);
  const verts = tiling.verts;

  const adj = board._cellNeighbors.map(l => l.slice()); // working copy of the full topology
  const usedEdge = new Set();
  const wallEdges = []; // committed walls: { a, b, x1, y1, x2, y2 } in unit coords

  const isConnected = () => {
    const seen = new Uint8Array(total);
    const stack = [0]; seen[0] = 1; let count = 1;
    while (stack.length) {
      const u = stack.pop();
      for (const v of adj[u]) if (!seen[v]) { seen[v] = 1; count++; stack.push(v); }
    }
    return count === total;
  };

  // Grow a continuous polyline of boundary edges from a start edge, following
  // shared vertices (with a little branching where a vertex offers a choice).
  const grow = (startEi, length) => {
    const chain = [startEi];
    let tip = edges[startEi].v2;
    for (let i = 1; i < length; i++) {
      const opts = (vertEdges.get(tip) || []).filter(e => !usedEdge.has(e) && !chain.includes(e));
      if (opts.length === 0) break;
      const nextEi = opts[Math.floor(rng() * opts.length)];
      const e = edges[nextEi];
      tip = (e.v1 === tip) ? e.v2 : e.v1;
      chain.push(nextEi);
    }
    return chain;
  };

  const numWalls = Math.min(1 + Math.floor(segmentCount / 2), 3); // 1-3 continuous walls
  for (let w = 0; w < numWalls; w++) {
    const avail = [];
    for (let ei = 0; ei < edges.length; ei++) if (!usedEdge.has(ei)) avail.push(ei);
    if (avail.length === 0) break;
    const start = avail[Math.floor(rng() * avail.length)];
    const length = 3 + Math.floor(rng() * (2 + Math.min(segmentCount, 3))); // 3-7 edges
    const chain = grow(start, length);

    // Tentatively sever the chain; keep it only if the board stays connected.
    const applied = [];
    for (const ei of chain) {
      const e = edges[ei];
      adj[e.cellA] = adj[e.cellA].filter(x => x !== e.cellB);
      adj[e.cellB] = adj[e.cellB].filter(x => x !== e.cellA);
      applied.push(ei);
    }
    if (isConnected()) {
      for (const ei of applied) {
        usedEdge.add(ei);
        const e = edges[ei];
        const p1 = verts[e.v1], p2 = verts[e.v2];
        wallEdges.push({ a: e.cellA, b: e.cellB, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
      }
    } else {
      // Undo this wall — restore its severed edges (order-independent for the solver).
      for (const ei of applied) {
        const e = edges[ei];
        adj[e.cellA].push(e.cellB);
        adj[e.cellB].push(e.cellA);
      }
    }
  }

  if (wallEdges.length > 0) {
    defineCellNeighbors(board, rows, cols, adj); // re-validate symmetry, then stamp
    board._tilingWalls = wallEdges;
  } else {
    board._tilingWalls = [];
  }
  // Numbers must reflect the reduced topology (a mine across a severed edge no
  // longer counts) — recalcAllAdjacency reads the board's own neighbor list.
  recalcAllAdjacency(board);
  return board._tilingWalls.map(w => `${Math.min(w.a, w.b)}-${Math.max(w.a, w.b)}`);
}

export function applyWalls(board, rows, cols, segmentCount, rng) {
  // A tiling declares its topology explicitly; walls there sever graph edges
  // rather than build the rectangular "r,c-r,c" edge set + diagonal rule.
  if (board._cellPos) return applyWallsTiling(board, rows, cols, segmentCount, rng);

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
  // If walls partition the board, clear ALL walls (the isolation check
  // below is all-or-nothing — it does not retry with fewer segments).
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

  // ALWAYS recalculate adjacency. Even when walls were cleared by the
  // isolation check above, the board's adjacency may already reflect a
  // PRIOR set of walls (from a constructive-generator call or an earlier
  // applyWalls). Skipping the recalc here leaves stale wall-aware counts
  // — cells would show fewer mines than actually surround them, and
  // chord would refuse to fire because counts don't match flags.
  recalcAllAdjacency(board);

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
  // Same ordering guarantee as applyLocked: the cache walks dr/dc in the order
  // the hand-rolled partner search did, so partners are collected in the same
  // sequence and rng() picks the same one.
  const nbrs = buildNeighborCache(board, rows, cols);

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
    // "Adjacent" is the board's own topology, so a mirror pair on a tiling is
    // two cells that genuinely touch. Walls are already absent from the list.
    const partners = [];
    for (const ni of nbrs[a.row * cols + a.col]) {
      const b = cellAt(board, cols, ni);
      if (b.isMine || b.adjacentMines <= 0) continue;
      if (hasBaseValueGimmick(b) || hasDisplayBlockingGimmick(b)) continue;
      if (used.has(`${b.row},${b.col}`)) continue;
      if (b.adjacentMines === a.adjacentMines) continue; // swap would be a no-op
      partners.push(b);
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
    recalcAllAdjacency(board);
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

// Eight directions for a tiling compass (Coastline Phase 2): the four
// orthogonal octagon axes plus the four diagonals (which alternate octagon and
// square). dx/dy are geometric (dx = +col, dy = +row). The ray itself is
// computed from cell POSITIONS and stored on the cell, so display and certifier
// read the same list — see computeCompassRay / compassRayCells.
const COMPASS_DIRS_8 = [
  { arrow: '←', dx: -1, dy: 0 },
  { arrow: '→', dx: 1, dy: 0 },
  { arrow: '↑', dx: 0, dy: -1 },
  { arrow: '↓', dx: 0, dy: 1 },
  { arrow: '↖', dx: -1, dy: -1 },
  { arrow: '↗', dx: 1, dy: -1 },
  { arrow: '↙', dx: -1, dy: 1 },
  { arrow: '↘', dx: 1, dy: 1 },
];

// A honeycomb has SIX straight lines of cell centers, not eight: the horizontal
// row plus the four half-step diagonals. There is deliberately no due-north or
// due-south ray on a pointy-top hex lattice, because the row above is offset by
// half a hex and no column of centers runs vertically. dy uses the real row
// spacing (sqrt(3)/2 pitch units) so the ray direction IS the lattice axis.
const COMPASS_DIRS_HEX = [
  { arrow: '←', dx: -1, dy: 0 },
  { arrow: '→', dx: 1, dy: 0 },
  { arrow: '↖', dx: -0.5, dy: -HEX_ROW_H },
  { arrow: '↗', dx: 0.5, dy: -HEX_ROW_H },
  { arrow: '↙', dx: -0.5, dy: HEX_ROW_H },
  { arrow: '↘', dx: 0.5, dy: HEX_ROW_H },
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
  const tiling = !!board._cellPos;
  const applied = [];
  for (let i = 0; i < Math.min(count, candidates.length); i++) {
    const cell = candidates[i];
    if (tiling) {
      // Pick a geometric direction whose ray is non-trivial (>= 2 cells) —
      // else the longest available — and store the precomputed ray. The cell's
      // number then counts mines along exactly this stored list.
      const idx = cell.row * cols + cell.col;
      // Direction set follows the lattice: 8 for 4.8.8, the 6 hex axes for a
      // honeycomb (a due-north ray would hit nothing there).
      const dirs = (board._tiling?.type === 'hex' ? COMPASS_DIRS_HEX : COMPASS_DIRS_8).slice();
      shuffle(dirs, rng);
      // The FIRST compass cell prefers a diagonal (octagon/square staircase ray)
      // so any compass board reliably shows that distinctive tiling ray at least
      // once; later cells stay fully random. Stable sort keeps the shuffle order
      // within each group.
      if (i === 0) {
        const isDiag = (d) => (d.dx !== 0 && d.dy !== 0 ? 1 : 0);
        dirs.sort((x, y) => isDiag(y) - isDiag(x));
      }
      let best = null, bestRay = null;
      for (const d of dirs) {
        const ray = computeCompassRay(board._cellPos, idx, d.dx, d.dy);
        if (ray.length >= 2) { best = d; bestRay = ray; break; }
        if (!best || ray.length > bestRay.length) { best = d; bestRay = ray; }
      }
      cell.isCompass = true;
      cell.compassDir = { dr: best.dy, dc: best.dx };
      cell.compassArrow = best.arrow;
      cell.compassRay = bestRay;
      applied.push({ row: cell.row, col: cell.col, arrow: best.arrow });
    } else {
      const dir = COMPASS_DIRS[Math.floor(rng() * COMPASS_DIRS.length)];
      cell.isCompass = true;
      cell.compassDir = dir;
      cell.compassArrow = dir.arrow;
      // compassCount + displayedMines are set by recomputeDisplayedMines
      applied.push({ row: cell.row, col: cell.col, arrow: dir.arrow });
    }
  }
  return applied;
}

// ── Locked Cell Check ──────────────────────────────────

export function isLockedCell(board, row, col, neighborCache) {
  const cell = board[row][col];
  if (!cell.isLocked) return false;

  const rows = board.length;
  const cols = board[0].length;

  // Reads the board's topology, so a locked cell on a tiling polls the cells
  // it actually touches. This must agree with the certifier's own unlock model
  // (canUnlock in boardSolver.js, which has always read the neighbor cache) —
  // if the two disagree, the solver certifies an unlock order the live game
  // will not perform. A severed wall edge is simply absent from the list,
  // which is the same "treat as satisfied" the coordinate walk spelled out.
  //
  // Pass a cache when calling in a loop; bare it derives the whole board's
  // lists per call. Both current callers are single-cell click checks.
  const nbrs = (neighborCache || buildNeighborCache(board, rows, cols))[row * cols + col];
  for (const ni of nbrs) {
    const neighbor = cellAt(board, cols, ni);
    // Mines and other locked cells don't block unlock
    // (prevents circular deadlock between adjacent locked cells)
    if (!neighbor.isRevealed && !neighbor.isMine && !neighbor.isLocked) return true; // Still locked
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

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (cell.isMine) continue;

      // ── Pass 1: base value ─────────────────────────────
      let base;
      if (cell.isSonar) {
        // Region geometry lives in adjacency.js so the certifier's copy of
        // this scan cannot drift from the number actually displayed here.
        let count = 0;
        for (const ni of sonarScanCells(board, rows, cols, r, c)) {
          if (cellAt(board, cols, ni).isMine) count++;
        }
        cell.sonarCount = count;
        base = count;
      } else if (cell.isCompass && cell.compassDir) {
        let count = 0;
        for (const ni of compassRayCells(board, rows, cols, r, c, cell.compassDir)) {
          if (cellAt(board, cols, ni).isMine) count++;
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

// ── Adjacency: ONE counter, one convention ────────────────
// Every adjacency recompute in the codebase routes through these two
// functions. Four hand-rolled copies of the neighbor loop used to exist
// (boardGenerator.calculateAdjacency, this one, and two in powerUps), and
// they disagreed on the MINE branch: some skipped mine cells, leaving a
// stale count on a cell swapMines had promoted from safe to mine. That
// stale value serialized into a canonical and the nightly verify sweep
// flagged it (dailyBoard/2026-07-16, caught 2026-07-10).
//
// The convention, in one place: a mine carries no number, so its
// adjacentMines is ALWAYS 0.

// Wall-aware count of the mines adjacent to (r, c). Walls block adjacency,
// so a mine across a wall edge does not count.
// Counts the mines a cell can see, through the board's own topology.
//
// `neighborCache` is optional but should be passed by any caller in a loop:
// without it every call derives the whole board's neighbor lists, turning an
// O(cells) sweep into O(cells²).
export function countAdjacentMines(board, r, c, neighborCache) {
  const rows = board.length;
  const cols = board[0].length;
  const nbrs = (neighborCache || buildNeighborCache(board, rows, cols))[r * cols + c];
  let count = 0;
  for (const ni of nbrs) {
    if (board[(ni / cols) | 0][ni % cols].isMine) count++;
  }
  return count;
}

// Recompute adjacentMines for every cell on the board.
export function recalcAllAdjacency(board) {
  const rows = board.length;
  const cols = board[0].length;
  const nbrCache = buildNeighborCache(board, rows, cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      board[r][c].adjacentMines = board[r][c].isMine ? 0 : countAdjacentMines(board, r, c, nbrCache);
    }
  }
}
