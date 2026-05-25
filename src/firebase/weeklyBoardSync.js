// Canonical weekly board sync. One board per ET week (Monday → Sunday)
// keyed by the Monday's YYYY-MM-DD. Mirrors dailyBoardSync's correctness
// contract — write-once at the rules layer, deserializer fills in
// false/missing fields so consuming code sees a fully-shaped cell — but
// re-uses dailyBoardSync's serializeBoard/deserializeBoard since the
// per-cell structure is identical.

import { waitForFirebaseReady } from './waitForFirebase.js';
import { serializeBoard, deserializeBoard } from './dailyBoardSync.js';
import { isTestEnvironment } from './env.js';
import { getCachedWeeklyBoard, cacheWeeklyBoard, addDays } from './boardCache.js';

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
  // Cache-first, same rationale as loadDailyBoard — the weekly board is
  // write-once/immutable for the week, so a cached copy is authoritative
  // and keeps the weekly playable offline once pre-fetched.
  const cached = getCachedWeeklyBoard(weekStart);
  if (cached) return cached;

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
    const val = snap.val();
    cacheWeeklyBoard(weekStart, val); // populate local cache for offline play
    return val;
  } catch (err) {
    console.warn('loadWeeklyBoard fetch failed:', err.message);
    return null;
  }
}

/**
 * Fetch + cache the current and next ET week's boards so the weekly stays
 * playable across a week boundary while offline. Best-effort; skips weeks
 * already cached. Intended to run in the background after boot.
 *
 * @param {string} currentWeek Monday's YYYY-MM-DD in ET
 */
export async function prefetchUpcomingWeeklyBoards(currentWeek) {
  if (typeof currentWeek !== 'string' || !currentWeek) return;
  for (const wk of [currentWeek, addDays(currentWeek, 7)]) {
    if (getCachedWeeklyBoard(wk)) continue;
    try { await loadWeeklyBoard(wk); } catch { /* best-effort */ }
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
