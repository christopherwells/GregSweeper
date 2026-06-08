/**
 * Firebase Auth (anonymous + linked) + Cloud Progress Sync
 *
 * Every fresh visit gets an anonymous uid via signInAnonymously. The user
 * can later upgrade the anonymous account to a permanent identity
 * (Google, email link) via src/firebase/firebaseAuth.js — that preserves
 * the uid. On a second device, signing in with the same identity SWITCHES
 * the device's session to the existing uid, so users/{uid}/* (streak,
 * dailyHistory, weeklyAttempts, etc.) carries across devices.
 *
 * The uid is reactive: subscribeToUidChanges(callback) fires whenever the
 * uid flips (initial anonymous sign-in, link, switch, sign-out + re-anon).
 * Callers should reload any user-keyed state when uid changes.
 *
 * Requires Firebase App + Auth + Database SDKs (loaded via CDN in
 * index.html) and initFirebase() from firebaseLeaderboard.js to have been
 * called first.
 */

import { isTestEnvironment } from './env.js';
import { subscribeAuthState } from './firebaseAuth.js';
import { safeGetJSON, safeSetJSON } from '../storage/storageAdapter.js';

const FIREBASE_TIMEOUT_MS = 5000;
const AUTH_SETTLE_TIMEOUT_MS = 800;

let _uid = null;
let _db = null;
let _ready = false;
// True after the FIRST non-null auth state of this session. Distinct
// from _uid because credential-switch flows go through a brief null
// intermediate state (after currentUser.delete() and before
// signInWithCredential) — without this flag, the post-switch fire
// would look like a fresh initial auth resolution and miss the
// "treat this as a uid switch, not an initial load" branch.
let _hasInitialized = false;
// Saves attempted before auth completes are coalesced here and flushed
// once _ready flips. Without this, fast Daily completions on slow
// connections drop their cloud sync silently. Cleared on a uid SWITCH
// (sign-in) because the queued writes were destined for the old uid.
let _pendingSave = null;
let _pendingHistory = null;
let _pendingWeeklyAttempts = null;

// Listeners notified on uid changes. main.js uses this to reload progress,
// firebasePush.js uses it to re-subscribe FCM under the new uid.
const _uidChangeListeners = new Set();

// Listeners notified when the cloud `users/{uid}/*` subtree changes —
// fires on every Firebase update under that path, including writes from
// other devices. main.js uses this to apply the merged progress and
// refresh on-screen counters so a daily completion on PC shows up on
// phone without requiring an app reopen.
const _cloudUpdateListeners = new Set();
let _cloudListenerRef = null;

/**
 * Return the stable uid for this session, or null if auth has not yet
 * resolved. The uid can change at runtime when the user signs in (their
 * anonymous uid is upgraded — uid unchanged) or switches accounts (their
 * old anonymous uid is abandoned and they adopt the existing uid).
 */
export function getUid() {
  return _uid;
}

/**
 * Subscribe to uid changes. Callback receives
 * `{ uid, previousUid, isInitial }`:
 *   - `isInitial: true` means the first time auth settles (anonymous
 *     sign-in completion on a fresh device, or persisted-session restore)
 *   - `isInitial: false` means an in-app switch — the previous uid's
 *     local state is stale and the caller should reload from the new uid
 * Returns an unsubscribe function.
 */
export function subscribeToUidChanges(callback) {
  _uidChangeListeners.add(callback);
  return () => _uidChangeListeners.delete(callback);
}

function _notifyUidChange(uid, previousUid, isInitial) {
  for (const cb of _uidChangeListeners) {
    try { cb({ uid, previousUid, isInitial }); }
    catch (err) { console.warn('uid change listener error:', err && err.message); }
  }
}

/**
 * Subscribe to real-time cloud updates of `users/{currentUid}/*`. The
 * callback fires with the snapshot value every time the subtree changes
 * — both for writes from THIS device (own writes echo back) and writes
 * from OTHER devices signed into the same account. Returns an
 * unsubscribe function.
 */
export function subscribeToCloudProgressUpdates(callback) {
  _cloudUpdateListeners.add(callback);
  return () => _cloudUpdateListeners.delete(callback);
}

function _detachCloudListener() {
  if (_cloudListenerRef) {
    try { _cloudListenerRef.off(); } catch {}
    _cloudListenerRef = null;
  }
}

function _attachCloudListener(uid) {
  _detachCloudListener();
  if (!uid || !_db) return;
  // .on('value', ...) fires once on attach with the current snapshot,
  // then on every subsequent write. That initial fire is the same data
  // loadProgress() returned during the explicit init chain, so the
  // double-apply is idempotent (max-merge, same data) — not worth
  // adding state to suppress.
  const ref = _db.ref('users/' + uid);
  _cloudListenerRef = ref;
  ref.on('value', (snap) => {
    const val = snap.val();
    if (!val) return;
    for (const cb of _cloudUpdateListeners) {
      try { cb(val); }
      catch (err) { console.warn('cloud update listener error:', err && err.message); }
    }
  }, (err) => {
    console.warn('cloud listener error:', err && err.message);
  });
}

function _flushPendingWrites() {
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
}

function _handleAuthChange(snap) {
  const newUid = snap.uid || null;
  const oldUid = _uid;

  if (newUid === oldUid) {
    // Same uid — either a no-op fire (e.g., a token refresh) or a link
    // upgrade where the providerId changed but uid stayed. Nothing to
    // reload either way; downstream code reads providerId via firebaseAuth.
    return;
  }

  if (!newUid) {
    // Signed out — could be a permanent logout OR a transient
    // intermediate state during credential-switch (currentUser.delete()
    // then signInWithCredential). Either way drop the uid + ready
    // flag, but keep _hasInitialized true so the subsequent sign-in
    // is treated as a uid SWITCH (with the reset+merge path), not as
    // a fresh initial auth resolution.
    _uid = null;
    _ready = false;
    _pendingSave = null;
    _pendingHistory = null;
    _pendingWeeklyAttempts = null;
    _detachCloudListener();
    return;
  }

  const isInitial = !_hasInitialized;
  _hasInitialized = true;
  _uid = newUid;
  _db = firebase.database();
  _ready = true;

  if (isInitial) {
    // First auth settle of the session — flush any writes queued during
    // the boot window where saveProgress was called before auth resolved.
    _flushPendingWrites();
  } else {
    // uid changed mid-session — pending writes were intended for the OLD
    // uid (its data is no longer reachable from this device), so discard.
    _pendingSave = null;
    _pendingHistory = null;
    _pendingWeeklyAttempts = null;
  }

  // Attach the real-time listener AFTER _uid + _db are set so the
  // listener fires under the new uid. Detach happens implicitly on the
  // next uid change (via _attachCloudListener which calls _detachCloudListener first).
  _attachCloudListener(newUid);

  // Re-send any durably-queued daily-history records under this uid.
  // Runs on both initial sign-in and account switch: the durable queue
  // holds the device-owner's real completions, which belong to whatever
  // account they sign into (this is what recovers Kate's offline days).
  flushPendingDailyHistory().catch(() => {});

  _notifyUidChange(newUid, oldUid, isInitial);
}

/**
 * Wire up the auth-state listener and bootstrap the initial anonymous
 * sign-in if no persisted session exists. Idempotent — calling twice is
 * a no-op after the first.
 *
 * Resolves when auth has settled (uid available) or after the timeout.
 * Existing callers can keep using `await initAnonymousAuth()` followed
 * by `loadProgress()`.
 */
let _initStarted = false;
let _initPromise = null;

export async function initAnonymousAuth() {
  if (_initStarted) return _initPromise;
  _initStarted = true;
  _initPromise = (async () => {
    try {
      if (typeof firebase === 'undefined' || !firebase.auth) return;
      if (!firebase.apps.length) return; // initFirebase must run first

      _db = firebase.database();

      // Wait for Firebase to FINISH reading its IndexedDB persistence
      // before deciding whether to sign in anonymously. Without this,
      // `firebase.auth().currentUser` returns null synchronously even
      // when a persisted session exists (the IndexedDB read is async).
      // Calling signInAnonymously while a persisted user is still
      // loading would create a fresh anonymous account and overwrite
      // the linked Google session — that's the "sign-in disappears
      // after refresh" bug. Awaiting the first onAuthStateChanged fire
      // guarantees we've seen Firebase's authoritative initial state.
      let resolveFirstFire;
      const firstFire = new Promise((resolve) => { resolveFirstFire = resolve; });
      let resolveSettled;
      const settled = new Promise((resolve) => { resolveSettled = resolve; });
      let firstFireDone = false;
      subscribeAuthState((snap) => {
        _handleAuthChange(snap);
        if (!firstFireDone) {
          firstFireDone = true;
          resolveFirstFire(snap);
        }
        if (snap.uid && resolveSettled) {
          resolveSettled();
          resolveSettled = null;
        }
      });

      const initialSnap = await Promise.race([
        firstFire,
        new Promise((resolve) => setTimeout(() => resolve(null), FIREBASE_TIMEOUT_MS)),
      ]);

      // After Firebase finished reading persistence, kick anon only if
      // truly no user is signed in.
      if (!initialSnap || !initialSnap.uid) {
        try {
          await Promise.race([
            firebase.auth().signInAnonymously(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('auth timeout')), FIREBASE_TIMEOUT_MS)),
          ]);
        } catch (err) {
          console.warn('Anonymous auth failed:', err && err.message);
        }
      }

      // Wait for the listener to have set _uid before returning, so
      // existing call sites that chain loadProgress() after init have a
      // valid uid to work with.
      await Promise.race([
        settled,
        new Promise((resolve) => setTimeout(resolve, AUTH_SETTLE_TIMEOUT_MS)),
      ]);
    } catch (err) {
      console.warn('initAnonymousAuth failed:', err && err.message);
    }
  })();
  return _initPromise;
}

/**
 * Save progress to cloud. Call when checkpoint advances or daily streak updates.
 * Fire-and-forget — does not block gameplay.
 */
export function saveProgress({ maxCheckpoint, dailyStreak, bestDailyStreak, lastDailyDate, powerUps }) {
  if (isTestEnvironment()) return;
  const data = {};
  if (maxCheckpoint != null) data.maxCheckpoint = maxCheckpoint;
  if (dailyStreak != null) data.dailyStreak = dailyStreak;
  if (bestDailyStreak != null) data.bestDailyStreak = bestDailyStreak;
  if (lastDailyDate != null) data.lastDailyDate = lastDailyDate;
  if (powerUps != null && typeof powerUps === 'object') data.powerUps = powerUps;

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

// dailyHistory's rule requires `submittedAt === now`, satisfied only by
// the server-timestamp sentinel (the server stamps its own clock). A
// literal client Date.now() never equals the server's now, so the whole
// write is rejected — the regression that silently froze every stats page
// from 2026-05-25 until this fix. Every dailyHistory write stamps
// submittedAt with this, mirroring the leaderboard score write.
function _serverTimestamp() {
  return (typeof firebase !== 'undefined' && firebase.database)
    ? firebase.database.ServerValue.TIMESTAMP
    : Date.now();
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
  if (!date) return;

  // An entry is either a full record `{ time }` or a completion-only
  // marker `{ completed: true }`. The marker lets us record a VERIFIED
  // completion (e.g. an offline day recovered for a streak) without
  // fabricating a time — fetchUserDailyHistory filters to numeric-time
  // rows, so a marker never pollutes the delta chart but still counts
  // toward the derived streak (computeStreakFromHistory walks the date
  // keys, not the values).
  // `body` holds only the meaningful content (time, or a completion
  // marker). submittedAt is deliberately NOT in here: the rule demands
  // submittedAt === now, so it is attached as the server sentinel at each
  // real write (below, and in flushPendingDailyHistory). Storing a client
  // Date.now() here is what got the write rejected.
  let body;
  if (typeof entry?.time === 'number') body = { time: entry.time };
  else if (entry?.completed) body = { completed: true };
  else return; // nothing meaningful to record

  if (!_ready || !_uid) {
    // Boot-window coalescing (auth not settled). In-memory ONLY: we don't
    // know the uid yet, so we can't tag a durable entry to its owner.
    // The window is brief — Firebase restores the anonymous session from
    // IndexedDB within ~1s even offline — and these flush on the initial
    // settle via _flushPendingWrites (and are discarded on a uid switch).
    // Re-routes through this function on settle, which re-stamps submittedAt.
    if (!_pendingHistory) _pendingHistory = {};
    _pendingHistory[date] = body;
    return;
  }

  _db.ref('users/' + _uid + '/dailyHistory/' + date)
    .set({ ...body, submittedAt: _serverTimestamp() }).catch(err => {
      console.warn('Daily history save failed:', err.message);
      // Durable retry: the completion record is the source of truth for
      // the streak, so a dropped write would silently break it. Persist
      // to localStorage and flush on the next auth-ready / boot.
      _persistPendingDailyHistory(date, body);
    });
}

// ── Durable daily-history retry queue ─────────────────
// RTDB's web SDK has no on-disk offline persistence, so a completion
// recorded while offline (or during a flaky write) must survive a page
// close in localStorage and re-send when connectivity returns. Keyed by
// date so re-completing the same day overwrites rather than duplicates.
const PENDING_HISTORY_KEY = 'minesweeper_pending_daily_history';

function _persistPendingDailyHistory(date, payload) {
  if (!_uid) return; // only the write-failed path persists, and that has a uid
  try {
    const q = safeGetJSON(PENDING_HISTORY_KEY, {}) || {};
    // Tag with the owning uid so flushPendingDailyHistory can refuse to
    // attribute this completion to a DIFFERENT account that later signs in
    // on this device (a shared/family device, or sign-out then sign-in).
    q[date] = { uid: _uid, ...payload };
    safeSetJSON(PENDING_HISTORY_KEY, q);
  } catch (err) {
    console.warn('Could not queue pending daily history:', err && err.message);
  }
}

// Re-send queued daily-history writes for the CURRENT uid only. Each entry
// is tagged with its owning uid; entries belonging to a different account
// that used this device are left untouched — never cross-attributed, which
// would inflate the wrong account's streak. Flushed on auth-ready.
export async function flushPendingDailyHistory() {
  if (!_ready || !_uid) return;
  if (isTestEnvironment()) return; // never write prod history from a test session
  let q;
  try { q = safeGetJSON(PENDING_HISTORY_KEY, null); } catch { return; }
  if (!q || typeof q !== 'object') return;
  const dates = Object.keys(q);
  if (dates.length === 0) return;
  const remaining = {};
  let flushed = 0;
  for (const date of dates) {
    const entry = q[date];
    // Only this account's own queued completions; leave others in place.
    if (!entry || entry.uid !== _uid) { if (entry) remaining[date] = entry; continue; }
    const { uid, ...payload } = entry; // strip the owner tag before writing
    try {
      // Re-stamp submittedAt with the server sentinel: the rule rejects a
      // stored client timestamp, and pre-fix queue entries may carry one.
      await _db.ref('users/' + _uid + '/dailyHistory/' + date)
        .set({ ...payload, submittedAt: _serverTimestamp() });
      flushed++;
    } catch {
      remaining[date] = entry;
    }
  }
  try { safeSetJSON(PENDING_HISTORY_KEY, remaining); } catch {}
  if (flushed > 0) console.log(`Re-sent ${flushed} pending daily-history record(s) after reconnect.`);
}

/**
 * Read the current user's set of completed daily dates from
 * `users/{uid}/dailyHistory`. Returns an array of 'YYYY-MM-DD' strings
 * (any entry shape counts — full or completion-only marker), or null if
 * the read could not be completed (offline / not signed in / timeout).
 * This is the authoritative completed-date set the streak derives from.
 */
export async function loadDailyHistory() {
  if (!_ready || !_uid) return null;
  try {
    const snap = await Promise.race([
      _db.ref('users/' + _uid + '/dailyHistory').once('value'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), FIREBASE_TIMEOUT_MS)),
    ]);
    if (!snap.exists()) return [];
    const dates = [];
    snap.forEach((child) => { if (child.key) dates.push(child.key); });
    return dates;
  } catch (err) {
    console.warn('loadDailyHistory failed:', err.message);
    return null;
  }
}

/**
 * Load the per-day attempt map for a given ET-week. On a SUCCESSFUL
 * cloud read returns the `{ 0: true, 3: true }` shape (numbers as keys
 * when consumed via `Object.keys`); a successful read with nothing
 * recorded returns an empty `{}` — that is an authoritative "no
 * attempts this week", not an error. Returns `null` when the read
 * could NOT be completed (not signed in, offline, or timed out) so the
 * caller can keep its synchronous localStorage seed instead of
 * mistaking an unreachable cloud for an empty one. Distinguishing these
 * is what lets an admin-side cloud deletion actually propagate to the
 * client. Never throws.
 */
export async function loadWeeklyAttempts(weekStart) {
  if (!_ready || !_uid || !weekStart) return null;
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
    return null;
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

// Overwrite the localStorage mirror for a week with an authoritative
// day-map. Used when a successful Firebase read is treated as the
// source of truth: this keeps the next boot's synchronous seed in sync
// with the cloud and lets an admin-side cloud deletion actually
// propagate, instead of being resurrected from a stale local copy.
export function replaceLocalWeeklyAttempts(weekStart, dayMap) {
  if (typeof weekStart !== 'string' || !weekStart) return;
  try {
    const clean = {};
    for (const k of Object.keys(dayMap || {})) {
      const n = Number(k);
      if (Number.isInteger(n) && n >= 0 && n <= 6 && dayMap[k]) clean[n] = true;
    }
    localStorage.setItem(LS_WEEKLY_ATTEMPTS_PREFIX + weekStart, JSON.stringify(clean));
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
