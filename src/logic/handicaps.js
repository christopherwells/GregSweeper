// Per-user handicaps. Same idea as a golf handicap: your typical offset
// from Greg-par across all your past dailies. Negative handicap = you beat
// par on average; positive = you trail. Shown alongside the global par in
// the end-of-game modal so fast and slow players each see a par that
// actually reflects what they usually do.
//
// Data source: src/logic/handicaps.json, refreshed daily by the
// "Refit Greg-par" GitHub Action (.github/workflows/refit-par-model.yml).
// The JSON is a static asset committed to the repo, so handicaps ship the
// same way the rest of the app does (through GitHub Pages + the service
// worker cache). No Firebase round-trip at runtime.

let _handicaps = null;
let _loading = null;

/**
 * Fetch the handicaps map. Cached after first call. Safe to call early —
 * if the file doesn't exist yet (e.g. very first deploy before any refit
 * has run), we fall back to an empty map and every lookup returns 0.
 */
export function loadHandicaps() {
  if (_handicaps !== null) return Promise.resolve(_handicaps);
  if (_loading) return _loading;

  _loading = fetch('./src/logic/handicaps.json')
    .then(r => (r.ok ? r.json() : null))
    .then(data => {
      _handicaps = (data && data.handicaps) || {};
      return _handicaps;
    })
    .catch(() => {
      _handicaps = {};
      return _handicaps;
    });
  return _loading;
}

/**
 * Return the signed-in user's handicap in seconds, or 0 if unknown.
 * Synchronous — returns 0 if loadHandicaps hasn't completed yet (or if
 * the user has fewer than MIN_PLAYS_FOR_HANDICAP plays, in which case
 * the refit intentionally omitted them from the map).
 */
export function getHandicap(uid) {
  if (!_handicaps || !uid) return 0;
  const v = _handicaps[uid];
  return typeof v === 'number' ? v : 0;
}

/**
 * Estimate a handicap from the player's own history when the static
 * handicaps.json doesn't have an entry yet (typical during the first
 * days after a player starts — their uid-tagged scores exist, but the
 * GitHub Action hasn't refitted since they first appeared, so their
 * handicap is missing from the file).
 *
 * Returns the mean residual (`time - predictedPar`) across a list of
 * `{ time, predictedPar }` pairs. Lower bound of 3 pairs — below that
 * the mean is too noisy to surface.
 */
export function estimateHandicapFromHistory(pairs) {
  if (!Array.isArray(pairs) || pairs.length < 3) return 0;
  let sum = 0;
  let n = 0;
  for (const p of pairs) {
    if (typeof p.time !== 'number' || typeof p.predictedPar !== 'number') continue;
    sum += p.time - p.predictedPar;
    n++;
  }
  if (n < 3) return 0;
  return Math.round((sum / n) * 10) / 10;
}

/**
 * Your personal par = Greg-par + your handicap.
 */
export function personalPar(globalPar, uid) {
  return globalPar + getHandicap(uid);
}
