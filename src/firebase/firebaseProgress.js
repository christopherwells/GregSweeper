/**
 * Firebase Anonymous Auth + Cloud Progress Sync
 *
 * Syncs minimal progress (challenge checkpoint, daily streak) to Firebase
 * so it survives cache clears and device switches. No account creation,
 * no prompts — completely invisible to the user.
 *
 * Requires Firebase App + Auth + Database SDKs (loaded via CDN in index.html)
 * and initFirebase() from firebaseLeaderboard.js to have been called first.
 */

const FIREBASE_TIMEOUT_MS = 5000;

let _uid = null;
let _db = null;
let _ready = false;

/**
 * Sign in anonymously and prepare for progress sync.
 * Call after initFirebase(). Silent — no UI, no errors shown.
 */
export async function initAnonymousAuth() {
  try {
    if (typeof firebase === 'undefined' || !firebase.auth) return;
    if (!firebase.apps.length) return; // initFirebase must run first

    const result = await Promise.race([
      firebase.auth().signInAnonymously(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('auth timeout')), FIREBASE_TIMEOUT_MS)),
    ]);

    _uid = result.user.uid;
    _db = firebase.database();
    _ready = true;
  } catch (err) {
    // Silent failure — progress stays local-only
    console.warn('Anonymous auth failed:', err.message);
  }
}

/**
 * Save progress to cloud. Call when checkpoint advances or daily streak updates.
 * Fire-and-forget — does not block gameplay.
 */
export function saveProgress({ maxCheckpoint, dailyStreak, bestDailyStreak, lastDailyDate }) {
  if (!_ready || !_uid) return;

  const data = {};
  if (maxCheckpoint != null) data.maxCheckpoint = maxCheckpoint;
  if (dailyStreak != null) data.dailyStreak = dailyStreak;
  if (bestDailyStreak != null) data.bestDailyStreak = bestDailyStreak;
  if (lastDailyDate != null) data.lastDailyDate = lastDailyDate;

  if (Object.keys(data).length === 0) return;

  _db.ref('users/' + _uid).update(data).catch(err => {
    console.warn('Cloud progress save failed:', err.message);
  });
}

/**
 * Load progress from cloud. Returns null if unavailable.
 * Call on app init to silently restore progress.
 */
export async function loadProgress() {
  if (!_ready || !_uid) return null;

  try {
    const snapshot = await Promise.race([
      _db.ref('users/' + _uid).once('value'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('read timeout')), FIREBASE_TIMEOUT_MS)),
    ]);

    return snapshot.val(); // { maxCheckpoint, dailyStreak, bestDailyStreak, lastDailyDate } or null
  } catch (err) {
    console.warn('Cloud progress load failed:', err.message);
    return null;
  }
}
