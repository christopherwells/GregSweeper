// Canonical weekly board sync. One board per ET week (Monday → Sunday)
// keyed by the Monday's YYYY-MM-DD. Mirrors dailyBoardSync's correctness
// contract — write-once at the rules layer, deserializer fills in
// false/missing fields so consuming code sees a fully-shaped cell — but
// re-uses dailyBoardSync's serializeBoard/deserializeBoard since the
// per-cell structure is identical.

import { waitForFirebaseReady } from './waitForFirebase.js';
import { serializeBoard, deserializeBoard } from './dailyBoardSync.js';
import { isTestEnvironment } from './env.js';

const DB_PATH = 'weeklyBoard';
const FETCH_TIMEOUT_MS = 5000;
const WRITE_TIMEOUT_MS = 5000;

export { serializeBoard, deserializeBoard };

/**
 * Load the canonical weekly board for an ET-week. Returns null when
 * Firebase is unavailable, the path is empty, or the read times out.
 * Shape of the returned object matches `serializeBoard` output.
 *
 * @param {string} weekStart Monday's YYYY-MM-DD in ET
 * @returns {Promise<object|null>}
 */
export async function loadWeeklyBoard(weekStart) {
  let db;
  try {
    db = await waitForFirebaseReady();
  } catch (err) {
    console.warn('loadWeeklyBoard:', err.message);
    return null;
  }
  try {
    const ref = db.ref(`${DB_PATH}/${weekStart}`);
    const snap = await Promise.race([
      ref.once('value'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT_MS)),
    ]);
    if (!snap.exists()) return null;
    return snap.val();
  } catch (err) {
    console.warn('loadWeeklyBoard fetch failed:', err.message);
    return null;
  }
}

/**
 * Write the canonical weekly board for a week. Write-once at the rules
 * layer — duplicate writes silently no-op. Returns true on success,
 * false on any failure.
 *
 * @param {string} weekStart Monday's YYYY-MM-DD in ET
 * @param {object} payload output of serializeBoard()
 * @returns {Promise<boolean>}
 */
export async function saveWeeklyBoard(weekStart, payload) {
  // Test branch: don't overwrite the production canonical weekly.
  // Same rationale as saveDailyBoard's guard.
  if (isTestEnvironment()) return false;
  let db;
  try {
    db = await waitForFirebaseReady();
  } catch (err) {
    console.warn('saveWeeklyBoard:', err.message);
    return false;
  }
  try {
    const ref = db.ref(`${DB_PATH}/${weekStart}`);
    const writePayload = {
      ...payload,
      writtenAt: firebase.database.ServerValue.TIMESTAMP,
    };
    await Promise.race([
      ref.set(writePayload),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), WRITE_TIMEOUT_MS)),
    ]);
    return true;
  } catch (err) {
    console.warn('saveWeeklyBoard failed:', err.message);
    return false;
  }
}
