// Resolve the "effective RNG seed" for a daily date. On improvement days
// (see experimentDesign.js), try CANDIDATE_COUNT variant seeds per date,
// generate + solve each candidate board, and return the seed whose board
// has the highest count of the targeted feature — pushing the daily
// population toward exercising axes where the Bayesian refit's posterior
// is still uncertain. On non-improvement days, or if no candidate is
// solvable, return the dateString unchanged.
//
// Called from two places: gameActions.js (the actual play flow) and
// main.js (the on-demand par calculation for the leaderboard when the
// player hasn't started today's daily yet). Both need to agree on the
// effective seed, which is why this logic lives in its own module
// rather than being duplicated.
//
// Mirrors the daily generation path in gameActions.js exactly: same
// dimension derivation, same gimmick application order, same
// solvability check. If the two ever drift, the selected candidate's
// claimed target-feature count won't match what the main path actually
// produces, and the bias signal evaporates.

import { createDailyRNG } from './seededRandom.js';
import { generateBoard, cleanSolverArtifacts } from './boardGenerator.js';
import { isBoardSolvable } from './boardSolver.js';
import { getDailyGimmick, applyGimmicks } from './gimmicks.js';
import { computeDailyFeatures } from './dailyFeatures.js';
import {
  DAILY_MIN_SIZE, DAILY_SIZE_RANGE,
  DAILY_MIN_DENSITY, DAILY_DENSITY_RANGE,
} from './difficulty.js';
import { getExperimentTarget, candidateSeed, CANDIDATE_COUNT } from './experimentDesign.js';

export function selectDailyRngSeed(dateString) {
  const target = getExperimentTarget(dateString);
  if (!target) return dateString;

  let bestSeed = null;
  let bestCount = -1;
  for (let i = 0; i < CANDIDATE_COUNT; i++) {
    const seed = candidateSeed(dateString, i);

    // Derive dimensions from the first three RNG calls — matches the
    // gameActions.js `state.rows/cols/totalMines` block exactly.
    const dRng = createDailyRNG(seed);
    const rows = DAILY_MIN_SIZE + Math.floor(dRng() * DAILY_SIZE_RANGE);
    const cols = DAILY_MIN_SIZE + Math.floor(dRng() * DAILY_SIZE_RANGE);
    const density = DAILY_MIN_DENSITY + dRng() * DAILY_DENSITY_RANGE;
    const mines = Math.max(5, Math.round(rows * cols * density));
    const fr = Math.floor(rows / 2);
    const fc = Math.floor(cols / 2);

    // Board generation with a fresh RNG stream (matches gameActions).
    const bRng = createDailyRNG(seed);
    const board = generateBoard(rows, cols, mines, fr, fc, bRng);
    cleanSolverArtifacts(board);

    // First-attempt gimmick pass only. Candidates that need retries to
    // become solvable are rare; skipping them here is simpler than
    // reproducing the retry loop, and a skipped candidate just means one
    // fewer competitor for "most target feature" — the remaining N-1
    // still produce a valid winner.
    const gimmicks = getDailyGimmick(seed, createDailyRNG);
    if (gimmicks.length > 0) {
      const gRng = createDailyRNG(seed + '-gimmick-apply-0');
      applyGimmicks(board, 1, gimmicks, gRng);
    }

    const check = isBoardSolvable(board, rows, cols, fr, fc);
    cleanSolverArtifacts(board);
    if (!check.solvable && check.remainingUnknowns !== 0) continue;

    const features = computeDailyFeatures(
      { board, rows, cols, totalMines: mines, activeGimmicks: gimmicks },
      check,
    );
    const count = features[target] || 0;
    if (count > bestCount) {
      bestCount = count;
      bestSeed = seed;
    }
  }

  // If every candidate was unsolvable on first-pass gimmicks (extremely
  // rare), fall back to the plain dateString — the main generation path
  // has its own retry loop that'll sort it out.
  return bestSeed || dateString;
}
