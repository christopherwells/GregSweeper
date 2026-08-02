// ── Par Lab (test-only): the designed board battery for per-shape par priors ──
//
// The per-shape par equations (PAR_MODEL_SHAPES) ship with every deviation
// prior-centered at ZERO, and live daily data identifies those deviations
// SLOWLY (one tiling daily per ~2 days post-flip, split six ways) and
// PARTIALLY: the shape rotation ships FIXED per-shape configs, so within a
// shape the live rows carry a CONSTANT cellCount and totalMines — their
// deviation columns are exactly collinear with the shape's intercept
// deviation, and no amount of daily data can separate them. This lab is the
// instrument for what the live instrument structurally cannot measure, plus a
// head start on what it measures slowly.
//
// THE BATTERY (100 boards, 20 chunks of 5, each block earning its place):
//
//   1. WARM-UPS (12; chunks 1-3ish, `warmup: true`): two plain boards per
//      tiling at its daily config, easiest lattice first. A first-ever cairo
//      board measures novelty, not the lattice; these rows exist so the
//      learning curve lands HERE and is excluded (or modeled) in the offline
//      fit rather than contaminating the estimates.
//   2. PLAIN SIZE x DENSITY GRID (54): per tiling, 3 sizes x 3 densities.
//      This is the block only the lab can supply — it breaks the
//      size/density-vs-intercept collinearity above, so the cellCount and
//      totalMines deviations get real priors instead of frozen zeros. It also
//      feeds the intercept and the reasoning-tier deviations on every row.
//   3. SQUARE ANCHORS (10, interleaved ~every 9 boards): known-model boards
//      spread through the session. They calibrate HIS day-to-day pace drift
//      across a long battery (a within-session bridge to the square model),
//      so a slow afternoon reads as a slow afternoon instead of as six
//      slow lattices.
//   4. MODIFIER SINGLES (24): per tiling, four single-modifier boards at the
//      daily config, roster rotated so all nine daily-safe modifiers appear
//      2-3 times. Live dailies WILL estimate these eventually (modifier
//      counts vary day to day); this block is the head start.
//
// CHUNK CONTRACT (the "fill gaps as we go" workflow): boards are identified
// by stable `id`s and progress is a log of per-id results, so any UNPLAYED
// board can be redesigned freely — swap specs, reorder, retune densities —
// without corrupting progress. After any chunk, export the results
// (the HUD's copy button), look at where the uncertainty still lives, and
// revise the remaining chunks in this file. Played ids are frozen history.
//
// Ordering is deterministic and interleaved (shapes rotate board to board)
// so practice effects spread across shapes instead of loading onto whichever
// lattice happens to come last.
//
// RECORDING: local only, by design. Test builds never write Firebase, and
// these rows feed a ONE-TIME offline prior-seeding analysis (R), not the
// nightly refit — so the log lives in localStorage and exports as JSON from
// the HUD. Losses and skips are recorded too (censoring information); a
// retry after a loss gets a FRESH seed, because replaying a layout you have
// already seen produces a time about the replay, not the board.

import { createDailyRNG } from './seededRandom.js';
import { generateBoard, cleanSolverArtifacts } from './boardGenerator.js';
import { isBoardSolvable } from './boardSolver.js';
import { generateTilingBoard } from './tilingGenerator.js';
import { coastlineBoardFor } from './coastlineLink.js';

// ── Design tables ────────────────────────────────────────────────────────

// Warm-up / interleave order: easiest lattice first (hex reads closest to a
// square grid; rhombille is the Pass-C-everything outlier).
const SHAPES = ['hex', '4.8.8', 'cairo', 'deltoidal', 'floret', 'rhombille'];

// Lattice dimensions per size class, with the cell totals as DESIGN
// CONSTANTS (a test pins each against buildTiling so they cannot drift).
// Mid sizes are the daily configs' lattices; small ~48 cells, large as big
// as generation cost allows (rhombille's 90-cell ceiling is the measured
// 13.7s worst-case; scripts/validate-parlab-battery.mjs measures every spec).
const SIZES = {
  '4.8.8':   { S: { M: 5, N: 5, total: 41 },  M: { M: 6, N: 7, total: 72 },  L: { M: 8, N: 9, total: 127 } },
  hex:       { S: { M: 7, N: 7, total: 49 },  M: { M: 9, N: 7, total: 63 },  L: { M: 11, N: 10, total: 110 } },
  cairo:     { S: { M: 5, N: 6, total: 49 },  M: { M: 7, N: 7, total: 84 },  L: { M: 8, N: 9, total: 127 } },
  deltoidal: { S: { M: 2, N: 4, total: 48 },  M: { M: 3, N: 4, total: 72 },  L: { M: 4, N: 4, total: 96 } },
  floret:    { S: { M: 2, N: 4, total: 48 },  M: { M: 3, N: 4, total: 72 },  L: { M: 4, N: 4, total: 96 } },
  rhombille: { S: { M: 4, N: 4, total: 48 },  M: { M: 4, N: 6, total: 72 },  L: { M: 5, N: 6, total: 90 } },
};

// Density grids. The open lattices reach down to the daily band's floor;
// the Laves lattices sit low at 0.18 with seeds VALIDATED offline
// (generation is deterministic, so a spec that generated once in the
// validator generates forever on-device) — EXCEPT rhombille, whose low
// point is its own CONSTRUCTIVE floor: sparse no-guess rhombille boards are
// effectively unfindable by sampling (0/12 whole-generation runs at 0.211,
// and the validator reproduced the dead zone at 0.18), so below ~0.22 the
// lattice has no reachable board space for par to describe. Its density
// slope is therefore estimated over the range production rhombille actually
// lives in.
const DENSITIES = {
  '4.8.8': [0.14, 0.20, 0.28],
  hex:     [0.14, 0.20, 0.28],
  cairo:     [0.18, 0.23, 0.28],
  deltoidal: [0.18, 0.23, 0.28],
  floret:    [0.18, 0.23, 0.28],
  rhombille: [0.23, 0.255, 0.28],
};

// Per-spec seed salts, found by the offline validator's seed search when a
// spec's default seed lands in a dead pocket of layout space (deltoidal's
// 96-cell board at density 0.18 needed three re-rolls). The salt is part of
// the design: it changes WHICH deterministic board the spec names, never
// how it is built.
const SEED_SALTS = {
  'p-deltoidal-L0': 's3',
};

// Per-shape play order through its own 13-board queue (9 plain + 4
// modifiers): sizes and densities alternate so no chunk is all-small or
// all-dense. Codes are `<size>-<densityIndex>`.
const PER_SHAPE_ORDER = ['M-1', 'S-0', 'L-1', 'M-2', 'S-1', 'L-0', 'M-0', 'S-2', 'L-2'];

// Square anchors: his home turf, spanning the familiar band. Interleaved at
// every 9th slot of the post-warm-up sequence.
const RECT_ANCHORS = [
  { rows: 8,  cols: 8,  density: 0.16 },
  { rows: 9,  cols: 9,  density: 0.20 },
  { rows: 10, cols: 10, density: 0.24 },
  { rows: 12, cols: 12, density: 0.18 },
  { rows: 14, cols: 14, density: 0.22 },
  { rows: 8,  cols: 12, density: 0.20 },
  { rows: 10, cols: 14, density: 0.26 },
  { rows: 9,  cols: 12, density: 0.15 },
  { rows: 12, cols: 14, density: 0.24 },
  { rows: 10, cols: 10, density: 0.20 },
];

// Modifier roster rotation: shape i takes roster[(i*4)..(i*4+3)] mod 9, so
// across 6 shapes x 4 boards every daily-safe modifier appears 2-3 times.
const MODIFIER_ROSTER = ['sonar', 'compass', 'wormhole', 'liar', 'mirror', 'mystery', 'locked', 'walls', 'worm'];

const mineCountFor = (total, density) => Math.max(5, Math.round(total * density));

// ── Battery assembly (deterministic, no RNG) ─────────────────────────────

function buildBattery() {
  const boards = [];

  // 1. Warm-ups: two rounds over the shapes at their daily configs.
  for (let round = 0; round < 2; round++) {
    for (const shape of SHAPES) {
      const cfg = coastlineBoardFor(shape);
      boards.push({
        id: `w-${shape}-${round + 1}`,
        shape, M: cfg.M, N: cfg.N, mines: cfg.mines,
        gimmicks: [], warmup: true,
      });
    }
  }

  // 2+4. Per-shape queues: the 9-board plain grid in PER_SHAPE_ORDER, then
  // the shape's 4 modifier boards at its daily config.
  const queues = SHAPES.map((shape, si) => {
    const q = [];
    for (const code of PER_SHAPE_ORDER) {
      const [size, dIdx] = code.split('-');
      const dims = SIZES[shape][size];
      const density = DENSITIES[shape][Number(dIdx)];
      q.push({
        id: `p-${shape}-${size}${dIdx}`,
        shape, M: dims.M, N: dims.N,
        mines: mineCountFor(dims.total, density),
        gimmicks: [], warmup: false,
      });
    }
    const cfg = coastlineBoardFor(shape);
    for (let k = 0; k < 4; k++) {
      const g = MODIFIER_ROSTER[(si * 4 + k) % MODIFIER_ROSTER.length];
      q.push({
        id: `m-${shape}-${g}`,
        shape, M: cfg.M, N: cfg.N, mines: cfg.mines,
        gimmicks: [g], warmup: false,
      });
    }
    return q;
  });

  // Interleave: rotate through the shapes, one board each, shifting the
  // starting shape every round so neighbors vary; drop in a square anchor at
  // every 9th slot (78 shape boards + 10 anchors = 88 post-warm-up slots).
  const interleaved = [];
  let round = 0;
  while (queues.some((q) => q.length > 0)) {
    for (let s = 0; s < SHAPES.length; s++) {
      const q = queues[(s + round) % SHAPES.length];
      if (q.length > 0) interleaved.push(q.shift());
    }
    round++;
  }
  let anchorIdx = 0;
  for (let slot = 0; interleaved.length > 0 || anchorIdx < RECT_ANCHORS.length; slot++) {
    if (slot % 9 === 4 && anchorIdx < RECT_ANCHORS.length) {
      const a = RECT_ANCHORS[anchorIdx++];
      boards.push({
        id: `a-${String(anchorIdx).padStart(2, '0')}`,
        shape: 'rect', rows: a.rows, cols: a.cols,
        mines: mineCountFor(a.rows * a.cols, a.density),
        gimmicks: [], warmup: false,
      });
    } else if (interleaved.length > 0) {
      boards.push(interleaved.shift());
    }
  }

  // Stamp sequence + chunk (1-based; chunks of 5).
  return boards.map((b, i) => ({ ...b, seq: i + 1, chunk: Math.floor(i / 5) + 1 }));
}

export const PAR_LAB_BATTERY = buildBattery();
export const PAR_LAB_CHUNK_SIZE = 5;

// ── Board building (the ONE builder — client and validator both call it) ──

/**
 * The deterministic seed for a board attempt. Attempt 0 is the designed
 * board (plus any design-time salt); each retry after a loss draws a FRESH
 * layout of the same spec (a replayed layout measures memory of the
 * reveal, not the board).
 */
export function parLabSeed(spec, attempt = 0) {
  const salt = SEED_SALTS[spec.id] ? `:${SEED_SALTS[spec.id]}` : '';
  return attempt > 0 ? `parlab:${spec.id}${salt}:r${attempt}` : `parlab:${spec.id}${salt}`;
}

/**
 * Build a lab board from its spec: certified, frozen, opener marked — the
 * same contract as a coastline practice board. Rect specs mirror the daily
 * local-gen recipe (generate around the container centre, certify, retry on
 * a deterministic seed ladder); tiling specs are generateTilingBoard
 * verbatim. Single-sourced so scripts/validate-parlab-battery.mjs proves
 * offline exactly what the client will build on-device.
 *
 * @returns {null | { board, rows, cols, totalMines, firstClick, check,
 *                    activeGimmicks, applied }}
 */
export function buildParLabBoard(spec, attempt = 0) {
  const seed = parLabSeed(spec, attempt);

  if (spec.shape === 'rect') {
    const { rows, cols, mines } = spec;
    const fr = Math.floor(rows / 2), fc = Math.floor(cols / 2);
    for (let a = 0; a < 60; a++) {
      const rng = a === 0 ? createDailyRNG(seed) : createDailyRNG(`${seed}-retry-${a}`);
      const board = generateBoard(rows, cols, mines, fr, fc, rng);
      cleanSolverArtifacts(board);
      const check = isBoardSolvable(board, rows, cols, fr, fc);
      cleanSolverArtifacts(board);
      if (check.solvable || check.remainingUnknowns === 0) {
        let totalMines = 0;
        for (const row of board) for (const c of row) if (c.isMine) totalMines++;
        return {
          board, rows, cols, totalMines,
          firstClick: fr * cols + fc, check,
          activeGimmicks: [], applied: {},
        };
      }
    }
    return null;
  }

  const res = generateTilingBoard({
    type: spec.shape, M: spec.M, N: spec.N, mines: spec.mines, seed,
    gimmicks: Array.isArray(spec.gimmicks) ? spec.gimmicks : [],
  });
  if (!res) return null;
  let totalMines = 0;
  for (const row of res.board) for (const c of row) if (c.isMine) totalMines++;
  return { ...res, totalMines };
}

// ── Progress + recording (pure; storage I/O lives in the UI layer) ───────

/**
 * A board is RESOLVED once it has a win or a skip row; losses leave it open
 * (the HUD offers a fresh-seed retry).
 */
export function resolvedIds(rows) {
  const done = new Set();
  for (const r of rows || []) {
    if (r && (r.result === 'win' || r.result === 'skip')) done.add(r.id);
  }
  return done;
}

/** The next unresolved board in battery order, or null when complete. */
export function nextParLabBoard(rows, battery = PAR_LAB_BATTERY) {
  const done = resolvedIds(rows);
  for (const spec of battery) {
    if (!done.has(spec.id)) return spec;
  }
  return null;
}

/** How many attempts (win/loss rows, not skips) this id already has. */
export function attemptCountFor(rows, id) {
  let n = 0;
  for (const r of rows || []) {
    if (r && r.id === id && (r.result === 'win' || r.result === 'loss')) n++;
  }
  return n;
}

export function labProgress(rows, battery = PAR_LAB_BATTERY) {
  const done = resolvedIds(rows);
  const resolved = battery.filter((b) => done.has(b.id)).length;
  return { resolved, total: battery.length, complete: resolved >= battery.length };
}

/**
 * Shape one result row. The features/par arguments are the run's own
 * computed values (state.coastlineFeatures / state.coastlinePar); wormEvents
 * ride along so realized worm exposure survives for the two worm boards.
 * `seq` is the global play counter — the offline fit's session-effect axis.
 */
export function buildParLabRow(spec, attempt, result, {
  timeSec = 0, features = null, par = 0, wormEvents = null, seq = 0,
} = {}) {
  const row = {
    id: spec.id,
    attempt,
    seed: parLabSeed(spec, attempt),
    shape: spec.shape,
    mines: spec.mines,
    gimmicks: Array.isArray(spec.gimmicks) ? [...spec.gimmicks] : [],
    warmup: spec.warmup === true,
    result,
    timeSec,
    seq,
    playedAt: new Date().toISOString(),
  };
  if (spec.shape === 'rect') { row.rows = spec.rows; row.cols = spec.cols; }
  else { row.M = spec.M; row.N = spec.N; }
  if (features) row.features = features;
  if (par > 0) row.par = Math.round(par * 10) / 10;
  if (Array.isArray(wormEvents) && wormEvents.length > 0) row.wormEvents = wormEvents;
  return row;
}

/**
 * Append with an idempotence guard: one row per (id, attempt) for
 * win/loss. A replay of an already-recorded attempt (the gameover modal's
 * own Play Again regenerates the same seed) must not produce a second row —
 * the second solve of a seen layout is not a measurement.
 * Returns the new rows array, or null if the row was a duplicate.
 */
export function appendParLabRow(rows, row) {
  const list = Array.isArray(rows) ? rows : [];
  if (row.result !== 'skip'
      && list.some((r) => r && r.id === row.id && r.attempt === row.attempt
        && (r.result === 'win' || r.result === 'loss'))) {
    return null;
  }
  return [...list, row];
}

/** The export payload the HUD copies to the clipboard. */
export function exportParLab(rows) {
  return JSON.stringify({
    format: 'parlab-v1',
    exportedAt: new Date().toISOString(),
    battery: PAR_LAB_BATTERY.length,
    rows: rows || [],
  });
}
