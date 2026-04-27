// Adaptive experimental design for the daily model refit.
//
// The Bayesian refit gives us per-coefficient posterior uncertainty.
// EVERY daily now picks, among a handful of candidate seeds, the one
// whose generated board maximises the currently-targeted feature. The
// target is chosen by the daily R refit (highest posterior coefficient
// of variation among a whitelist, EXCLUDING any feature targeted in the
// last 3 days) and shipped as a static JSON asset. The "no repeats in
// 3 days" rule lives on the R side — see `recentTargets` in
// experimentTarget.json — so this module just trusts whatever target
// the refit chose for today.
//
// Constraints this module respects:
// - Identical result on every client. All logic is a pure function of
//   the currently-loaded target; the target is the same for every
//   player on the same day, so the chosen seed is the same for every
//   player.
// - The target follows the fit, not the clock. If the refit hasn't run
//   for a day (Firebase blip, CI outage, whatever) we keep using the
//   previously-loaded target — no special-casing needed. Variety is
//   still preserved because that previous target was already chosen
//   to differ from the 2 days before it.
// - Fallback if the JSON can't be fetched at all: DEFAULT_TARGET
//   (currently advancedLogicMoves, the shakiest coefficient at the time
//   this module was written).

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
