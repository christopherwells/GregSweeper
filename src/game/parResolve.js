// ── On-demand par resolution ──────────────────────────
// Extracted from main.js (2026-07-10 split). Shared by the leaderboard
// modal and the title screen's Daily-card par badge — both can need par
// BEFORE the player has generated today's board.

import { state } from '../state/gameState.js';
import { loadDailyPar, saveDailyPar } from '../storage/statsStorage.js';
import { computeDailyFeatures, predictPar } from '../logic/dailyFeatures.js';
import { generateBoard, cleanSolverArtifacts } from '../logic/boardGenerator.js';
import { isBoardSolvable } from '../logic/boardSolver.js';
import { createDailyRNG } from '../logic/seededRandom.js';
import { selectDailyRngSeed } from '../logic/selectDailyRngSeed.js';
import { getMissionForSeed, getTargetGimmickName } from '../logic/experimentDesign.js';
import { getDailyGimmick, applyGimmicks } from '../logic/gimmicks.js';
import { loadDailyBoard, deserializeBoard } from '../firebase/dailyBoardSync.js';
import { loadWeeklyBoard } from '../firebase/weeklyBoardSync.js';
import { DAILY_MIN_SIZE, DAILY_SIZE_RANGE, DAILY_MIN_DENSITY, DAILY_DENSITY_RANGE } from '../logic/difficulty.js';
import { reportCaughtError } from '../diagnostics/errorReporter.js';

// Shared daily-par resolver. Cheap path: cached features (date-keyed in
// localStorage, or in-memory from a fresh play) -> predictPar. Fallback:
// solve today's canonical board, or only if Firebase has nothing,
// regenerate locally, then cache the result. ignoreInMemory skips the
// in-memory state.dailyFeatures source so the title card gets strictly
// today's-date par and never a previous play's leftover features.
export async function computeDailyParForDate(dateStr, ignoreInMemory = false) {
  const cached = loadDailyPar(dateStr);
  const featuresForPar = (ignoreInMemory ? null : state.dailyFeatures) || cached.features || null;
  let dailyPar = 0;
  let dailyMoves = (ignoreInMemory ? 0 : state.dailyMoves) || cached.moves;
  if (featuresForPar) {
    dailyPar = predictPar(featuresForPar);
    if (!dailyMoves && featuresForPar.totalClicks) dailyMoves = featuresForPar.totalClicks;
  }
  if (dailyPar === 0) {
    // Compute par on-demand. Try the canonical board on Firebase first
    // — every player today plays that exact layout, so par must come
    // from solving IT, not whatever the local generator would produce.
    // Falls back to local generation only when Firebase has nothing
    // (very first player of a new date OR offline).
    try {
      let pBoard, pRows, pCols, pMines, activeGimmicks;
      let parResult;
      let pSeed; // effective RNG seed — wormLoad derives from it

      const canonicalRaw = await loadDailyBoard(dateStr).catch(err => { reportCaughtError('par-canonical-fetch', err); return null; });
      if (canonicalRaw) {
        const r = deserializeBoard(canonicalRaw);
        pBoard = r.board;
        pRows = r.rows;
        pCols = r.cols;
        pMines = r.totalMines;
        activeGimmicks = r.activeGimmicks || [];
        pSeed = r.rngSeed || dateStr;
        // Solve from the certified opener deserializeBoard returns — the ONE
        // definition (stored firstClick on a tiling, container centre on a
        // rectangle). The container-centre formula that lived here anchored a
        // tiling canonical's par on an unrelated container slot, where the
        // solve stalls at click 1 and par quietly comes out wrong (issue #195).
        const pFixedR = Math.floor(r.firstClick / pCols), pFixedC = r.firstClick % pCols;
        parResult = isBoardSolvable(pBoard, pRows, pCols, pFixedR, pFixedC);
        cleanSolverArtifacts(pBoard);
      } else {
        // Mirror the daily-gen path: resolve the effective RNG seed first so
        // the computed par matches what the player will actually see when
        // they start today's daily (especially on adaptive-experiment days).
        const rngSeed = selectDailyRngSeed(dateStr);
        pSeed = rngSeed;
        const dimRng = createDailyRNG(rngSeed);
        pRows = DAILY_MIN_SIZE + Math.floor(dimRng() * DAILY_SIZE_RANGE);
        pCols = DAILY_MIN_SIZE + Math.floor(dimRng() * DAILY_SIZE_RANGE);
        const pDensity = DAILY_MIN_DENSITY + dimRng() * DAILY_DENSITY_RANGE;
        pMines = Math.max(5, Math.round(pRows * pCols * pDensity));
        const pFixedR = Math.floor(pRows / 2), pFixedC = Math.floor(pCols / 2);
        // Recover the mission that won the seed selection so we
        // force-inject the same gimmick (and respect the single-only
        // constraint for coverage slots) the selector evaluated.
        const parMission = getMissionForSeed(rngSeed);
        const forcedGimmick = getTargetGimmickName(parMission.target);
        activeGimmicks = getDailyGimmick(rngSeed, createDailyRNG, forcedGimmick, parMission.singleOnly);

        for (let attempt = 0; attempt < 50; attempt++) {
          const boardRng = attempt === 0
            ? createDailyRNG(rngSeed)
            : createDailyRNG(rngSeed + '-retry-' + attempt);
          pBoard = generateBoard(pRows, pCols, pMines, pFixedR, pFixedC, boardRng);
          cleanSolverArtifacts(pBoard);
          if (activeGimmicks.length > 0) {
            const gRng = createDailyRNG(rngSeed + '-gimmick-apply-' + attempt);
            applyGimmicks(pBoard, 1, activeGimmicks, gRng);
          }
          parResult = isBoardSolvable(pBoard, pRows, pCols, pFixedR, pFixedC);
          cleanSolverArtifacts(pBoard);
          if (parResult.solvable || parResult.remainingUnknowns === 0) break;
        }
      }

      if (parResult && (parResult.solvable || parResult.remainingUnknowns === 0)) {
        const features = computeDailyFeatures(
          { board: pBoard, rows: pRows, cols: pCols, totalMines: pMines, activeGimmicks, rngSeed: pSeed },
          parResult,
        );
        dailyPar = predictPar(features);
        dailyMoves = parResult.totalClicks;
        saveDailyPar(dateStr, dailyPar, dailyMoves, features);
      }
    } catch (e) { dailyPar = 0; }
  }
  return { par: dailyPar, moves: dailyMoves };
}

// Weekly par: solve the canonical weekly board once per session (same
// canonical-solve path as computeDailyParForDate's Firebase branch).
const _weeklyParCache = new Map();
export async function computeWeeklyPar(weekStart) {
  if (_weeklyParCache.has(weekStart)) return _weeklyParCache.get(weekStart);
  let par = 0;
  try {
    const raw = await loadWeeklyBoard(weekStart).catch(() => null);
    if (raw) {
      const r = deserializeBoard(raw);
      // Same single definition of the certified opener as the daily branch
      // above (issue #195).
      const fr = Math.floor(r.firstClick / r.cols), fc = r.firstClick % r.cols;
      const check = isBoardSolvable(r.board, r.rows, r.cols, fr, fc);
      cleanSolverArtifacts(r.board);
      if (check.solvable || check.remainingUnknowns === 0) {
        const features = computeDailyFeatures(
          { board: r.board, rows: r.rows, cols: r.cols, totalMines: r.totalMines, activeGimmicks: r.activeGimmicks || [], rngSeed: r.rngSeed || '' },
          check,
        );
        par = predictPar(features);
      }
    }
  } catch { par = 0; }
  _weeklyParCache.set(weekStart, par);
  return par;
}
