// Daily board feature extraction + par prediction.
//
// The "Greg-par" model is a linear function of board features, fit in R offline
// on real completion data and shipped here as coefficients in PAR_MODEL
// (src/logic/difficulty.js). This module is the only place that computes
// features or applies the model — everything else (the game-over modal,
// the Firebase meta upload, the backfill utility) reads what this module
// produces.
//
// Core insight driving the feature set: it is not move count, it is move type.
// The solver classifies each of its deductions into one of five buckets
// (Pass A / canonical subset / generic subset / advanced / disjunctive) and
// returns counts. Those are the primary signal; board shape and gimmick cell
// counts are secondary features that the regression can weight or trim as
// the data warrants.

import { PAR_MODEL } from './difficulty.js';

// ── Feature extraction ────────────────────────────────

/**
 * Build the feature vector for a daily board at the moment it has been
 * generated, gimmicks applied, and the solver has confirmed solvability.
 *
 * @param {Object} state          live game state (after board/gimmicks set)
 * @param {Object} solverResult   return value of isBoardSolvable(...)
 * @returns {Object}              plain data object, safe to JSON-serialise
 */
export function computeDailyFeatures(state, solverResult) {
  const board = state.board;
  const rows = state.rows;
  const cols = state.cols;
  const totalMines = state.totalMines;
  const cellCount = rows * cols;
  const density = cellCount > 0 ? totalMines / cellCount : 0;

  // Gimmick cell counts: derive from the board itself rather than from
  // state.gimmickData, so the counts stay accurate even if a defuse / shield
  // mutation reshuffles things later. (This function runs before any play
  // happens, so right now the two are equivalent — reading the board is just
  // simpler and avoids coupling to gimmickData's internal shape.)
  let mysteryCellCount = 0;
  let liarCellCount = 0;
  let lockedCellCount = 0;
  let wormholeCellCount = 0;
  let mirrorCellCount = 0;
  let sonarCellCount = 0;
  let compassCellCount = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (cell.isMystery) mysteryCellCount++;
      if (cell.isLiar) liarCellCount++;
      if (cell.isLocked) lockedCellCount++;
      if (cell.isWormhole) wormholeCellCount++;
      if (cell.mirrorPair) mirrorCellCount++;
      if (cell.isSonar) sonarCellCount++;
      if (cell.isCompass) compassCellCount++;
    }
  }

  // Wormhole and mirror cells come in pairs — pair counts are the more natural
  // unit for the model (the player reasons about a pair, not two cells).
  const wormholePairCount = Math.floor(wormholeCellCount / 2);
  const mirrorPairCount = Math.floor(mirrorCellCount / 2);

  const wallEdgeCount = board._wallEdges ? board._wallEdges.size : 0;
  const gimmickTypeCount = Array.isArray(state.activeGimmicks) ? state.activeGimmicks.length : 0;

  return {
    // Move-type counts (primary features)
    passAMoves: solverResult.passAMoves ?? 0,
    canonicalSubsetMoves: solverResult.canonicalSubsetMoves ?? 0,
    genericSubsetMoves: solverResult.genericSubsetMoves ?? 0,
    advancedLogicMoves: solverResult.advancedLogicMoves ?? 0,
    disjunctiveMoves: solverResult.disjunctiveMoves ?? 0,
    totalClicks: solverResult.totalClicks ?? 0,

    // Board shape
    rows,
    cols,
    cellCount,
    totalMines,
    density,
    wallEdgeCount,
    remainingUnknowns: solverResult.remainingUnknowns ?? 0,
    techniqueLevel: solverResult.techniqueLevel ?? 0,

    // Gimmick cell counts
    gimmickTypeCount,
    mysteryCellCount,
    liarCellCount,
    lockedCellCount,
    wormholePairCount,
    mirrorPairCount,
    sonarCellCount,
    compassCellCount,
  };
}

// ── Model application ─────────────────────────────────

// Maps each PAR_MODEL coefficient to the feature field it multiplies.
// Keeping this table explicit (rather than implicit in predictPar's math)
// makes predictPar and breakdownPar share exactly one source of truth.
//
// Labels are what the modal renders as the "why this board was hard"
// breakdown. Style: sentence-case, compact, singular concept.
const COEF_TERMS = [
  { coef: 'secPerPassAMove',           feature: 'passAMoves',           label: 'Pass A moves' },
  { coef: 'secPerCanonicalSubsetMove', feature: 'canonicalSubsetMoves', label: 'canonical subsets' },
  { coef: 'secPerGenericSubsetMove',   feature: 'genericSubsetMoves',   label: 'generic subsets' },
  { coef: 'secPerAdvancedLogicMove',   feature: 'advancedLogicMoves',   label: 'advanced logic' },
  { coef: 'secPerDisjunctiveMove',     feature: 'disjunctiveMoves',     label: 'disjunctive logic' },
  { coef: 'secPerCell',                feature: 'cellCount',            label: 'board size',         baseline: true },
  { coef: 'secPerMineFlag',            feature: 'totalMines',           label: 'flag count',         baseline: true },
  { coef: 'secPerWallEdge',            feature: 'wallEdgeCount',        label: 'walls' },
  { coef: 'secPerMysteryCell',         feature: 'mysteryCellCount',     label: 'mystery' },
  { coef: 'secPerLiarCell',            feature: 'liarCellCount',        label: 'liar' },
  { coef: 'secPerLockedCell',          feature: 'lockedCellCount',      label: 'locked' },
  { coef: 'secPerWormholePair',        feature: 'wormholePairCount',    label: 'wormhole' },
  { coef: 'secPerMirrorPair',          feature: 'mirrorPairCount',      label: 'mirror' },
  { coef: 'secPerSonarCell',           feature: 'sonarCellCount',       label: 'sonar' },
  { coef: 'secPerCompassCell',         feature: 'compassCellCount',     label: 'compass' },
];

/**
 * Predicted par (in seconds) for a board described by `features`.
 * Rounded to 0.1s to match how par is displayed.
 */
export function predictPar(features) {
  let par = PAR_MODEL.intercept;
  for (const { coef, feature } of COEF_TERMS) {
    par += (PAR_MODEL[coef] || 0) * (features[feature] || 0);
  }
  return Math.round(par * 10) / 10;
}

/**
 * Per-term contribution breakdown for the game-over modal.
 * Returns an array of `{ label, seconds }`, ordered largest first, with:
 *   - Zero-contribution terms filtered out.
 *   - Baseline terms (intercept + board-size + flag-count) merged into a
 *     single `{ label: "baseline", seconds: N }` entry so the modal line
 *     doesn't become a wall of tiny contributions.
 */
export function breakdownPar(features) {
  const entries = [];
  let baseline = PAR_MODEL.intercept;

  for (const { coef, feature, label, baseline: isBaseline } of COEF_TERMS) {
    const contribution = (PAR_MODEL[coef] || 0) * (features[feature] || 0);
    if (isBaseline) {
      baseline += contribution;
    } else if (contribution > 0.05) {
      entries.push({ label, seconds: Math.round(contribution * 10) / 10 });
    }
  }

  entries.sort((a, b) => b.seconds - a.seconds);

  if (baseline > 0.05) {
    entries.push({ label: 'baseline', seconds: Math.round(baseline * 10) / 10 });
  }

  return entries;
}
