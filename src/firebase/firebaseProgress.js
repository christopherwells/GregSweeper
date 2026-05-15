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

import { isTestEnvironment } from './env.js';

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
// Weekly day-attempt markers submitted before auth completes. Keyed by
// `${weekStart}/${day}` for uniqueness; flushed on _ready.
let _pendingWeeklyAttempts = null;

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
    if (_pendingWeeklyAttempts) {
      const queued = _pendingWeeklyAttempts;
      _pendingWeeklyAttempts = null;
      for (const key of Object.keys(queued)) {
        const [weekStart, day] = key.split('/');
        markWeeklyDayAttempted(weekStart, Number(day));
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
  if (isTestEnvironment()) return;
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
  if (isTestEnvironment()) return;
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
 * Load the per-day attempt map for a given ET-week. Returns
 * `{ 0: true, 3: true }` shape (numbers as keys when consumed via
 * `Object.keys`). Used by the startup gate so newGame() can
 * synchronously check whether today's slot has been used. Never throws;
 * returns {} on any failure or when offline.
 */
export async function loadWeeklyAttempts(weekStart) {
  if (!_ready || !_uid || !weekStart) return {};
  try {
    const snap = await Promise.race([
      _db.ref(`users/${_uid}/weeklyAttempts/${weekStart}/dayAttempts`).once('value'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), FIREBASE_TIMEOUT_MS)),
    ]);
    if (!snap.exists()) return {};
    const out = {};
    snap.forEach((child) => {
      const k = Number(child.key);
      if (Number.isInteger(k) && k >= 0 && k <= 6) out[k] = true;
    });
    return out;
  } catch (err) {
    console.warn('loadWeeklyAttempts failed:', err.message);
    return {};
  }
}

/**
 * Record that the player completed today's weekly attempt. Writes
 * `users/{uid}/weeklyAttempts/{weekStart}/dayAttempts/{day}` with a
 * server-side timestamp. Queues into _pendingWeeklyAttempts when auth
 * isn't ready yet.
 */
export function markWeeklyDayAttempted(weekStart, day) {
  if (typeof weekStart !== 'string' || !Number.isInteger(day) || day < 0 || day > 6) return;
  // Test branch: skip Firebase write and skip localStorage too —
  // otherwise the test deployment would gate the player out of weekly
  // mode on test even though no real attempt was recorded.
  if (isTestEnvironment()) return;

  // Mirror the attempt to localStorage so the synchronous gate (in
  // main.js's weekly mode-card handler + reset-button handler) doesn't
  // fail-open during the boot-time race when Firebase is still loading
  // anonymous auth. Without this, a fresh page-load on a slow network
  // could let the player tap Weekly before the cloud cache populates and
  // get a second attempt for the same day.
  saveLocalWeeklyAttempt(weekStart, day);

  if (!_ready || !_uid) {
    if (!_pendingWeeklyAttempts) _pendingWeeklyAttempts = {};
    _pendingWeeklyAttempts[`${weekStart}/${day}`] = true;
    return;
  }

  const payload = {
    timestamp: typeof firebase !== 'undefined' && firebase.database
      ? firebase.database.ServerValue.TIMESTAMP
      : Date.now(),
  };
  _db.ref(`users/${_uid}/weeklyAttempts/${weekStart}/dayAttempts/${day}`).set(payload).catch(err => {
    console.warn('Weekly attempt save failed:', err.message);
  });
}

// ── Local-storage backup of weekly attempts ────────────
// In-memory state.cachedWeeklyDayAttempts is repopulated from Firebase on
// each startup, but that fetch can race with the title-screen render
// when anonymous auth or the network is slow. Mirroring to localStorage
// gives us a synchronous source the gate can trust before Firebase has
// settled. Keyed per weekStart so old weeks don't pollute the current one.

const LS_WEEKLY_ATTEMPTS_PREFIX = 'minesweeper_weekly_attempts_';

export function loadLocalWeeklyAttempts(weekStart) {
  if (typeof weekStart !== 'string' || !weekStart) return {};
  try {
    const raw = localStorage.getItem(LS_WEEKLY_ATTEMPTS_PREFIX + weekStart);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const clean = {};
    for (const k of Object.keys(parsed)) {
      const n = Number(k);
      if (Number.isInteger(n) && n >= 0 && n <= 6 && parsed[k]) clean[n] = true;
    }
    return clean;
  } catch { return {}; }
}

export function saveLocalWeeklyAttempt(weekStart, day) {
  if (typeof weekStart !== 'string' || !weekStart) return;
  if (!Number.isInteger(day) || day < 0 || day > 6) return;
  try {
    const current = loadLocalWeeklyAttempts(weekStart);
    current[day] = true;
    localStorage.setItem(LS_WEEKLY_ATTEMPTS_PREFIX + weekStart, JSON.stringify(current));
  } catch { /* private browsing / quota — best-effort */ }
}

// Sweep localStorage entries for weeks we're no longer tracking. Called
// once at startup; cheap, only touches keys with our prefix.
export function pruneStaleLocalWeeklyAttempts(currentWeekStart) {
  try {
    const keep = currentWeekStart ? LS_WEEKLY_ATTEMPTS_PREFIX + currentWeekStart : null;
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_WEEKLY_ATTEMPTS_PREFIX) && k !== keep) toRemove.push(k);
    }
    for (const k of toRemove) localStorage.removeItem(k);
  } catch { /* best-effort */ }
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
