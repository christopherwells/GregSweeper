import { safeGet, safeSet, safeRemove, safeGetJSON, safeSetJSON } from '../storage/storageAdapter.js';
import { isTestEnvironment } from './env.js';
import { reportCaughtError } from '../diagnostics/errorReporter.js';
import { findRowForBoard } from '../logic/scoreRowMatch.js';
/**
 * Firebase Online Daily Leaderboard
 * Uses Firebase Realtime Database (compat SDK loaded via CDN in index.html).
 * Falls back to localStorage when offline or Firebase unavailable.
 */

let firebaseReady = false;
let db = null;

// Client-side rate limiting: track last submission timestamp
let _lastSubmitTime = 0;
const SUBMIT_COOLDOWN_MS = 30000; // 30 seconds between submissions

// Score validation bounds
const MIN_VALID_TIME = 5;    // seconds — anything faster is impossible
const MAX_VALID_TIME = 3600; // seconds — 1 hour cap

// Retry queue for failed submissions. When a submit fails (offline,
// auth-race, transient Firebase error, or post-rules-deploy rejection on
// a stale client), queue the payload to localStorage. Flushed from
// initFirebase() on every successful boot.
const PENDING_KEY = 'minesweeper_pending_daily_submissions';
const PENDING_WEEKLY_KEY = 'minesweeper_pending_weekly_submissions';
const PENDING_MAX_ENTRIES = 10;                   // Drop oldest beyond this
// 14 days / 6 attempts (was 7 / 3). flushPending* only runs while online,
// so attempts increment only on real online tries — but on persistently
// bad service a player can burn several boots before reconnecting. The
// wider window is what lets a score queued on flaky service still recover
// when the player finally gets signal days later, instead of aging out.
const PENDING_MAX_AGE_MS = 14 * 24 * 3600 * 1000; // 14 days — older entries are stale
const PENDING_MAX_ATTEMPTS = 6;                   // Give up after N flushes per entry

function _queueFailedSubmission(dateString, name, time, bombHits, extras) {
  try {
    const pending = safeGetJSON(PENDING_KEY) || [];
    pending.push({
      dateString,
      name,
      time,
      bombHits,
      extras: extras || {},
      queuedAt: Date.now(),
      attempts: 0,
    });
    while (pending.length > PENDING_MAX_ENTRIES) pending.shift();
    safeSetJSON(PENDING_KEY, pending);
  } catch (err) {
    console.warn('Could not queue pending submission:', err.message);
  }
}

/**
 * Initialize Firebase. Call once on app startup.
 * Config should be replaced with user's own Firebase project config.
 */
export async function initFirebase() {
  try {
    // Check if Firebase SDK is available (loaded via CDN)
    if (typeof firebase === 'undefined' || !firebase.initializeApp) {
      console.log('Firebase SDK not loaded — leaderboard will be local-only');
      return;
    }

    // Firebase project configuration
    // Replace with your own Firebase project config from console.firebase.google.com
    const firebaseConfig = {
      apiKey: "AIzaSyBhiFPIUA0u021Yh7eA35N2nQOIUPVPtpo",
      authDomain: "gregsweeper-66d02.firebaseapp.com",
      databaseURL: "https://gregsweeper-66d02-default-rtdb.firebaseio.com",
      projectId: "gregsweeper-66d02",
      storageBucket: "gregsweeper-66d02.firebasestorage.app",
      messagingSenderId: "381276018616",
      appId: "1:381276018616:web:28a79187190dcf9caba14d"
    };

    // Only initialize if not already done
    if (!firebase.apps.length) {
      firebase.initializeApp(firebaseConfig);
    }

    db = firebase.database();

    // Test connectivity with a quick read
    try {
      await Promise.race([
        db.ref('.info/connected').once('value'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('connection timeout')), 5000)),
      ]);
    } catch (connErr) {
      console.warn('Firebase connected but database may be unreachable:', connErr.message);
      // Still mark as ready — individual operations have their own timeouts
    }

    firebaseReady = true;
    console.log('Firebase leaderboard initialized');
    // Catch up on any queued failed submissions from prior offline / auth-race sessions
    flushPendingSubmissions().catch(err => reportCaughtError('flush-pending-daily', err));
    flushPendingWeeklySubmissions().catch(err => reportCaughtError('flush-pending-weekly', err));
  } catch (err) {
    console.warn('Firebase init failed — using local leaderboard:', err.message);
    if (err.message?.includes('permission')) {
      console.warn('Hint: Check Firebase Realtime Database Security Rules in the Firebase Console.');
      console.warn('For testing, set rules to: { ".read": true, ".write": true }');
    }
    firebaseReady = false;
  }
}

/**
 * Check if Firebase is connected and available.
 */
export function isFirebaseOnline() {
  return firebaseReady && db !== null;
}

/**
 * Submit a score to the online daily leaderboard.
 *
 * Board features for the date are uploaded separately to `dailyMeta/{date}`
 * (write-once), because every player on a given date gets the same board and
 * denormalising features into every per-player score push would waste space
 * and complicate the R join for the offline refit.
 *
 * @param {string} dateString YYYY-MM-DD format
 * @param {string} name Player name (max 20 chars)
 * @param {number} time Completion time in seconds
 * @param {number} bombHits Number of bomb hits (daily mode strikes)
 * @param {Object} [extras]
 * @param {string} [extras.uid] Stable anonymous uid for per-user analyses
 * @param {number} [extras.par] Predicted par at play time (for R diagnostics)
 * @param {Object} [extras.features] Board feature vector for dailyMeta upsert
 * @returns {Promise<boolean>} true if submitted successfully
 */
/**
 * Internal: push the score to Firebase. No rate limiting. Returns true
 * on success, false on any validation/network/auth failure. Shared by
 * submitOnlineScore (with rate limit + queueing) and flushPendingSubmissions
 * (bypasses rate limit because queue entries are legitimate prior attempts,
 * not user spam).
 */
async function _doSubmitOnlineScore(dateString, name, time, bombHits, extras) {
  if (!isFirebaseOnline()) return false;

  if (typeof time !== 'number' || time < MIN_VALID_TIME || time > MAX_VALID_TIME) {
    console.warn(`Score rejected — time ${time}s is outside valid range (${MIN_VALID_TIME}–${MAX_VALID_TIME}s)`);
    return false;
  }

  try {
    const sanitizedName = String(name).slice(0, 20).trim();
    if (!sanitizedName) return false;

    const payload = {
      name: sanitizedName,
      time,
      bombHits,
      timestamp: firebase.database.ServerValue.TIMESTAMP,
    };
    if (extras.uid) payload.uid = String(extras.uid);
    if (typeof extras.par === 'number') payload.par = extras.par;
    // Per-hit event log: [{ t, row, col, penalty?, infoValue? }, ...].
    // - v1.5.9+ plays carry { t, row, col }.
    // - v1.5.149+ plays (new info-value bomb mechanic) additionally
    //   carry `penalty` and `infoValue`. The R refit treats events
    //   without a `penalty` field as the legacy +10s/re-fog cohort.
    // Denormalised `totalBombPenalty` is the sum of per-hit penalties on
    // the row, so the R-side `clean_time = time - totalBombPenalty`
    // subtraction is a single column read instead of an unnest.
    if (Array.isArray(extras.bombHitEvents) && extras.bombHitEvents.length > 0) {
      payload.bombHitEvents = extras.bombHitEvents;
      let totalPenalty = 0;
      for (const e of extras.bombHitEvents) {
        if (e && typeof e.penalty === 'number') totalPenalty += e.penalty;
      }
      if (totalPenalty > 0) {
        payload.totalBombPenalty = Math.round(totalPenalty * 10) / 10;
      }
    }
    // Lens invocations: [{ t, kind }] with kind 'flag-warning' | 'region'.
    // Hints change completion times, so the R refit EXCLUDES hinted plays
    // from the par fit — an uninstrumented hint system would quietly
    // corrupt the model. Only attached when the player actually used the
    // lens, so hint-free rows stay byte-identical to before.
    if (Array.isArray(extras.hintEvents) && extras.hintEvents.length > 0) {
      payload.hintEvents = extras.hintEvents;
    }
    // Effective RNG seed used for this daily's generation. Equal to the
    // dateString on non-experiment days, a `:trialN` variant on
    // adaptive-experiment days (see experimentDesign.js). Stored so
    // the R refit can reproduce the exact board offline if it ever
    // needs to recompute features or solver move-type counts.
    if (typeof extras.rngSeed === 'string' && extras.rngSeed !== dateString) {
      payload.rngSeed = extras.rngSeed;
    }

    // One row per (player, board): if this uid already has a row for the
    // SAME effective board seed, the score was already recorded —
    // typically by another device signed into the same account, or by a
    // queued retry whose original push actually landed. Skip the push
    // and report 'duplicate' so callers can toast honestly instead of
    // claiming a fresh submission. Matching is per BOARD, not per uid
    // (see scoreRowMatch.js): a practice (?seed=) row can never block
    // the real daily, and a player with a divergent historical row can
    // still land their canonical replay. A failed read falls open to
    // the push — a flaky read must not eat a real score.
    if (extras.uid) {
      try {
        const existing = await db.ref(`daily/${dateString}`).once('value');
        const dup = findRowForBoard(
          existing.val(), String(extras.uid), dateString,
          typeof extras.rngSeed === 'string' ? extras.rngSeed : dateString,
        );
        if (dup) return 'duplicate';
      } catch { /* read failed — proceed with the push */ }
    }

    const ref = db.ref(`daily/${dateString}`);
    await ref.push(payload);

    // Fire-and-forget meta upload. Don't block the score submission if the
    // meta write fails or is rejected (e.g. write-once rule when another
    // client already uploaded it for today).
    if (extras.features && typeof extras.features === 'object') {
      // PERMISSION_DENIED is the EXPECTED write-once rejection when another
      // client already wrote today's meta — only unexpected failures report.
      upsertDailyMeta(dateString, extras.features).catch(err => {
        const msg = String((err && err.code) || (err && err.message) || '');
        if (!/permission[ _]?denied/i.test(msg)) reportCaughtError('daily-meta-upsert', err);
      });
    }

    return true;
  } catch (err) {
    console.warn('Firebase submit failed:', err.message);
    return false;
  }
}

export async function submitOnlineScore(dateString, name, time, bombHits = 0, extras = {}) {
  // Test branch: never write to the production leaderboard. Reads
  // (fetchOnlineLeaderboard) still work so the modal still shows
  // current standings, but no test score lands in the bucket.
  if (isTestEnvironment()) return false;
  // Offline / Firebase not ready — queue and retry on next successful boot
  if (!isFirebaseOnline()) {
    _queueFailedSubmission(dateString, name, time, bombHits, extras);
    return false;
  }

  // Client-side rate limiting — reject without queueing (user spam, not a
  // submission worth retrying)
  const now = Date.now();
  if (now - _lastSubmitTime < SUBMIT_COOLDOWN_MS) {
    console.warn('Score submission rate-limited — please wait before submitting again');
    return false;
  }

  // Three-way outcome: true (pushed), false (failed — queued for retry),
  // 'duplicate' (this account already has a row for this exact board —
  // definitive, not queued, no cooldown burned).
  const ok = await _doSubmitOnlineScore(dateString, name, time, bombHits, extras);
  if (ok === true) {
    _lastSubmitTime = now;
  } else if (ok === false) {
    // Push failed mid-flight (transient network, auth race, or post-deploy
    // rule rejection on a stale client). Queue for retry.
    _queueFailedSubmission(dateString, name, time, bombHits, extras);
  }
  return ok;
}

/**
 * Submit a timed-mode run to `timed/{pushId}`. Unlike daily, every timed
 * board is unique, so the feature vector rides the row itself (there is
 * no per-date meta bucket to join against). These rows are fit-data
 * first, leaderboard later: the R refit starts using them via a
 * modeTimed effect once >= 20 rows exist (same threshold pattern as new
 * feature coefficients). Fire-and-forget — no retry queue; timed runs
 * are frequent and a lost row is statistically replaceable.
 *
 * @param {string} name Player name
 * @param {number} time Completion time in seconds
 * @param {number} level Difficulty tab (1-4: Beginner..Extreme)
 * @param {Object} extras { uid, par, features }
 * @returns {Promise<boolean>}
 */
export async function submitTimedScore(name, time, level, extras = {}) {
  if (isTestEnvironment()) return false;
  if (!isFirebaseOnline()) return false;
  if (typeof time !== 'number' || time < MIN_VALID_TIME || time > MAX_VALID_TIME) return false;

  const now = Date.now();
  if (now - _lastSubmitTime < SUBMIT_COOLDOWN_MS) return false;

  try {
    const sanitizedName = String(name).slice(0, 20).trim();
    if (!sanitizedName) return false;
    const payload = {
      name: sanitizedName,
      time,
      level: typeof level === 'number' ? level : 0,
      timestamp: firebase.database.ServerValue.TIMESTAMP,
    };
    if (extras.uid) payload.uid = String(extras.uid);
    if (typeof extras.par === 'number' && extras.par > 0) payload.par = extras.par;
    if (extras.features && typeof extras.features === 'object') {
      payload.features = extras.features;
    }
    await db.ref('timed').push(payload);
    _lastSubmitTime = now;
    return true;
  } catch (err) {
    console.warn('Timed score submission failed:', err && err.message);
    return false;
  }
}

/**
 * Resubmit any queued failed score writes. Called by initFirebase() on every
 * successful boot. Bypasses SUBMIT_COOLDOWN_MS — queue entries are legitimate
 * prior submissions, not user spam. Drops entries older than PENDING_MAX_AGE_MS
 * or that have hit PENDING_MAX_ATTEMPTS.
 */
export async function flushPendingSubmissions() {
  // Never write prod scores from a test session — the pending queue lives in
  // localStorage, shared across the master/test github.io origin, so a score
  // queued on master must not flush while the test build is open.
  if (isTestEnvironment()) return;
  if (!isFirebaseOnline()) return;
  let pending;
  try {
    pending = safeGetJSON(PENDING_KEY);
  } catch (err) {
    console.warn('Could not read pending submissions:', err.message);
    return;
  }
  if (!Array.isArray(pending) || pending.length === 0) return;

  const stillPending = [];
  const now = Date.now();
  let flushed = 0;
  for (const entry of pending) {
    if (now - entry.queuedAt > PENDING_MAX_AGE_MS) continue;
    if (entry.attempts >= PENDING_MAX_ATTEMPTS) continue;
    entry.attempts++;
    const ok = await _doSubmitOnlineScore(
      entry.dateString,
      entry.name,
      entry.time,
      entry.bombHits,
      entry.extras || {}
    );
    // 'duplicate' resolves the entry too: the score is already on the
    // board (the original push landed, or another device submitted
    // while this one was offline) — retrying would only re-read.
    if (ok) flushed++;
    else stillPending.push(entry);
  }
  try {
    safeSetJSON(PENDING_KEY, stillPending);
  } catch (err) {
    console.warn('Could not save pending submissions:', err.message);
  }
  if (flushed > 0) {
    console.log(`Re-submitted ${flushed} pending daily score(s) after reconnect.`);
  }
}

/**
 * Submit the player's weekly result to `weekly/{weekStart}/{uid}`.
 * Writes per-day data via `update` and bestTime via a transaction, so
 * each day's entry is additive and never clobbers prior days even if
 * the pre-fetch of existing data failed.
 *
 * Caller passes only today's {day: time} entry and a local bestTime
 * candidate. The transaction ensures server-side bestTime only decreases.
 *
 * @param {string} weekStart 'YYYY-MM-DD' Monday in ET
 * @param {string} uid stable anonymous uid
 * @param {string} name player name (max 20 chars)
 * @param {number} bestTime local best-time candidate (seconds)
 * @param {Object<number, number>} dayTimes today's entry, e.g. {2: 50.1}
 * @returns {Promise<boolean>}
 */
export async function submitWeeklyScore(weekStart, uid, name, bestTime, dayTimes, extras = {}) {
  // Test branch: don't write to the production weekly leaderboard.
  if (isTestEnvironment()) return false;
  if (!weekStart || !uid) return false;
  if (typeof bestTime !== 'number' || bestTime < MIN_VALID_TIME || bestTime > MAX_VALID_TIME) {
    console.warn(`Weekly bestTime ${bestTime}s outside valid range`);
    return false;
  }
  // Offline — durably queue and retry on the next online boot (mirrors the
  // daily path). Previously a flaky connection here dropped the weekly
  // score permanently with no retry, which is how Kate's weekly attempts
  // could vanish on bad service.
  if (!isFirebaseOnline()) {
    _queueFailedWeeklySubmission(weekStart, uid, name, bestTime, dayTimes, extras);
    return false;
  }
  const ok = await _doSubmitWeeklyScore(weekStart, uid, name, bestTime, dayTimes, extras);
  if (!ok) _queueFailedWeeklySubmission(weekStart, uid, name, bestTime, dayTimes, extras);
  return ok;
}

async function _doSubmitWeeklyScore(weekStart, uid, name, bestTime, dayTimes, extras = {}) {
  try {
    const sanitizedName = String(name).slice(0, 20).trim();
    if (!sanitizedName) return false;

    const safeDayTimes = {};
    if (dayTimes && typeof dayTimes === 'object') {
      for (const [k, v] of Object.entries(dayTimes)) {
        const day = Number(k);
        if (Number.isInteger(day) && day >= 0 && day <= 6
            && typeof v === 'number' && v >= MIN_VALID_TIME && v <= MAX_VALID_TIME) {
          safeDayTimes[day] = v;
        }
      }
    }

    const safeDayBombHits = {};
    if (extras.dayBombHits && typeof extras.dayBombHits === 'object') {
      for (const [k, v] of Object.entries(extras.dayBombHits)) {
        const day = Number(k);
        if (Number.isInteger(day) && day >= 0 && day <= 6
            && typeof v === 'number' && v >= 0 && v <= 50) {
          safeDayBombHits[day] = v;
        }
      }
    }

    const ref = db.ref(`weekly/${weekStart}/${uid}`);

    // Additive per-day write: only touches the days in this submission,
    // never overwrites prior days. Fixes #27.
    const updates = {
      name: sanitizedName,
      timestamp: firebase.database.ServerValue.TIMESTAMP,
    };
    for (const [day, time] of Object.entries(safeDayTimes)) {
      updates[`dayTimes/${day}`] = time;
    }
    for (const [day, hits] of Object.entries(safeDayBombHits)) {
      updates[`dayBombHits/${day}`] = hits;
    }
    if (typeof extras.totalMoves === 'number' && extras.totalMoves > 0 && extras.totalMoves < 1000) {
      updates.totalMoves = extras.totalMoves;
    }

    try {
      await ref.update(updates);
      await ref.child('bestTime').transaction(current => {
        if (current === null || bestTime <= current) return bestTime;
        return undefined;
      }).catch(err => reportCaughtError('weekly-besttime-transaction', err));
      return true;
    } catch {
      // First write for this player+week — node doesn't exist yet, so
      // update() failed the hasChildren rule. set() is safe here because
      // there's no prior data to clobber.
      const payload = {
        name: sanitizedName,
        bestTime,
        timestamp: firebase.database.ServerValue.TIMESTAMP,
      };
      if (Object.keys(safeDayTimes).length > 0) payload.dayTimes = safeDayTimes;
      if (Object.keys(safeDayBombHits).length > 0) payload.dayBombHits = safeDayBombHits;
      if (typeof extras.totalMoves === 'number' && extras.totalMoves > 0 && extras.totalMoves < 1000) {
        payload.totalMoves = extras.totalMoves;
      }
      await ref.set(payload);
      return true;
    }
  } catch (err) {
    console.warn('Weekly score submit failed:', err.message);
    return false;
  }
}

function _queueFailedWeeklySubmission(weekStart, uid, name, bestTime, dayTimes, extras) {
  try {
    const pending = safeGetJSON(PENDING_WEEKLY_KEY) || [];
    const existingIdx = pending.findIndex(e => e && e.weekStart === weekStart && e.uid === uid);
    if (existingIdx >= 0) {
      // Merge today's day into the existing queued entry so both days
      // reach Firebase on flush — with additive writes each day is
      // independent.
      const existing = pending[existingIdx];
      existing.dayTimes = { ...existing.dayTimes, ...(dayTimes || {}) };
      if (extras?.dayBombHits) {
        existing.extras = existing.extras || {};
        existing.extras.dayBombHits = { ...(existing.extras.dayBombHits || {}), ...extras.dayBombHits };
      }
      existing.bestTime = Math.min(existing.bestTime, bestTime);
      existing.name = name;
      existing.queuedAt = Date.now();
      existing.attempts = 0;
    } else {
      pending.push({
        weekStart, uid, name, bestTime,
        dayTimes: dayTimes || {},
        extras: extras || {},
        queuedAt: Date.now(),
        attempts: 0,
      });
    }
    while (pending.length > PENDING_MAX_ENTRIES) pending.shift();
    safeSetJSON(PENDING_WEEKLY_KEY, pending);
  } catch (err) {
    console.warn('Could not queue pending weekly submission:', err.message);
  }
}

/**
 * Resubmit any queued failed weekly writes. Called by initFirebase() on
 * every successful boot, next to flushPendingSubmissions(). Same staleness
 * rules as the daily queue.
 */
export async function flushPendingWeeklySubmissions() {
  // Test-session guard (see flushPendingSubmissions). The weekly path
  // writes per-day data additively, but a stray test-session flush
  // would still pollute the player's live weekly row.
  if (isTestEnvironment()) return;
  if (!isFirebaseOnline()) return;
  let pending;
  try {
    pending = safeGetJSON(PENDING_WEEKLY_KEY);
  } catch (err) {
    console.warn('Could not read pending weekly submissions:', err.message);
    return;
  }
  if (!Array.isArray(pending) || pending.length === 0) return;

  const stillPending = [];
  const now = Date.now();
  let flushed = 0;
  for (const entry of pending) {
    if (now - entry.queuedAt > PENDING_MAX_AGE_MS) continue;
    if (entry.attempts >= PENDING_MAX_ATTEMPTS) continue;
    entry.attempts++;
    const ok = await _doSubmitWeeklyScore(
      entry.weekStart, entry.uid, entry.name, entry.bestTime, entry.dayTimes, entry.extras || {}
    );
    if (ok) flushed++;
    else stillPending.push(entry);
  }
  try {
    safeSetJSON(PENDING_WEEKLY_KEY, stillPending);
  } catch (err) {
    console.warn('Could not save pending weekly submissions:', err.message);
  }
  if (flushed > 0) {
    console.log(`Re-submitted ${flushed} pending weekly score(s) after reconnect.`);
  }
}

/**
 * Fetch the weekly leaderboard for a given weekStart. Returns an
 * array sorted by bestTime ascending (faster on top), with ties broken
 * by attempts-used (more attempts → better tiebreaker so single-day
 * flukes don't beat full-week explorers). Returns [] when offline or
 * empty.
 */
export async function fetchWeeklyLeaderboard(weekStart) {
  if (!isFirebaseOnline() || !weekStart) return [];
  try {
    const snap = await Promise.race([
      db.ref(`weekly/${weekStart}`).once('value'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
    ]);
    if (!snap.exists()) return [];

    const rows = [];
    snap.forEach((child) => {
      const v = child.val();
      if (v && typeof v.bestTime === 'number') {
        const dayTimes = v.dayTimes || {};
        const dayBombHits = v.dayBombHits || {};
        // Find which day produced the best time so we can report the
        // strikes from that specific play. If bestTime appears on
        // multiple days (rare, players matching their own time), the
        // first match wins — fine for the leaderboard column.
        let bestDay = null;
        for (const [k, t] of Object.entries(dayTimes)) {
          if (Math.abs(t - v.bestTime) < 0.05) { bestDay = Number(k); break; }
        }
        const bestDayBombHits = bestDay != null && typeof dayBombHits[bestDay] === 'number'
          ? dayBombHits[bestDay] : null;
        rows.push({
          uid: child.key,
          name: v.name || 'Anonymous',
          bestTime: v.bestTime,
          dayTimes,
          dayBombHits,
          bestDay,
          bestDayBombHits,
          totalMoves: typeof v.totalMoves === 'number' ? v.totalMoves : null,
          attemptsUsed: Object.keys(dayTimes).length,
        });
      }
    });

    rows.sort((a, b) => {
      if (a.bestTime !== b.bestTime) return a.bestTime - b.bestTime;
      return b.attemptsUsed - a.attemptsUsed; // more attempts → higher rank on tie
    });
    return rows;
  } catch (err) {
    console.warn('Weekly leaderboard fetch failed:', err.message);
    return [];
  }
}

/**
 * Write `dailyMeta/{date}` if it doesn't already exist. Rules enforce
 * write-once server-side; the client check here is a bandwidth optimisation,
 * not a guarantee. The FIRST successful client submission for a date lands
 * the features; everyone else no-ops.
 */
async function upsertDailyMeta(dateString, features) {
  if (!isFirebaseOnline()) return;
  const ref = db.ref(`dailyMeta/${dateString}`);
  const snap = await ref.once('value');
  if (snap.exists()) return;
  await ref.set({
    features,
    writtenAt: firebase.database.ServerValue.TIMESTAMP,
  });
}

/**
 * Fetch the current user's daily history, most-recent-first, limited to
 * `daysBack` recent entries. Returns an array of `{ date, time }` or null
 * if Firebase is offline. Par and delta are computed at render time against
 * the current PAR_MODEL + dailyMeta features, so that older entries
 * automatically reflect the latest coefficients after a refit (no server-
 * side rewrite needed).
 */
export async function fetchUserDailyHistory(uid, daysBack = 30) {
  if (!isFirebaseOnline() || !uid) return null;
  try {
    const ref = db.ref(`users/${uid}/dailyHistory`);
    const snapshot = await Promise.race([
      ref.once('value'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
    if (!snapshot.exists()) return [];

    const entries = [];
    snapshot.forEach((child) => {
      const v = child.val();
      if (v && typeof v.time === 'number') {
        entries.push({ date: child.key, time: v.time });
      }
    });

    entries.sort((a, b) => b.date.localeCompare(a.date));
    return entries.slice(0, daysBack);
  } catch (err) {
    console.warn('Firebase daily-history fetch failed:', err.message);
    return null;
  }
}

/**
 * Fetch the full daily score tree — a map of `{ date: [{uid, name, time, bombHits, ...}, ...] }`.
 * Flattens each date's pushId-keyed object into a plain array. Used by
 * the stats page's percentile-trend chart to rank the signed-in user
 * against the full field on each date. World-readable.
 * Returns null on error.
 */
export async function fetchAllDailyScores() {
  if (!isFirebaseOnline()) return null;
  try {
    const snapshot = await Promise.race([
      db.ref('daily').once('value'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
    ]);
    if (!snapshot.exists()) return {};
    const byDate = {};
    snapshot.forEach((dateChild) => {
      const date = dateChild.key;
      const scores = [];
      dateChild.forEach((entryChild) => {
        const v = entryChild.val();
        if (v && typeof v.time === 'number') {
          scores.push({
            uid: v.uid || null,
            name: v.name || 'Anonymous',
            time: v.time,
            bombHits: v.bombHits || 0,
          });
        }
      });
      byDate[date] = scores;
    });
    return byDate;
  } catch (err) {
    console.warn('Firebase all-daily fetch failed:', err.message);
    return null;
  }
}

/**
 * Fetch the full dailyMeta tree — a map of `{ date: features }`. Used by
 * the history chart to compute each historical entry's par on the fly
 * against the current PAR_MODEL. World-readable, no auth needed.
 * Returns null on error.
 */
export async function fetchAllDailyMeta() {
  if (!isFirebaseOnline()) return null;
  try {
    const snapshot = await Promise.race([
      db.ref('dailyMeta').once('value'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
    if (!snapshot.exists()) return {};

    const byDate = {};
    snapshot.forEach((child) => {
      const v = child.val();
      if (v && v.features) byDate[child.key] = v.features;
    });
    return byDate;
  } catch (err) {
    console.warn('Firebase dailyMeta fetch failed:', err.message);
    return null;
  }
}

// NOTE: Client-side validation is not sufficient for security.
// Firebase Security Rules should be configured to enforce:
//   - Time range validation (5–3600 seconds)
//   - Rate limiting per user/IP
//   - Name length and content sanitization
//   - Date string format validation
// See: https://firebase.google.com/docs/database/security

/**
 * Fetch the online daily leaderboard for a given date.
 * @param {string} dateString YYYY-MM-DD format
 * @returns {Promise<Array<{name: string, time: number, bombHits: number, uid: string|null}>>}
 *   sorted entries. uid rides along for the Adjusted (handicap) and
 *   Friends leaderboard views; rows are public either way.
 */
export async function fetchOnlineLeaderboard(dateString) {
  if (!isFirebaseOnline()) return null;

  try {
    const ref = db.ref(`daily/${dateString}`);
    // Race against a 5-second timeout to avoid hanging on bad config
    const snapshot = await Promise.race([
      ref.orderByChild('time').limitToFirst(50).once('value'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);

    if (!snapshot.exists()) return [];

    const entries = [];
    snapshot.forEach((child) => {
      const val = child.val();
      entries.push({
        name: val.name || 'Anonymous',
        time: val.time || 0,
        bombHits: val.bombHits || 0,
        uid: val.uid || null,
      });
    });

    // Already sorted by time from Firebase query, but ensure it
    entries.sort((a, b) => a.time - b.time);
    return entries;
  } catch (err) {
    console.warn('Firebase fetch failed:', err.message);
    return null; // null signals to fall back to local
  }
}

