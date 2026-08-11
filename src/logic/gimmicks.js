// ── Gimmick System ──────────────────────────────────────
// 7 gimmicks introduced at checkpoints after L10.
// Each gimmick has: apply (board setup), render hints, solver adjustments.

import { safeGet, safeSet, safeGetJSON, safeSetJSON } from '../storage/storageAdapter.js';
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

// ── Modifier copy: the rules, not one board's version of them ──────────────
//
// `desc` is the permanent reference (the Modifiers help tab renders it),
// `longDesc` is the first-encounter card, and `exampleHtml` is that card's
// diagram. All three are player copy, so all three take ZERO em-dashes and no
// en-dashes.
//
// Every sentence here must be true on EVERY shape. That is not a style
// preference: the Challenge 250 venue rule debuts six of the nine modifiers
// on a tiling (locked and worm on the Honeycomb, wormhole and compass on
// Octagons, mirror on 3D Cubes, sonar on Paving Stones), so a rectangular
// claim is a wrong claim at the moment the player first reads it. Sonar used to
// promise "a 5×5 area centered on the cell" and compass "4 mines to the left
// in that row"; neither survives contact with a lattice that has no rows.
//
// Where a shape genuinely changes the answer (how many directions a compass
// has, what "two steps out" looks like), the copy names the Classic case as
// the concrete anchor and states the general rule alongside it, rather than
// forking into per-shape strings. `exampleHtml` is the ONE per-shape fork: it
// stays the square diagram, and a tiling board swaps in a real patch of its
// own lattice from logic/modifierExample.js.
//
// Any count stated here is measured against the geometry by
// test/modifierCopy.test.mjs, the same discipline shapeIntro.js follows.
const GIMMICK_DEFS = {
  walls: {
    intro: 11, name: 'Walls', icon: '🧱',
    desc: 'Walls sit between two cells and stop each one counting the other.',
    longDesc: 'A wall is a thick line along the boundary between two cells. Numbers on either side of it never count mines across it, so treat a wall like the edge of the board: it splits the board into sections you work through separately.',
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
    desc: 'Unflagged mines creep to a neighboring cell every few seconds. Flagged mines stay put!',
    longDesc: 'A mine you have not flagged will creep to a cell it shares an edge with, one step at a time, every few seconds. The numbers update as it goes. Flag a mine to pin it in place: a flagged mine never moves.',
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
    desc: 'Paired cells share one number: the SUM of both cells\' real neighbor counts.',
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
    desc: 'Some cells start a countdown when revealed. Reveal all their safe neighbors before time runs out!',
    longDesc: 'Pressure plate cells show their number like normal, but a countdown timer starts when revealed. You must reveal every non-mine neighbor before time runs out or the plate detonates. Solve the area around the plate fast!',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell revealed">1</div><div class="ge-cell revealed ge-pressure" style="box-shadow:inset 0 0 6px rgba(255,50,50,0.5)">2<img class="ge-piece" src="assets/sprites/mod-pressure.svg" alt=""></div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">1</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">0</div></div><div class="ge-caption">Reveal all safe cells around the plate before the timer runs out!</div>',
  },
  sonar: {
    intro: 81, name: 'Sonar', icon: '📡',
    desc: 'Sonar cells count every mine within two steps of them, not just their immediate neighbors.',
    longDesc: 'A sonar cell reaches two steps out in every direction, so it covers far more ground than an ordinary number and its count runs higher. On a Classic board that is the 5x5 block around it, and on the other board shapes it is every cell you can get to in two moves. Tap a revealed sonar cell to light up exactly which cells it counts.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(3,32px)"><div class="ge-cell revealed">1</div><div class="ge-cell revealed ge-sonar" style="color:#26c6da;font-weight:900"><img class="ge-piece" src="assets/sprites/mod-sonar.svg" alt="">5</div><div class="ge-cell revealed">2</div><div class="ge-cell revealed">1</div><div class="ge-cell revealed">1</div><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">0</div><div class="ge-cell revealed">0</div><div class="ge-cell unrevealed"></div></div><div class="ge-caption">On a Classic board that is the 5\u00d75 block: this "5" counts 5 mines inside it</div>',
  },
  compass: {
    intro: 91, name: 'Compass', icon: '🧭',
    desc: 'Cells with an arrow count every mine in a straight line the way they point, out to the edge of the board.',
    longDesc: 'A compass cell shows an arrow and a number. The number counts every mine along the straight line the arrow points down, out to the edge of the board, and nothing off that line. On a Classic board it has four directions, along the rows and columns. On the other board shapes it has six or eight, some of them running at an angle. Tap a revealed compass cell to light up the line it counts.',
    exampleHtml: '<div class="gimmick-example-grid" style="grid-template-columns:repeat(5,32px)"><div class="ge-cell unrevealed"></div><div class="ge-cell revealed">1</div><div class="ge-cell revealed ge-compass" style="color:#ffa726;font-weight:900">3\u2190</div><div class="ge-cell revealed">2</div><div class="ge-cell unrevealed"></div></div><div class="ge-caption">"3\u2190" = 3 mines to the left in this row</div>',
  },
  // Sprite-only modifier: no `icon` emoji field, by design. Every icon
  // surface renders assets/sprites/mod-worm.svg; def.icon consumers carry
  // a missing-icon guard.
  worm: {
    intro: 101, name: 'Worm Tiles',
    desc: 'Some cells hide a worm egg. Revealing one hatches a worm that crawls over your numbers.',
    longDesc: 'A few safe cells hold a buried worm egg. Revealing one hatches a worm that crawls across your revealed cells, one step at a time onto a cell it shares an edge with, hiding the numbers it sits on as it goes. It prefers open ground and shies away from big numbers. It can\'t hurt you and it never changes the board, so remember what you read or wait for it to move along.',
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
// Exported for the shape-rotation lockstep guard (test/shapeRotation.test.mjs):
// every entry here must also be in tilingGenerator's TILING_SAFE_GIMMICKS, or a
// daily mission could name a gimmick a tiling day cannot honor.
export const DAILY_SAFE_GIMMICKS = ['mystery', 'locked', 'walls', 'liar', 'wormhole', 'mirror', 'sonar', 'compass', 'worm'];

// ── Modifier popup preference ──────────────────────────

export function isModifierPopupDisabled() {
  return safeGet(POPUP_DISABLED_KEY) === 'true';
}

export function setModifierPopupDisabled(disabled) {
  safeSet(POPUP_DISABLED_KEY, disabled ? 'true' : 'false');
}

// ── Daily gimmick selection (seeded, ~35% of days) ─────
// `forcedGimmick`, when provided and member of DAILY_SAFE_GIMMICKS,
// guarantees that gimmick is the primary on every seed, used by the
// adaptive-experiment path so the candidate-seed loop competes on
// target-cell count rather than presence.
//
// `singleOnly`, when true, suppresses the natural-rate second-gimmick
// roll. Used by coverage-mission slots in the multi-objective candidate
// selection: those slots are intentionally dedicated to a single
// undersampled feature, and adding a random second gimmick would
// muddy the signal we're trying to fill in.
//
// Default double-gimmick rate is 10% (down from the original 20%),
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
// without replacement so we never duplicate. Originally 2-4 but four
// stacked modifiers is technically solvable (the solver verifies it)
// but humanly miserable, recognizing disjunctive liar constraints
// while tracking compass arrows and wormhole partners and wall-aware
// adjacency in the same play makes the board read as unsolvable even
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

// (getGimmicksForLevel, the old ladder's per-level modifier lottery, was
// retired with the sawtooth: Challenge 250 specs AUTHOR their modifier
// sets in challenge250.js, and no board on the ladder rolls a random
// secondary. GIMMICK_DEFS[].intro survives as getIntensity's ramp anchor
// and the help/popup metadata.)

// ── Chaos mode: random gimmick selection (includes all types) ──

export function getChaosGimmicks(count, rng = Math.random) {
  const allTypes = Object.keys(GIMMICK_DEFS);
  const shuffled = [...allTypes].sort(() => rng() - 0.5);
  return shuffled.slice(0, Math.min(count, allTypes.length));
}

// ── Gimmick intensity (count of affected cells) ────────

// The intensity ramp's ceiling, FROZEN at the old 120-level ladder's top.
// getIntensity's whole scale, the per-type intro positions above and this
// cap, is the UNIT the Challenge 250 spec tables author their
// `gimmickLevel` dial in (11..120, "old-ladder levels"): the proven Paving
// T12 spec was measured at level 115 on exactly this scale, and every
// authored ladder spec was validated against it. Re-anchoring this to the
// 250-level ladder would silently re-price every one of them, which is why
// it is a local constant here rather than the ladder length import it used
// to be.
const INTENSITY_RAMP_MAX_LEVEL = 120;

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

  // After introduction: slowly ramp toward the (frozen) ramp ceiling
  const progress = (level - introEnd) / (INTENSITY_RAMP_MAX_LEVEL - introEnd);
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
        // layout), don't re-roll them, the new random walls would
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
        // HOW MANY move is the difficulty dial (his ruling 2026-08-04:
        // "multiple mines can move, if the difficulty rolls that way").
        // getIntensity is the ladder-wide intensity ramp every other modifier
        // reads, so mineShift now scales the same way they do instead of
        // being a flat 1-or-2 forever.
        applied.mineShift = {
          interval: MINESHIFT_MIN_SECONDS
            + Math.floor(rng() * (MINESHIFT_MAX_SECONDS - MINESHIFT_MIN_SECONDS + 1)),
          count: Math.max(1, Math.min(intensity, MINESHIFT_MAX_MOVERS)),
        };
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

  // Single source of truth for displayed numbers, runs after every gimmick
  // has marked its cells, so liar offsets stack correctly on top of
  // wormhole/mirror/sonar/compass base values.
  recomputeDisplayedMines(board);

  return applied;
}

// True if a cell already owns the base displayed number (i.e. any other
// base-value gimmick must not be placed on it). Liar is NOT in this list,
// liar stacks on top of a base value via its offset.
function hasBaseValueGimmick(cell) {
  return cell.isWormhole || !!cell.mirrorPair || cell.isSonar || cell.isCompass;
}

// True if the cell's displayed value is replaced by something other than a
// mine-count number, stacking a base-value gimmick on top would be wasted.
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
// Eggs go on PLAIN numbered safe cells only, no mine, no other gimmick on
// the cell, so the post-hatch cell shows an ordinary number and the solver
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
  // every safe neighbor lives behind a wall), the cell can never unlock,
  // dead end for the player. Pre-filter out those placements so the
  // generator never ships an undeadlockable locked cell.
  //
  // Walls are applied before locked in ORDER, so the cache is final here.
  // buildNeighborCache walks dr/dc in the same order the hand-rolled loop
  // did, so candidates land in the same sequence and the seeded shuffle
  // consumes the RNG identically, same board, same seed, as before.
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
  // yet, running the recompute here fills every cell's PRE-LIE display
  // value (sonar/compass region counts, wormhole pair sums, mirror swaps),
  // exactly the base the final recompute will stack the offset on. The old
  // hand-rolled base closure read cell.sonarCount / cell.compassCount,
  // fields ONLY recomputeDisplayedMines populates, so the base-≥2 guard
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
      // Liar cannot share a cell with anything that masks the number.
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
  // On a TILING the container's (row, col) is pure storage, it says nothing
  // about what a cell touches, so a coordinate walk marks cells that are not
  // the liar's neighbors and misses ones that are. Follow the board's own
  // neighbor graph instead (walls there are just absent edges).
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

  // Rectangular boards keep the literal 8-neighborhood walk VERBATIM. It is
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
// neighbor graph, both directions, so symmetry holds, in contiguous "reef"
// chains that snake between cells. The certifier and recalcAllAdjacency then see
// a graph with fewer edges and need NO wall logic at all: a severed link is
// just absent (the memory's "walls baked into the neighbor list"), with none
// of the rectangular diagonal ambiguity and no "r,c-r,c" string contract. The
// removed pairs ride a render-only board._tilingWalls so the renderer can draw a
// bar on each shared edge. Isolation is all-or-nothing, like the rectangular
// path: a wall set that disconnects the board ships as no walls.

// A WALL BLOCKS THE CELLS WHOSE SIGHT LINE IT CROSSES (his rule, 2026-08-07,
// playing 3D Cubes at L87: a cell read 5 where it should have read less,
// "because corners shouldn't see through a wall").
//
// THE RULE, in his words: "If a line drawn from the center of one cell to
// another is bisected by a wall, those two cells aren't connected." Whether two
// cells see past a corner depends on the ANGLE between them, not merely on
// whether they touch: two facing each other across an open corner still see one
// another, two that would have to curve around the wall do not.
//
// What it replaces. Corner-inclusive adjacency makes cells meeting at a single
// VERTEX neighbors, but buildWireframe emits an edge only for a pair sharing
// TWO vertices, so severing wireframe edges left every corner contact intact
// and a wall drawn through the corner still counted mines across itself.
// Measured over 12 walled boards for each shape beforehand: EVERY board on all four
// Laves tilings was affected, 464 see-through corner links, 165 of them feeding
// a wrong clue (rhombille worst at 77). The certifier reads the same adjacency,
// so those boards certified as no-guess and were self-consistent while being
// unsolvable for a person reasoning from the wall in front of them, which is
// the worst shape this class of bug takes.
//
// One rule covers both kinds of neighbor, which is why it is written this way
// rather than as a special case bolted onto edge severing: an edge neighbor's
// sight line crosses its own shared boundary, so a wall there blocks it by the
// same test, and the previous behavior falls out instead of being preserved
// by hand.
//
// 4.8.8 and the honeycomb are untouched, structurally rather than luckily: both
// are trivalent, so they have no vertex-only pairs, and their edge neighbors
// sever exactly as before. Verified byte-identical.

const _SIGHT_EPS = 1e-9;

const _cross = (ox, oy, ax, ay, bx, by) => (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);

/**
 * Does segment p1-p2 cross segment q1-q2? Endpoint contact COUNTS: a sight line
 * that runs exactly through the tip of a wall is grazing it, and a player
 * reading the board sees the wall in the way.
 */
function _segmentsCross(p1, p2, q1, q2) {
  const d1 = _cross(q1.x, q1.y, q2.x, q2.y, p1.x, p1.y);
  const d2 = _cross(q1.x, q1.y, q2.x, q2.y, p2.x, p2.y);
  const d3 = _cross(p1.x, p1.y, p2.x, p2.y, q1.x, q1.y);
  const d4 = _cross(p1.x, p1.y, p2.x, p2.y, q2.x, q2.y);
  const s1 = Math.abs(d1) < _SIGHT_EPS ? 0 : Math.sign(d1);
  const s2 = Math.abs(d2) < _SIGHT_EPS ? 0 : Math.sign(d2);
  const s3 = Math.abs(d3) < _SIGHT_EPS ? 0 : Math.sign(d3);
  const s4 = Math.abs(d4) < _SIGHT_EPS ? 0 : Math.sign(d4);
  if (s1 * s2 > 0 || s3 * s4 > 0) return false;
  if (s1 || s2 || s3 || s4) return true;
  // Collinear: overlap on the shared line is a block, a mere extension is not.
  const on = (a, b, c) => Math.min(a.x, b.x) - _SIGHT_EPS <= c.x && c.x <= Math.max(a.x, b.x) + _SIGHT_EPS
    && Math.min(a.y, b.y) - _SIGHT_EPS <= c.y && c.y <= Math.max(a.y, b.y) + _SIGHT_EPS;
  return on(p1, p2, q1) || on(p1, p2, q2) || on(q1, q2, p1) || on(q1, q2, p2);
}

/**
 * Neighbor links whose sight line a set of walled edges crosses.
 *
 * @param {object} tiling            the built tiling
 * @param {Array}  edges             buildWireframe edges
 * @param {Array<number[]>} adjacency the FULL (unwalled) neighbor lists
 * @param {Iterable<number>} walledEdgeIdx indices into `edges`
 * @returns {Array<[number, number]>} cell pairs to sever
 */
export function sightLineCuts(tiling, edges, adjacency, walledEdgeIdx) {
  const walls = [];
  for (const ei of walledEdgeIdx) {
    const e = edges[ei];
    walls.push([tiling.verts[e.v1], tiling.verts[e.v2]]);
  }
  if (!walls.length) return [];
  const cuts = [];
  for (let a = 0; a < adjacency.length; a++) {
    const pa = tiling.cellPos[a];
    for (const b of adjacency[a]) {
      if (b <= a) continue;                       // each pair once
      const pb = tiling.cellPos[b];
      const p1 = { x: pa.cx, y: pa.cy };
      const p2 = { x: pb.cx, y: pb.cy };
      for (const [q1, q2] of walls) {
        if (_segmentsCross(p1, p2, q1, q2)) { cuts.push([a, b]); break; }
      }
    }
  }
  return cuts;
}

function applyWallsTiling(board, rows, cols, segmentCount, rng) {
  const total = rows * cols;
  // The wireframe gives every cell-boundary edge tagged with the two cells it
  // separates, so a wall is a CONTINUOUS run of edges sharing vertices, the
  // bars connect end to end, and each sits on the TRUE shared boundary
  // (including the 45° octagon/square edges).
  // Rebuild the SAME tiling the board was generated on, the wireframe (and so
  // every wall segment) is geometry-specific, and a 4.8.8 wireframe over a
  // honeycomb would draw walls on edges that do not exist.
  const tiling = buildTiling(board._tiling.type, board._tiling.M, board._tiling.N);
  const { edges, vertEdges } = buildWireframe(tiling);
  const verts = tiling.verts;

  const full = board._cellNeighbors.map(l => l.slice());   // the untouched topology
  let adj = full.map(l => l.slice());
  const usedEdge = new Set();
  const wallEdges = []; // committed walls: { a, b, x1, y1, x2, y2 } in unit coords

  // Severing is recomputed from the WHOLE walled set each time rather than
  // applied incrementally, because a corner cut depends on how many walls meet
  // at a vertex: a later chain can be the second wall at a vertex an earlier
  // one only touched, and that pair only becomes severable once both exist.
  const severAll = (walledEdgeIdx) => {
    const out = full.map(l => l.slice());
    const drop = (a, b) => {
      out[a] = out[a].filter(x => x !== b);
      out[b] = out[b].filter(x => x !== a);
    };
    // ONE test for both kinds of neighbor. An edge neighbor's sight line
    // crosses its own shared boundary, so a wall on that boundary blocks it by
    // the same rule that blocks a corner contact, and the old edge-severing
    // behavior falls out rather than being kept by hand.
    for (const pair of sightLineCuts(tiling, edges, full, walledEdgeIdx)) drop(pair[0], pair[1]);
    return out;
  };

  const isConnectedOn = (g) => {
    const seen = new Uint8Array(total);
    const stack = [0]; seen[0] = 1; let count = 1;
    while (stack.length) {
      const u = stack.pop();
      for (const v of g[u]) if (!seen[v]) { seen[v] = 1; count++; stack.push(v); }
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

    // Tentatively sever the chain, corner contacts included; keep it only if
    // the board stays connected. Connectivity is judged on the SEVERED graph,
    // so a chain whose corner cuts would strand a cell is refused along with
    // the rest of it, which is what keeps the all-or-nothing contract honest
    // now that a wall removes more than its own edges.
    // A chain that disconnects the board is TRIMMED before it is abandoned.
    // Severing sight lines removes more links than severing edges did, so a
    // full-length chain strands a cell more often, and the all-or-nothing
    // contract then shipped the board with no walls at all: measured, cairo
    // kept walls on only 8 of 12 boards where it had kept them on all 12.
    // Walking the chain back one edge at a time recovers a shorter wall
    // instead, which is a better answer than none and keeps the contract
    // intact, since whatever survives is still applied whole.
    let keep = chain;
    let trial = severAll([...usedEdge, ...keep]);
    while (keep.length > 1 && !isConnectedOn(trial)) {
      keep = keep.slice(0, -1);
      trial = severAll([...usedEdge, ...keep]);
    }
    if (isConnectedOn(trial)) {
      adj = trial;
      for (const ei of keep) {
        usedEdge.add(ei);
        const e = edges[ei];
        const p1 = verts[e.v1], p2 = verts[e.v2];
        wallEdges.push({ a: e.cellA, b: e.cellB, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
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
  // longer counts), recalcAllAdjacency reads the board's own neighbor list.
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
        // Edge between (r, c) and (r+1, c), horizontal wall at this column
        if (r >= 0 && r < rows - 1 && c >= 0 && c < cols) {
          key = wallKey(r, c, r + 1, c);
        }
        c += dir; // extend along columns
      } else {
        // Edge between (r, c) and (r, c+1), vertical wall at this row
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

  // Verify walls don't create isolated regions, every cell must be
  // reachable from every other cell through wall-respecting paths.
  // If walls partition the board, clear ALL walls (the isolation check
  // below is all-or-nothing, it does not retry with fewer segments).
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
  // applyWalls). Skipping the recalc here leaves stale wall-aware counts:
  // cells would show fewer mines than actually surround them, and
  // chord would refuse to fire because counts don't match flags.
  recalcAllAdjacency(board);

  return wallEdges;
}

// ── Wormholes: paired cells show summed adjacency ──────

// Cells within `radius` graph steps of `start`, inclusive of start: a plain
// breadth-first ball over the neighbor lists. Only the explicit-topology
// branch of applyWormholes calls this; rectangles never do.
function graphBall(neighborCache, start, radius) {
  const seen = new Set([start]);
  let frontier = [start];
  for (let d = 0; d < radius; d++) {
    const next = [];
    for (const i of frontier) {
      for (const n of neighborCache[i]) {
        if (!seen.has(n)) { seen.add(n); next.push(n); }
      }
    }
    frontier = next;
  }
  return seen;
}

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

  // Pair separation is TWO rules, split by topology (the computeLiarZone
  // pattern). The rule exists to keep a pair's endpoints apart, an adjacent
  // pair's sum is trivially decomposable.
  //
  // On a RECTANGLE it is container Manhattan distance, kept VERBATIM in the
  // else-branch below: pair placement consumes the shared RNG stream, so any
  // change to that branch moves every shipped canonical board with a
  // wormhole.
  //
  // On an EXPLICIT topology (a tiling) the container's (row, col) is pure
  // storage, two cells "3 apart" by container arithmetic can be direct
  // lattice neighbors, so the separation is GRAPH distance over the board's
  // own neighbor lists: the partner must sit outside the 2-step ball of the
  // first endpoint, i.e. at graph distance >= 3. There is deliberately no
  // small-board analog of the rectangle's Manhattan-2 tier: distance 2
  // on a graph means a shared neighbor, and buildStaticGimmickConstraints
  // skips a pair whose neighborhoods overlap, so a distance-2 pair would
  // display a sum the certifier can never use, decorative by construction.
  // Distance >= 3 makes the union constraint always emit. The smallest
  // shipped tiling board is 63 cells (COASTLINE_BOARDS), so the cramped
  // boards the rectangle tier exists for do not arise here.
  const explicitTopo = !!board._cellNeighbors;
  const nbrs = explicitTopo ? buildNeighborCache(board, rows, cols) : null;

  const pairs = [];
  const used = new Set();
  for (let p = 0; p < Math.min(pairCount, Math.floor(candidates.length / 2)); p++) {
    let a = null, b = null;
    let nearA = null;
    for (const cell of candidates) {
      const key = `${cell.row},${cell.col}`;
      if (used.has(key)) continue;
      if (!a) {
        a = cell;
        used.add(key);
        if (explicitTopo) nearA = graphBall(nbrs, a.row * cols + a.col, 2);
        continue;
      }
      if (explicitTopo) {
        // Graph separation: outside a's 2-step ball → distance >= 3.
        if (!nearA.has(cell.row * cols + cell.col)) {
          b = cell;
          used.add(key);
          break;
        }
        continue;
      }
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

// A mine shifts on its own clock, rolled once per board. Christopher's ruling
// (2026-08-04): move like the worm, just not as often, between 2 and 20
// seconds. The old range was 30-45s, so this is a real change in feel and he
// said so when he asked for it.
const ORTHO_STEPS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

export const MINESHIFT_MIN_SECONDS = 2;
export const MINESHIFT_MAX_SECONDS = 20;

// The ceiling on how many mines move at once. getIntensity tops out around 5,
// and a board where five mines relocate every few seconds is already the
// deep end of Chaos; the cap is here so a future intensity change cannot
// quietly turn a shift into a reshuffle.
export const MINESHIFT_MAX_MOVERS = 5;

/**
 * Is mine shift a live modifier of the game currently in state?
 *
 * The shifter is the one interval whose cadence used to be remembered in a
 * MODULE variable rather than derived from the game it belongs to, so it
 * outlived its own board: leaving a Chaos round through the title screen
 * paused the interval but kept the memory, and the next `resumeTimer`, a tab
 * return, an unlocked phone, a dismissed bomb popup, restarted it against
 * whatever game had been loaded since. On a resumed Daily that meant mines
 * relocating inside a CANONICAL board mid-play: the certificate voided, the
 * numbers rewritten, and a submitted score whose stored feature vector
 * describes a board that no longer exists (issue #238, the #192 shape in a
 * different timer).
 *
 * The fix is to ask the LIVE game rather than a remembered cadence, which is
 * how the worm heartbeat has always resumed (`state.worms.length > 0`). Chaos
 * is the only mode that rolls this modifier, so both halves are checked: a
 * board outside Chaos can never be shifting, and a Chaos board that did not
 * roll it never starts.
 *
 * @param {{gameMode?: string, activeGimmicks?: string[]}} gameState
 * @returns {boolean}
 */
export function mineShiftIsActive(gameState) {
  if (!gameState || gameState.gameMode !== 'chaos') return false;
  return Array.isArray(gameState.activeGimmicks)
    && gameState.activeGimmicks.includes('mineShift');
}

/**
 * One shift step: 1-2 unflagged mines each move to a cell they SHARE AN EDGE
 * WITH, which is the worm's rule and, on a tiling, the only rule that means
 * anything.
 *
 * The old walk was the rectangular 8-neighborhood by coordinate, which is
 * fine on a square grid and nonsense on a lattice: `(row±1, col±1)` there
 * indexes the CONTAINER, and a tiling container is an arbitrary exact
 * factorization, so a mine would have "shifted" to a cell it does not touch
 * and often is nowhere near. Chaos has always been rectangular, so this never
 * manifested; it would have the moment Chaos gained the shapes.
 *
 * `buildWormCrawlTopology` is the one builder for "which cells may something
 * crawl between": side-sharing neighbors on a tiling, null on a rectangle
 * (whose orthogonal walk it leaves alone). Sharing it with the worm is the
 * point, two crawl rules would be two chances to disagree about what a step
 * is, and the worm's is the one that has been played.
 *
 * How MANY move is the difficulty dial: `count` comes from the modifier's
 * intensity at generation, so a deep Chaos round moves several at once while
 * an early one moves one. Fewer than `count` move when the board does not
 * offer that many shiftable mines, which is the honest outcome rather than a
 * retry loop.
 *
 * @param {Array} board
 * @param {Function} rng
 * @param {{neighborsOf: Function}|null} topology from buildWormCrawlTopology
 * @param {number} count how many mines to move this tick
 */
export function performMineShift(board, rng = Math.random, topology = null, count = 1) {
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

  // Pick the movers. The old rule was a flat 1-2 regardless of difficulty.
  shuffle(shiftable, rng);
  const movers = Math.max(1, Math.min(Math.round(count) || 1, MINESHIFT_MAX_MOVERS));
  const toShift = shiftable.slice(0, movers);
  const shifted = [];

  for (const mine of toShift) {
    // Where this mine may step: the crawl graph on a tiling, the orthogonal
    // four on a rectangle. Both are "cells sharing an edge"; the rectangular
    // branch is written out because a rectangle carries no crawl topology.
    const candidates = topology
      ? topology.neighborsOf(mine.row, mine.col)
      : ORTHO_STEPS
        .map(([dr, dc]) => ({ r: mine.row + dr, c: mine.col + dc }))
        .filter(({ r, c }) => r >= 0 && r < rows && c >= 0 && c < cols)
        .map(({ r, c }) => ({ r, c }));

    const dests = [];
    for (const n of candidates) {
      const nr = n.r !== undefined ? n.r : n.row;
      const nc = n.c !== undefined ? n.c : n.col;
      const dest = board[nr] && board[nr][nc];
      if (dest && !dest.isMine && !dest.isRevealed && !dest.isFlagged) {
        dests.push({ row: nr, col: nc });
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
    cell.plateTimer = 15; // placeholder, dynamic timer computed at reveal time
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

// ── Which straight lines a compass may point along ─────
//
// A compass ray is measured, not chosen by taste. The metric is how much of the
// straight line the arrow draws actually lies inside the cells the number
// counts: the shipped 4.8.8 diagonals keep 100% of it, the shipped 4.8.8 axes
// about 90%, and the hex verticals that were REJECTED keep about 66%. Every set
// below clears 88% and every alternative dropped from one scores 53-69%. (The
// figures move by about a point with patch size; the gap does not.)
//
// dx/dy are geometric (dx = +col, dy = +row). The ray itself is computed from
// cell POSITIONS and stored on the cell, so display and certifier read the same
// list, see computeCompassRay / compassRayCells.

// sin 60 degrees in pitch units. This IS a honeycomb's row spacing (HEX_ROW_H)
// and it is also the long leg of every 30/60 degree lattice axis on the Laves
// tilings, so both six-direction tables below read it from one constant rather
// than each spelling sqrt(3)/2 for itself.
const SIN_60 = HEX_ROW_H;

// Eight directions, four axes, four diagonals, for the two lattices whose
// compass-bearing points sit on a SQUARE grid: the 4.8.8 (the orthogonal octagon
// axes plus the diagonals, which alternate octagon and square) and cairo (whose
// ray anchors are the midpoints of the underlying square lattice's edges, so
// they sit on a 45-degree-rotated square lattice of their own, its diagonals
// score 100.0% and its axes about 88%).
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

// Six directions at 0/60/120 and their opposites: the three lines of centers on
// a honeycomb (the horizontal row plus the four half-step diagonals) and,
// numerically identical, on rhombille.
//
// There is deliberately no due-north or due-south ray here, and the reason is
// NOT the one this comment used to give ("no column of centers runs vertically"
// which is just false; in odd-r offset rows i and i+2 share cx, so the column
// exists and a vertical ray reaches something from 77 of 121 origins). The real
// reason is that the column runs along the shared VERTICAL EDGES of the row
// between: only about 66% of the drawn line lies inside counted cells and not
// one step of it lands on a cell touching the last, so the player cannot follow
// it. Same for 30/150. That number is the reject side of the shipped bar.
const COMPASS_DIRS_60 = [
  { arrow: '←', dx: -1, dy: 0 },
  { arrow: '→', dx: 1, dy: 0 },
  { arrow: '↖', dx: -0.5, dy: -SIN_60 },
  { arrow: '↗', dx: 0.5, dy: -SIN_60 },
  { arrow: '↙', dx: -0.5, dy: SIN_60 },
  { arrow: '↘', dx: 0.5, dy: SIN_60 },
];

// The same three axes turned 30 degrees, 30/90/150 and their opposites, for
// floret and deltoidal. The exact complement of COMPASS_DIRS_60: this set has a
// true due-north/south and no due-east/west.
//
// Which of the two a lattice takes is fixed by its builder's ROTATIONAL PHASE,
// and picking wrong is the silent failure here: the rejected set still returns
// rays (mean length 1.3 to 2.8 on the fixture patches) rather than nothing, so
// it reads as plausible on review. test/tilingCompass.test.mjs is the guard, it
// re-measures both candidate sets against the builders' actual output.
//
// Deltoidal reaches this quality only from the ray ANCHOR that tilingGeometry
// stores alongside the drawn center (cellPos[i].ax/ay, the kite's long-diagonal
// midpoint). Compute the ray from the drawn center instead and its best
// direction keeps 67.2%, under the bar that rejected the hex verticals. Cairo's
// eight directions depend on its own anchor the same way. See each builder's
// anchor note in tilingGeometry.js.
const COMPASS_DIRS_30 = [
  { arrow: '↑', dx: 0, dy: -1 },
  { arrow: '↓', dx: 0, dy: 1 },
  { arrow: '↖', dx: -SIN_60, dy: -0.5 },
  { arrow: '↗', dx: SIN_60, dy: -0.5 },
  { arrow: '↙', dx: -SIN_60, dy: 0.5 },
  { arrow: '↘', dx: SIN_60, dy: 0.5 },
];

// The set each lattice may point along, keyed by the tiling's own type. Exported
// so the guard test measures THIS table rather than a copy of it, a second copy
// is precisely the drift the guard exists to catch.
export const COMPASS_DIRS_BY_TILING = {
  '4.8.8': COMPASS_DIRS_8,
  cairo: COMPASS_DIRS_8,
  hex: COMPASS_DIRS_60,
  rhombille: COMPASS_DIRS_60,
  floret: COMPASS_DIRS_30,
  deltoidal: COMPASS_DIRS_30,
};

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
      // Pick a geometric direction whose ray is non-trivial (>= 2 cells),
      // else the longest available, and store the precomputed ray. The cell's
      // number then counts mines along exactly this stored list.
      const idx = cell.row * cols + cell.col;
      // Direction set follows the LATTICE, not the container: which straight
      // lines of centers exist is a property of the tiling. An unrecognized type
      // takes the 8-direction set, matching buildTiling's own 4.8.8 fallback.
      const dirs = (COMPASS_DIRS_BY_TILING[board._tiling?.type] || COMPASS_DIRS_8).slice();
      shuffle(dirs, rng);
      // The FIRST compass cell prefers an off-axis direction (the 4.8.8's
      // octagon/square staircase, a Laves lattice's 30/60 degree run) so any
      // compass board reliably shows that distinctive tiling ray at least once;
      // later cells stay fully random. Stable sort keeps the shuffle order
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
  // (canUnlock in boardSolver.js, which has always read the neighbor cache),
  // if the two disagree, the solver certifies an unlock order the live game
  // will not perform. A severed wall edge is just absent from the list,
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

  return false; // All safe neighbors revealed, unlocked!
}

// ── First-encounter popup tracking ─────────────────────

// A card is "seen" at a REVISION, not merely seen. His ruling (2026-08-04):
// anytime a card is changed, it should be marked as not seen. A player who
// learned the old sonar card, the one promising "a 5x5 area centered on the
// cell", has NOT seen the card that replaced it, and telling them they have
// is how a correction fails to reach the people who most need it.
//
// The revision is DERIVED from the card's own content rather than declared,
// so it cannot be forgotten: editing a word of `desc`, `longDesc` or the
// example markup moves the hash and the card shows again on the next board
// carrying it. A declared version number is a version number somebody
// eventually forgets to bump during a copy edit.
//
// Stored shape is {gimmick: revision}. The old shape was a flat array of
// names, read as "seen at an unknown revision", which re-shows each card
// once. That is the honest reading rather than a lossy one: an array entry
// genuinely does not record WHICH version of the card was read.

/** FNV-1a over a card's player-visible content. Stable across engines. */
export function cardRevision(gimmick) {
  const def = GIMMICK_DEFS[gimmick];
  if (!def) return '0';
  const content = [def.name, def.desc, def.longDesc, def.exampleHtml]
    .map((x) => x || '').join('\0');
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export function hasSeenGimmick(gimmick) {
  const seen = safeGetJSON(SEEN_KEY, {});
  if (Array.isArray(seen)) return false;   // legacy: no revision recorded
  return seen[gimmick] === cardRevision(gimmick);
}

export function markGimmickSeen(gimmick) {
  const stored = safeGetJSON(SEEN_KEY, {});
  const seen = (stored && !Array.isArray(stored) && typeof stored === 'object') ? stored : {};
  seen[gimmick] = cardRevision(gimmick);
  safeSetJSON(SEEN_KEY, seen);
}

/**
 * Forget every first-encounter card, so the next board with a modifier
 * teaches it again.
 *
 * Called once by the Challenge 250 epoch migration. The cards ARE the
 * ladder's teaching moments, and the ladder was rebuilt from level 1 for
 * everyone: a player who met walls on the old 120-level ladder meets them
 * again at L6 on the new one, and suppressing the card there makes the
 * opener read as broken rather than as familiar (his report, 2026-08-04).
 */
export function clearSeenGimmicks() {
  safeSetJSON(SEEN_KEY, {});
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
        cell.displayedMines = undefined; // plain number cell, render uses adjacentMines
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
