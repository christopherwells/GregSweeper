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

// Solver move-type counters → the pooled PAR_MODEL coefficients from the
// 2026-06-08 identifiability rework (PR #36): the four raw counters pool
// into two earned tiers, pattern (subset deductions) and search
// (tank/gauss enumeration).
//
// Deliberately unpriced:
//   - passAMoves: the rework absorbed trivial propagation into cellCount
//     (it's a board-size proxy), so deduction a mine anchors in Pass A
//     prices at 0. Cascade-anchoring mines are therefore underpriced
//     relative to the pre-rework four-coefficient scale; the flat
//     BOMB_PENALTY_BASE keeps every strike non-free regardless.
//   - disjunctiveMoves: dropped 2026-05-04, confounded with liar-cell
//     presence (absorbed into secPerLiarCell).
//
// Exported for the unit test that pins each coef name to a live
// PAR_MODEL key — the original four-name mapping silently zeroed every
// info-value for the hours between PR #32 and this fix because nothing
// checked the names against the model.
export const POOLED_TERMS = [
  { coef: 'secPerPatternMove', moveKeys: ['canonicalSubsetMoves', 'genericSubsetMoves'] },
  { coef: 'secPerSearchMove',  moveKeys: ['advancedLogicMoves'] },
];

// All five raw solver counters, reported in `deltas` for diagnostics and
// offline re-weighting (scripts/reanchor-bomb-tiers.mjs) even where the
// pricing above ignores them.
const RAW_DELTA_KEYS = ['passAMoves', 'canonicalSubsetMoves', 'genericSubsetMoves', 'advancedLogicMoves', 'disjunctiveMoves'];

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
  for (const moveKey of RAW_DELTA_KEYS) {
    deltas[moveKey] = (resultA[moveKey] || 0) - (resultB[moveKey] || 0);
  }

  let infoValue = 0;
  for (const term of POOLED_TERMS) {
    // Loud failure beats a silent zero: a missing coefficient means the
    // PAR_MODEL names drifted (the exact regression this rewrite fixes).
    // The caller (handleDailyBombHit) catches, warns, and charges the
    // base penalty, so the player is never stranded — but the break is
    // visible instead of quietly logging infoValue: 0 to Firebase.
    if (typeof PAR_MODEL[term.coef] !== 'number') {
      throw new Error(`PAR_MODEL is missing coefficient "${term.coef}" — bomb pricing is de-wired`);
    }
    const pooledDelta = term.moveKeys.reduce((sum, k) => sum + deltas[k], 0);
    infoValue += pooledDelta * PAR_MODEL[term.coef];
  }

  // Clamp ≥ 0. A mine whose discovery somehow ADDS solver work shouldn't
  // refund time; that would imply a negative penalty and a strict
  // incentive to bomb-pop, which would break the strategic framing.
  if (infoValue < 0) infoValue = 0;

  return { infoValue, deltas, resultA, resultB };
}
