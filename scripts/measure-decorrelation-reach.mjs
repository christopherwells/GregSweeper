// Measure how far SELECTION alone can push a daily board into the
// under-sampled corner of the (density × clueShare3) plane.
//
// This is the probe that decides whether Journal PR F2 (constructive
// synthesis) is worth designing. F1 gives the experiment a decorrelation
// mission, but decorrelation has no gimmick to force, so it SELECTS rather
// than constructs: it can only take the best of N boards the generator
// happened to produce. The open question is how good that best-of-N actually
// is. If selection already reaches the corner, F2 buys little. If it stalls
// at the mild edge, the constructive placer is the only way to the extreme
// corner and to the unobservable digit tail.
//
// Method. Generate a POOL of daily-shaped boards through the real pipeline
// (same dimensions, same natural gimmick lottery, same solvability gate), fit
// clueShare3 on density over that pool, then ask what best-of-N does to the
// residual. Fitting the line on the generator's OWN output is the honest
// frame: it measures the reach of selection against the confound the
// generator itself produces, with no dependence on a Firebase export or on
// whatever the refit happened to emit last night.
//
// Reported:
//   1. The generator's natural confound (r, R²) between density and 3-share.
//   2. Residual reach by N: mean best-of-N |residual|, how often it clears
//      the mild (1 SD) and extreme (2 SD) corners, and WHICH TAIL it landed
//      in. Scoring on magnitude puts both tails in play, but a magnitude rule
//      that in practice only ever returned one side would still leave the
//      design one-tailed, so the tail split is the number that proves it.
//   3. The joint-distribution shift: where the selected boards actually sit
//      in density and 3-share, versus the pool. A two-sided residual design
//      should add spread around the line WITHOUT dragging either marginal
//      far, which is also what keeps a nonlinear (inverted-U) response
//      visible rather than sampling only one side of it.
//
// Pure local generation: no Firebase, no network, writes nothing.
//
// Usage: node scripts/measure-decorrelation-reach.mjs [poolSize] [--verbose]

import { createDailyRNG } from '../src/logic/seededRandom.js';
import { generateBoard, cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import { isBoardSolvable } from '../src/logic/boardSolver.js';
import { getDailyGimmick, applyGimmicks } from '../src/logic/gimmicks.js';
import { computeDailyFeatures } from '../src/logic/dailyFeatures.js';
import {
  DAILY_MIN_SIZE, DAILY_SIZE_RANGE, DAILY_MIN_DENSITY, DAILY_DENSITY_RANGE,
} from '../src/logic/difficulty.js';

const POOL = parseInt(process.argv[2] || '400', 10);
const VERBOSE = process.argv.includes('--verbose');

// Candidate counts to evaluate. 10 is today's ordinary day; 19 is what a
// decorrelation day costs with the live 8-entry coverage list
// (1 primary + 8 coverage + DECORRELATION_SLOTS).
const NS = [1, 5, 10, 19, 40, 80];
// Resamples per N when estimating best-of-N from the pool.
const TRIALS = 4000;
const FEATURE = 'clueShare3';
const CONFOUNDER = 'density';
// Seeded so a re-run reproduces the table exactly. A measurement someone
// quotes in a plan should be re-derivable, and Math.random would make the
// second decimal wander between runs for no reason.
const pick = createDailyRNG('decorrelation-reach-resample');

// Build one board exactly as a real candidate slot would: daily dimensions
// from the seed's first three draws, the natural gimmick lottery (a
// decorrelation slot forces nothing), and the same solvability gate.
function buildCandidate(seed) {
  const dRng = createDailyRNG(seed);
  const rows = DAILY_MIN_SIZE + Math.floor(dRng() * DAILY_SIZE_RANGE);
  const cols = DAILY_MIN_SIZE + Math.floor(dRng() * DAILY_SIZE_RANGE);
  const density = DAILY_MIN_DENSITY + dRng() * DAILY_DENSITY_RANGE;
  const mines = Math.max(5, Math.round(rows * cols * density));
  const fr = Math.floor(rows / 2), fc = Math.floor(cols / 2);

  const board = generateBoard(rows, cols, mines, fr, fc, createDailyRNG(seed));
  cleanSolverArtifacts(board);
  const gimmicks = getDailyGimmick(seed, createDailyRNG, null, false);
  if (gimmicks.length > 0) {
    applyGimmicks(board, 1, gimmicks, createDailyRNG(seed + '-gimmick-apply-0'));
  }
  const check = isBoardSolvable(board, rows, cols, fr, fc);
  cleanSolverArtifacts(board);
  if (!check.solvable && check.remainingUnknowns !== 0) return null;
  return computeDailyFeatures(
    { board, rows, cols, totalMines: mines, activeGimmicks: gimmicks, rngSeed: seed },
    check,
  );
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sd = (a) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};
function quantile(a, q) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}

// ── build the pool ───────────────────────────────────────────────────
console.log(`generating ${POOL} daily-shaped candidates…`);
const pool = [];
let attempts = 0;
while (pool.length < POOL && attempts < POOL * 4) {
  const f = buildCandidate(`sweep-${attempts}`);
  attempts++;
  if (f) pool.push(f);
}
console.log(`pool:                  ${pool.length} solvable of ${attempts} attempts`);

const xs = pool.map((f) => f[CONFOUNDER]);
const ys = pool.map((f) => f[FEATURE]);

// ── the generator's natural confound ─────────────────────────────────
const mx = mean(xs), my = mean(ys);
let sxy = 0, sxx = 0, syy = 0;
for (let i = 0; i < xs.length; i++) {
  sxy += (xs[i] - mx) * (ys[i] - my);
  sxx += (xs[i] - mx) ** 2;
  syy += (ys[i] - my) ** 2;
}
const slope = sxy / sxx;
const intercept = my - slope * mx;
const r = sxy / Math.sqrt(sxx * syy);
const resid = pool.map((f, i) => ys[i] - slope * xs[i] - intercept);
const rsd = sd(resid);

console.log('');
console.log('── the confound the generator ships naturally ──');
console.log(`${FEATURE} vs ${CONFOUNDER}:  r = ${r.toFixed(3)}  R2 = ${(r * r).toFixed(3)}`);
console.log(`fitted line:           ${FEATURE} = ${slope.toFixed(3)} x ${CONFOUNDER} + ${intercept.toFixed(3)}`);
console.log(`residual sd:           ${rsd.toFixed(3)}`);
console.log(`${CONFOUNDER} range:        ${quantile(xs, 0).toFixed(3)} to ${quantile(xs, 1).toFixed(3)} (median ${quantile(xs, 0.5).toFixed(3)})`);
console.log(`${FEATURE} range:    ${quantile(ys, 0).toFixed(2)} to ${quantile(ys, 1).toFixed(2)} (median ${quantile(ys, 0.5).toFixed(2)})`);
// The other half of the F2 case: the high-clue tail. Selection can only pick
// from boards the generator makes, so if 5-and-up clues are near-absent
// across the whole pool, no candidate count reaches them and only
// constructive placement ever could.
const tail = pool.map((f) => f.clueShare5plus);
console.log(`clueShare5plus:        median ${quantile(tail, 0.5).toFixed(2)}, p95 ${quantile(tail, 0.95).toFixed(2)}, max ${quantile(tail, 1).toFixed(2)} per ten clues`);
console.log(`boards with no 5+ clue: ${(100 * tail.filter((v) => v === 0).length / tail.length).toFixed(0)}%`);

// ── reach by candidate count ─────────────────────────────────────────
// Candidates within a day are independent draws from the same generator, so
// resampling the pool without replacement is a faithful simulation of a day's
// slate. Scored on |z|, matching missionCandidateScore: both tails break the
// correlation equally, so the furthest-off board wins whichever side it is on.
const z = resid.map((v) => v / rsd);

console.log('');
console.log('── residual reach by candidate count (scored on |z|, both tails) ──');
console.log('   N   mean best |z|   >= 1 SD   >= 2 SD   above line   sel. density   sel. 3-share');
const shiftByN = new Map();
for (const n of NS) {
  let sumZ = 0, mild = 0, extreme = 0, sumDen = 0, sumShare = 0, above = 0;
  for (let t = 0; t < TRIALS; t++) {
    let bestI = -1, bestAbs = -Infinity;
    for (let k = 0; k < n; k++) {
      const i = Math.floor(pick() * z.length);
      if (Math.abs(z[i]) > bestAbs) { bestAbs = Math.abs(z[i]); bestI = i; }
    }
    sumZ += bestAbs;
    if (bestAbs >= 1) mild++;
    if (bestAbs >= 2) extreme++;
    // Which tail the winner landed in. Both are equally useful, but a
    // magnitude rule that in practice only ever returns ONE side would still
    // leave the design one-tailed, so this is the number to watch.
    if (z[bestI] > 0) above++;
    sumDen += xs[bestI];
    sumShare += ys[bestI];
  }
  const row = {
    meanZ: sumZ / TRIALS,
    mild: mild / TRIALS,
    extreme: extreme / TRIALS,
    above: above / TRIALS,
    den: sumDen / TRIALS,
    share: sumShare / TRIALS,
  };
  shiftByN.set(n, row);
  console.log(
    `  ${String(n).padStart(2)}   ${row.meanZ.toFixed(2).padStart(12)}   ` +
    `${(100 * row.mild).toFixed(0).padStart(6)}%   ${(100 * row.extreme).toFixed(0).padStart(6)}%   ` +
    `${(100 * row.above).toFixed(0).padStart(9)}%   ` +
    `${row.den.toFixed(3).padStart(12)}   ${row.share.toFixed(2).padStart(11)}`,
  );
}

// ── the joint shift ──────────────────────────────────────────────────
// The question F2 hangs on. Selection that raises 3-share while leaving
// density where it was has ridden the confound, not broken it. Breaking it
// means the selected boards sit LOWER in density than the pool while sitting
// HIGHER in 3-share.
console.log('');
console.log('── joint shift vs the unselected pool ──');
console.log(`pool mean:             ${CONFOUNDER} ${mx.toFixed(3)}   ${FEATURE} ${my.toFixed(2)}`);
for (const n of NS) {
  const row = shiftByN.get(n);
  const dDen = (row.den - mx) / sd(xs);
  const dShare = (row.share - my) / sd(ys);
  console.log(
    `  N=${String(n).padStart(2)}  ${CONFOUNDER} ${dDen >= 0 ? '+' : ''}${dDen.toFixed(2)} SD   ` +
    `${FEATURE} ${dShare >= 0 ? '+' : ''}${dShare.toFixed(2)} SD`,
  );
}

// How much of each corner exists at all: the ceiling selection is chasing,
// reported per TAIL because a magnitude rule can only sample a side the
// generator actually produces.
console.log('');
console.log(`furthest above the line: +${Math.max(...z).toFixed(2)} SD`);
console.log(`furthest below the line: ${Math.min(...z).toFixed(2)} SD`);
console.log(`pool beyond 1 SD:  ${(100 * z.filter((v) => v >= 1).length / z.length).toFixed(1)}% above, ${(100 * z.filter((v) => v <= -1).length / z.length).toFixed(1)}% below`);
console.log(`pool beyond 2 SD:  ${(100 * z.filter((v) => v >= 2).length / z.length).toFixed(1)}% above, ${(100 * z.filter((v) => v <= -2).length / z.length).toFixed(1)}% below`);

if (VERBOSE) {
  console.log('');
  console.log('── the ten most decorrelating boards in the pool ──');
  const idx = z.map((v, i) => i).sort((a, b) => z[b] - z[a]).slice(0, 10);
  for (const i of idx) {
    console.log(
      `  z ${z[i] >= 0 ? '+' : ''}${z[i].toFixed(2)}   ${CONFOUNDER} ${xs[i].toFixed(3)}   ${FEATURE} ${ys[i].toFixed(2)}   ` +
      `${pool[i].rows}x${pool[i].cols}  mines ${pool[i].totalMines}`,
    );
  }
}
