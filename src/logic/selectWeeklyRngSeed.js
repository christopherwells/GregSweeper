// Resolve the effective RNG seed for a weekly puzzle by trying 10
// candidate seeds and picking the winner with a BANDED argmax: gimmick
// count (primary) + advanced-logic-moves tiebreaker, weighted by how close
// the candidate's par sits to the week's target par (parBand.js,
// Christopher's ruling 2026-08-02: weeklies land between 60s and 360s,
// skewed lightly toward the easy end with occasional hard weeks).
// Candidates pricing outside the band are excluded outright unless the
// whole slate is outside, in which case the nearest board wins. Before the
// band, this argmax took the hardest stack available every week (shipped
// median 121s, tail to 251s); the stack stays 2-4 forced, the band just
// decides among stacks.
//
// This function is the ONE copy of the weekly selection rule:
// scripts/precompute-weekly-board.mjs calls it directly and rebuilds the
// winning candidate, rather than keeping the private contest copy it used
// to carry, the weekly half of the same mirror-pair drift class the daily
// side closed when the slot arithmetic drifted (see selectMissionWinner's
// history). The same dimension derivation and gimmick-application order as
// daily, just with the weekly pool and score.

import { createDailyRNG } from './seededRandom.js';
import { generateBoard, cleanSolverArtifacts } from './boardGenerator.js';
import { isBoardSolvable } from './boardSolver.js';
import { getWeeklyGimmicks, applyGimmicks } from './gimmicks.js';
import { computeDailyFeatures, predictPar } from './dailyFeatures.js';
import {
  WEEKLY_MIN_SIZE, WEEKLY_SIZE_RANGE, BOARD_WIDTH_CAP,
  DAILY_MIN_DENSITY, DAILY_DENSITY_RANGE,
} from './difficulty.js';
import { drawWeeklyTargetPar, WEEKLY_PAR_BAND, bandedArgmax } from './parBand.js';
import { clampRectDims } from './boardFit.js';

const CANDIDATE_COUNT = 10;

export function selectWeeklyRngSeed(weekStart) {
  const cands = [];

  for (let i = 0; i < CANDIDATE_COUNT; i++) {
    const seed = `${weekStart}:trial${i}`;

    const dRng = createDailyRNG(seed);
    // HIS RULING (2026-08-20): a weekly must not scroll at the default cell
    // size. clampRectDims is the ONE rule, and it replaces the old cols-only
    // cap: a NARROW board is the one that got too tall, because cells grow to
    // fill the width, so 14x8 stood 502px against a 462px budget while 14x12
    // is 362px. Clamping consumes no extra rng() call, so every stored
    // canonical's seed stream is untouched and only an illegal draw moves.
    const { rows, cols } = clampRectDims(
      WEEKLY_MIN_SIZE + Math.floor(dRng() * WEEKLY_SIZE_RANGE),
      WEEKLY_MIN_SIZE + Math.floor(dRng() * WEEKLY_SIZE_RANGE),
    );
    const density = DAILY_MIN_DENSITY + dRng() * DAILY_DENSITY_RANGE;
    const mines = Math.max(5, Math.round(rows * cols * density));
    const fr = Math.floor(rows / 2);
    const fc = Math.floor(cols / 2);

    const bRng = createDailyRNG(seed);
    const board = generateBoard(rows, cols, mines, fr, fc, bRng);
    cleanSolverArtifacts(board);

    // Always 2-4 gimmicks for weekly. Same first-attempt-only gimmick
    // application as daily's selectDailyRngSeed, if a candidate is
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
    // Par rides along for the band weight.
    const features = computeDailyFeatures(
      { board, rows, cols, totalMines: mines, activeGimmicks: gimmicks, rngSeed: seed },
      check,
    );
    const score = gimmicks.length + (check.advancedLogicMoves || 0) * 0.01;
    cands.push({ seed, score, par: predictPar(features) });
  }

  // Fallback to the bare weekStart if every candidate was unsolvable
  // on first pass, extremely rare with a forced 2-4 gimmick pool.
  if (cands.length === 0) return weekStart;
  const idx = bandedArgmax(cands, drawWeeklyTargetPar(weekStart), WEEKLY_PAR_BAND);
  return idx >= 0 ? cands[idx].seed : weekStart;
}
