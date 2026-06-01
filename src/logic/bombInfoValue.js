// Compute the "info-value" in par-seconds of the player learning that a
// specific cell is a mine. Used by the daily/weekly bomb-hit handler to
// turn the old constant +10s + re-fog penalty into a deterministic cost
// proportional to how much that mine was anchoring the rest of the solve.
//
// Approach (boards-from-scratch): run isBoardSolvable twice on the same
// board.
//   Run A: prior strikes are pre-flagged. The strike under evaluation is
//          NOT pre-flagged — the solver still has to identify it.
//   Run B: prior strikes AND the strike under evaluation are pre-flagged.
// Move-type counts drop in B by however much deduction the strike was
// anchoring. Weighting each drop by PAR_MODEL coefs converts that to
// par-seconds — the "info-value" we charge as the penalty.
//
// The solver only reads structural board fields (isMine, adjacency,
// gimmick fields) — it ignores the live isRevealed/isFlagged state — so
// the player's current progress doesn't enter the calculation. The
// info-value is a property of the board + the cell, not of the player's
// run. That's a deliberate V1 simplification; refining to a
// "remaining-from-current-state" model is a follow-up if calibration
// feels off in practice.

import { isBoardSolvable } from './boardSolver.js';
import { PAR_MODEL } from './difficulty.js';

// Solver move-type counter → its PAR_MODEL coefficient.
// disjunctiveMoves is intentionally omitted: PAR_MODEL has no
// secPerDisjunctiveMove (it was dropped 2026-05-04, absorbed into
// secPerLiarCell because disjunctive moves are confounded with the
// presence of liar cells).
const MOVE_TYPE_TO_COEF = {
  passAMoves:           'secPerPassAMove',
  canonicalSubsetMoves: 'secPerCanonicalSubsetMove',
  genericSubsetMoves:   'secPerGenericSubsetMove',
  advancedLogicMoves:   'secPerAdvancedLogicMove',
};

/**
 * @param {Array<Array<object>>} board       the canonical board (live state ignored)
 * @param {number} rows
 * @param {number} cols
 * @param {number} safeRow                   first-click row (typically Math.floor(rows/2))
 * @param {number} safeCol                   first-click col (typically Math.floor(cols/2))
 * @param {number} strikeRow                 the just-hit mine's row
 * @param {number} strikeCol                 the just-hit mine's col
 * @param {Array<{row:number,col:number}>} [priorStrikes=[]]
 *        Cells previously struck on this attempt. Pre-flagged in both
 *        runs so the returned info-value is the MARGINAL value of this
 *        hit given those prior ones, not the cumulative value.
 *
 * @returns {{
 *   infoValue: number,    // par-seconds, clamped to ≥ 0
 *   deltas: Object,       // {moveType → count delta (resultA - resultB)}
 *   resultA: Object,      // solver result with prior strikes pre-flagged
 *   resultB: Object,      // solver result with strike+prior pre-flagged
 * }}
 */
export function computeBombInfoValue(board, rows, cols, safeRow, safeCol, strikeRow, strikeCol, priorStrikes = []) {
  const priorFlags = Array.isArray(priorStrikes)
    ? priorStrikes
        .filter(p => p && Number.isInteger(p.row) && Number.isInteger(p.col))
        .map(p => ({ row: p.row, col: p.col }))
    : [];

  const resultA = isBoardSolvable(board, rows, cols, safeRow, safeCol, undefined, {
    preFlagCells: priorFlags,
  });
  const resultB = isBoardSolvable(board, rows, cols, safeRow, safeCol, undefined, {
    preFlagCells: [...priorFlags, { row: strikeRow, col: strikeCol }],
  });

  const deltas = {};
  let infoValue = 0;
  for (const moveKey of Object.keys(MOVE_TYPE_TO_COEF)) {
    const a = resultA[moveKey] || 0;
    const b = resultB[moveKey] || 0;
    const delta = a - b;
    deltas[moveKey] = delta;
    const coef = PAR_MODEL[MOVE_TYPE_TO_COEF[moveKey]] || 0;
    infoValue += delta * coef;
  }

  // Clamp ≥ 0. A mine whose discovery somehow ADDS solver work shouldn't
  // refund time; that would imply a negative penalty and a strict
  // incentive to bomb-pop, which would break the strategic framing.
  if (infoValue < 0) infoValue = 0;

  return { infoValue, deltas, resultA, resultB };
}
