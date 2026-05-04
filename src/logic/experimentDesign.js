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
// Each candidate's score is `target_count * deficit_weight`. Slot 0's
// weight is fixed low (PRIMARY_WEIGHT) so it only wins when its target
// count is several times higher than the best coverage candidate.
// Coverage slots use the deficit weight from the ranked list — heavier
// for the most undersampled features. The candidate with the highest
// score is the daily.
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
};

export function getTargetGimmickName(target) {
  return TARGET_TO_GIMMICK[target] || null;
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
// wins when its target_count is several times the best coverage. With
// PRIMARY_WEIGHT = 0.1 and a typical liar deficit_weight of ~0.5, the
// primary slot needs ~5× the cell count of the best coverage candidate
// to win. That tuning yields roughly 1-in-10 primary outcomes when the
// coverage list is well-populated, matching the design intent.
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

/**
 * Resolve the mission for the candidate identified by an effective
 * RNG seed of the form `${dateString}:trial${n}`. Returns the same
 * shape as getMissionForSlot. If the seed doesn't match the candidate
 * pattern (e.g. fallback to plain dateString in selectDailyRngSeed),
 * defaults to slot 0 / primary so the play path still picks a
 * sensible gimmick.
 */
export function getMissionForSeed(rngSeed) {
  if (typeof rngSeed !== 'string') return getMissionForSlot(0);
  const m = rngSeed.match(/:trial(\d+)$/);
  if (!m) return getMissionForSlot(0);
  return getMissionForSlot(parseInt(m[1], 10));
}

/**
 * Resolve the mission for a given candidate slot index. Returns:
 *   { target, deficitWeight, singleOnly, isPrimary }
 *
 * Slot 0 → primary high-CV target with full natural double-roll allowed.
 * Slots ≥1 → cycle through the coverage list with single-gimmick only.
 * If the coverage list is empty (legacy experimentTarget.json) every
 * slot falls back to primary, recovering the pre-multi-objective
 * behaviour where all 10 candidates compete on the same target.
 */
export function getMissionForSlot(slotIndex) {
  if (slotIndex === 0) {
    return {
      target:        getCurrentTarget(),
      deficitWeight: PRIMARY_WEIGHT,
      singleOnly:    false,
      isPrimary:     true,
    };
  }
  const coverage = getCoverageTargets();
  if (coverage.length === 0) {
    // Legacy fallback — no coverage list available, so every slot just
    // optimises the primary target like before.
    return {
      target:        getCurrentTarget(),
      deficitWeight: PRIMARY_WEIGHT,
      singleOnly:    false,
      isPrimary:     true,
    };
  }
  const entry = coverage[(slotIndex - 1) % coverage.length];
  return {
    target:        entry.feature,
    deficitWeight: typeof entry.deficit_weight === 'number' ? entry.deficit_weight : 0.1,
    singleOnly:    true,
    isPrimary:     false,
  };
}
