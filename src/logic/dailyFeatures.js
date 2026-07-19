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

import { PAR_MODEL, PAR_MODEL_TIMED } from './difficulty.js';
import { wormLoadFor } from './worms.js';

// ── Clue-digit shares ─────────────────────────────────
//
// The arithmetic-load axis: of the clues that show a NUMBER, what fraction
// are 2s, 3s, 4s, 5-and-up? Nonzero-digit SHARES with 5+ lumped and 1s the
// omitted reference, scaled ×10 so one unit reads as "one extra clue-in-ten
// of that digit". Raw counts are density in disguise (mean clue ≈ 8 × density,
// r ≈ 0.94), so only the SHAPE at fixed density can carry signal.
//
// This is a straight port of `clue_histogram` / `digit_shares_from_boards` in
// scripts/refit-par-model.R, and the two MUST agree cell-for-cell: R derives
// the shares from the stored canonical board for the fit (authoritative, full
// history back to DIGIT_ERA_START), while this copy exists so the axis is
// scorable at SELECTION time, before a board is written. Same rule on both
// sides — count a cell only if it eventually shows the player a number, and
// count the TRUE adjacency, never the gimmick-DISPLAYED magnitude (wormhole
// pair sums, sonar 5×5 counts) that the modifier terms already model.
//
// Exclusions, matching R exactly: mines carry no clue, mystery hides its
// number, and a pressure plate shows a timer rather than a count.
export const CLUE_SHARE_KEYS = ['clueShare2', 'clueShare3', 'clueShare4', 'clueShare5plus'];

// Shares are per-ten-clues, so a board with no numbered clue at all has no
// denominator; R drops that date, and here every share is simply 0.
export function clueShares(board, rows, cols) {
  const hist = new Array(9).fill(0); // hist[d] = cells showing digit d (0..8)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (cell.isMine || cell.isMystery || cell.isPressurePlate) continue;
      const v = cell.adjacentMines || 0;
      if (v >= 0 && v <= 8) hist[v]++;
    }
  }
  // Denominator is the cells that show a NUMBER: digits 1..8. Zeros cascade
  // away and are already told as `zeroClusterCount`.
  const nz = hist[1] + hist[2] + hist[3] + hist[4] + hist[5] + hist[6] + hist[7] + hist[8];
  if (nz === 0) return { clueShare2: 0, clueShare3: 0, clueShare4: 0, clueShare5plus: 0 };
  return {
    clueShare2: (10 * hist[2]) / nz,
    clueShare3: (10 * hist[3]) / nz,
    clueShare4: (10 * hist[4]) / nz,
    clueShare5plus: (10 * (hist[5] + hist[6] + hist[7] + hist[8])) / nz,
  };
}

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
  const wormEggs = [];

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
      if (cell.isWormEgg) wormEggs.push({ r, c });
    }
  }

  // Worm exposure: total pre-programmed segment-moves in hundreds (see
  // wormLoadFor). Egg count alone can't carry the burden now that the
  // per-board lifetime varies 30-80 — a 3-egg board at 30 moves is far
  // lighter than one at 80. The seed identity MUST match what the hatch
  // path uses (state.dailyRngSeed / weeklyRngSeed on the client; the
  // canonical payload's rngSeed on recompute paths — same value by the
  // resume-eligibility contract), or the stored feature would describe
  // worms nobody plays.
  const wormSeed = state.dailyRngSeed || state.weeklyRngSeed || state.rngSeed || '';
  const wormLoad = wormLoadFor(wormEggs, wormSeed);

  // Wormhole and mirror cells come in pairs — pair counts are the more natural
  // unit for the model (the player reasons about a pair, not two cells).
  const wormholePairCount = Math.floor(wormholeCellCount / 2);
  const mirrorPairCount = Math.floor(mirrorCellCount / 2);

  const wallEdgeCount = board._wallEdges ? board._wallEdges.size : 0;
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
  // isolated region UNSOLVABLE — and the solver filters those boards
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

  // Count connected components of adj=0 safe cells via BFS.
  const dirs = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
  const visited = Array.from({ length: rows }, () => new Array(cols).fill(false));
  let zeroClusterCount = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (visited[r][c]) continue;
      const cell = board[r][c];
      if (cell.isMine || (cell.adjacentMines || 0) !== 0) continue;
      // BFS-flood this cluster
      const queue = [[r, c]];
      visited[r][c] = true;
      while (queue.length > 0) {
        const [cr, cc] = queue.shift();
        for (const [dr, dc] of dirs) {
          const nr = cr + dr, nc = cc + dc;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
          if (visited[nr][nc]) continue;
          const nb = board[nr][nc];
          if (nb.isMine || (nb.adjacentMines || 0) !== 0) continue;
          visited[nr][nc] = true;
          queue.push([nr, nc]);
        }
      }
      zeroClusterCount++;
    }
  }

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
    wormLoad,

    // Structural features (v1.5.16+ — see above for definitions)
    nonZeroSafeCellCount,
    zeroClusterCount,

    // Clue-digit shares. Measured, never maximized: the count-based candidate
    // scorer deliberately refuses to read these (OBSERVATIONAL_TARGETS in
    // experimentDesign.js), because maximizing 3-share would pile up exactly
    // the high-3-high-density boards the decorrelation mission exists to
    // counterbalance. They are here so the DECORRELATION residual is scorable
    // at selection time, and so the shares land in dailyMeta alongside every
    // other feature.
    ...clueShares(board, rows, cols),
  };
}

// ── Model application ─────────────────────────────────

// Maps each PAR_MODEL coefficient to a function that derives its predictor
// value from the raw feature object. Keeping this table explicit (and
// deriving each value rather than reading a stored field) makes predictPar
// and breakdownPar share one source of truth AND keeps every historical
// dailyMeta record usable — the derived predictors below are all functions
// of the raw counts that dailyMeta has always stored.
//
// The predictor set was reworked (2026-06-08) so the coefficients are
// actually identified, not collinearity-scrambled / prior-driven:
//   - SIZE block decorrelated: `cellCount` is the lone board-size axis
//     (it absorbs trivial-propagation time, so `passAMoves` — a size proxy,
//     VIF 7.4 — is dropped, as is the near-redundant `nonZeroSafeCellCount`,
//     VIF 23.7). `totalMines` stays a raw count — VIF 3.6, fine once those
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
  // Size / density — the baseline block.
  { coef: 'secPerCell',        value: f => f.cellCount || 0,                                       displayGroup: 'baseline', baseline: true },
  { coef: 'secPerMineFlag',    value: f => f.totalMines || 0,                                       displayGroup: 'baseline', baseline: true },
  // Reasoning load — two earned tiers.
  { coef: 'secPerPatternMove', value: f => (f.canonicalSubsetMoves || 0) + (f.genericSubsetMoves || 0), displayGroup: 'pattern moves' },
  { coef: 'secPerSearchMove',  value: f => f.advancedLogicMoves || 0,                              displayGroup: 'search moves' },
  // Board structure.
  { coef: 'secPerWallEdge',    value: f => f.wallEdgeCount || 0,    displayGroup: 'walls' },
  { coef: 'secPerZeroCluster', value: f => f.zeroClusterCount || 0, displayGroup: 'structure' },
  // Modifiers — kept split (sparse; earn out over time).
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

export function predictPar(features) {
  // Quick play has its own win-conditional equation (features.modeTimed
  // is stamped by the timed path); daily/weekly use the main model.
  // Same terms, different coefficients.
  const model = features && features.modeTimed ? PAR_MODEL_TIMED : PAR_MODEL;
  return applyParModel(features, model);
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
export function breakdownPar(features, model = PAR_MODEL) {
  // Daily game-over modal only; the model is injectable so the log-scale
  // allocation is testable without mutating the shipped PAR_MODEL.
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
    // Additive: contributions ARE seconds — unchanged behavior.
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
