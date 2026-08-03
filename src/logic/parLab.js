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
// THE BATTERY (82 boards after the two mid-battery revisions below — the
// chunk-9/10 recalibration at 55/105 and the board-66 trim; originally 105
// in 21 chunks of 5 — each block earning its place):
//
//   1. WARM-UPS (18; the opening chunks, `warmup: true`): THREE consecutive
//      plain boards per tiling at its daily config, easiest lattice first.
//      A first-ever cairo board measures novelty, not the lattice, and
//      acclimation builds fastest on same-shape repetition — so each shape's
//      warm-ups run back to back (Christopher's call, 2026-08-02) instead of
//      interleaving. Three points per shape also give the offline fit a
//      per-shape learning slope to CHECK (did the curve flatten?) rather
//      than assume. Excluded from the estimates either way.
//   2. PLAIN SIZE x DENSITY GRID (54): originally 3 sizes x 3 densities per
//      tiling; redistributed at the chunk-9/10 recalibration checkpoint
//      (2026-08-03, his call — see GRID_PLAN) to 6 boards on each pinned
//      lattice (hex, 4.8.8, rhombille) and 12 on each noisy one (cairo,
//      floret, deltoidal). This is the block only the lab can supply — it
//      breaks the size/density-vs-intercept collinearity above, so the
//      cellCount and totalMines deviations get real priors instead of
//      frozen zeros. It also feeds the intercept and the reasoning-tier
//      deviations on every row.
//   3. SQUARE ANCHORS (7 after the board-66 trim, interleaved ~every 9
//      boards): known-model boards
//      spread through the session. They calibrate HIS day-to-day pace drift
//      across a long battery (a within-session bridge to the square model),
//      so a slow afternoon reads as a slow afternoon instead of as six
//      slow lattices.
//   4. MODIFIER SINGLES (10 after the board-66 trim; originally 24): per
//      tiling, single-modifier boards at the daily config, allocated by
//      MECHANISM rather than evenly (see MODIFIER_PLAN): the gimmicks whose information REGION is a function
//      of the lattice — sonar (depth-2 graph ball, area ~ valence²),
//      compass (three different direction families across the six
//      lattices), wormhole (pair-sum ceiling 20 on rhombille), worm (crawls
//      the neighbor graph) — get 3-4 boards spread across the lattices
//      where the mechanism diverges most, because "does sonar cost
//      differently on a valence-10 lattice?" is a real question with a
//      plausible yes. The mechanically shape-neutral five (mystery, liar,
//      mirror, locked, walls — their information effect does not scale
//      with valence) get 2 each, enough for a POOLED tilings-vs-square
//      prior. Per-shape × per-gimmick cells (54 of them) are unpowerable
//      at this scale and unnecessary: the offline fit estimates pooled
//      gimmick shifts plus per-shape terms only where the mechanism block
//      supplies real replication. Contrast comes from the model jointly —
//      every modifier board sits at its shape's daily config, next to the
//      grid's mid-size plains and the warm-up baselines at that config.
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
// RECORDING: localStorage is the source of truth and every row also SYNCS
// to the world-readable `parLab/` Firebase path (parLabSync.js — the one
// deliberate exception to "test builds never write Firebase", because this
// dataset is the product, not pollution), so the analysis can fetch results
// without a manual handoff. The local log doubles as the outbox: rows carry
// an fbKey once pushed, unsynced rows flush opportunistically on every lab
// entry and result, and the HUD's copy button stays as the offline
// fallback.
//
// MINES ARE DAILY-STYLE STRIKES (Christopher's ruling, 2026-08-02): the lab
// parameterizes the DAILY par model, so a lab mine costs what a daily mine
// costs — revealed strike marker, info-value + ramped base logged to the
// hit-event log, play continues, never game over. A loss-on-mine lab would
// measure a more cautious solve than the model's own response frame.
//
// TIME CONVENTION — the daily's, verbatim: `timeSec` is the final
// penalty-INCLUSIVE time (state.preciseTime, the same number a daily
// submits and the win modal shows — stopTimer folds the strike penalties
// in), `penaltySec` is the total folded penalty, and `bombHitEvents`
// carries the per-hit breakdown. The offline fit recovers
// pure_time = timeSec − penaltySec (equivalently − Σ event penalties),
// exactly the recipe the nightly refit applies to daily rows, and applies
// the same >30% mine-detonation probe filter (bombHits vs mines are both
// on the row). Rows recorded before 2026-08-02's fix lack `penaltySec`
// and carry a PURE-wall-clock integer timeSec instead — for those,
// pure_time = timeSec with no subtraction (they are all warm-ups; the
// field's presence is the discriminator).
//
// With strikes, every played board completes; the loss/retry machinery
// below survives as a defensive path, and Skip remains the way out of a
// board mid-way (an abandoned board re-issues its SAME seed later, so skip
// a board you walked away from half-seen). A played board that must be
// VOIDED (deliberate mine-popping, an interrupted run, any contaminated
// row) goes through redoParLabBoard: its resolving rows flip to 'invalid'
// locally, an 'invalid' TOMBSTONE row syncs to the server (the original
// synced row is append-only and cannot be edited — the analysis voids any
// (uid, id, attempt) that has an invalid row), and the board re-issues at
// the next attempt number, which is a FRESH layout.

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

// Per-shape play order through its own plain-grid queue. Codes are
// `<size>-<densityIndex>` with an optional `r` suffix for a REPLICATE — the
// same size x density cell under a fresh id, hence a fresh deterministic
// layout (parLabSeed keys on the id).
//
// THE CHUNK-9/10 RECALIBRATION (Christopher's call, 2026-08-03, at 55/105
// boards): hex, 4.8.8, and rhombille came back PINNED — log-spreads x/1.4
// or tighter across their six played grid boards, gentle-or-flat size
// slopes — so their remaining three grid boards each (M-0, S-2, L-2) would
// have spent nine boards confirming what the fit already holds. Those nine
// slots moved to the three noisy lattices, each noisy for a different
// reason: cairo's uncertainty is concentrated in its LARGE corner (size
// slope 0.56 -> 1.41 -> 2.67 with n=1 at L), so its three adds are L
// replicates across the density row; floret is variance-and-learning
// dominated (M1 4.62 early, M2 1.31 late), so its adds replicate the
// mid-density cell at each size; deltoidal is the widest spread of all
// (x/1.9) with a steep slope, same replicate pattern as floret. Grid
// total stays 54; played ids are frozen history and keep their specs.
// TRIMMED at board 66 (Christopher's call, 2026-08-03: "if stuff is
// stabilizing, I'd rather test other regions or just have less work to
// do"). What the audit found and the trim keeps/cuts:
// - cairo's slope came back TIGHT (M 1.47 sd 0.08 over n3, L 3.06 sd 0.19)
//   — the three L replicates became redundant and are gone; the 0.28-density
//   corners (S-2, L-2) stay, they are the unexplored dimension.
// - floret's inverted slope is real (L calm at 1.30 sd 0.10) — its L boards
//   are gone; S-1r stays to adjudicate the 1.78-vs-2.99 small-cell split,
//   M-0 completes the mid density row.
// - deltoidal's SMALL cell is the wildest number in the battery (sd 1.26,
//   0.74 vs 4.42) — S-1r and S-2 attack it; M-0 and L-2 complete density
//   rows on the steepest lattice; only L-1r was redundant.
const GRID_PLAN = {
  hex:       ['M-1', 'S-0', 'L-1', 'M-2', 'S-1', 'L-0'],
  '4.8.8':   ['M-1', 'S-0', 'L-1', 'M-2', 'S-1', 'L-0'],
  rhombille: ['M-1', 'S-0', 'L-1', 'M-2', 'S-1', 'L-0'],
  cairo:     ['M-1', 'S-0', 'L-1', 'M-2', 'S-1', 'L-0', 'M-0', 'S-2', 'L-2'],
  floret:    ['M-1', 'S-0', 'L-1', 'M-2', 'S-1', 'L-0', 'M-1r', 'M-0', 'S-1r'],
  deltoidal: ['M-1', 'S-0', 'L-1', 'M-2', 'S-1', 'L-0', 'M-1r', 'S-2', 'M-0', 'S-1r', 'L-2'],
};

// Square anchors: his home turf, spanning the familiar band. Interleaved at
// every 9th slot of the post-warm-up sequence.
const RECT_ANCHORS = [
  { rows: 8,  cols: 8,  density: 0.16 },
  { rows: 9,  cols: 9,  density: 0.20 },
  { rows: 10, cols: 10, density: 0.24 },
  { rows: 12, cols: 12, density: 0.18 },
  { rows: 14, cols: 14, density: 0.22 },
  // Trimmed from nine to seven at board 66: his pace pinned at 0.55-0.57
  // across a-03..a-05, so two drift sentinels cover the remaining stretch.
  { rows: 8,  cols: 12, density: 0.20 },
  { rows: 12, cols: 14, density: 0.24 },
];

// The modifier allocation (see the header). Region-geometry gimmicks span
// the lattices where their mechanism diverges most: sonar across the
// valence range (rhombille 10, deltoidal 9, cairo 7, hex 6); compass across
// all THREE direction families (8-dir: 4.8.8/cairo-family, 60°:
// hex/rhombille, 30°: floret/deltoidal); wormhole on the sum-ceiling
// extremes including rhombille's 20; worm across the valence extremes.
// Each shape carries exactly four so no lattice's modifier exposure
// confounds with its intercept more than another's.
// TRIMMED at board 66 to the mechanism core (played singles stay frozen:
// hex-sonar, 4.8.8-compass, 4.8.8-wormhole, rhombille-sonar). Kept: the
// sonar valence arc's top (deltoidal, 9 — with hex 6 and rhombille 10
// already played), one compass block per remaining direction family (hex
// 60°, floret 30°), wormhole's sum-20 ceiling (rhombille), and two
// neutrality spot-checks on hard lattices (floret-liar — on floret rather
// than deltoidal so the queue lengths keep the tail interleaved, and
// deltoidal already hosts the sonar single — plus rhombille-locked). Cut:
// every WORM single — his side-only crawl ruling
// (worms cross sides, never corners; see challenge-250 design) changes the
// mechanic they would measure, so worm timing data waits for the new crawl
// to ship rather than recording the outgoing one. Also cut: the remaining
// shape-neutral pairs (mystery/mirror/walls and the low-valence sonar and
// mid wormhole cells) — pooled gimmick shifts identify from live tiling
// dailies eventually, unlike the size/density slopes only this lab can
// supply.
const MODIFIER_PLAN = {
  hex:       ['sonar', 'compass'],
  '4.8.8':   ['compass', 'wormhole'],
  cairo:     [],
  deltoidal: ['sonar'],
  floret:    ['compass', 'liar'],
  rhombille: ['sonar', 'wormhole', 'locked'],
};

const mineCountFor = (total, density) => Math.max(5, Math.round(total * density));

// ── Battery assembly (deterministic, no RNG) ─────────────────────────────

function buildBattery() {
  const boards = [];

  // 1. Warm-ups: three CONSECUTIVE boards per shape at its daily config —
  // same-shape runs, easiest lattice first, so acclimation actually builds
  // before the next lattice arrives.
  for (const shape of SHAPES) {
    const cfg = coastlineBoardFor(shape);
    for (let round = 0; round < 3; round++) {
      boards.push({
        id: `w-${shape}-${round + 1}`,
        shape, M: cfg.M, N: cfg.N, mines: cfg.mines,
        gimmicks: [], warmup: true,
      });
    }
  }

  // 2+4. Per-shape queues: the plain grid in GRID_PLAN order (6 boards on
  // the pinned lattices, 12 on the noisy three — see the recalibration
  // note above), then the shape's 4 modifier boards at its daily config.
  const queues = SHAPES.map((shape, si) => {
    const q = [];
    for (const code of GRID_PLAN[shape]) {
      const m = code.match(/^([SML])-(\d)(r?)$/);
      const [, size, dIdx, rep] = m;
      const dims = SIZES[shape][size];
      const density = DENSITIES[shape][Number(dIdx)];
      q.push({
        id: `p-${shape}-${size}${dIdx}${rep}`,
        shape, M: dims.M, N: dims.N,
        mines: mineCountFor(dims.total, density),
        gimmicks: [], warmup: false,
      });
    }
    const cfg = coastlineBoardFor(shape);
    for (const g of MODIFIER_PLAN[shape]) {
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
  // every 9th slot (78 shape boards + 9 anchors = 87 post-warm-up slots).
  // The pinned lattices' queues drain six rounds early now; the rotation
  // then cycles the three noisy queues, which stay a 3-shape rotation, so
  // the no-three-consecutive-same-shape property survives the uneven
  // lengths.
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
 * A board is RESOLVED once it has a win or a skip row that has not been
 * voided; losses leave it open (fresh-seed retry), and an 'invalid' row for
 * the same (id, attempt) voids the win/skip it tombstones — the board
 * re-issues at the next attempt.
 */
export function resolvedIds(rows) {
  const list = rows || [];
  const voided = new Set();
  for (const r of list) {
    if (r && r.result === 'invalid') voided.add(`${r.id}#${r.attempt}`);
  }
  const done = new Set();
  for (const r of list) {
    if (r && (r.result === 'win' || r.result === 'skip') && !voided.has(`${r.id}#${r.attempt}`)) {
      done.add(r.id);
    }
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

/**
 * How many layout-SEEING attempts this id already has. Wins, losses, and
 * invalidated rows all count (each saw its layout, so the next issue must
 * be a fresh seed); skips do not — but tombstones and their voided rows
 * share an attempt number, so the pairs collapse to one sighting.
 */
export function attemptCountFor(rows, id) {
  const attempts = new Set();
  for (const r of rows || []) {
    if (r && r.id === id && (r.result === 'win' || r.result === 'loss' || r.result === 'invalid')) {
      attempts.add(r.attempt);
    }
  }
  return attempts.size;
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
  timeSec = 0, penaltySec = 0, features = null, par = 0, wormEvents = null, seq = 0,
  bombHits = 0, bombHitEvents = null,
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
    // The daily convention: penalty-INCLUSIVE final time (state.preciseTime
    // — what stopTimer committed and the win modal shows). penaltySec below
    // is what the fit subtracts back out; see the header.
    timeSec,
    seq,
    playedAt: new Date().toISOString(),
  };
  if (spec.shape === 'rect') { row.rows = spec.rows; row.cols = spec.cols; }
  else { row.M = spec.M; row.N = spec.N; }
  if (features) row.features = features;
  if (par > 0) row.par = Math.round(par * 10) / 10;
  if (Array.isArray(wormEvents) && wormEvents.length > 0) row.wormEvents = wormEvents;
  if (penaltySec > 0) row.penaltySec = Math.round(penaltySec * 10) / 10;
  if (bombHits > 0) {
    row.bombHits = bombHits;
    if (Array.isArray(bombHitEvents) && bombHitEvents.length > 0) row.bombHitEvents = bombHitEvents;
  }
  return row;
}

/**
 * Append with an idempotence guard: one measurement per (id, attempt).
 * A replay of an already-recorded attempt (the gameover modal's own Play
 * Again regenerates the same seed) must not produce a second row — the
 * second solve of a seen layout is not a measurement, and an INVALIDATED
 * attempt stays spent for the same reason. Skips and tombstones bypass
 * the guard: neither claims to measure anything.
 * Returns the new rows array, or null if the row was a duplicate.
 */
export function appendParLabRow(rows, row) {
  const list = Array.isArray(rows) ? rows : [];
  if (row.result !== 'skip' && row.result !== 'invalid'
      && list.some((r) => r && r.id === row.id && r.attempt === row.attempt
        && (r.result === 'win' || r.result === 'loss' || r.result === 'invalid'))) {
    return null;
  }
  return [...list, row];
}

/**
 * VOID a played board so it re-issues with a fresh layout — the escape
 * hatch for a contaminated row (deliberate mine-popping, an interrupted
 * sitting, a run the player wants stricken). Resolving rows (win/skip)
 * for the id flip to 'invalid' IN PLACE (they keep their fbKey — the
 * synced originals are append-only and stay on the server), and one
 * 'invalid' TOMBSTONE row per voided attempt is appended WITHOUT an
 * fbKey, so the sync flush publishes the voiding: the analysis drops any
 * (uid, id, attempt) that carries an invalid row. attemptCountFor counts
 * the voided attempt as seen, so the re-issue draws the next seed.
 *
 * @param {Array} rows the stored log
 * @param {string|number} idOrSeq board id, or its 1-based battery seq
 * @param {Array} battery
 * @returns {null | {rows: Array, spec: Object}} null when nothing to void
 */
export function redoParLabBoard(rows, idOrSeq, battery = PAR_LAB_BATTERY) {
  const seq = Number(idOrSeq);
  const spec = Number.isInteger(seq) && String(idOrSeq).trim() === String(seq)
    ? battery.find((b) => b.seq === seq)
    : battery.find((b) => b.id === String(idOrSeq).trim());
  if (!spec) return null;

  const list = Array.isArray(rows) ? rows : [];
  const alreadyVoided = new Set(
    list.filter((r) => r && r.id === spec.id && r.result === 'invalid').map((r) => r.attempt),
  );
  const voidAttempts = new Set();
  const flipped = list.map((r) => {
    if (r && r.id === spec.id && (r.result === 'win' || r.result === 'skip')
        && !alreadyVoided.has(r.attempt)) {
      voidAttempts.add(r.attempt);
      return { ...r, result: 'invalid' };
    }
    return r;
  });
  if (voidAttempts.size === 0) return null;

  let out = flipped;
  for (const attempt of [...voidAttempts].sort((a, b) => a - b)) {
    out = appendParLabRow(out, buildParLabRow(spec, attempt, 'invalid', { seq: out.length + 1 }));
  }
  return { rows: out, spec };
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
