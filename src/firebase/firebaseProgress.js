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
// Saves attempted before auth completes are coalesced here and flushed
// once _ready flips. Without this, fast Daily completions on slow
// connections drop their cloud sync silently.
let _pendingSave = null;
// Daily-history entries submitted before auth completes are queued here and
// flushed together on _ready. One entry per date (last-write-wins), since
// re-submitting the same date is always a no-op or an upgrade.
let _pendingHistory = null;

/**
 * Return the stable anonymous uid established by initAnonymousAuth, or null
 * if auth has not yet resolved.
 */
export function getUid() {
  return _uid;
}

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

    // Flush any save attempts that arrived before auth completed.
    if (_pendingSave) {
      const data = _pendingSave;
      _pendingSave = null;
      saveProgress(data);
    }
    if (_pendingHistory) {
      const queued = _pendingHistory;
      _pendingHistory = null;
      for (const [date, entry] of Object.entries(queued)) {
        saveDailyHistoryEntry(date, entry);
      }
    }
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
  const data = {};
  if (maxCheckpoint != null) data.maxCheckpoint = maxCheckpoint;
  if (dailyStreak != null) data.dailyStreak = dailyStreak;
  if (bestDailyStreak != null) data.bestDailyStreak = bestDailyStreak;
  if (lastDailyDate != null) data.lastDailyDate = lastDailyDate;

  if (Object.keys(data).length === 0) return;

  // Auth not ready yet — coalesce into a pending save. We always merge
  // so the latest values win for each field; queueing wins exclusively
  // for that field, max-comparison is the cloud's job on flush.
  if (!_ready || !_uid) {
    _pendingSave = { ...(_pendingSave || {}), ...data };
    return;
  }

  _db.ref('users/' + _uid).update(data).catch(err => {
    console.warn('Cloud progress save failed:', err.message);
  });
}

/**
 * Write a daily-history entry for the current user.
 * We only store the raw completion `time`, not par or delta. Par is a
 * function of the board's features and the current PAR_MODEL; since both
 * change over time (coefficients refit daily), recomputing par at read
 * time against whatever PAR_MODEL is currently shipping keeps every
 * historical entry in sync with the latest model. Otherwise we'd either
 * have to write back to every row on every refit, or live with stale
 * pars in older rows that don't match the rest of the app.
 */
export function saveDailyHistoryEntry(date, entry) {
  if (!date || !entry || typeof entry.time !== 'number') return;

  const payload = {
    time: entry.time,
    submittedAt: typeof firebase !== 'undefined' && firebase.database
      ? firebase.database.ServerValue.TIMESTAMP
      : Date.now(),
  };

  if (!_ready || !_uid) {
    if (!_pendingHistory) _pendingHistory = {};
    _pendingHistory[date] = payload;
    return;
  }

  _db.ref('users/' + _uid + '/dailyHistory/' + date).set(payload).catch(err => {
    console.warn('Daily history save failed:', err.message);
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
