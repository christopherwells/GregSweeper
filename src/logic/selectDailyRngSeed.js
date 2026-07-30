// Resolve the "effective RNG seed" for a daily date by trying
// CANDIDATE_COUNT variant seeds, scoring each against its assigned
// mission, and returning the seed of the best-scoring candidate.
//
// The slots split into one PRIMARY mission (slot 0, force-injects the
// high-CV target's gimmick, allowed to roll a second gimmick at the
// natural ~10% rate), a block of COVERAGE missions (each force-injects
// a different undersampled gimmick from the ranked coverage_targets
// list, single-gimmick only), and — on days the refit emits one — a
// block of DECORRELATION missions past the coverage list, which chase
// the residual of a confounded feature against its confounder rather
// than any feature's level.
//
// Scoring, the slot→mission mapping, AND the winner-pick all live in
// experimentDesign.js (missionCandidateScore / resolveMissionForSlot /
// selectMissionWinner). They are NOT reimplemented here: this file and
// scripts/daily-board-pipeline.mjs are a mirror pair that must pick the
// same seed, and the slot arithmetic having already drifted once across
// exactly that pair is why all three now delegate.
//
// The winner is drawn by a date-seeded weighted lottery over the scored
// slots (P ∝ score), not an argmax — deficit weights set each mission's
// FREQUENCY, so the most undersampled gimmick is the likeliest daily but
// never a monoculture (the argmax served worm 10 of 12 days straight,
// 2026-07-30). Decorrelation slots keep argmax supremacy; see
// selectMissionWinner for the full rationale.
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
  candidateSeed, getCandidateCount, getTargetGimmickName, getMissionForSlot,
  missionCandidateScore, selectMissionWinner,
} from './experimentDesign.js';

export function selectDailyRngSeed(dateString) {
  const scored = [];

  // Ordinary days evaluate CANDIDATE_COUNT slots; a decorrelation day adds a
  // block of decorrelation slots past the coverage list, since selection depth
  // is the only reach that mission has.
  const candidateCount = getCandidateCount();

  for (let i = 0; i < candidateCount; i++) {
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
      { board, rows, cols, totalMines: mines, activeGimmicks: gimmicks, rngSeed: seed },
      check,
    );
    const score = missionCandidateScore(mission, features);
    if (score === null) continue;
    scored.push({ score, mission, seed });
  }

  // Date-seeded weighted lottery over the scored slots (decorrelation
  // keeps argmax supremacy) — see selectMissionWinner. If every candidate
  // was unsolvable on first-pass gimmicks (extremely rare), fall back to
  // the plain dateString — the main generation path has its own retry
  // loop that'll sort it out.
  const winner = selectMissionWinner(scored, dateString);
  return winner ? winner.seed : dateString;
}
