// Per-user handicaps. Same idea as a golf handicap, but MULTIPLICATIVE:
// your typical pace as a RATIO of Greg-par, not a fixed seconds offset. A
// player's skill edge scales with how much board there is to solve, so a
// ratio (k < 1 = you finish in a fraction of Greg's time, k > 1 = you take
// longer) behaves correctly on tiny and huge boards alike. The old additive
// seconds handicap broke on small boards — a -57s offset is nonsense against
// a 3s par (see the "Proportional handicap" plan).
//
//   personalPar = globalPar × k  (+ your additive bomb-seconds cost)
//   adjusted    = time / k       (a Greg-equivalent time; never negative)
//
// A seconds MAGNITUDE is still shown for intuition (a RATING vs Greg), derived
// from the ratio at a REFERENCE par: displaySeconds = (1 - k) × refPar.
// POSITIVE = faster/better than Greg, negative = slower — so a fast player reads
// "+10s / +12%" and a slower one "−47s / −58%", stable across boards.
//
// Data source: src/logic/handicaps.json, refreshed daily by the "Refit
// Greg-par" GitHub Action. The ratio file is tagged `format: "logratio-v1"`;
// a legacy additive file (no format tag) is treated as UNRATED (k=1) for
// everyone — the client must never read additive seconds as ratios
// (+55s would become k=55). No Firebase round-trip at runtime.

// WIDE sanity bound on the ratio — rejects a degenerate/garbage value only,
// never shapes a real player. The regularizers are partial pooling (the R fit)
// and shrinkage-toward-1 (the provisional estimate below), which leave a
// well-sampled player on their true k however extreme; clamping a confidently
// -estimated k would censor real skill. [0.1, 10] never bites a plausible human.
export const HANDICAP_K_MIN = 0.1;
export const HANDICAP_K_MAX = 10.0;
// Fallback reference par for the seconds display when the file omits refPar.
export const REF_PAR_FALLBACK = 60;

let _format = 'additive'; // 'logratio-v1' | 'additive'
let _ratios = null;       // uid -> k (empty {} in legacy/unrated mode)
let _details = null;      // uid -> { k, bombSeconds }
let _refPar = REF_PAR_FALLBACK;
let _meta = null;
let _loading = null;

function clampK(k) {
  return Math.min(HANDICAP_K_MAX, Math.max(HANDICAP_K_MIN, k));
}

function applyLoaded(data) {
  const isRatio = !!(data && data.format === 'logratio-v1');
  _format = isRatio ? 'logratio-v1' : 'additive';
  if (isRatio) {
    _ratios = data.handicaps || {};
    _details = data.handicapDetails || {};
    _refPar = typeof data.refPar === 'number' && data.refPar > 0 ? data.refPar : REF_PAR_FALLBACK;
  } else {
    // Legacy additive file (or missing): do NOT interpret seconds as ratios.
    // Everyone is unrated (k=1) until a logratio-v1 file ships.
    _ratios = {};
    _details = {};
    _refPar = REF_PAR_FALLBACK;
  }
  _meta = data
    ? {
        updatedAt: data.updatedAt,
        modelFitN: data.modelFitN,
        nPlayers: data.nPlayers,
        method: data.method,
        format: _format,
        refPar: _refPar,
        // secPerBombHit is fit-only (not in shipped PAR_MODEL) but published
        // here for provisional-handicap bomb reasoning.
        secPerBombHit: typeof data.secPerBombHit === 'number' ? data.secPerBombHit : 0,
      }
    : { updatedAt: null, modelFitN: null, nPlayers: null, method: null, format: 'additive', refPar: REF_PAR_FALLBACK, secPerBombHit: 0 };
}

/**
 * Fetch the handicaps file. Cached after first call. Safe to call early —
 * a missing file falls back to unrated (every lookup returns k=1). Resolves
 * to the ratio map (uid -> k), which is what rankAdjusted consumes.
 */
export function loadHandicaps() {
  if (_ratios !== null) return Promise.resolve(_ratios);
  if (_loading) return _loading;

  _loading = fetch('./src/logic/handicaps.json')
    .then(r => (r.ok ? r.json() : null))
    .then(data => { applyLoaded(data); return _ratios; })
    .catch(() => { applyLoaded(null); return _ratios; });
  return _loading;
}

/**
 * Metadata from the loaded file: refit time, N, players, method, the format
 * ('logratio-v1' | 'additive'), the reference par, and the fitted per-bomb
 * cost. Nulls if load hasn't completed or the file was missing.
 */
export function getHandicapsMeta() {
  return _meta || { updatedAt: null, modelFitN: null, nPlayers: null, method: null, format: 'additive', refPar: REF_PAR_FALLBACK, secPerBombHit: 0 };
}

/** The reference par used to convert a ratio to a display-seconds magnitude. */
export function getRefPar() {
  return _refPar;
}

/** The raw ratio map (uid -> k). Empty {} in legacy/unrated mode. For rankAdjusted. */
export function getHandicapRatioMap() {
  return _ratios || {};
}

/**
 * The user's multiplicative handicap k (default 1 = neutral / unrated).
 * k > 1 = typically slower than Greg; k < 1 = faster. Defensively clamped.
 */
export function getHandicapRatio(uid) {
  if (!_ratios || !uid) return 1;
  const k = _ratios[uid];
  return typeof k === 'number' && Number.isFinite(k) && k > 0 ? clampK(k) : 1;
}

/** True when the uid is present in the shipped ratio fit (the "rated" flag). */
export function isRatedHandicap(uid) {
  return !!(_ratios && uid && typeof _ratios[uid] === 'number' && Number.isFinite(_ratios[uid]));
}

// Sign convention for the handicap RATING display, single-sourced so it can't
// drift or invert again: POSITIVE = faster/BETTER than Greg (k < 1), negative =
// slower/worse (k > 1). This is NOT the "your pace" par-composition line in the
// Lab File, which must add up to personalPar and so keeps +gregPar×(k-1).
export function ratioDisplaySeconds(k, refPar) { return (1 - k) * refPar; }
export function ratioDisplayPercent(k) { return (1 - k) * 100; }

/**
 * The user's handicap as a SECONDS magnitude at a reference par, a RATING vs
 * Greg. POSITIVE = typically FASTER/better than Greg, negative = slower.
 * Defaults to the shipped refPar (stable cross-board rating); pass a board's own
 * par for a board-scaled figure.
 */
export function getHandicapSeconds(uid, refPar = _refPar) {
  const base = typeof refPar === 'number' && refPar > 0 ? refPar : _refPar;
  return ratioDisplaySeconds(getHandicapRatio(uid), base);
}

/** The user's handicap as a percent. Positive = faster/better than Greg. */
export function getHandicapPercent(uid) {
  return ratioDisplayPercent(getHandicapRatio(uid));
}

/**
 * The {k, bombSeconds} decomposition from the ratio file, or null when the
 * refit hasn't emitted it (legacy file, missing uid, or load not complete).
 * Callers must treat null as "no itemization available" — never fabricate.
 */
export function getHandicapDetails(uid) {
  if (!_details || !uid) return null;
  const d = _details[uid];
  if (!d || typeof d.k !== 'number' || typeof d.bombSeconds !== 'number') return null;
  return d;
}

// Minimum pairs before we surface a provisional handicap. Two is the
// minimum where the mean isn't a single ratio in disguise.
const PROVISIONAL_HANDICAP_MIN_PAIRS = 2;
// Shrink a provisional ratio toward k=1 by n/(n+tau) in log space, matching
// the fit's partial-pooling philosophy so a lucky-fast day or two doesn't
// produce an extreme provisional k.
const PROVISIONAL_SHRINK_TAU = 3;

/**
 * Provisional ratio from the player's own history when handicaps.json has no
 * entry yet. k is the GEOMETRIC mean of time/par (exp(mean(log ratio)) — the
 * arithmetic mean of ratios is biased high, Jensen), shrunk toward 1 and
 * clamped. Each pair: `{ time, predictedPar }`. Returns { k, n, provisional }
 * or null below MIN_PAIRS. Bombs ride in the ratio implicitly (a player who
 * bombs is slower, so their time/par is higher) — the clean/bomb split only
 * comes from the R fit, never fabricated client-side.
 */
export function estimateHandicapDetails(pairs) {
  if (!Array.isArray(pairs)) return null;
  let sumLog = 0;
  let n = 0;
  for (const p of pairs) {
    if (typeof p.time !== 'number' || typeof p.predictedPar !== 'number') continue;
    if (p.time <= 0 || p.predictedPar <= 0) continue;
    sumLog += Math.log(p.time / p.predictedPar);
    n++;
  }
  if (n < PROVISIONAL_HANDICAP_MIN_PAIRS) return null;
  const meanLog = sumLog / n;
  const shrunk = meanLog * (n / (n + PROVISIONAL_SHRINK_TAU));
  const k = clampK(Math.exp(shrunk));
  return { k: Math.round(k * 1000) / 1000, n, provisional: true };
}

/** Provisional ratio only (default neutral k=1). */
export function estimateHandicapFromHistory(pairs) {
  const r = estimateHandicapDetails(pairs);
  return r ? r.k : 1;
}

export const PROVISIONAL_MIN = PROVISIONAL_HANDICAP_MIN_PAIRS;

/**
 * Rebuild the local residual cache from the user's Firebase dailyHistory +
 * the public dailyMeta tree. Used at boot so the provisional handicap
 * survives cache clears / private browsing / cross-device opens.
 *
 * Intentionally does NOT survive a uid reset (save-scumming). Best-effort:
 * failures are swallowed and return 0. Returns the number of residuals
 * appended (appendDailyResidual dedupes by date, so re-running is idempotent).
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
 * Your personal par = Greg-par × your ratio + your additive bomb-seconds.
 * Skill scales with the board (multiplicative); bombs are a fixed per-hit
 * seconds cost. bombSeconds is 0 unless the ratio fit shipped a {k, bombSeconds}.
 */
export function personalPar(globalPar, uid) {
  const k = getHandicapRatio(uid);
  const d = getHandicapDetails(uid);
  const bomb = d ? d.bombSeconds : 0;
  return globalPar * k + bomb;
}
