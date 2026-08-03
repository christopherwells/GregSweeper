// How dense can each tiling go? (Christopher's ask, 2026-08-03: "see how
// high we can go with each of these tilings for mine density... this will
// be important for planning.")
//
// The Par Lab grid proved every lattice to density 0.28 and measured nothing
// above it, while the Challenge-250 ladder's top tiers want denser boards
// (the rectangular challenge cap is 0.34). This sweep measures, per lattice
// and per ladder-relevant size, from 0.28 up through 0.38:
//
//   - CERTIFIED-GENERATION success rate over K deterministic seeds (the
//     shipped generateTilingBoard, production maxAttempts, constructive
//     placer — every density here is above the 0.22 threshold);
//   - generation cost (median / worst ms) — player-facing on the ladder,
//     because every attempt draws a FRESH layout, so a death-retry pays it;
//   - median fitted par-per-cell at the shipped per-shape equations (the
//     tier currency the density buys);
//   - median techniqueLevel (does density buy reasoning or just mines).
//
// Plus a 3-STACK SPOT CHECK (locked+sonar+walls, a representative top-tier
// stack) at each shape's mid size at 0.30 and 0.34 — the ladder's top tiers
// are stacked, and a density only counts as reachable if stacked boards
// generate there too.
//
// Cost guards, because a hopeless cell is the expensive kind (a failed seed
// burns the full attempt budget): a cell stops early once 3 seeds have
// failed (its rate is already below any ship bar) or once it has spent
// CELL_BUDGET_MS, recording how far it got. Results are deterministic per
// seed, so re-runs reproduce.
//
//   node scripts/measure-tiling-density-ceilings.mjs                # full sweep
//   node scripts/measure-tiling-density-ceilings.mjs --shape=hex    # one shape
//
// Findings are logged in CHALLENGE_250_MAP.md (density-ceiling appendix).
// Not in CI: the full run is minutes to tens of minutes.

import { generateTilingBoard } from '../src/logic/tilingGenerator.js';
import { buildTiling, TILING_TYPES } from '../src/logic/tilingGeometry.js';
import { computeDailyFeatures, predictPar } from '../src/logic/dailyFeatures.js';
import { generateBoard, cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import { isBoardSolvable } from '../src/logic/boardSolver.js';
import { createDailyRNG } from '../src/logic/seededRandom.js';

const K_SEEDS = 10;
const K_STACK = 6;
const DENSITIES = [0.28, 0.30, 0.32, 0.34, 0.36, 0.38];
const CELL_BUDGET_MS = 120000;
const FAIL_STOP = 3;
const STACK = ['locked', 'sonar', 'walls'];

// Ladder-relevant sizes per lattice (the sizes Challenge-250 specs draw
// from): the banded-daily rungs, capped at rhombille's 72-cell cost ruling.
const SIZES = {
  '4.8.8': [[6, 7], [7, 8], [8, 9]],
  hex: [[9, 7], [9, 9], [11, 10]],
  cairo: [[5, 6], [4, 10], [7, 7]],
  floret: [[2, 3], [2, 4], [3, 4], [4, 4]],
  rhombille: [[4, 4], [4, 5], [4, 6]],
  deltoidal: [[2, 3], [2, 4], [3, 4]],
};

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function measureCell(type, M, N, density, gimmicks, kSeeds, tag) {
  const total = buildTiling(type, M, N).total;
  const mines = Math.max(5, Math.round(total * density));
  const t0 = Date.now();
  let ok = 0, fails = 0, tried = 0;
  const times = [], ppcs = [], tiers = [];
  for (let k = 0; k < kSeeds; k++) {
    if (fails >= FAIL_STOP || Date.now() - t0 > CELL_BUDGET_MS) break;
    tried++;
    const seed = `densitysweep:${tag}:${type}:${M}x${N}d${Math.round(density * 100)}:${k}`;
    const s0 = Date.now();
    const res = generateTilingBoard({ type, M, N, mines, seed, gimmicks });
    const ms = Date.now() - s0;
    times.push(ms);
    const certified = res && res.check.solvable && res.check.remainingUnknowns === 0;
    if (!certified) { fails++; continue; }
    ok++;
    tiers.push(res.check.techniqueLevel || 0);
    const f = computeDailyFeatures(
      { board: res.board, rows: res.rows, cols: res.cols, totalMines: mines,
        activeGimmicks: res.activeGimmicks, rngSeed: seed },
      res.check,
    );
    ppcs.push(predictPar(f) / total);
  }
  return {
    total, mines, ok, tried,
    medMs: times.length ? median(times) : NaN,
    worstMs: times.length ? Math.max(...times) : NaN,
    medPpc: ppcs.length ? median(ppcs) : NaN,
    medTier: tiers.length ? median(tiers) : NaN,
  };
}

function line(label, c, kSeeds) {
  const rate = `${c.ok}/${c.tried}${c.tried < kSeeds ? ` (stopped early of ${kSeeds})` : ''}`;
  return `   ${label}  ${String(c.total).padStart(4)}c ${String(c.mines).padStart(3)}m`
    + `  ${rate.padEnd(22)} med ${String(Math.round(c.medMs)).padStart(6)}ms  worst ${String(Math.round(c.worstMs)).padStart(6)}ms`
    + (Number.isFinite(c.medPpc) ? `  ppc ${c.medPpc.toFixed(2)}  tier ${c.medTier}` : '');
}

const shapeFilter = process.argv.find((a) => a.startsWith('--shape='))?.slice(8) || null;
const shapes = shapeFilter ? [shapeFilter] : TILING_TYPES;

for (const type of shapes) {
  if (!SIZES[type]) { console.error(`unknown shape '${type}'`); process.exit(1); }
  console.log(`\n== ${type} — plain sweep ==`);
  for (const [M, N] of SIZES[type]) {
    for (const density of DENSITIES) {
      const c = measureCell(type, M, N, density, [], K_SEEDS, 'plain');
      console.log(line(`${M}x${N} d${density.toFixed(2)}`, c, K_SEEDS));
    }
  }
  console.log(`   -- 3-stack spot check (${STACK.join('+')}), mid size --`);
  const mid = SIZES[type][Math.min(1, SIZES[type].length - 1)];
  for (const density of [0.30, 0.34]) {
    const c = measureCell(type, mid[0], mid[1], density, STACK, K_STACK, 'stack');
    console.log(line(`${mid[0]}x${mid[1]} d${density.toFixed(2)}`, c, K_STACK));
  }
}

// Rectangular reference at the established 0.34 challenge cap and around it,
// so the tiling numbers read against a familiar baseline. generateBoard's
// terminal fallback can return an uncertified board, so certification is
// checked here exactly as the challenge retry loop would.
if (!shapeFilter) {
  console.log('\n== Classic 12x12 reference ==');
  for (const density of [0.30, 0.34, 0.38]) {
    const mines = Math.round(144 * density);
    const t0 = Date.now();
    let ok = 0, tried = 0;
    const times = [];
    for (let k = 0; k < K_SEEDS; k++) {
      if (Date.now() - t0 > CELL_BUDGET_MS) break;
      tried++;
      const rng = createDailyRNG(`densitysweep:rect:12x12d${Math.round(density * 100)}:${k}`);
      const s0 = Date.now();
      const board = generateBoard(12, 12, mines, 6, 6, rng);
      const check = board ? isBoardSolvable(board, 12, 12, 6, 6) : null;
      if (board) cleanSolverArtifacts(board);
      times.push(Date.now() - s0);
      if (check && check.solvable && check.remainingUnknowns === 0) ok++;
    }
    console.log(`   12x12 d${density.toFixed(2)}  144c ${String(mines).padStart(3)}m  ${ok}/${tried}`
      + `  med ${String(Math.round(median(times))).padStart(6)}ms  worst ${String(Math.round(Math.max(...times))).padStart(6)}ms`);
  }
}
console.log('\nSweep complete.');
