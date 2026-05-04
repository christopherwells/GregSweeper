// Resolve the "effective RNG seed" for a daily date by trying
// CANDIDATE_COUNT variant seeds, scoring each against its assigned
// mission, and returning the seed of the best-scoring candidate.
//
// The 10 slots split into one PRIMARY mission (slot 0, force-injects
// the high-CV target's gimmick, allowed to roll a second gimmick at
// the natural ~10% rate) and nine COVERAGE missions (slots 1-9, each
// force-injects a different undersampled gimmick from the ranked
// coverage_targets list, single-gimmick only). Scoring is:
//
//   score = target_count_in_features × deficit_weight
//
// where target/deficit_weight come from getMissionForSlot(i). The
// candidate with the highest score is the daily. Coverage slots'
// deficit weights are heavier than the primary slot's fixed low weight,
// so coverage missions win most days; the primary slot only wins when
// its target's cell count is high enough to overcome the weight gap —
// roughly 10% of the time when the coverage list is well-populated.
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
import {
  candidateSeed, CANDIDATE_COUNT, getTargetGimmickName, getMissionForSlot,
} from './experimentDesign.js';

export function selectDailyRngSeed(dateString) {
  let bestSeed = null;
  let bestScore = -Infinity;

  for (let i = 0; i < CANDIDATE_COUNT; i++) {
    const mission = getMissionForSlot(i);
    if (!mission || !mission.target) continue;
    const forcedGimmick = getTargetGimmickName(mission.target);
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
    // fewer competitor — the remaining slots still produce a valid
    // winner.
    const gimmicks = getDailyGimmick(seed, createDailyRNG, forcedGimmick, mission.singleOnly);
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
    const count = features[mission.target] || 0;
    const score = count * mission.deficitWeight;
    if (score > bestScore) {
      bestScore = score;
      bestSeed = seed;
    }
  }

  // If every candidate was unsolvable on first-pass gimmicks (extremely
  // rare), fall back to the plain dateString — the main generation path
  // has its own retry loop that'll sort it out.
  return bestSeed || dateString;
}
