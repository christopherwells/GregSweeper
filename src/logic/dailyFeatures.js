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

  // ── Structural features (added v1.5.16+) ─────────────
  // Three features computed from the board layout itself:
  //
  //  - nonZeroSafeCellCount: safe cells with adjacency > 0. These are
  //    the cells the player has to deduce (vs zero-adjacency cells
  //    that auto-cascade-reveal). Higher = more deduction work.
  //
  //  - zeroClusterCount: connected components of adjacency-0 cells.
  //    Each component is a cascade entry point. More clusters = more
  //    decisions about where to start clicking; fewer big cascades.
  //
  //  - fragmentationRatio: 1 - (largest-safe-region / total-safe-cells).
  //    0 = all safe cells form one connected region (easy to traverse).
  //    Approaches 1 = many small disconnected safe islands separated
  //    by mines (lots of separate puzzles to solve).
  //
  // All three are expected to have non-negative coefficients in the
  // par regression (more deduction work / more cascade entries / more
  // fragmentation = more time), which keeps them compatible with the
  // existing positive-only lognormal priors.
  let nonZeroSafeCellCount = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (!cell.isMine && (cell.adjacentMines || 0) > 0) nonZeroSafeCellCount++;
    }
  }

  // BFS connected components on the board. Two passes:
  //  pass 1 counts components of (safe && adj==0)  → zeroClusterCount
  //  pass 2 finds max component size of (safe)     → maxSafeRegionSize
  const dirs = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
  const visited = Array.from({ length: rows }, () => new Array(cols).fill(false));
  function bfsCount(r0, c0, pred) {
    let count = 0;
    const queue = [[r0, c0]];
    visited[r0][c0] = true;
    while (queue.length > 0) {
      const [r, c] = queue.shift();
      count++;
      for (const [dr, dc] of dirs) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        if (visited[nr][nc]) continue;
        if (!pred(board[nr][nc])) continue;
        visited[nr][nc] = true;
        queue.push([nr, nc]);
      }
    }
    return count;
  }

  let zeroClusterCount = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (visited[r][c]) continue;
      const cell = board[r][c];
      if (cell.isMine || (cell.adjacentMines || 0) !== 0) continue;
      bfsCount(r, c, ce => !ce.isMine && (ce.adjacentMines || 0) === 0);
      zeroClusterCount++;
    }
  }

  // Reset visited for the safe-region pass.
  for (const row of visited) row.fill(false);
  let maxSafeRegionSize = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (visited[r][c]) continue;
      if (board[r][c].isMine) continue;
      const size = bfsCount(r, c, ce => !ce.isMine);
      if (size > maxSafeRegionSize) maxSafeRegionSize = size;
    }
  }
  const safeCellCount = cellCount - totalMines;
  const fragmentationRatio = safeCellCount > 0
    ? 1 - (maxSafeRegionSize / safeCellCount)
    : 0;

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

    // Structural features (v1.5.16+ — see above for definitions)
    nonZeroSafeCellCount,
    zeroClusterCount,
    fragmentationRatio,
  };
}

// ── Model application ─────────────────────────────────

// Maps each PAR_MODEL coefficient to the feature field it multiplies.
// Keeping this table explicit (rather than implicit in predictPar's math)
// makes predictPar and breakdownPar share exactly one source of truth.
//
// `displayGroup` controls the label the modal shows. The regression still
// uses all five move-type coefficients independently, but for the UI they
// collapse into three intuitive buckets (easy / medium / hard). Gimmick
// and board-shape terms each stand alone with their natural name.
//
//   easy   = Pass A + canonical subsets (recognised instantly)
//   medium = generic subsets (some scanning)
//   hard   = advanced logic + disjunctive (the moves that actually slow you down)
const COEF_TERMS = [
  { coef: 'secPerPassAMove',           feature: 'passAMoves',           displayGroup: 'easy moves' },
  { coef: 'secPerCanonicalSubsetMove', feature: 'canonicalSubsetMoves', displayGroup: 'easy moves' },
  { coef: 'secPerGenericSubsetMove',   feature: 'genericSubsetMoves',   displayGroup: 'medium moves' },
  { coef: 'secPerAdvancedLogicMove',   feature: 'advancedLogicMoves',   displayGroup: 'hard moves' },
  { coef: 'secPerDisjunctiveMove',     feature: 'disjunctiveMoves',     displayGroup: 'hard moves' },
  { coef: 'secPerCell',                feature: 'cellCount',            displayGroup: 'baseline',    baseline: true },
  { coef: 'secPerMineFlag',            feature: 'totalMines',           displayGroup: 'baseline',    baseline: true },
  { coef: 'secPerWallEdge',            feature: 'wallEdgeCount',        displayGroup: 'walls' },
  { coef: 'secPerMysteryCell',         feature: 'mysteryCellCount',     displayGroup: 'mystery' },
  { coef: 'secPerLiarCell',            feature: 'liarCellCount',        displayGroup: 'liar' },
  { coef: 'secPerLockedCell',          feature: 'lockedCellCount',      displayGroup: 'locked' },
  { coef: 'secPerWormholePair',        feature: 'wormholePairCount',    displayGroup: 'wormhole' },
  { coef: 'secPerMirrorPair',          feature: 'mirrorPairCount',      displayGroup: 'mirror' },
  { coef: 'secPerSonarCell',           feature: 'sonarCellCount',       displayGroup: 'sonar' },
  { coef: 'secPerCompassCell',         feature: 'compassCellCount',     displayGroup: 'compass' },
  // Structural features (v1.5.16+). All grouped under "structure" so the
  // end-of-game breakdown shows a single combined chip rather than three
  // small ones — nonZeroSafeCells, zeroClusters, and fragmentation are
  // all aspects of the board's overall puzzle shape, not separate
  // mechanics the player can identify.
  { coef: 'secPerNonZeroSafeCell',     feature: 'nonZeroSafeCellCount', displayGroup: 'structure' },
  { coef: 'secPerZeroCluster',         feature: 'zeroClusterCount',     displayGroup: 'structure' },
  { coef: 'secPerFragmentation',       feature: 'fragmentationRatio',   displayGroup: 'structure' },
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
 * Returns an array of `{ label, seconds }`, ordered largest first.
 * Multiple coefficients sharing a `displayGroup` (e.g. Pass A and
 * canonical subsets both rolling up under "easy moves") are summed.
 * Zero-contribution groups are filtered out. Baseline-flagged terms
 * (intercept + board-size + flag-count) merge into a single "baseline"
 * chip so the modal stays readable on boards with many gimmicks.
 */
export function breakdownPar(features) {
  const byGroup = new Map();
  let baseline = PAR_MODEL.intercept;

  for (const { coef, feature, displayGroup, baseline: isBaseline } of COEF_TERMS) {
    const contribution = (PAR_MODEL[coef] || 0) * (features[feature] || 0);
    if (isBaseline) {
      baseline += contribution;
    } else if (contribution > 0) {
      byGroup.set(displayGroup, (byGroup.get(displayGroup) || 0) + contribution);
    }
  }

  const entries = [];
  for (const [label, seconds] of byGroup) {
    const rounded = Math.round(seconds * 10) / 10;
    if (rounded > 0) entries.push({ label, seconds: rounded });
  }

  entries.sort((a, b) => b.seconds - a.seconds);

  if (baseline > 0.05) {
    entries.push({ label: 'baseline', seconds: Math.round(baseline * 10) / 10 });
  }

  return entries;
}
