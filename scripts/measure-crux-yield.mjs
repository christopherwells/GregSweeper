// Measure crux-teaser yield over a sweep of daily seeds: how often a
// generated board produces a materializable crux, the tier mix, the mini
// dimensions, and the serialized payload size. Mirrors the candidate
// pipeline so the boards match what ships. Pure local generation — no
// Firebase, no network.
//
// Usage: node scripts/measure-crux-yield.mjs [count]

import { createDailyRNG } from '../src/logic/seededRandom.js';
import { getDailyGimmick, applyGimmicks } from '../src/logic/gimmicks.js';
import { generateBoard, cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import { isBoardSolvable } from '../src/logic/boardSolver.js';
import { DAILY_MIN_SIZE, DAILY_SIZE_RANGE, DAILY_MIN_DENSITY, DAILY_DENSITY_RANGE } from '../src/logic/difficulty.js';
import { extractCrux, materializeCrux } from '../src/logic/cruxExtract.js';

const N = parseInt(process.argv[2] || '120', 10);

// A handful of gimmicks to exercise the strip-and-reverify path. null =
// plain board.
const GIMMICK_MIX = [null, null, null, 'walls', 'liar', 'sonar', 'wormhole', 'mystery', 'locked', 'compass', 'mirror'];

function buildBoard(seed, forced) {
  const dRng = createDailyRNG(seed);
  const rows = DAILY_MIN_SIZE + Math.floor(dRng() * DAILY_SIZE_RANGE);
  const cols = DAILY_MIN_SIZE + Math.floor(dRng() * DAILY_SIZE_RANGE);
  const density = DAILY_MIN_DENSITY + dRng() * DAILY_DENSITY_RANGE;
  const totalMines = Math.max(5, Math.round(rows * cols * density));
  const fr = Math.floor(rows / 2), fc = Math.floor(cols / 2);
  const boardRng = createDailyRNG(seed);
  let board = generateBoard(rows, cols, totalMines, fr, fc, boardRng);
  cleanSolverArtifacts(board);
  const activeGimmicks = forced ? getDailyGimmick(seed, createDailyRNG, forced, true) : [];
  let check = null;
  for (let a = 0; a < 60; a++) {
    if (a > 0) {
      board = generateBoard(rows, cols, totalMines, fr, fc, createDailyRNG(seed + '-retry-' + a));
      cleanSolverArtifacts(board);
    }
    if (activeGimmicks.length > 0) applyGimmicks(board, 1, activeGimmicks, createDailyRNG(seed + '-g-' + a));
    check = isBoardSolvable(board, rows, cols, fr, fc);
    cleanSolverArtifacts(board);
    if (check.solvable || check.remainingUnknowns === 0) break;
  }
  const solvable = check && (check.solvable || check.remainingUnknowns === 0);
  return { board, rows, cols, activeGimmicks, solvable };
}

let solvable = 0, hasCrux = 0, materialized = 0;
const tierMix = {};
const skipNoCrux = { plain: 0, gimmick: 0 };
let maxBytes = 0, sumBytes = 0, maxDim = 0;
const dims = {};

for (let i = 0; i < N; i++) {
  const forced = GIMMICK_MIX[i % GIMMICK_MIX.length];
  const { board, rows, cols, solvable: ok } = buildBoard(`measure-${i}`, forced);
  if (!ok) continue;
  solvable++;
  const crux = extractCrux(board, rows, cols);
  if (!crux) { (forced ? skipNoCrux.gimmick++ : skipNoCrux.plain++); continue; }
  hasCrux++;
  const payload = materializeCrux(board, rows, cols, crux);
  if (!payload) continue;
  materialized++;
  tierMix[payload.tier] = (tierMix[payload.tier] || 0) + 1;
  const bytes = JSON.stringify(payload).length;
  sumBytes += bytes; maxBytes = Math.max(maxBytes, bytes);
  const d = Math.max(payload.rows, payload.cols);
  maxDim = Math.max(maxDim, d);
  dims[`${payload.rows}x${payload.cols}`] = (dims[`${payload.rows}x${payload.cols}`] || 0) + 1;
}

console.log(`boards solvable:      ${solvable}/${N}`);
console.log(`have a crux (tier>=1): ${hasCrux}/${solvable}`);
console.log(`materialized teaser:   ${materialized}/${hasCrux}  (${(100 * materialized / solvable).toFixed(0)}% of solvable)`);
console.log(`no-crux skips:         plain=${skipNoCrux.plain} gimmick=${skipNoCrux.gimmick}`);
console.log(`tier mix:              ${JSON.stringify(tierMix)}`);
console.log(`mini dims:             ${JSON.stringify(dims)} (max dim ${maxDim})`);
console.log(`payload bytes:         avg ${materialized ? Math.round(sumBytes / materialized) : 0}, max ${maxBytes}`);
