// Compare candidate selection with vs without the load-bearing filter
// to see how often the filter actually changes the chosen seed.
//
// Usage: node scripts/test-load-bearing-filter.mjs [YYYY-MM-DD ...]
// Default: a small set of historical dates we know had decorative
// modifiers per the audit script.

import { createDailyRNG } from '../src/logic/seededRandom.js';
import { getDailyGimmick, applyGimmicks } from '../src/logic/gimmicks.js';
import { generateBoard, cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import { isBoardSolvable, findDecorativeGimmicks } from '../src/logic/boardSolver.js';
import { computeDailyFeatures } from '../src/logic/dailyFeatures.js';
import { DAILY_MIN_SIZE, DAILY_SIZE_RANGE, DAILY_MIN_DENSITY, DAILY_DENSITY_RANGE } from '../src/logic/difficulty.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CANDIDATE_COUNT = 10;
const PRIMARY_WEIGHT = 0.1;

const TARGET_TO_GIMMICK = {
  mysteryCellCount:  'mystery',
  liarCellCount:     'liar',
  lockedCellCount:   'locked',
  wormholePairCount: 'wormhole',
  mirrorPairCount:   'mirror',
  sonarCellCount:    'sonar',
  compassCellCount:  'compass',
  wallEdgeCount:     'walls',
};

function loadSpec() {
  try {
    const raw = readFileSync(join(__dirname, '..', 'src', 'logic', 'experimentTarget.json'), 'utf8');
    const data = JSON.parse(raw);
    return {
      target: data.target || 'advancedLogicMoves',
      coverage_targets: Array.isArray(data.coverage_targets) ? data.coverage_targets : [],
    };
  } catch {
    return { target: 'advancedLogicMoves', coverage_targets: [] };
  }
}

function missionForSlot(spec, slotIndex) {
  if (slotIndex === 0 || spec.coverage_targets.length === 0) {
    return { target: spec.target, deficitWeight: PRIMARY_WEIGHT, singleOnly: false, isPrimary: true };
  }
  const entry = spec.coverage_targets[(slotIndex - 1) % spec.coverage_targets.length];
  return {
    target: entry.feature,
    deficitWeight: typeof entry.deficit_weight === 'number' ? entry.deficit_weight : 0.1,
    singleOnly: true,
    isPrimary: false,
  };
}

function buildOneCandidate(seed, forcedGimmick, singleOnly) {
  const dRng = createDailyRNG(seed);
  const rows = DAILY_MIN_SIZE + Math.floor(dRng() * DAILY_SIZE_RANGE);
  const cols = DAILY_MIN_SIZE + Math.floor(dRng() * DAILY_SIZE_RANGE);
  const density = DAILY_MIN_DENSITY + dRng() * DAILY_DENSITY_RANGE;
  const totalMines = Math.max(5, Math.round(rows * cols * density));
  const fr = Math.floor(rows / 2), fc = Math.floor(cols / 2);

  const boardRng = createDailyRNG(seed);
  let board = generateBoard(rows, cols, totalMines, fr, fc, boardRng);
  cleanSolverArtifacts(board);
  const activeGimmicks = getDailyGimmick(seed, createDailyRNG, forcedGimmick, singleOnly);

  let check = null;
  for (let dAttempt = 0; dAttempt < 200; dAttempt++) {
    if (dAttempt > 0) {
      const retryRng = createDailyRNG(seed + '-retry-' + dAttempt);
      board = generateBoard(rows, cols, totalMines, fr, fc, retryRng);
      cleanSolverArtifacts(board);
    }
    if (activeGimmicks.length > 0) {
      const gRng = createDailyRNG(seed + '-gimmick-apply-' + dAttempt);
      applyGimmicks(board, 1, activeGimmicks, gRng);
    }
    check = isBoardSolvable(board, rows, cols, fr, fc);
    cleanSolverArtifacts(board);
    if (check.solvable || check.remainingUnknowns === 0) break;
  }
  const decorative = (check && (check.solvable || check.remainingUnknowns === 0))
    ? findDecorativeGimmicks(board, rows, cols, fr, fc, activeGimmicks)
    : [];
  return { board, rows, cols, totalMines, activeGimmicks, check, decorative, fr, fc };
}

function selectWithFilter(dateString, spec, useLoadBearing) {
  let best = null, bestScore = -Infinity, bestSeed = null;
  let totalSolvable = 0, totalLoadBearing = 0;
  for (let i = 0; i < CANDIDATE_COUNT; i++) {
    const mission = missionForSlot(spec, i);
    const forced = TARGET_TO_GIMMICK[mission.target] || null;
    const seed = `${dateString}:trial${i}`;
    const cand = buildOneCandidate(seed, forced, mission.singleOnly);
    if (!cand.check.solvable && cand.check.remainingUnknowns !== 0) continue;
    totalSolvable++;
    if (cand.decorative.length === 0) totalLoadBearing++;
    if (useLoadBearing && cand.decorative.length > 0) continue;
    const features = computeDailyFeatures(
      { board: cand.board, rows: cand.rows, cols: cand.cols, totalMines: cand.totalMines, activeGimmicks: cand.activeGimmicks },
      cand.check,
    );
    const count = features[mission.target] || 0;
    // Mirrors precompute-daily-board.mjs / selectDailyRngSeed.js: cap the
    // target count at 5 so wallEdgeCount (10-30) can't dwarf the cell-based
    // gimmicks (3-5 max) and dominate every selection.
    const score = Math.min(count, 5) * mission.deficitWeight;
    if (score > bestScore) {
      bestScore = score;
      bestSeed = seed;
      best = cand;
    }
  }
  return { best, bestSeed, bestScore, totalSolvable, totalLoadBearing };
}

(async () => {
  const args = process.argv.slice(2);
  const dates = args.length > 0 ? args : [
    '2026-04-28', '2026-05-01', '2026-05-03', '2026-05-04', '2026-05-05',
    '2026-05-06', '2026-05-07', '2026-05-08', '2026-05-09',
  ];
  const spec = loadSpec();
  console.log(`spec: target=${spec.target}, coverage=${spec.coverage_targets.length} entries`);
  console.log('');

  for (const date of dates) {
    const without = selectWithFilter(date, spec, false);
    const with_ = selectWithFilter(date, spec, true);
    const same = without.bestSeed === with_.bestSeed;
    console.log(`${date}:`);
    console.log(`  candidates: ${without.totalSolvable} solvable, ${without.totalLoadBearing} load-bearing`);
    console.log(`  WITHOUT filter: ${without.bestSeed || '(none)'}  modifiers=[${without.best?.activeGimmicks.join(',') || ''}]  decorative=[${without.best?.decorative.join(',') || ''}]`);
    console.log(`  WITH filter:    ${with_.bestSeed || '(fallback)'}  modifiers=[${with_.best?.activeGimmicks.join(',') || ''}]  decorative=[${with_.best?.decorative.join(',') || ''}]  ${same ? '== same' : '<<< CHANGED'}`);
    console.log('');
  }
})().catch(err => {
  console.error('test failed:', err.stack || err.message);
  process.exit(1);
});
