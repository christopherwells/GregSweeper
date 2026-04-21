import { safeGet, safeSet, safeRemove, safeGetJSON, safeSetJSON } from '../storage/storageAdapter.js';
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
export async function submitOnlineScore(dateString, name, time, bombHits = 0, extras = {}) {
  if (!isFirebaseOnline()) return false;

  // Client-side rate limiting: reject submissions too close together
  const now = Date.now();
  if (now - _lastSubmitTime < SUBMIT_COOLDOWN_MS) {
    console.warn('Score submission rate-limited — please wait before submitting again');
    return false;
  }

  // Basic score validation: reject impossible or unreasonable times
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

    const ref = db.ref(`daily/${dateString}`);
    await ref.push(payload);

    // Fire-and-forget meta upload. Don't block the score submission if the
    // meta write fails or is rejected (e.g. write-once rule when another
    // client already uploaded it for today).
    if (extras.features && typeof extras.features === 'object') {
      upsertDailyMeta(dateString, extras.features).catch(() => {});
    }

    _lastSubmitTime = now;
    return true;
  } catch (err) {
    console.warn('Firebase submit failed:', err.message);
    return false;
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
 * @returns {Promise<Array<{name: string, time: number, bombHits: number}>>} sorted entries
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

