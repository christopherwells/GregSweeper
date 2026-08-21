// Compute the "info-value" in par-seconds of the player learning that a
// specific cell is a mine. Used by the daily/weekly bomb-hit handler to
// turn the old constant +10s + re-fog penalty into a deterministic cost
// proportional to how much that mine was anchoring the rest of the solve.
//
// Approach (boards-from-scratch): run isBoardSolvable twice on the same
// board.
//   Run A: prior strikes are pre-flagged. The strike under evaluation is
//          NOT pre-flagged, the solver still has to identify it.
//   Run B: prior strikes AND the strike under evaluation are pre-flagged.
// Move-type counts drop in B by however much deduction the strike was
// anchoring. Weighting each drop by PAR_MODEL coefs converts that to
// par-seconds, the "info-value" we charge as the penalty.
//
// The solver only reads structural board fields (isMine, adjacency,
// gimmick fields), it ignores the live isRevealed/isFlagged state, so
// the player's current progress doesn't enter the calculation. The
// info-value is a property of the board + the cell, not of the player's
// run. That's a deliberate V1 simplification; refining to a
// "remaining-from-current-state" model is a follow-up if calibration
// feels off in practice.

import { isBoardSolvable } from './boardSolver.js';
import { PAR_MODEL } from './difficulty.js';
import { predictPar } from './dailyFeatures.js';

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
// PAR_MODEL key, the original four-name mapping silently zeroed every
// info-value for the hours between PR #32 and this fix because nothing
// checked the names against the model.
export const POOLED_TERMS = [
  // The COEF names track the rate form (2026-08-20). Only the de-wiring
  // guard reads them: the price itself is a predictPar DIFFERENCE between two
  // feature vectors, so the per-cell division happens inside the model and
  // this file never converts anything. The moveKeys are stored FEATURE keys
  // and do not move.
  { coef: 'secPerPatternRate', moveKeys: ['canonicalSubsetMoves', 'genericSubsetMoves'] },
  { coef: 'secPerSearchRate',  moveKeys: ['advancedLogicMoves'] },
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
 * @param {object|null} [boardFeatures=null]
 *        The board's daily/weekly feature vector (state.dailyFeatures /
 *        state.weeklyFeatures). Sets the multiplicative par baseline used
 *        to price the info-value under the log-scale model; ignored (all
 *        shape terms cancel) under the additive model. Pass it so a struck
 *        mine on a hard board is priced against that board's own par.
 * @param {number|null} [parBaseline=null]
 *        The board's SANE displayed par (the anchored number on an
 *        oversized board). When supplied, the info-value is the move
 *        SHARE priced at this baseline instead of at the raw model read,
 *        which is a no-op on fit boards and the whole fix on oversized
 *        ones (see the rescale below).
 * @param {{liveState?: boolean}} [opts={}]
 *        `liveState: false` prices from the OPENER instead of from the
 *        player's board. The live reading is the shipped rule; the opener
 *        reading survives for callers that hold a stored payload rather
 *        than a played board (matchRepair), where "what is revealed" is
 *        not a question the board can answer.
 *
 * @returns {{
 *   infoValue: number,    // par-seconds, clamped to ≥ 0
 *   deltas: Object,       // {moveType → count delta (resultA - resultB)}
 *   resultA: Object,      // solver result with prior strikes pre-flagged
 *   resultB: Object,      // solver result with strike+prior pre-flagged
 * }}
 */
export function computeBombInfoValue(board, rows, cols, safeRow, safeCol, strikeRow, strikeCol, priorStrikes = [], boardFeatures = null, parBaseline = null, opts = {}) {
  const priorFlags = Array.isArray(priorStrikes)
    ? priorStrikes
        .filter(p => p && Number.isInteger(p.row) && Number.isInteger(p.col))
        .map(p => ({ row: p.row, col: p.col }))
    : [];

  // FROM THE PLAYER'S BOARD, not from the opener (his ruling 2026-08-20: "a
  // check of what the par is now that the mine is hit given the live board").
  // Both solves resume from what is already revealed, so the counts they
  // return are the work REMAINING, and their difference is what learning
  // this mine actually saved THIS player from here. The from-scratch reading
  // charged for deduction they had already done: he hit a mine sitting
  // inside cleared territory and was billed ~90s, and a probe with every
  // safe cell revealed still charged 8-16s a strike.
  //
  // `liveState` defaults ON for the strike path and can be switched off, so
  // an offline re-derivation with no live board (matchRepair replaying a
  // stored payload) still gets the old, well-defined answer rather than
  // pricing against a board that reads as untouched.
  const resume = opts.liveState !== false;
  const resultA = isBoardSolvable(board, rows, cols, safeRow, safeCol, undefined, {
    preFlagCells: priorFlags,
    resumeFromLiveState: resume,
  });
  const resultB = isBoardSolvable(board, rows, cols, safeRow, safeCol, undefined, {
    preFlagCells: [...priorFlags, { row: strikeRow, col: strikeCol }],
    resumeFromLiveState: resume,
  });

  const deltas = {};
  for (const moveKey of RAW_DELTA_KEYS) {
    deltas[moveKey] = (resultA[moveKey] || 0) - (resultB[moveKey] || 0);
  }

  // Loud failure beats a silent zero: a missing coefficient means the
  // PAR_MODEL names drifted (the exact regression the POOLED_TERMS guard
  // caught). The caller (handleDailyBombHit) catches, warns, and charges
  // the base penalty, so the player is never stranded, but the break is
  // visible instead of quietly pricing at 0.
  for (const term of POOLED_TERMS) {
    if (typeof PAR_MODEL[term.coef] !== 'number') {
      throw new Error(`PAR_MODEL is missing coefficient "${term.coef}", bomb pricing is de-wired`);
    }
  }

  // Price the info-value as the PAR DIFFERENCE the mine's information makes:
  // par(with the moves it anchored) − par(without them). Scale-agnostic,
  // under the additive model this equals Σ pooledDelta × coef (the original
  // formula, since every board-shape term cancels and the intercept drops
  // out); under the log model it is the correct MARGINAL seconds at the
  // board's own par, so a struck mine on a hard board is dearer than the
  // same deduction on an easy one. Only the pooled reasoning-move counts
  // differ between the two vectors; boardFeatures supplies the shared
  // shape terms that set the multiplicative baseline under the log scale.
  const pooledMoveKeys = POOLED_TERMS.flatMap(term => term.moveKeys);
  const featuresWith = { ...(boardFeatures || {}) };
  const featuresWithout = { ...(boardFeatures || {}) };
  for (const k of pooledMoveKeys) {
    featuresWith[k] = resultA[k] || 0;
    featuresWithout[k] = resultB[k] || 0;
  }
  let infoValue = predictPar(featuresWith) - predictPar(featuresWithout);

  // THE OVERSIZED RESCALE (his report, 2026-08-19: two Classic marathon
  // boards read "10 h over par", and "the mine penalties were all
  // enormous"). Under the log model the difference above carries the
  // board's full multiplicative baseline, exp(everything) x the move
  // share; past a shape's fit ceiling that baseline is the raw
  // extrapolation the marathon lane exists to avoid: the same
  // move share that prices a few seconds on a fit board priced THOUSANDS
  // of par-seconds per strike. The par DISPLAY was already guarded (the
  // parProvisional carve-outs in gameActions); this was the consumer left
  // behind. The fix prices the move SHARE against the board's sane par:
  // infoValue x (parBaseline / rawWith) algebraically equals
  // parBaseline x (1 - exp(movesB - movesA)), the marginal share at the
  // anchored price. On a fit board the caller's baseline IS
  // predictPar(features), the ratio is 1, and this is a no-op.
  // The factor is a property of the BOARD, never of this strike: the ratio
  // of the board's sane par to the board's OWN raw model read, both over
  // the same stored feature vector. The first cut divided by the
  // per-strike read instead (issue #391), which equals the board's read
  // only while no prior strike has removed a pooled deduction; from the
  // second strike on, the ratio climbed above 1 and CHARGED MORE than the
  // pre-fix formula, on ordinary fit boards the change claimed to leave
  // alone (measured on shipped library boards: a 72-cell deltoidal went
  // 670.6s to 1213.3s, worst single strike 3.77x). Over the board's own
  // read the move terms cancel, so the ratio is exactly 1 on a fit board
  // for EVERY strike, and on an oversized one it is the constant
  // anchored-over-extrapolated correction the lane needs.
  const rawBoardPar = boardFeatures ? predictPar(boardFeatures) : 0;
  if (Number.isFinite(parBaseline) && parBaseline > 0 && rawBoardPar > 0) {
    infoValue *= parBaseline / rawBoardPar;
  }

  // Clamp ≥ 0. A mine whose discovery somehow ADDS solver work shouldn't
  // refund time; that would imply a negative penalty and a strict
  // incentive to bomb-pop, which would break the strategic framing.
  if (infoValue < 0) infoValue = 0;

  // THE RE-PRICEABLE RECORD (his requirement, 2026-08-20: "I'd love for all
  // the old data to be usable still... we don't know the board state for
  // every board when a mine was hit, so you can't recalculate the hit when
  // the par is recalculated").
  //
  // He is right, and it is the one real cost of pricing from the live board:
  // the seconds are measured under the model of the day, and the revealed
  // set that produced them is not stored anywhere, so a later model could
  // never re-derive them. The answer is to record the measurement in
  // MODEL-INDEPENDENT units. The two solves differ only in their pooled
  // remaining move counts, so those four numbers plus the board's own
  // feature vector (already stored) are enough for ANY future model to
  // recompute the seconds exactly, with no board state and no solver run.
  // repriceStoredStrike below is that computation, and the shape it reads
  // is the shape the strike event stores.
  const pooledOf = (r) => ({
    pattern: (r.canonicalSubsetMoves || 0) + (r.genericSubsetMoves || 0),
    search: r.advancedLogicMoves || 0,
  });
  const before = pooledOf(resultA);
  const after = pooledOf(resultB);

  return {
    infoValue,
    deltas,
    resultA,
    resultB,
    patternBefore: before.pattern,
    searchBefore: before.search,
    patternAfter: after.pattern,
    searchAfter: after.search,
  };
}

/**
 * Re-derive a stored strike's info-value under the CURRENT model, from the
 * numbers the event carries rather than from the board it was played on.
 *
 * This is what makes a live-state price survive a refit: the stored counts
 * are a measurement of the BOARD STATE (how much reasoning remained, with
 * and without the mine), which no model change can invalidate, while the
 * seconds they imply move with every refit. A row missing the counts (any
 * strike recorded before 2026-08-20) returns null, which callers must read
 * as "keep the stored seconds" rather than as zero.
 *
 * @param {object} ev       the stored strike event
 * @param {object} features the board's stored feature vector
 * @param {number} parBaseline the board's sane par (the anchored one on an
 *   oversized board), the same baseline the live pricing used
 * @returns {number|null} info-value in seconds under today's model
 */
export function repriceStoredStrike(ev, features, parBaseline = null) {
  if (!ev || !features) return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const pB = n(ev.patternBefore), sB = n(ev.searchBefore);
  const pA = n(ev.patternAfter), sA = n(ev.searchAfter);
  if (pB == null || sB == null || pA == null || sA == null) return null;
  const withMoves = { ...features, canonicalSubsetMoves: pB, genericSubsetMoves: 0, advancedLogicMoves: sB };
  const withoutMoves = { ...features, canonicalSubsetMoves: pA, genericSubsetMoves: 0, advancedLogicMoves: sA };
  let out = predictPar(withMoves) - predictPar(withoutMoves);
  const rawBoardPar = predictPar(features);
  if (Number.isFinite(parBaseline) && parBaseline > 0 && rawBoardPar > 0) {
    out *= parBaseline / rawBoardPar;
  }
  return out < 0 ? 0 : Math.round(out * 10) / 10;
}
