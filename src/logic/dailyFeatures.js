// Daily board feature extraction + par prediction.
//
// The "Greg-par" model is a linear function of board features, fit in R offline
// on real completion data and shipped here as coefficients in PAR_MODEL
// (src/logic/difficulty.js). This module is the only place that computes
// features or applies the model, everything else (the game-over modal,
// the Firebase meta upload, the backfill utility) reads what this module
// produces.
//
// Core insight driving the feature set: it is not move count, it is move type.
// The solver classifies each of its deductions into one of five buckets
// (Pass A / canonical subset / generic subset / advanced / disjunctive) and
// returns counts. Those are the primary signal; board dimensions and gimmick cell
// counts are secondary features that the regression can weight or trim as
// the data warrants.

import { PAR_MODEL, PAR_MODEL_TIMED, PAR_MODEL_SHAPES } from './difficulty.js';
import { wormLoadFor } from './worms.js';
import { buildNeighborCache } from './adjacency.js';
import { computeContributionFeatures, CONTRIBUTION_FEATURE_KEYS } from './boardSolver.js';

// ── Clue-digit shares ─────────────────────────────────
//
// The arithmetic-load axis: of the clues that show a NUMBER, what fraction
// are 2s, 3s, 4s, 5-and-up? Nonzero-digit SHARES with 5+ lumped and 1s the
// omitted reference, scaled ×10 so one unit reads as "one extra clue-in-ten
// of that digit". Raw counts are density in disguise (mean clue ≈ 8 × density,
// r ≈ 0.94), so only the SHAPE at fixed density can carry signal.
//
// This is a straight port of `clue_digit_counts` / `digit_shares_from_boards`
// in scripts/refit-par-model.R, and the two MUST agree cell-for-cell: R derives
// the shares from the stored canonical board for the fit (authoritative, full
// history back to DIGIT_ERA_START), while this copy exists so the axis is
// scorable at SELECTION time, before a board is written. Same rule on both
// sides, count a cell only if it eventually shows the player a number, and
// count the TRUE adjacency, never the gimmick-DISPLAYED magnitude (wormhole
// pair sums, sonar 5×5 counts) that the modifier terms already model.
//
// Exclusions, matching R exactly: mines carry no clue, mystery hides its
// number, and a pressure plate shows a timer rather than a count.
export const CLUE_SHARE_KEYS = ['clueShare2', 'clueShare3', 'clueShare4', 'clueShare5plus'];

// Shares are per-ten-clues, so a board with no numbered clue at all has no
// denominator; R drops that date, and here every share is 0.
//
// Counted into the four reported buckets plus a running denominator, with NO
// upper bound on the digit. This used to be a fixed nine-wide histogram
// (`if (v >= 0 && v <= 8) hist[v]++`), which quietly assumed no cell can touch
// more than eight others. True on a rectangle and on both tilings shipped
// through 2026-07-22, and false the moment a lattice with a higher valence
// arrives: a rhombille rhombus has ten corner-inclusive neighbors and a
// deltoidal kite nine, so a 9 or a 10 was dropped from the numerator AND the
// denominator and all four shares were computed over a smaller board than the
// one that exists. Nothing would have thrown, the shares would still have summed
// to at most ten, and the wrong number would have landed in a write-once
// dailyMeta row (the zeroClusterCount precedent). Bucketing has no ceiling to
// get wrong, so the next lattice cannot reintroduce one.
export function clueShares(board, rows, cols) {
  let nz = 0, n2 = 0, n3 = 0, n4 = 0, n5plus = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (cell.isMine || cell.isMystery || cell.isPressurePlate) continue;
      const v = cell.adjacentMines || 0;
      // Denominator is the cells that show a NUMBER. Zeros cascade away and are
      // already told as `zeroClusterCount`.
      if (v <= 0) continue;
      nz++;
      if (v === 2) n2++;
      else if (v === 3) n3++;
      else if (v === 4) n4++;
      else if (v >= 5) n5plus++;
    }
  }
  if (nz === 0) return { clueShare2: 0, clueShare3: 0, clueShare4: 0, clueShare5plus: 0 };
  return {
    clueShare2: (10 * n2) / nz,
    clueShare3: (10 * n3) / nz,
    clueShare4: (10 * n4) / nz,
    clueShare5plus: (10 * n5plus) / nz,
  };
}

// ── Feature extraction ────────────────────────────────

/**
 * The keys below whose values come from the SOLVER (the `solverResult`
 * argument) rather than from the board itself. Everything else
 * computeDailyFeatures emits is pure structure: the same board, dimensions and
 * rngSeed produce the same number under any version of the solver.
 *
 * The PRODUCER declares this, and the nightly canonical sweep
 * (scripts/verify-canonical-boards.mjs) reads it, because the sweep's whole
 * hard-fail-vs-warn split turns on the distinction: a structural mismatch
 * between a stored dailyMeta and a recompute can only be tampering or a
 * generator bug, while a solver-derived count drifts legitimately when a
 * solver change lands between a board's precompute night and the sweep.
 *
 * It lives here, and the sweep DEFAULTS to hard-fail for anything absent from
 * it, because the reverse arrangement already failed once: the sweep kept its
 * own hand-written allowlist of structural keys, two entries named fields this
 * function does not emit, and both real modifier counts silently fell through
 * to warn-only with nothing failing (issue #180). With the default inverted, a
 * newly-emitted structural feature is guarded the moment it exists, and the
 * failure mode of getting this list wrong is a LOUD false alarm rather than a
 * silently disarmed check.
 *
 * `test/dailyFeaturesClassification.test.mjs` pins the membership by
 * DIFFERENTIAL rather than by eye: it computes the vector twice over one board
 * with two different solverResults and asserts that exactly these keys move.
 *
 * Adding a feature key touches two more places that cannot import this list:
 * `FEATURES_EPOCH` in scripts/verify-canonical-boards.mjs (so the seven-day
 * precompute horizon is not read as tampering) and `NEW_STRUCTURAL_FEATURES`
 * in scripts/refit-par-model.R (so older rows get a 0 rather than an NA).
 */
export const RESULT_DRIVEN_FEATURE_KEYS = Object.freeze([
  'passAMoves',
  'canonicalSubsetMoves',
  'genericSubsetMoves',
  'advancedLogicMoves',
  'disjunctiveMoves',
  'totalClicks',
  'remainingUnknowns',
  'techniqueLevel',
]);

// Solver-derived splits into two sub-classes with different test handles but
// the same sweep treatment (warn on drift, never hard-fail):
//  - RESULT_DRIVEN: read straight off the passed solverResult, the
//    differential test varies the result object and watches them move.
//  - CONTRIBUTION: computed by their OWN strip-solves from the opener passed
//    via opts (see computeDailyFeatures below), a function of the solver's
//    CODE, not of the solverResult argument, so they drift exactly when a
//    solver change lands mid-horizon, which is the sweep's warn case.
export const SOLVER_DERIVED_FEATURE_KEYS = Object.freeze([
  ...RESULT_DRIVEN_FEATURE_KEYS,
  ...CONTRIBUTION_FEATURE_KEYS,
]);

/**
 * Build the feature vector for a daily board at the moment it has been
 * generated, gimmicks applied, and the solver has confirmed solvability.
 *
 * @param {Object} state          live game state (after board/gimmicks set)
 * @param {Object} solverResult   return value of isBoardSolvable(...)
 * @param {Object} [opts]
 * @param {{row: number, col: number}} [opts.contributionOpener]
 *   When present, the certified opener the CONTRIBUTION features
 *   (`<g>Required` / `<g>ClicksSaved`, see boardSolver's
 *   computeContributionFeatures) are strip-solved from, and the ten keys are
 *   emitted; absent, they are OMITTED entirely (like tilingType). The split
 *   is deliberate: the strip solves cost one extra solver run per testable
 *   type, so the candidate-scoring hot loops (selectDailyRngSeed, the
 *   pipeline's per-candidate pass) never pay it, only the sites that WRITE
 *   a features record do (final daily/weekly boards, the meta writers, the
 *   nightly verify sweep). A candidate vector therefore lacks the keys,
 *   which is safe: no mission scores on them, and missionCandidateScore
 *   reads only its own target key.
 * @returns {Object}              plain data object, safe to JSON-serialise
 */
export function computeDailyFeatures(state, solverResult, opts = {}) {
  const board = state.board;
  const rows = state.rows;
  const cols = state.cols;
  const totalMines = state.totalMines;
  const cellCount = rows * cols;
  const density = cellCount > 0 ? totalMines / cellCount : 0;

  // Gimmick cell counts: derive from the board itself rather than from
  // state.gimmickData, so the counts stay accurate even if a defuse / shield
  // mutation reshuffles things later. (This function runs before any play
  // happens, so right now the two are equivalent, reading the board is just
  // simpler and avoids coupling to gimmickData's internal shape.)
  let mysteryCellCount = 0;
  let liarCellCount = 0;
  let lockedCellCount = 0;
  let lockedMineCount = 0;
  let wormholeCellCount = 0;
  let mirrorCellCount = 0;
  let sonarCellCount = 0;
  let compassCellCount = 0;
  const wormEggs = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (cell.isMystery) mysteryCellCount++;
      if (cell.isLiar) liarCellCount++;
      if (cell.isLocked) {
        lockedCellCount++;
        // What is UNDER the lock changes the work: a locked number is
        // delayed information, a locked mine is a cell the player must
        // PROVE is a mine and never open (applyLocked places both,
        // "Allow mines AND numbered cells to be locked"). The split is
        // Christopher's observation, 2026-07-30; lockedNumberCount is
        // derived below so the pair always sums to lockedCellCount.
        if (cell.isMine) lockedMineCount++;
      }
      if (cell.isWormhole) wormholeCellCount++;
      if (cell.mirrorPair) mirrorCellCount++;
      if (cell.isSonar) sonarCellCount++;
      if (cell.isCompass) compassCellCount++;
      if (cell.isWormEgg) wormEggs.push({ r, c });
    }
  }
  const lockedNumberCount = lockedCellCount - lockedMineCount;

  // Worm exposure: total pre-programmed segment-moves in hundreds (see
  // wormLoadFor). Egg count alone can't carry the burden now that the
  // per-board lifetime varies 30-80, a 3-egg board at 30 moves is far
  // lighter than one at 80. The seed identity MUST match what the hatch
  // path uses (state.dailyRngSeed / weeklyRngSeed on the client; the
  // canonical payload's rngSeed on recompute paths, same value by the
  // resume-eligibility contract), or the stored feature would describe
  // worms nobody plays.
  const wormSeed = state.dailyRngSeed || state.weeklyRngSeed || state.rngSeed || '';
  const wormLoad = wormLoadFor(wormEggs, wormSeed);

  // Wormhole and mirror cells come in pairs, pair counts are the more natural
  // unit for the model (the player reasons about a pair, not two cells).
  const wormholePairCount = Math.floor(wormholeCellCount / 2);
  const mirrorPairCount = Math.floor(mirrorCellCount / 2);

  // Severed edges, asked of whichever wall layer the board actually stores.
  // A rectangular board stores them as `"r,c-r,c"` keys in `_wallEdges`; a
  // tiling stores index pairs in `_tilingWalls`, because `applyWallsTiling`
  // severs links straight out of `_cellNeighbors` and keeps the removed pairs
  // only so the renderer can draw them. Reading `_wallEdges` alone reported
  // every walled tiling board as wall-FREE, a plausible-looking zero rather
  // than an error (found 2026-07-23).
  //
  // The two units are not identical and the model should not pretend they are:
  // a rectangular wall edge blocks one orthogonal step plus up to two diagonal
  // ones, while a tiling wall edge blocks exactly one graph edge. Sharing the
  // COEFFICIENT NAME across topologies is a modeling assumption, and each
  // shape's own secPerWallEdge in PAR_MODEL_SHAPES (base + that shape's
  // earned wall deviation) is what absorbs the difference once data lands.
  const wallEdgeCount = board._tilingWalls
    ? board._tilingWalls.length
    : (board._wallEdges ? board._wallEdges.size : 0);
  const gimmickTypeCount = Array.isArray(state.activeGimmicks) ? state.activeGimmicks.length : 0;

  // ── Structural features (added v1.5.16+) ─────────────
  // Two features computed from the board layout itself:
  //
  //  - nonZeroSafeCellCount: safe cells with adjacency > 0. These are
  //    the cells the player has to deduce (vs zero-adjacency cells
  //    that auto-cascade-reveal). Higher = more deduction work.
  //
  //  - zeroClusterCount: connected components of adjacency-0 cells.
  //    Each component is a cascade entry point. More clusters = more
  //    decisions about where to start clicking; fewer big cascades.
  //
  // (A third feature, fragmentationRatio = 1 - maxSafeRegion/safeCells,
  // was tried briefly but turned out to be structurally zero on every
  // board we ship: with 8-dir adjacency, isolating a safe region from
  // the main mass requires complete mine encirclement, which makes the
  // isolated region UNSOLVABLE, and the solver filters those boards
  // out before they ever get committed as a daily. So we'd be fitting
  // noise on a metric that's zero by construction. Dropped.)
  //
  // Both remaining features expect non-negative coefficients in the
  // par regression (more deduction work / more cascade entries = more
  // time), so they fit the existing positive-only lognormal priors.
  let nonZeroSafeCellCount = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (!cell.isMine && (cell.adjacentMines || 0) > 0) nonZeroSafeCellCount++;
    }
  }

  // Count connected components of adj=0 safe cells, flooding along the BOARD'S
  // OWN adjacency rather than a hardcoded 8-neighborhood over (row, col).
  //
  // This used to walk a literal `dirs` array with rectangular bounds checks,
  // which was wrong two separate ways. On a TILING, `rows`/`cols` are pure
  // storage, `containerFor` returns any exact factorization, so 63 hexagons
  // ship as a 7×9 container and a prime cell count ships as 1×N, so the walk
  // counted components of a grid the board is not (measured: 8 vs 5 on a plain
  // 4.8.8, 3 vs 2 on a plain honeycomb, and 2.6× off on the 1×113 container).
  // On a walled RECTANGLE it was wall-BLIND, so it merged clusters that walls
  // genuinely separate and disagreed with the cascade the player actually sees.
  //
  // `buildNeighborCache` answers both: it derives the wall-severed
  // 8-neighborhood on a rectangle and returns the explicit edge list on a
  // tiling, so this is now one flood over whatever the board says touches what.
  // Fixing the rectangular half is a deliberate behavior change, it moves
  // `zeroClusterCount` on 8 of the 147 shipped canonicals, all by +1 cluster
  // (≈ +0.11% par at the current coefficient), and every one of those 8 carries
  // walls. Christopher's call, 2026-07-23: fix it properly rather than branch.
  const neighborCache = buildNeighborCache(board, rows, cols);
  const cellAtIndex = (i) => board[(i / cols) | 0][i % cols];
  const isZeroSafe = (cell) => !cell.isMine && (cell.adjacentMines || 0) === 0;
  const visited = new Uint8Array(rows * cols);
  let zeroClusterCount = 0;
  for (let i = 0; i < rows * cols; i++) {
    if (visited[i]) continue;
    if (!isZeroSafe(cellAtIndex(i))) continue;
    // Flood this cluster. A stack rather than the old `queue.shift()`, the
    // component is the same either way, and shift() on an array is O(n).
    const stack = [i];
    visited[i] = 1;
    while (stack.length > 0) {
      for (const nb of neighborCache[stack.pop()]) {
        if (visited[nb]) continue;
        if (!isZeroSafe(cellAtIndex(nb))) continue;
        visited[nb] = 1;
        stack.push(nb);
      }
    }
    zeroClusterCount++;
  }

  return {
    // Move-type counts (primary features)
    passAMoves: solverResult.passAMoves ?? 0,
    canonicalSubsetMoves: solverResult.canonicalSubsetMoves ?? 0,
    genericSubsetMoves: solverResult.genericSubsetMoves ?? 0,
    advancedLogicMoves: solverResult.advancedLogicMoves ?? 0,
    disjunctiveMoves: solverResult.disjunctiveMoves ?? 0,
    totalClicks: solverResult.totalClicks ?? 0,

    // Board dimensions
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
    lockedMineCount,
    lockedNumberCount,
    wormholePairCount,
    mirrorPairCount,
    sonarCellCount,
    compassCellCount,
    wormLoad,

    // Structural features (v1.5.16+, see above for definitions)
    nonZeroSafeCellCount,
    zeroClusterCount,

    // The board's SHAPE, present only on a non-rectangular board. DERIVED from the
    // board's own `_tiling` descriptor rather than stamped by the caller (the
    // way `modeTimed` is), because a daily board's features are recomputed
    // independently by every client, by the precompute pipeline, and by the
    // nightly verify sweep, a caller-stamped shape could differ between them,
    // and a derived one cannot.
    //
    // ABSENT on rectangles, never `'rect'`. The verify sweep's vintage escape
    // hatch is `stored === undefined && recomputed === 0`, so a key that
    // recomputed to a non-zero value on a historical board would hard-fail
    // every past date. Omitting it entirely keeps `Object.entries(recomputed)`
    // byte-identical on every rectangular board ever written.
    ...(board._tiling && board._tiling.type ? { tilingType: board._tiling.type } : {}),

    // Clue-digit shares. Measured, never maximized: the count-based candidate
    // scorer deliberately refuses to read these (OBSERVATIONAL_TARGETS in
    // experimentDesign.js), because maximizing 3-share would pile up exactly
    // the high-3-high-density boards the decorrelation mission exists to
    // counterbalance. They are here so the DECORRELATION residual is scorable
    // at selection time, and so the shares land in dailyMeta alongside every
    // other feature.
    ...clueShares(board, rows, cols),

    // Contribution features (`<g>Required` / `<g>ClicksSaved`), the
    // counterfactual the load-bearing filter computes and discards, kept as
    // data. Emitted only when the caller passes the certified opener; see the
    // opts doc above for which call sites do and why. Fed to the R refit's
    // SECONDARY contribution fit only, never a PAR_MODEL term until it earns
    // out (the clueShare discipline).
    ...(opts.contributionOpener
      ? computeContributionFeatures(
          board, rows, cols,
          opts.contributionOpener.row, opts.contributionOpener.col,
          state.activeGimmicks, neighborCache,
        )
      : {}),
  };
}

// ── Model application ─────────────────────────────────

// Maps each PAR_MODEL coefficient to a function that derives its predictor
// value from the raw feature object. Keeping this table explicit (and
// deriving each value rather than reading a stored field) makes predictPar
// and breakdownPar share one source of truth AND keeps every historical
// dailyMeta record usable, the derived predictors below are all functions
// of the raw counts that dailyMeta has always stored.
//
// The predictor set was reworked (2026-06-08) so the coefficients are
// actually identified, not collinearity-scrambled / prior-driven:
//   - SIZE block decorrelated: `cellCount` is the lone board-size axis
//     (it absorbs trivial-propagation time, so `passAMoves`, a size proxy,
//     VIF 7.4, is dropped, as is the near-redundant `nonZeroSafeCellCount`,
//     VIF 23.7). `totalMines` stays a raw count, VIF 3.6, fine once those
//     redundant size features are gone (density made its coef unreadable).
//   - REASONING collapsed into two earned tiers: `pattern` (subset
//     deductions = canonical + generic) and `search` (advanced enumeration).
//     The raw four move-types are too sparse/small-count to identify
//     separately; pooling densifies them.
//   - MODIFIERS kept split. They're sparse today (each on ~5-10% of boards),
//     so their coefficients are still prior-anchored; the adaptive coverage
//     missions accumulate boards until they earn out.
//
// disjunctiveMoves remains unmodeled (dropped 2026-05-04, confounded with
// liarCellCount). The solver still counts it for diagnostics.
const COEF_TERMS = [
  // Size / density, the baseline block.
  { coef: 'secPerCell',        value: f => f.cellCount || 0,                                       displayGroup: 'baseline', baseline: true },
  { coef: 'secPerMineFlag',    value: f => f.totalMines || 0,                                       displayGroup: 'baseline', baseline: true },
  // Reasoning load, two earned tiers.
  { coef: 'secPerPatternMove', value: f => (f.canonicalSubsetMoves || 0) + (f.genericSubsetMoves || 0), displayGroup: 'pattern moves' },
  { coef: 'secPerSearchMove',  value: f => f.advancedLogicMoves || 0,                              displayGroup: 'search moves' },
  // Board structure.
  { coef: 'secPerWallEdge',    value: f => f.wallEdgeCount || 0,    displayGroup: 'walls' },
  { coef: 'secPerZeroCluster', value: f => f.zeroClusterCount || 0, displayGroup: 'structure' },
  // Modifiers, kept split (sparse; earn out over time).
  { coef: 'secPerMysteryCell',  value: f => f.mysteryCellCount || 0,  displayGroup: 'mystery' },
  { coef: 'secPerLiarCell',     value: f => f.liarCellCount || 0,     displayGroup: 'liar' },
  { coef: 'secPerLockedCell',   value: f => f.lockedCellCount || 0,   displayGroup: 'locked' },
  { coef: 'secPerWormholePair', value: f => f.wormholePairCount || 0, displayGroup: 'wormhole' },
  { coef: 'secPerMirrorPair',   value: f => f.mirrorPairCount || 0,   displayGroup: 'mirror' },
  { coef: 'secPerSonarCell',    value: f => f.sonarCellCount || 0,    displayGroup: 'sonar' },
  { coef: 'secPerCompassCell',  value: f => f.compassCellCount || 0,  displayGroup: 'compass' },
  // Worm Tiles: wormLoad = pre-programmed segment-moves in hundreds (egg
  // lengths × the board's 30-80 move budget). applyParModel's
  // `(model[coef] || 0)` keeps predictPar safe until the nightly refit
  // emits the coefficient (and the R-side 20-play zero-guard holds it at
  // 0 until real data exists).
  { coef: 'secPerWormLoad',     value: f => f.wormLoad || 0,          displayGroup: 'worms' },
  // The board's shape is NOT a term here anymore. The six per-shape 0/1 indicator
  // terms (2026-07-23) were superseded on 2026-08-01 by whole per-shape
  // equations: `modelFor` below dispatches a tiling feature vector to its own
  // full coefficient block in PAR_MODEL_SHAPES, so shape enters by SELECTING
  // the model rather than by a term inside one. COEF_TERMS therefore stays a
  // pure description of the shared equation shape, identical across
  // PAR_MODEL, PAR_MODEL_TIMED and every PAR_MODEL_SHAPES block.
];

/**
 * Predicted par (in seconds) for a board described by `features`.
 * Rounded to 0.1s to match how par is displayed.
 *
 * The model is applied either additively (`par = intercept + Σ coef·x`) or
 * multiplicatively (`par = exp(intercept + Σ coef·x)`), selected by the
 * model's `scale` field. `scale === 'log'` means the coefficients are
 * log-multipliers and par is the lognormal MEDIAN (`exp(Xβ)`); any other
 * value (or its absence) means the legacy additive seconds model. Branching
 * on the marker keeps the additive→log swap atomic: the R refit flips the
 * coefficients and the `scale` field together in one commit, so predictPar
 * can never apply the wrong transform to a set of coefficients.
 */
/**
 * Apply a specific par model to a feature vector. Pure and injectable
 * (predictPar picks the model; this applies it), so the log path is
 * testable without mutating the shipped globals. Additive when
 * `model.scale !== 'log'`, multiplicative (lognormal median) otherwise.
 */
export function applyParModel(features, model) {
  let acc = model.intercept;
  for (const { coef, value } of COEF_TERMS) {
    acc += (model[coef] || 0) * value(features);
  }
  const par = model.scale === 'log' ? Math.exp(acc) : acc;
  return Math.round(par * 10) / 10;
}

// ── Model dispatch ────────────────────────────────────

// '6.6.6' is the deep-link alias for the honeycomb (TILING_TYPES in
// tilingGeometry.js keeps canonical names only and documents the alias). A
// STORED tilingType can only ever be canonical, every builder stamps
// `board._tiling.type` itself, and computeDailyFeatures derives from that,
// so this map is defensive normalization for any caller that hands modelFor
// a raw link token instead of a feature-vector type.
const TILING_TYPE_ALIASES = { '6.6.6': 'hex' };

/**
 * The par model a feature vector prices under (per-shape par equations,
 * Christopher's ruling 2026-08-01, replacing the six per-shape intercept
 * offset terms). Precedence:
 *   1. `modeTimed`, quick play has its own win-censored equation and is
 *      rectangles-only, so it wins outright;
 *   2. `tilingType`, a non-rectangular board prices on its OWN full
 *      equation in PAR_MODEL_SHAPES (base fit + that shape's earned
 *      deviations, composed by the nightly refit);
 *   3. PAR_MODEL, rectangles, and the FALLBACK for an unknown type.
 *
 * The fallback is the same hazard buildTiling documents: an unrecognized
 * type does not throw, it silently prices as a rectangle. That is the right
 * default for the one real case (a tiling that ships its feature before its
 * block must price as a plain board, never borrow another lattice's
 * equation), but it means a typo'd type produces a plausible par with no
 * error anywhere, so any caller taking a type from OUTSIDE the code must
 * validate against TILING_TYPES first.
 */
export function modelFor(features) {
  if (features && features.modeTimed) return PAR_MODEL_TIMED;
  const t = features && features.tilingType;
  if (t) {
    const model = PAR_MODEL_SHAPES[TILING_TYPE_ALIASES[t] || t];
    if (model) return model;
  }
  return PAR_MODEL;
}

export function predictPar(features) {
  // Dispatch through modelFor (timed first, then shape, then the base
  // model), so a tiling daily's par is automatically its shape's own
  // equation with no caller involvement.
  return applyParModel(features, modelFor(features));
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
export function breakdownPar(features, model = null) {
  // The model is injectable so the log-scale allocation is testable without
  // mutating the shipped globals; the DEFAULT resolves through modelFor, so
  // a tiling board's breakdown reads that shape's own equation exactly
  // as predictPar does (no caller passes a model today).
  if (!model) model = modelFor(features);
  const isLog = model.scale === 'log';

  // Accumulate each group's raw contribution. Under the additive model a
  // contribution is already SECONDS; under the log model it is a LOG-term
  // (`coef · x`) and the seconds conversion happens after.
  const byGroup = new Map();
  let baselineTerm = model.intercept;
  for (const { coef, value, displayGroup, baseline: isBaseline } of COEF_TERMS) {
    const contribution = (model[coef] || 0) * value(features);
    if (isBaseline) {
      baselineTerm += contribution;
    } else if (contribution > 0) {
      byGroup.set(displayGroup, (byGroup.get(displayGroup) || 0) + contribution);
    }
  }

  const entries = [];

  if (!isLog) {
    // Additive: contributions ARE seconds, unchanged behavior.
    for (const [label, seconds] of byGroup) {
      const rounded = Math.round(seconds * 10) / 10;
      if (rounded > 0) entries.push({ label, seconds: rounded });
    }
    entries.sort((a, b) => b.seconds - a.seconds);
    if (baselineTerm > 0.05) {
      entries.push({ label: 'baseline', seconds: Math.round(baselineTerm * 10) / 10 });
    }
    return entries;
  }

  // Log-scale: par is multiplicative, so a term adds no fixed number of
  // seconds. Split par into a baseline board (`exp(intercept + size terms)`)
  // plus the difficulty above it, and allocate those above-baseline seconds
  // to each group in proportion to its share of the log-difficulty
  // (`coef·x / Σ coef·x`). The chips still read in seconds and still sum to
  // par (a group accounting for 40% of the log-difficulty gets 40% of the
  // seconds above baseline), while honestly reflecting the multiplicative model.
  const baseline = Math.exp(baselineTerm);
  const par = applyParModel(features, model);
  const aboveBaseline = par - baseline;
  const sumLog = [...byGroup.values()].reduce((s, v) => s + v, 0);
  if (sumLog > 0 && aboveBaseline > 0) {
    for (const [label, logContribution] of byGroup) {
      const seconds = aboveBaseline * (logContribution / sumLog);
      const rounded = Math.round(seconds * 10) / 10;
      if (rounded > 0) entries.push({ label, seconds: rounded });
    }
  }
  entries.sort((a, b) => b.seconds - a.seconds);
  const baseRounded = Math.round(baseline * 10) / 10;
  if (baseRounded > 0.05) {
    entries.push({ label: 'baseline', seconds: baseRounded });
  }
  return entries;
}
