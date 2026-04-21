// One-shot calibration harness: regenerate today's daily board from its
// date seed, run the instrumented solver, compute features, and compare
// the seeded PAR_MODEL's predicted par to the real observed completion
// times. Used once when seeding coefficients to avoid shipping a
// visibly-wrong par on day one. A real refit happens in R later.
//
// Usage: node scripts/calibrate-today.mjs [date]

import { generateBoard, cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import { isBoardSolvable } from '../src/logic/boardSolver.js';
import { applyGimmicks, getDailyGimmick } from '../src/logic/gimmicks.js';
import { createDailyRNG } from '../src/logic/seededRandom.js';
import {
  DAILY_MIN_SIZE, DAILY_SIZE_RANGE,
  DAILY_MIN_DENSITY, DAILY_DENSITY_RANGE,
  PAR_MODEL,
} from '../src/logic/difficulty.js';
import { computeDailyFeatures, predictPar, breakdownPar } from '../src/logic/dailyFeatures.js';

const dateStr = process.argv[2] || '2026-04-21';
// Observed times — refresh these when recalibrating.
const observedTimes = { Chris: 65.0, Kate: 87.6 };

// Mirrors the daily generation path in src/game/gameActions.js ~line 219.
const dimRng = createDailyRNG(dateStr);
const rows = DAILY_MIN_SIZE + Math.floor(dimRng() * DAILY_SIZE_RANGE);
const cols = DAILY_MIN_SIZE + Math.floor(dimRng() * DAILY_SIZE_RANGE);
const density = DAILY_MIN_DENSITY + dimRng() * DAILY_DENSITY_RANGE;
const totalMines = Math.max(5, Math.round(rows * cols * density));
const fixedRow = Math.floor(rows / 2);
const fixedCol = Math.floor(cols / 2);

const activeGimmicks = getDailyGimmick(dateStr, createDailyRNG);

let board;
let solverResult;
let gimmickData = {};

for (let attempt = 0; ; attempt++) {
  const boardRng = attempt === 0
    ? createDailyRNG(dateStr)
    : createDailyRNG(dateStr + '-retry-' + attempt);
  board = generateBoard(rows, cols, totalMines, fixedRow, fixedCol, boardRng);
  cleanSolverArtifacts(board);
  if (activeGimmicks.length > 0) {
    const gRng = createDailyRNG(dateStr + '-gimmick-apply-' + attempt);
    gimmickData = applyGimmicks(board, 1, activeGimmicks, gRng);
  }
  solverResult = isBoardSolvable(board, rows, cols, fixedRow, fixedCol);
  cleanSolverArtifacts(board);
  if (solverResult.solvable || solverResult.remainingUnknowns === 0) break;
  if (attempt > 50) {
    console.error('Could not find solvable board after 50 attempts');
    process.exit(1);
  }
}

// Fake state object for computeDailyFeatures
const state = { board, rows, cols, totalMines, activeGimmicks };
const features = computeDailyFeatures(state, solverResult);
const predicted = predictPar(features);
const breakdown = breakdownPar(features);

// ── Report ─────────────────────────────────────────────
console.log('\n=== Daily calibration for', dateStr, '===\n');

console.log('Board:    ', rows + '×' + cols, '(' + totalMines, 'mines,', (density * 100).toFixed(1) + '%)');
console.log('Gimmicks: ', activeGimmicks.length ? activeGimmicks.join(', ') : '(none)');

console.log('\nSolver moves (sum should equal totalClicks - 1):');
console.log('  Pass A:               ', features.passAMoves);
console.log('  Canonical subsets:    ', features.canonicalSubsetMoves);
console.log('  Generic subsets:      ', features.genericSubsetMoves);
console.log('  Advanced logic:       ', features.advancedLogicMoves);
console.log('  Disjunctive (liar):   ', features.disjunctiveMoves);
const moveSum = features.passAMoves + features.canonicalSubsetMoves +
  features.genericSubsetMoves + features.advancedLogicMoves + features.disjunctiveMoves;
console.log('  Sum + 1 (first click):', moveSum + 1, '    totalClicks:', features.totalClicks,
  moveSum + 1 === features.totalClicks ? '✓' : '✗ MISMATCH');
console.log('  Technique level:      ', features.techniqueLevel);

console.log('\nGimmick cell counts:');
console.log('  mystery:', features.mysteryCellCount,
  ' liar:', features.liarCellCount,
  ' locked:', features.lockedCellCount,
  ' wormhole pairs:', features.wormholePairCount,
  ' mirror pairs:', features.mirrorPairCount,
  ' sonar:', features.sonarCellCount,
  ' compass:', features.compassCellCount);
console.log('  wall edges:', features.wallEdgeCount);

console.log('\n=== Par ===');
console.log('Observed:     ', Object.entries(observedTimes).map(([n, t]) => n + ' ' + t + 's').join(', '));
const obsArr = Object.values(observedTimes);
const obsMin = Math.min(...obsArr);
const obsMax = Math.max(...obsArr);
const obsMid = (obsMin + obsMax) / 2;
console.log('  range:', obsMin + 's – ' + obsMax + 's  midpoint:', obsMid.toFixed(1) + 's');
console.log('Predicted par:', predicted + 's');

console.log('\nBreakdown (largest first):');
for (const { label, seconds } of breakdown) {
  console.log('  +' + seconds + 's  ' + label);
}

console.log('\nAcceptance: predicted par in [' + obsMin + ', ' + obsMax + '] s?',
  predicted >= obsMin && predicted <= obsMax ? '✓' : '✗');

if (predicted < obsMin || predicted > obsMax) {
  const targetScale = obsMid / predicted;
  console.log('\nTo bring predicted to midpoint ' + obsMid.toFixed(1) + 's, scale coefficients by ' + targetScale.toFixed(3) + '×');
}
