// Resolve the effective RNG seed for a weekly puzzle by trying 10
// candidate seeds, scoring each by gimmick count + advanced-logic-moves
// tiebreaker, and returning the seed of the highest-scoring candidate.
//
// Unlike daily's experiment-design system (which optimises for data
// collection on a high-CV target), weekly's selection rule is simple:
// among all candidates with the most modifiers stacked, prefer the one
// that requires the most advanced logic to solve. The same dimension
// derivation and gimmick-application order as daily, just with a
// different pool/score function.

import { createDailyRNG } from './seededRandom.js';
import { generateBoard, cleanSolverArtifacts } from './boardGenerator.js';
import { isBoardSolvable } from './boardSolver.js';
import { getWeeklyGimmicks, applyGimmicks } from './gimmicks.js';
import {
  WEEKLY_MIN_SIZE, WEEKLY_SIZE_RANGE,
  DAILY_MIN_DENSITY, DAILY_DENSITY_RANGE,
} from './difficulty.js';

const CANDIDATE_COUNT = 10;

export function selectWeeklyRngSeed(weekStart) {
  let bestSeed = null;
  let bestScore = -Infinity;

  for (let i = 0; i < CANDIDATE_COUNT; i++) {
    const seed = `${weekStart}:trial${i}`;

    const dRng = createDailyRNG(seed);
    const rows = WEEKLY_MIN_SIZE + Math.floor(dRng() * WEEKLY_SIZE_RANGE);
    const cols = WEEKLY_MIN_SIZE + Math.floor(dRng() * WEEKLY_SIZE_RANGE);
    const density = DAILY_MIN_DENSITY + dRng() * DAILY_DENSITY_RANGE;
    const mines = Math.max(5, Math.round(rows * cols * density));
    const fr = Math.floor(rows / 2);
    const fc = Math.floor(cols / 2);

    const bRng = createDailyRNG(seed);
    const board = generateBoard(rows, cols, mines, fr, fc, bRng);
    cleanSolverArtifacts(board);

    // Always 2–4 gimmicks for weekly. Same first-attempt-only gimmick
    // application as daily's selectDailyRngSeed — if a candidate is
    // unsolvable on first pass, skip it; rare with a 14×14 board.
    const gimmicks = getWeeklyGimmicks(seed, createDailyRNG);
    if (gimmicks.length > 0) {
      const gRng = createDailyRNG(seed + '-gimmick-apply-0');
      applyGimmicks(board, 1, gimmicks, gRng);
    }

    const check = isBoardSolvable(board, rows, cols, fr, fc);
    cleanSolverArtifacts(board);
    if (!check.solvable && check.remainingUnknowns !== 0) continue;

    // Score: gimmick count (primary) + advancedLogicMoves * 0.01
    // (tiebreaker among same-mod-count candidates → harder-to-solve wins).
    const score = gimmicks.length + (check.advancedLogicMoves || 0) * 0.01;
    if (score > bestScore) {
      bestScore = score;
      bestSeed = seed;
    }
  }

  // Fallback to the bare weekStart if every candidate was unsolvable
  // on first pass — extremely rare with a forced 2–4 gimmick pool.
  return bestSeed || weekStart;
}
