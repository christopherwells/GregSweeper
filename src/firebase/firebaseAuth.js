/**
 * Firebase identity sign-in / sign-out / link.
 *
 * Anonymous accounts (the default for every fresh visit) can be UPGRADED
 * to a permanent identity (Google, email link) via linkWithPopup /
 * linkWithCredential. After upgrade the uid stays the same — all
 * existing users/{uid}/* data and leaderboard rows carry over.
 *
 * On a second device the credential is already attached to the first
 * device's uid, so linkWithPopup hits `auth/credential-already-in-use`.
 * The onCredentialConflict callback asks the user to confirm, then
 * signInWithCredential SWITCHES this device's session to the existing
 * uid. The data the second device's old anonymous uid had is abandoned
 * by design (V1 scope — no cross-uid merge).
 *
 * Auth state changes are broadcast via subscribeAuthState(). The progress
 * + push modules listen and reload / re-subscribe under the new uid so
 * streak, dailyHistory, weeklyAttempts, and FCM tokens follow the user.
 */

import { isTestEnvironment } from './env.js';

const LS_PENDING_EMAIL = 'minesweeper_pending_email_link';
const EMAIL_LINK_RETURN_PARAM = 'emailLink';

let _googleProvider = null;
function _getGoogleProvider() {
  if (!_googleProvider) {
    _googleProvider = new firebase.auth.GoogleAuthProvider();
    _googleProvider.addScope('email');
  }
  return _googleProvider;
}

function _emailLinkActionUrl() {
  // Stay on whatever origin we were served from so the test branch and
  // production each get their own return URL.
  const url = new URL(window.location.href);
  url.search = '?' + EMAIL_LINK_RETURN_PARAM + '=1';
  url.hash = '';
  return url.toString();
}

function _describeProvider(providerId) {
  if (providerId === 'google.com') return 'Google';
  if (providerId === 'apple.com') return 'Apple';
  if (providerId === 'password') return 'Email';
  return 'Anonymous';
}

function _snapshotUser(user) {
  if (!user) {
    return {
      uid: null,
      isAnonymous: true,
      email: null,
      displayName: null,
      providerId: 'anonymous',
      providerLabel: 'Anonymous',
    };
  }
  const primary = user.providerData && user.providerData[0];
  return {
    uid: user.uid,
    isAnonymous: !!user.isAnonymous,
    email: user.email || (primary && primary.email) || null,
    displayName: user.displayName || (primary && primary.displayName) || null,
    providerId: primary ? primary.providerId : 'anonymous',
    providerLabel: primary ? _describeProvider(primary.providerId) : 'Anonymous',
  };
}

/**
 * Synchronous snapshot of the current auth state. Returns the same shape
 * as the subscribeAuthState callback. Use this for Settings UI render
 * paths that need the state right now, not for one-time async fetches.
 *
 * Safe to call before Firebase is initialized — returns the anonymous-
 * placeholder shape until the real state lands.
 */
export function getAuthState() {
  if (typeof firebase === 'undefined' || !firebase.auth) return _snapshotUser(null);
  if (!firebase.apps || firebase.apps.length === 0) return _snapshotUser(null);
  try {
    return _snapshotUser(firebase.auth().currentUser);
  } catch {
    return _snapshotUser(null);
  }
}

// Subscribers are queued and a single native onAuthStateChanged is
// attached once Firebase has been initializeApp'd. This lets callers
// subscribe at module-load time without ordering constraints between
// initFirebase() and the auth listener wiring.
const _authStateListeners = new Set();
let _nativeListenerAttached = false;

function _ensureNativeAuthListener() {
  if (_nativeListenerAttached) return;
  if (typeof firebase === 'undefined' || !firebase.auth || !firebase.apps || firebase.apps.length === 0) {
    setTimeout(_ensureNativeAuthListener, 100);
    return;
  }
  try {
    firebase.auth().onAuthStateChanged((user) => {
      const snap = _snapshotUser(user);
      for (const cb of _authStateListeners) {
        try { cb(snap); }
        catch (err) { console.warn('auth state listener error:', err && err.message); }
      }
    });
    _nativeListenerAttached = true;
  } catch (err) {
    console.warn('attach auth listener failed:', err && err.message);
    setTimeout(_ensureNativeAuthListener, 250);
  }
}

/**
 * Subscribe to auth-state changes. Callback gets the same shape as
 * getAuthState(). Returns an unsubscribe function. Safe to call before
 * Firebase is initialized — the listener attaches once Firebase is
 * ready.
 */
export function subscribeAuthState(callback) {
  _authStateListeners.add(callback);
  _ensureNativeAuthListener();
  return () => _authStateListeners.delete(callback);
}

/**
 * Clear the device's pushSubscription under the CURRENT uid before
 * switching to a different uid. Otherwise the hourly push cron keeps
 * sending to the abandoned uid's FCM token until the cron's own 404
 * tombstone path eventually retires it.
 */
async function _clearCurrentDevicePushSubscription() {
  if (isTestEnvironment()) return;
  try {
    if (typeof firebase === 'undefined' || !firebase.database || !firebase.auth) return;
    const user = firebase.auth().currentUser;
    if (!user) return;
    await firebase.database().ref(`users/${user.uid}/pushSubscription`).remove();
  } catch (err) {
    console.warn('clear push subscription failed:', err && err.message);
  }
}

/**
 * Best-effort cleanup of the abandoned anonymous Auth record on the
 * "switch to existing account" path. Anonymous accounts have no
 * recent-auth requirement and `currentUser.delete()` removes the record
 * from Firebase Auth. The database data under that uid is NOT cascaded
 * — that stays orphaned (acceptable for V1).
 */
async function _deleteCurrentAnonymousAuthRecord() {
  try {
    if (typeof firebase === 'undefined' || !firebase.auth) return;
    const user = firebase.auth().currentUser;
    if (!user || !user.isAnonymous) return;
    await user.delete();
  } catch (err) {
    // Non-fatal — Auth record will sit unused but the credential switch
    // below still succeeds.
    console.warn('delete anonymous auth record failed:', err && err.message);
  }
}

/**
 * Upgrade the current anonymous user with a Google credential, OR (if
 * the credential is already attached to another account) switch this
 * device's session to that existing account.
 *
 * `onCredentialConflict({ providerLabel, email })` is awaited before the
 * switch; resolving to truthy proceeds, falsy aborts. If omitted, the
 * switch happens silently.
 *
 * Returns `{ status, providerLabel, email, message }` where status is:
 *   'linked'    — anonymous account upgraded, uid unchanged
 *   'switched'  — credential already existed, this device now uses that uid
 *   'cancelled' — user closed the popup or declined the conflict prompt
 *   'error'     — anything else (see message)
 */
export async function linkWithGoogle({ onCredentialConflict } = {}) {
  if (typeof firebase === 'undefined' || !firebase.auth) {
    return { status: 'error', message: 'Firebase auth not loaded' };
  }
  const auth = firebase.auth();
  const current = auth.currentUser;
  if (!current) return { status: 'error', message: 'No active user — anonymous auth has not resolved yet' };

  const provider = _getGoogleProvider();
  try {
    const result = current.isAnonymous
      ? await current.linkWithPopup(provider)
      : await auth.signInWithPopup(provider);
    return {
      status: 'linked',
      providerLabel: 'Google',
      email: (result && result.user && result.user.email) || null,
    };
  } catch (err) {
    if (err && (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request')) {
      return { status: 'cancelled' };
    }
    if (err && err.code === 'auth/credential-already-in-use') {
      const cred = err.credential;
      const proceed = onCredentialConflict
        ? await onCredentialConflict({ providerLabel: 'Google', email: err.email || null })
        : true;
      if (!proceed) return { status: 'cancelled' };

      await _clearCurrentDevicePushSubscription();
      await _deleteCurrentAnonymousAuthRecord();

      try {
        const result = await auth.signInWithCredential(cred);
        return {
          status: 'switched',
          providerLabel: 'Google',
          email: (result && result.user && result.user.email) || err.email || null,
        };
      } catch (e2) {
        console.warn('signInWithCredential after conflict failed:', e2 && e2.message);
        return { status: 'error', message: (e2 && e2.message) || 'signInWithCredential failed' };
      }
    }
    if (err && err.code === 'auth/popup-blocked') {
      // Caller can offer the redirect fallback if needed; popup-blocked
      // is common on in-app browsers and some PWA contexts. Keep status
      // distinct so the UI can hint.
      return { status: 'popup-blocked', message: 'Browser blocked the popup. Try again or switch to a normal tab.' };
    }
    console.warn('linkWithGoogle failed:', err && err.code, err && err.message);
    return { status: 'error', message: (err && err.message) || 'unknown error' };
  }
}

/**
 * Send a passwordless sign-in link to `email`. The link points back to
 * this origin with `?emailLink=1`; clicking it on either device hits
 * tryCompleteEmailLink() which finishes the auth.
 *
 * Returns `{ status, message }` where status is 'sent' | 'invalid-email'
 * | 'error'.
 */
export async function sendEmailLink(email) {
  if (typeof firebase === 'undefined' || !firebase.auth) {
    return { status: 'error', message: 'Firebase auth not loaded' };
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { status: 'invalid-email' };
  }
  try {
    await firebase.auth().sendSignInLinkToEmail(email, {
      url: _emailLinkActionUrl(),
      handleCodeInApp: true,
    });
    try { localStorage.setItem(LS_PENDING_EMAIL, email); } catch { /* private mode */ }
    return { status: 'sent' };
  } catch (err) {
    console.warn('sendEmailLink failed:', err && err.message);
    return { status: 'error', message: (err && err.message) || 'unknown error' };
  }
}

/**
 * At boot, if the current URL is a return-from-email-link URL, complete
 * the sign-in. Mirrors linkWithGoogle's link-or-switch behavior, with
 * the same conflict-confirmation hook.
 *
 * `promptForEmail()` is awaited when localStorage doesn't have the
 * stashed email (link clicked on a device different from the one that
 * sent it). Resolve to a string to proceed, falsy to abort.
 *
 * Returns `{ status }` where status is one of:
 *   'noop'             — URL is not an email-link return URL
 *   'linked'           — anonymous account upgraded
 *   'switched'         — switched to existing account
 *   'needs-email'      — couldn't get the email; nothing happened
 *   'already-signed-in'— a non-anonymous session was already active
 *   'cancelled'        — user declined the conflict prompt
 *   'error'            — see message
 */
export async function tryCompleteEmailLink({ onCredentialConflict, promptForEmail } = {}) {
  if (typeof firebase === 'undefined' || !firebase.auth) return { status: 'noop' };
  const auth = firebase.auth();
  if (!auth.isSignInWithEmailLink(window.location.href)) return { status: 'noop' };

  // Already signed in via a non-anonymous provider — bare URL stripping
  // is enough; don't re-link.
  const existing = auth.currentUser;
  if (existing && !existing.isAnonymous) {
    _stripEmailLinkQuery();
    return { status: 'already-signed-in' };
  }

  let email = null;
  try { email = localStorage.getItem(LS_PENDING_EMAIL) || null; } catch { /* private mode */ }
  if (!email && promptForEmail) {
    email = await promptForEmail();
  }
  if (!email) {
    return { status: 'needs-email' };
  }

  let cred;
  try {
    cred = firebase.auth.EmailAuthProvider.credentialWithLink(email, window.location.href);
  } catch (err) {
    console.warn('credentialWithLink failed:', err && err.message);
    _stripEmailLinkQuery();
    return { status: 'error', message: (err && err.message) || 'invalid email link' };
  }

  try {
    if (existing && existing.isAnonymous) {
      await existing.linkWithCredential(cred);
    } else {
      await auth.signInWithCredential(cred);
    }
    try { localStorage.removeItem(LS_PENDING_EMAIL); } catch {}
    _stripEmailLinkQuery();
    return { status: 'linked', providerLabel: 'Email', email };
  } catch (err) {
    if (err && err.code === 'auth/credential-already-in-use') {
      const proceed = onCredentialConflict
        ? await onCredentialConflict({ providerLabel: 'Email', email })
        : true;
      if (!proceed) {
        try { localStorage.removeItem(LS_PENDING_EMAIL); } catch {}
        _stripEmailLinkQuery();
        return { status: 'cancelled' };
      }
      await _clearCurrentDevicePushSubscription();
      await _deleteCurrentAnonymousAuthRecord();
      try {
        await auth.signInWithCredential(err.credential || cred);
        try { localStorage.removeItem(LS_PENDING_EMAIL); } catch {}
        _stripEmailLinkQuery();
        return { status: 'switched', providerLabel: 'Email', email };
      } catch (e2) {
        console.warn('signInWithCredential (email-link) after conflict failed:', e2 && e2.message);
        _stripEmailLinkQuery();
        return { status: 'error', message: (e2 && e2.message) || 'signInWithCredential failed' };
      }
    }
    console.warn('tryCompleteEmailLink failed:', err && err.code, err && err.message);
    _stripEmailLinkQuery();
    return { status: 'error', message: (err && err.message) || 'unknown error' };
  }
}

function _stripEmailLinkQuery() {
  try {
    const url = new URL(window.location.href);
    let touched = false;
    for (const key of [EMAIL_LINK_RETURN_PARAM, 'apiKey', 'oobCode', 'mode', 'lang', 'continueUrl']) {
      if (url.searchParams.has(key)) { url.searchParams.delete(key); touched = true; }
    }
    if (!touched) return;
    const search = url.searchParams.toString();
    window.history.replaceState(null, '', url.pathname + (search ? '?' + search : '') + url.hash);
  } catch {
    // Best-effort — leaving query params on a fresh page load is cosmetic only.
  }
}

/**
 * Sign out and immediately re-sign-in anonymously so the app always has
 * some uid to work with. Pre-cleans the current device's pushSubscription
 * so the cron stops sending pushes to the abandoned identity.
 *
 * Returns the new anonymous uid on success, or null on failure.
 */
export async function signOut() {
  if (typeof firebase === 'undefined' || !firebase.auth) return null;
  try {
    await _clearCurrentDevicePushSubscription();
    await firebase.auth().signOut();
    const result = await firebase.auth().signInAnonymously();
    return (result && result.user && result.user.uid) || null;
  } catch (err) {
    console.warn('signOut failed:', err && err.message);
    return null;
  }
}
