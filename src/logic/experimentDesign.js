// Adaptive experimental design for the daily model refit.
//
// EVERY daily picks, among CANDIDATE_COUNT candidate seeds, ONE
// candidate to ship. Each candidate is built around a "mission" — a
// specific feature target that candidate is trying to maximise:
//
//   slot 0:    PRIMARY mission. Force-injects the high-CV target's
//              gimmick (chosen by the R refit). Allowed to roll a
//              second gimmick at the natural ~10% rate.
//   slots 1-9: COVERAGE missions. Each force-injects a different
//              undersampled gimmick from the ranked coverage_targets
//              list (also produced by the R refit). Single-gimmick
//              only — no second-roll. Slots cycle through the list
//              if it's shorter than 9 entries.
//
// Each candidate's score is `min(target_count, COUNT_CAP) * deficit_weight`.
// The cap (= 5; defined in selectDailyRngSeed.js and the precompute script)
// stops wallEdgeCount (10-30 edges per board) from dwarfing the cell-based
// gimmicks (3-5 cells max) — without it, walls' coverage slot wins nearly
// every selection because its raw count is several times anyone else's.
// Slot 0's weight is fixed low (PRIMARY_WEIGHT). Coverage slots use the
// deficit weight from the ranked list — heavier for the most undersampled
// features. The day's winner is DRAWN from the scored candidates by a
// date-seeded weighted lottery (selectMissionWinner), so a score is a
// mission's frequency, not a fixed rank — see that function for why the
// argmax this replaced served a monoculture.
//
// Constraints this module respects:
// - Identical result on every client. All logic is a pure function of
//   the currently-loaded target + coverage_targets; both are the same
//   for every player on the same day, so the chosen seed is the same.
// - The target follows the fit, not the clock. If the refit hasn't
//   run for a day, we keep using the previously-loaded target.
// - Fallback if the JSON can't be fetched at all: DEFAULT_TARGET
//   (currently advancedLogicMoves) and an empty coverage_targets list,
//   in which case ALL slots fall back to the primary target — same
//   behaviour as the pre-multi-objective design.

import { createDailyRNG } from './seededRandom.js';
import { bandWeightsFor } from './parBand.js';

const EXPERIMENT_PATH = './src/logic/experimentTarget.json';

// Used only until loadExperimentTarget resolves, and as a safety net if
// the JSON is missing or malformed. Kept short because a mis-cached old
// JS bundle paired with a fresh JSON is the most likely divergence
// source, and we'd rather have a known target than a silent skip.
const DEFAULT_TARGET = 'advancedLogicMoves';

// How many candidate board-generation attempts to make on an improvement
// day. Each candidate runs the full generate + gimmicks + solve pipeline,
// so cost scales linearly. 10 empirically produces a visible bias without
// a jarring first-load delay (~500-800 ms). Now that every daily is an
// improvement day, this cost is paid on every cold daily load — if it
// becomes user-visible, lower to 5–7.
export const CANDIDATE_COUNT = 10;

// Map experiment-target feature names to the gimmick name that produces
// them. When the target maps to a gimmick, the candidate-seed loop
// force-injects that gimmick into every candidate's gimmick list so the
// 10-way max competes on cell COUNT rather than mere PRESENCE — without
// this, the natural 6.6% per-seed inclusion rate means ~50% of dailies
// have zero of the target across all 10 candidates and the maximisation
// is meaningless. Targets not in this map (move-type counts, structural
// features) fall through to the natural gimmick lottery.
const TARGET_TO_GIMMICK = {
  mysteryCellCount:  'mystery',
  liarCellCount:     'liar',
  lockedCellCount:   'locked',
  wormholePairCount: 'wormhole',
  mirrorPairCount:   'mirror',
  sonarCellCount:    'sonar',
  compassCellCount:  'compass',
  wallEdgeCount:     'walls',
  wormLoad:          'worm',
};

export function getTargetGimmickName(target) {
  return TARGET_TO_GIMMICK[target] || null;
}

// Targets that are MEASURED on every board but must never be MAXIMIZED.
//
// The clue-digit shares are computed for every board the fit sees, so a
// "threes study" needs no threes-heavy board to make progress. Worse, chasing
// a high 3-share actively harms the thing the study is stuck on: 3-share runs
// r ≈ 0.80 against mine density, so the boards that maximize it are
// overwhelmingly the dense ones we already have too many of, and piling more
// on deepens the confound instead of breaking it. The decorrelation mission is
// the sanctioned way to aim at a digit share, and it aims at the RESIDUAL, not
// the level.
//
// Before the shares were ported into computeDailyFeatures this held by
// accident (`features.clueShare3` was undefined, so the count scorer read 0).
// Now that the client computes them, the refusal has to be explicit.
const OBSERVATIONAL_TARGETS = new Set([
  'clueShare2', 'clueShare3', 'clueShare4', 'clueShare5plus',
]);

export function isObservationalTarget(target) {
  return OBSERVATIONAL_TARGETS.has(target);
}

let _cachedTarget = null;          // the `target` string from the JSON
let _cachedMeta = null;            // the rest of the object (for debugging / diagnostics modal)
let _loading = null;

/**
 * Fetch the current experiment target JSON. Cached after first call.
 * Safe to call early. If the file is missing (very first deploy before
 * the refit has run once) or malformed, DEFAULT_TARGET applies and the
 * rest of the meta is empty.
 */
export function loadExperimentTarget() {
  if (_cachedTarget !== null) return Promise.resolve(_cachedTarget);
  if (_loading) return _loading;

  _loading = fetch(EXPERIMENT_PATH)
    .then(r => (r.ok ? r.json() : null))
    .then(data => {
      _cachedTarget = (data && typeof data.target === 'string') ? data.target : DEFAULT_TARGET;
      _cachedMeta = data || {};
      return _cachedTarget;
    })
    .catch(() => {
      _cachedTarget = DEFAULT_TARGET;
      _cachedMeta = {};
      return _cachedTarget;
    });
  return _loading;
}

/**
 * Current target feature name. Synchronous — returns DEFAULT_TARGET if
 * loadExperimentTarget hasn't completed yet. Use this inside the daily
 * generation flow; call loadExperimentTarget() at app startup to warm
 * the cache.
 */
export function getCurrentTarget() {
  return _cachedTarget || DEFAULT_TARGET;
}

/**
 * Return the metadata object from experimentTarget.json — useful for the
 * diagnostics modal to surface "why is today's daily unusual?".
 */
export function getExperimentMeta() {
  return _cachedMeta || {};
}

/**
 * Return the feature name to bias toward for this date's daily. Every
 * daily is now an improvement day — the R refit guarantees no target
 * repeats within 3 days, so variety is preserved without skipping
 * generations on the client. dateString is unused now (kept for API
 * compatibility and future per-date overrides).
 */
// eslint-disable-next-line no-unused-vars
export function getExperimentTarget(dateString) {
  return getCurrentTarget();
}

/**
 * Build the Nth candidate seed string for a given date.
 * `${dateString}:trial${n}` — a deterministic namespace that varies the
 * RNG stream while keeping the dateString as a parsable prefix (so
 * anything that inspects the seed can still recover the date).
 */
export function candidateSeed(dateString, n) {
  return `${dateString}:trial${n}`;
}

// ── Multi-objective candidate selection ──────────────────────────────
//
// Slot 0 = primary high-CV mission. Its weight is fixed low so it only
// wins when its target_count saturates the cap against a coverage slot
// with a smaller deficit weight. With PRIMARY_WEIGHT = 0.1, COUNT_CAP = 5,
// and a typical liar deficit_weight of ~0.5, the primary slot tops out at
// 5×0.1 = 0.5 while the heaviest coverage tops out at 5×0.5 = 2.5, so
// coverage wins whenever its target injects. The tuning yields roughly
// 1-in-10 primary outcomes when the coverage list is well-populated,
// matching the design intent.
const PRIMARY_WEIGHT = 0.1;

/**
 * Coverage targets list from experimentTarget.json, ordered most-to-least
 * undersampled. Each entry: { feature, n_boards, deficit_weight }.
 * Empty array if the JSON pre-dates the multi-objective design.
 */
export function getCoverageTargets() {
  const meta = getExperimentMeta();
  const list = Array.isArray(meta.coverage_targets) ? meta.coverage_targets : [];
  return list.filter(t => t && typeof t.feature === 'string');
}

// ── Decorrelation missions ───────────────────────────────────────────
//
// The gap the primary and coverage missions leave open. A primary mission
// shrinks ONE coefficient's uncertainty; a coverage mission fills ONE
// gimmick's sample gap. Neither breaks COLLINEARITY, which is the disease that
// actually blocks a coefficient from being identified: feeding a confounded
// term more of the SAME correlated shape cannot separate it from its
// confounder, no matter how many boards you spend. What separates them is an
// observation in the design's weakest direction, which is textbook optimal
// experimental design.
//
// The live instance: clue 3-share runs r ≈ 0.80 / R² ≈ 0.64 against mine
// density on the canonical-era boards, so "3s cost time" and "3s ride on the
// dense boards they appear on" predict nearly the same data. A board high in
// 3-share but LOW in density tells those two apart; a board high in both tells
// us nothing new.
//
// The refit does the statistics. It already runs the regression of a feature
// on its confounder inside the digit VIF loop, so the fitted line is free, and
// it emits that line here as `decorrelation_mission`. The client stays dumb: it
// scores a candidate board by how far the feature sits ABOVE what the
// confounder predicts, in residual standard deviations. No client-side fitting,
// no eigen-decomposition, one subtraction and a divide.
//
// Shape (every field required except residualSd/weight):
//   { feature, confounder, slope, intercept, residualSd, weight }
// so the residual is `feature - slope × confounder - intercept`, and a
// candidate is scored on its MAGNITUDE.
//
// BOTH TAILS COUNT (Christopher's ruling, 2026-07-18: "both tails should be
// sampled... the variable space is sampled in such a way to reduce
// correlation between variables"). What reduces the correlation is residual
// VARIANCE, and a board two SDs BELOW the line adds exactly as much of it as
// one two SDs above. An earlier cut scored `sign × residual`, chasing whichever
// tail the fit judged thinner; that is worse on two counts. It throws away half
// the reachable boards for no gain in precision, and sampling only one side
// would extrapolate structure — which matters here specifically, because the
// clue-ambiguity hypothesis predicts an inverted U in the digit response, and a
// one-tailed design is exactly what would hide a curve.

// Residual scale when the refit does not supply one: score in raw feature
// units. Emitted `residualSd` is what makes `weight` mean the same thing
// across different (feature, confounder) pairs, so the refit always sends it.
const DEFAULT_RESIDUAL_SD = 1;

// Weight when the refit does not supply one. Sits between the primary slot's
// fixed 0.1 and the heaviest coverage weight so a decorrelation candidate
// competes without automatically owning every day.
const DEFAULT_DECORRELATION_WEIGHT = 0.3;

// How many candidate slots a decorrelation mission gets, on top of the primary
// and coverage slots. Decorrelation has no gimmick to force, so unlike every
// other mission it SELECTS rather than constructs, and the only lever on how
// far into the corner it reaches is how many boards it gets to choose among.
// Cost is linear in this number and is paid only on decorrelation days.
export const DECORRELATION_SLOTS = 10;

/**
 * Validate a raw `decorrelation_mission` from experimentTarget.json. Returns a
 * normalized mission spec, or null if anything about it is unusable — a
 * malformed mission must degrade to "no decorrelation today", never to a
 * NaN score that silently wins or loses every candidate.
 *
 * @param {any} raw
 * @returns {{feature: string, confounder: string, slope: number, intercept: number, residualSd: number, weight: number}|null}
 */
export function normalizeDecorrelationMission(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { feature, confounder } = raw;
  if (typeof feature !== 'string' || !feature) return null;
  if (typeof confounder !== 'string' || !confounder) return null;
  // Regressing a feature on itself has a zero residual by construction, so it
  // could only ever score every candidate identically.
  if (feature === confounder) return null;
  const slope = Number(raw.slope);
  const intercept = Number(raw.intercept);
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return null;
  const rawSd = Number(raw.residualSd);
  const residualSd = Number.isFinite(rawSd) && rawSd > 0 ? rawSd : DEFAULT_RESIDUAL_SD;
  const rawWeight = Number(raw.weight);
  const weight = Number.isFinite(rawWeight) && rawWeight > 0 ? rawWeight : DEFAULT_DECORRELATION_WEIGHT;
  return { feature, confounder, slope, intercept, residualSd, weight };
}

/**
 * The decorrelation mission from the loaded experimentTarget.json, or null.
 */
export function getDecorrelationMission() {
  return normalizeDecorrelationMission(getExperimentMeta().decorrelation_mission);
}

/**
 * How far a candidate board sits OFF the fitted line, in residual standard
 * deviations. SIGNED: positive means the feature runs higher than the
 * confounder predicts, negative means lower. Both are equally useful
 * observations, so scoring takes the magnitude (see missionCandidateScore);
 * the sign is preserved here because it is what tells a caller WHICH corner a
 * board landed in, which the reach sweep reports.
 *
 * Returns null when the board cannot be scored on this pair at all, so the
 * caller skips the candidate rather than ranking it on a NaN.
 *
 * @param {Object} decorrelation normalized mission spec
 * @param {Object} features      computeDailyFeatures output
 * @returns {number|null}
 */
export function decorrelationResidualZ(decorrelation, features) {
  if (!decorrelation || !features) return null;
  const y = Number(features[decorrelation.feature]);
  const x = Number(features[decorrelation.confounder]);
  if (!Number.isFinite(y) || !Number.isFinite(x)) return null;
  const residual = y - decorrelation.slope * x - decorrelation.intercept;
  const z = residual / decorrelation.residualSd;
  return Number.isFinite(z) ? z : null;
}

/**
 * Resolve the mission for the candidate identified by an effective
 * RNG seed of the form `${dateString}:trial${n}`. Returns the same
 * shape as getMissionForSlot. If the seed doesn't match the candidate
 * pattern (e.g. fallback to plain dateString in selectDailyRngSeed)
 * OR the slot index has no valid mission, defaults to slot 0 / primary
 * so the play path always picks a sensible gimmick.
 */
export function getMissionForSeed(rngSeed) {
  if (typeof rngSeed !== 'string') return getMissionForSlot(0);
  const m = rngSeed.match(/:trial(\d+)$/);
  if (!m) return getMissionForSlot(0);
  const mission = getMissionForSlot(parseInt(m[1], 10));
  return mission || getMissionForSlot(0);
}

/**
 * Resolve the mission for a given candidate slot index. Returns:
 *   { target, deficitWeight, singleOnly, isPrimary }   or null
 *
 * Slot 0 → primary high-CV target with full natural double-roll allowed.
 * Slots 1 through coverage.length → cycle through the coverage list
 *   one-to-one (no wrap), single-gimmick only.
 * Slots beyond that → null, so the candidate loop in selectDailyRngSeed
 *   skips them. Returning null fixes the "(slotIndex - 1) % coverage.length"
 *   bug where short coverage lists made top-2 deficits get DOUBLE slots
 *   (e.g. coverage.length=7 + CANDIDATE_COUNT=10 → slots 1+8 and 2+9 both
 *   targeted the top-deficit feature, silently halving the effective
 *   sampling rate of features ranked lower in the deficit list).
 * If the coverage list is empty (legacy experimentTarget.json) every
 * slot falls back to primary, recovering the pre-multi-objective
 * behaviour where all 10 candidates compete on the same target.
 */
export function getMissionForSlot(slotIndex) {
  return resolveMissionForSlot(
    slotIndex, getCurrentTarget(), getCoverageTargets(), getDecorrelationMission(),
  );
}

/**
 * Saturating cap on a mission's raw score input. wallEdgeCount runs 10-30
 * edges per board while cell-based gimmicks cap out at ~3-5 cells, so an
 * uncapped `count × weight` lets walls dominate every selection; saturating
 * here makes the weight (how badly the design wants this mission) the actual
 * driver. Decorrelation shares the cap so an outlier board cannot buy an
 * unbounded score with one freak residual.
 *
 * This used to be copied into selectDailyRngSeed.js and daily-board-pipeline.mjs
 * as separate consts. It lives with the scorer now for the same reason
 * resolveMissionForSlot does: two copies of a determinism-critical number are
 * two chances to drift.
 */
export const COUNT_CAP = 5;

/**
 * Score one candidate board against its slot's mission. Higher wins the day.
 * Returns null when the candidate cannot be scored on this mission, which the
 * caller must treat as "skip", not as zero.
 *
 * Both selection paths — the client's selectDailyRngSeed and the Node
 * precompute's selectBestCandidate — call THIS function. They previously
 * carried the scoring expression twice; the slot arithmetic having already
 * drifted once across exactly that mirror pair, the scoring rule is single
 * sourced from the start.
 *
 * @param {Object} mission  a resolveMissionForSlot result
 * @param {Object} features computeDailyFeatures output for the candidate
 * @returns {number|null}
 */
export function missionCandidateScore(mission, features) {
  if (!mission || !mission.target || !features) return null;
  if (mission.type === 'decorrelation') {
    const z = decorrelationResidualZ(mission.decorrelation, features);
    if (z === null) return null;
    // MAGNITUDE, not the signed residual: a board two SDs below the fitted
    // line breaks the correlation exactly as well as one two SDs above, so
    // both tails compete and the furthest-off board wins. A board sitting ON
    // the line scores ~0 and loses to any coverage slot with a count, which
    // is the right outcome — on a day nothing reaches a corner, the board is
    // better spent on coverage.
    return Math.min(Math.abs(z), COUNT_CAP) * mission.deficitWeight;
  }
  // Observational targets are measured on every board and must never be
  // maximized — see OBSERVATIONAL_TARGETS. Scoring them 0 preserves exactly
  // the behaviour that held before the clue shares became computable here.
  const count = isObservationalTarget(mission.target) ? 0 : (features[mission.target] || 0);
  return Math.min(count, COUNT_CAP) * mission.deficitWeight;
}

/**
 * Pick the day's winning candidate from the scored slots — a date-seeded
 * WEIGHTED LOTTERY, not an argmax.
 *
 * The argmax this replaced was a monoculture machine: coverage deficit
 * weights move slowly (deficit = 1/(n_boards+1), and n_boards grows about
 * one per day), so whichever mission scored highest on Monday scored
 * highest on Tuesday too, and the top-deficit gimmick owned every daily
 * until it saturated. Measured 2026-07-30: worm won 10 of the previous 12
 * dates and every precomputed future board, because min(wormLoad, CAP) ×
 * 0.143 ≈ 0.71 against every other slot's ceiling of ~0.36. This is the
 * same lesson as PR F1's weight tuning, from the other side: a weight sets
 * who wins a contest, never how often a mission runs. Sampling ∝ score IS
 * the frequency mechanism — the most undersampled gimmick is still the most
 * likely daily, but never the only one, and the mix self-corrects nightly
 * as the refit moves the weights.
 *
 * Two deliberate edges:
 * - DECORRELATION keeps its argmax supremacy: when a decorrelation slot
 *   holds the top score outright, it wins outright. Its R-derived weight is
 *   calibrated to "tie the strongest coverage mission at the target residual
 *   depth" under exactly that contest, and its frequency is already owned by
 *   its own mechanism (the 7-day cadence). Running it through the lottery
 *   would quietly re-tune both.
 * - An all-zero pool draws UNIFORMLY. Zero total weight carries no signal,
 *   and falling back to "first slot" would freeze rotation on exactly the
 *   days the scores can't discriminate.
 *
 * Determinism: one rng stream seeded from the date (`:missionDraw`
 * namespace, disjoint from the `:trialN` candidate seeds), consumed by at
 * most one draw — every client and the precompute resolve the same winner
 * for the same date and pool. Both selection paths (selectDailyRngSeed.js
 * and scripts/daily-board-pipeline.mjs) call THIS function; the winner-pick
 * used to exist as two argmax copies, the same mirror-pair shape whose slot
 * arithmetic had already drifted once.
 *
 * Par banding (Christopher's ruling 2026-08-02, see parBand.js): when the
 * caller passes `bandCtx = { targetPar, band }`, each NON-decorrelation
 * entry's score is multiplied by its band weight — 0 outside the band, a
 * log-scale closeness kernel to the day's target inside it — before the
 * draw, so the lottery keeps deciding WHICH mission a board studies while
 * the band decides how LONG the board runs (measured shift in mission-win
 * shares ≤ ~4 points). Three composition rules are load-bearing:
 * - Decorrelation supremacy is checked on RAW scores, before any band
 *   weight. Its R-derived weight is calibrated to "tie the strongest
 *   coverage" under exactly that contest, and a decorrelation winner is
 *   exempt from the band (those rare days chase a residual corner).
 * - An all-zero-score pool draws ∝ band weight instead of uniformly — no
 *   mission signal, so the band alone decides.
 * - Entries without a finite `par` weigh 0; if NO entry carries one the
 *   whole band step disengages and the legacy draw runs verbatim.
 *
 * @param {Array<{score: number, mission: Object, par?: number}>} entries
 *   scored candidates in slot order (each carries whatever else the caller
 *   needs back; `par` is required only for banding)
 * @param {string} dateString YYYY-MM-DD, the lottery's seed anchor
 * @param {{targetPar: number, band: import('./parBand.js').ParBand}|null} [bandCtx]
 *   the day's par target and band, or null for the pre-band contest
 * @returns {Object|null} the winning entry, or null for an empty pool
 */
export function selectMissionWinner(entries, dateString, bandCtx = null) {
  const pool = (Array.isArray(entries) ? entries : [])
    .filter(e => e && typeof e.score === 'number' && e.score >= 0);
  if (pool.length === 0) return null;

  // First-max, matching the strict `>` the old argmax used (ties favored
  // the earlier slot).
  let top = pool[0];
  for (const e of pool) { if (e.score > top.score) top = e; }
  if (top.mission?.type === 'decorrelation') return top;

  // Ordinary days: weighted draw over the non-decorrelation slots. A
  // decorrelation slot that did NOT take the top score stays out of the
  // draw — it wins outright at depth or not at all, per its calibration.
  const drawPool = pool.filter(e => e.mission?.type !== 'decorrelation');
  if (drawPool.length === 0) return top;
  const rng = createDailyRNG(`${dateString}:missionDraw`);

  // Every branch below consumes exactly ONE rng() call, so a client with
  // banding and a client without it stay on the same stream position for
  // anything seeded after the draw.
  const weights = bandCtx && Number.isFinite(bandCtx.targetPar) && bandCtx.band
    ? bandWeightsFor(drawPool, bandCtx.targetPar, bandCtx.band)
    : null;
  if (weights !== null) {
    const drawWeighted = ws => {
      let r = rng() * ws.reduce((s, w) => s + w, 0);
      let last = null;
      for (let i = 0; i < drawPool.length; i++) {
        if (ws[i] <= 0) continue; // a zero-weight entry must not win on the r === 0 edge
        last = drawPool[i];
        r -= ws[i];
        if (r <= 0) return drawPool[i];
      }
      return last; // float-edge fallback
    };
    const eff = drawPool.map((e, i) => e.score * weights[i]);
    if (eff.some(w => w > 0)) return drawWeighted(eff);
    if (weights.some(w => w > 0)) return drawWeighted(weights);
    // Unreachable while bandWeightsFor guarantees a positive weight for any
    // finite par, but degrade to the legacy uniform draw rather than assume.
  }
  const total = drawPool.reduce((s, e) => s + e.score, 0);
  if (total <= 0) return drawPool[Math.min(drawPool.length - 1, Math.floor(rng() * drawPool.length))];
  let r = rng() * total;
  for (const e of drawPool) {
    r -= e.score;
    if (r <= 0) return e;
  }
  return drawPool[drawPool.length - 1]; // float-edge fallback
}

/**
 * The mission for a TILING day (Project Coastline shape rotation), where the
 * day has ONE candidate instead of the rectangular 10-way contest — the
 * client fallback must replay selection deterministically, and generating a
 * contest's worth of rhombille boards on a phone is minutes, not milliseconds.
 *
 * With no candidate features to score, the rectangular lottery's
 * `min(count, CAP) × weight` collapses to its weight term: a date-seeded
 * weighted draw (P ∝ deficit weight) over the slots whose mission maps to a
 * FORCE-INJECTABLE gimmick — the primary when its target is a gimmick, plus
 * every coverage entry. That keeps the same self-correcting property the
 * rectangular lottery has (the most undersampled gimmick is the likeliest
 * tiling daily, never the only one, and the mix follows the refit's weights
 * nightly) without needing boards to exist before the draw.
 *
 * Excluded, deliberately:
 *  - DECORRELATION missions: they SELECT rather than construct — a residual
 *    can only be chased across a candidate pool, and a tiling day has a pool
 *    of one. On a tiling day the decorrelation mission simply does not run
 *    (its 7-day cadence anchor only advances on a night that ships one, and
 *    its live targets are digit shares the fit reads from RECTANGULAR rows
 *    anyway — see the digit frame's rectangles-only filter).
 *  - OBSERVATIONAL targets: measured on every board, never maximized; with
 *    nothing to force there is nothing for this draw to pick.
 *
 * Returns { slot, mission } — slot feeds candidateSeed so the effective seed
 * keeps the same `${date}:trialN` form as a rectangle day and anything
 * inspecting a seed recovers the mission through the same arithmetic — or
 * null when no slot qualifies (observational primary + empty coverage list),
 * in which case the caller uses the plain dateString seed and the natural
 * gimmick lottery, exactly like the rectangular plain-dateString fallback.
 *
 * Determinism: one rng stream (`:shapeMission` namespace, disjoint from
 * `:trialN`, `:missionDraw`, and the `:shape` draw itself), at most one draw.
 *
 * @param {string} dateString YYYY-MM-DD
 * @param {string|null} target the primary target feature name
 * @param {Array} coverage coverage_targets list
 * @returns {{slot: number, mission: Object}|null}
 */
export function selectTilingMission(dateString, target, coverage) {
  const list = Array.isArray(coverage) ? coverage : [];
  const entries = [];
  for (let slot = 0; slot <= list.length; slot++) {
    const mission = resolveMissionForSlot(slot, target, list, null);
    if (!mission || !mission.target) continue;
    if (!getTargetGimmickName(mission.target)) continue;
    const weight = typeof mission.deficitWeight === 'number' && mission.deficitWeight > 0
      ? mission.deficitWeight
      : 0;
    entries.push({ slot, mission, weight });
  }
  if (entries.length === 0) return null;

  const rng = createDailyRNG(`${dateString}:shapeMission`);
  const total = entries.reduce((s, e) => s + e.weight, 0);
  if (total <= 0) {
    // No usable weights carries no signal — draw uniformly, like
    // selectMissionWinner's all-zero pool.
    return entries[Math.min(entries.length - 1, Math.floor(rng() * entries.length))];
  }
  let r = rng() * total;
  for (const e of entries) {
    r -= e.weight;
    if (r <= 0) return e;
  }
  return entries[entries.length - 1]; // float-edge fallback
}

/**
 * How many candidate slots to evaluate. Baseline on an ordinary day; on a
 * decorrelation day the tail slots become decorrelation candidates and the
 * count rises to give them a real selection pool.
 *
 * Decorrelation cannot force its way into a board the way a coverage mission
 * force-injects its gimmick, so candidate count is the ONLY reach knob it has.
 * Cost is linear and paid only when a mission is live.
 *
 * @param {Array}  coverage      coverage_targets list
 * @param {Object} decorrelation normalized decorrelation mission, or null
 * @returns {number}
 */
export function resolveCandidateCount(coverage, decorrelation) {
  // Validate rather than test truthiness: `{}` and a half-filled mission are
  // both truthy, and resolveMissionForSlot rejects them. If this function
  // trusted them the loop would evaluate a block of extra slots that resolve
  // to null — wasted work on an ordinary day, and the two functions would
  // disagree about whether a mission is live.
  if (!normalizeDecorrelationMission(decorrelation)) return CANDIDATE_COUNT;
  const list = Array.isArray(coverage) ? coverage : [];
  return 1 + list.length + DECORRELATION_SLOTS;
}

/**
 * The client's candidate count for today, from the loaded experiment file.
 */
export function getCandidateCount() {
  return resolveCandidateCount(getCoverageTargets(), getDecorrelationMission());
}

/**
 * The mission fields a canonical board payload carries, as a plain object to
 * merge in after serializeBoard (which is a strict whitelist and will not
 * carry them for you).
 *
 * ONE definition, because there are TWO canonical writers: the Node precompute
 * and the client's local-generation fallback in gameActions.js. A board written
 * by either must be describable by the same Field Note, and the stamped mission
 * is the ONLY drift-proof record of why a board exists — boards are generated
 * up to 7 days ahead and the nightly refit reorders the coverage list, so
 * re-deriving the mission from the seed's slot index against the current file
 * names the wrong study.
 *
 * A decorrelation day adds `missionType` and `missionConfounder` so the note
 * can say what the board pulls apart instead of mislabelling it a plain study
 * of the feature. Both are whitelisted in firebase-rules.json's dailyBoard
 * block; that block ends in `$other: false`, so an un-whitelisted child would
 * make the WHOLE canonical write fail validation and drop silently.
 *
 * @param {Object} mission a resolveMissionForSlot result
 * @returns {Object} fields to Object.assign onto the payload (empty if none)
 */
/**
 * One-word label for a mission, for the precompute logs. Reads the mission's
 * own discriminator: labelling by `isPrimary` alone printed a decorrelation
 * winner as "COVERAGE", and the Actions log is one of the artifacts used to
 * reconstruct why a historical board exists.
 *
 * @param {Object} mission a resolveMissionForSlot result
 * @returns {string}
 */
export function missionLabel(mission) {
  if (!mission) return 'NO';
  if (mission.type === 'decorrelation') return 'DECORRELATION';
  return mission.isPrimary ? 'PRIMARY' : 'COVERAGE';
}

export function missionStamp(mission) {
  const m = mission || {};
  if (typeof m.target !== 'string') return {};
  const stamp = {
    missionTarget: m.target,
    missionIsPrimary: m.isPrimary === true,
  };
  if (m.type === 'decorrelation' && m.decorrelation) {
    stamp.missionType = 'decorrelation';
    stamp.missionConfounder = m.decorrelation.confounder;
  }
  return stamp;
}

/**
 * The slot → mission arithmetic, as a PURE function of (slotIndex, target,
 * coverage). This is the ONE source of truth: the client selection path
 * reaches it through getMissionForSlot (which supplies the fetch-cached
 * target/coverage) and the Node precompute pipeline calls it directly with
 * its own file-read spec. They used to carry separate copies and DRIFTED —
 * the pipeline wrapped (`(slotIndex - 1) % coverage.length`) where the
 * client returned null, so with a coverage list shorter than 9 the
 * precompute evaluated slots 8-9 as duplicates of coverage[0]/[1] and could
 * pick a `:trial8/9` seed the client would never choose. The canonical
 * board still won for actual play (clients read it verbatim), but
 * parResolve's pre-play par estimate re-ran the client's no-wrap selection
 * and could land on a DIFFERENT board than the date's canonical. Sharing
 * this function makes that class of divergence structurally impossible.
 *
 * Slot 0 → the primary high-CV target, full natural double-roll allowed.
 * Slots 1..coverage.length → the coverage list one-to-one, single-gimmick.
 * Slots beyond that → the DECORRELATION mission when the refit emitted one,
 *   else null so the caller skips them. (No-wrap is deliberate: wrapping gave
 *   the top-deficit features DOUBLE slots, silently halving the sampling rate
 *   of everything ranked below them.)
 * An empty coverage list collapses the non-decorrelation slots to primary,
 * recovering the pre-multi-objective behaviour.
 *
 * With no decorrelation mission this is byte-identical to the pre-F1 function,
 * which is the whole back-compat story: an experimentTarget.json without the
 * new key selects exactly the board it selected before.
 */
export function resolveMissionForSlot(slotIndex, target, coverage, decorrelation = null) {
  const list = Array.isArray(coverage) ? coverage : [];
  const primary = () => ({
    target,
    deficitWeight: PRIMARY_WEIGHT,
    singleOnly:    false,
    isPrimary:     true,
  });
  if (slotIndex === 0) return primary();
  if (slotIndex - 1 < list.length) {
    const entry = list[slotIndex - 1];
    return {
      target:        entry.feature,
      deficitWeight: typeof entry.deficit_weight === 'number' ? entry.deficit_weight : 0.1,
      singleOnly:    true,
      isPrimary:     false,
    };
  }
  const decor = normalizeDecorrelationMission(decorrelation);
  if (decor) {
    return {
      // The target IS the confounded feature, so getTargetGimmickName finds no
      // gimmick to force (correct — there is none) and the mission stays
      // nameable by the Field Note.
      target:        decor.feature,
      deficitWeight: decor.weight,
      // The natural gimmick lottery, unforced and unconstrained: this mission
      // is about the clue shape, and leaning on the gimmick roll either way
      // would only add noise to the axis being separated.
      singleOnly:    false,
      isPrimary:     false,
      type:          'decorrelation',
      decorrelation: decor,
    };
  }
  if (list.length === 0) return primary();
  return null;
}
