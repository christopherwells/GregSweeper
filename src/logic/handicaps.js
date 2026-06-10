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
let _details = null;  // v2: uid -> { clean, bomb } decomposition
let _meta = null;
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
      _details = (data && data.handicapDetails) || {};
      _meta = data
        ? {
            updatedAt: data.updatedAt,
            modelFitN: data.modelFitN,
            nPlayers: data.nPlayers,
            method: data.method,
            // secPerBombHit is fit-only (not in shipped PAR_MODEL) but the
            // refit publishes it here so the client can subtract bomb-hit
            // contributions when computing provisional handicaps. Without
            // this, a player with one fast day and one bomb-hit day sees
            // a wildly swinging provisional handicap.
            secPerBombHit: typeof data.secPerBombHit === 'number' ? data.secPerBombHit : 0,
          }
        : { updatedAt: null, modelFitN: null, nPlayers: null, method: null, secPerBombHit: 0 };
      return _handicaps;
    })
    .catch(() => {
      _handicaps = {};
      _details = {};
      _meta = { updatedAt: null, modelFitN: null, nPlayers: null, method: null, secPerBombHit: 0 };
      return _handicaps;
    });
  return _loading;
}

/**
 * Metadata from the currently-loaded handicaps.json: when the GitHub
 * Action last refit, how many scores it saw, how many players, which
 * method (brms-ranef / seed-residuals), and the fitted per-bomb-hit
 * time cost (used for provisional-handicap bomb subtraction).
 * Returns nulls if loadHandicaps hasn't completed yet or the file was
 * missing.
 */
export function getHandicapsMeta() {
  return _meta || { updatedAt: null, modelFitN: null, nPlayers: null, method: null, secPerBombHit: 0 };
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
 * The clean/bomb decomposition of the user's handicap (handicaps.json
 * v2's handicapDetails), or null when the refit hasn't emitted it yet
 * (pre-v2 file, missing uid, or load not complete). Callers must treat
 * null as "no itemization available" — never fabricate a split.
 */
export function getHandicapDetails(uid) {
  if (!_details || !uid) return null;
  const d = _details[uid];
  if (!d || typeof d.clean !== 'number' || typeof d.bomb !== 'number') return null;
  return d;
}

// Minimum residuals before we'll surface a provisional handicap. Two is
// the minimum where the mean isn't just a single delta in disguise;
// the wide-uncertainty caveat is rendered alongside the number.
const PROVISIONAL_HANDICAP_MIN_PAIRS = 2;

/**
 * Estimate a handicap from the player's own history when the static
 * handicaps.json doesn't have an entry yet (typical during the first
 * days after a player starts — their uid-tagged scores exist, but the
 * GitHub Action hasn't refitted since they first appeared, so their
 * handicap is missing from the file).
 *
 * Returns the mean residual (`time - predictedPar`) across a list of
 * `{ time, predictedPar }` pairs. Below MIN_PAIRS returns 0.
 */
export function estimateHandicapFromHistory(pairs) {
  const r = estimateHandicapDetails(pairs);
  return r ? r.handicap : 0;
}

/**
 * Same as estimateHandicapFromHistory but also returns the sample size
 * so callers can render an "(N plays)" qualifier alongside the number.
 * Returns null when the sample is too small to surface anything.
 *
 * Each pair: `{ time, predictedPar }`. The handicap is your offset from
 * Greg's CLEAN par INCLUDING your bomb factor — bombs are part of your
 * handicap, not stripped out. Greg-par is the clean board difficulty; how
 * you actually play, bombs and all, lives in the handicap. So we use the
 * raw delta, realized time − clean par. Averaging over plays keeps a single
 * bomb day from swinging it, while a player who reliably bombs rightly
 * carries that cost in their handicap.
 */
export function estimateHandicapDetails(pairs) {
  if (!Array.isArray(pairs)) return null;
  let sum = 0;
  let n = 0;
  for (const p of pairs) {
    if (typeof p.time !== 'number' || typeof p.predictedPar !== 'number') continue;
    sum += p.time - p.predictedPar;
    n++;
  }
  if (n < PROVISIONAL_HANDICAP_MIN_PAIRS) return null;
  return {
    handicap: Math.round((sum / n) * 10) / 10,
    n,
    provisional: true,
  };
}

export const PROVISIONAL_MIN = PROVISIONAL_HANDICAP_MIN_PAIRS;

/**
 * Rebuild the local residual cache from the user's Firebase dailyHistory
 * + the public dailyMeta tree. Used at app boot so the provisional
 * handicap survives cache clears, private-browsing sessions, and cross-
 * device opens.
 *
 * Intentionally does NOT survive a uid reset (save-scumming) — that's a
 * deliberate "start over" gesture by the player, and silently linking
 * to old uids by name would be guessable and fragile.
 *
 * Returns the number of residuals appended. appendDailyResidual dedupes
 * by date so re-running is idempotent.
 *
 * Best-effort: failures are swallowed and return 0. The win-path
 * residual append still runs regardless, so even a backfill failure
 * doesn't degrade the per-play recording.
 */
export async function backfillResidualsFromFirebase(uid) {
  if (!uid) return 0;
  try {
    const [{ fetchUserDailyHistory, fetchAllDailyMeta }, dailyFeatures, statsStorage] = await Promise.all([
      import('../firebase/firebaseLeaderboard.js'),
      import('./dailyFeatures.js'),
      import('../storage/statsStorage.js'),
    ]);
    const [history, meta] = await Promise.all([
      fetchUserDailyHistory(uid, 50),
      fetchAllDailyMeta(),
    ]);
    if (!Array.isArray(history) || !meta) return 0;
    let added = 0;
    for (const h of history) {
      if (!h || !h.date || typeof h.time !== 'number') continue;
      const m = meta[h.date];
      const features = m && m.features ? m.features : null;
      if (!features) continue;
      const par = dailyFeatures.predictPar(features);
      if (typeof par !== 'number' || par <= 0) continue;
      statsStorage.appendDailyResidual({ date: h.date, time: h.time, par });
      added++;
    }
    return added;
  } catch {
    return 0;
  }
}

/**
 * Your personal par = Greg-par + your handicap.
 */
export function personalPar(globalPar, uid) {
  return globalPar + getHandicap(uid);
}
