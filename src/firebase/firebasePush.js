// Web Push subscription + notification preferences. Wraps FCM's
// getToken / deleteToken for the browser side; the actual sending of
// pushes happens in scripts/send-push.mjs running on a GH Actions
// hourly cron. The flow:
//
//   user toggles ON → enableNotifications({hourLocal})
//                    → Notification.requestPermission()
//                    → messaging.getToken({vapidKey})
//                    → write users/{uid}/pushSubscription + notificationPrefs
//
//   cron fires hourly → scripts/send-push.mjs reads subscriptions,
//                      filters to {hourLocal === currentHourET}, POSTs
//                      to FCM REST → SW push event → showNotification
//
//   user taps          → SW notificationclick → focus tab or open
//                       ./?mode=daily / ?mode=weekly per the payload's
//                       deepLink field.
//
// iOS PWA constraint: Web Push only works on iOS 16.4+ AND only for
// PWAs that have been added to the home screen. enableNotifications
// detects iOS-non-standalone and surfaces a hint instead of silently
// failing.

import { safeGet, safeSet, safeRemove } from '../storage/storageAdapter.js';
import { getUid } from './firebaseProgress.js';

// VAPID public key from Firebase Console → Project Settings → Cloud
// Messaging → Web Push certificates. Public — safe to ship in client.
// FCM uses this to derive the per-subscriber endpoint when the page
// calls messaging.getToken({vapidKey}).
const VAPID_PUBLIC_KEY = 'BOuXy2fkaqrNc2KnGgLaMVKo1hJ3z9UeP7S1vU1RO_fLYmzdX1jmyC1GSSiUxW_JiXSnqvUFmGfJaeeRd0KTeZw';

const PERMISSION_HINT_KEY = 'gregsweeper_push_permission_hinted';

function _isIOS() {
  // iPadOS 13+ ships a Mac user agent — the only reliable tell is the
  // combination of Macintosh + touch capability (Macs proper don't
  // have touchscreens). Plain iPad/iPhone/iPod still works for the
  // older path.
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && 'ontouchstart' in window);
}
function _isInstalledPWA() {
  return window.navigator.standalone === true ||
         window.matchMedia('(display-mode: standalone)').matches;
}

export function isPushSupported() {
  return 'serviceWorker' in navigator
      && 'Notification' in window
      && 'PushManager' in window
      && typeof firebase !== 'undefined'
      && firebase.messaging
      && firebase.messaging.isSupported?.();
}

export function getPushPermission() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission; // 'default' | 'granted' | 'denied'
}

/**
 * Subscribe to push notifications. Returns one of:
 *   'success' — permission granted, token registered, prefs saved
 *   'no-key' — VAPID public key not configured (deploy-time setup needed)
 *   'denied' — browser permission denied (user must change in OS settings)
 *   'unsupported' — browser/PWA doesn't support Web Push
 *   'ios-needs-install' — iOS Safari without home-screen install
 *   'error' — anything else; details in console.warn
 */
export async function enableNotifications({ hourLocal = 9, dailyReminder = true, streakWarning = false } = {}) {
  if (!isPushSupported()) {
    return _isIOS() && !_isInstalledPWA() ? 'ios-needs-install' : 'unsupported';
  }
  if (!VAPID_PUBLIC_KEY) return 'no-key';

  let perm = Notification.permission;
  if (perm === 'default') {
    try { perm = await Notification.requestPermission(); }
    catch (err) { console.warn('Notification.requestPermission failed:', err.message); return 'error'; }
  }
  if (perm !== 'granted') return 'denied';

  const uid = getUid();
  if (!uid || typeof firebase === 'undefined' || !firebase.database) return 'error';
  const db = firebase.database();

  // Write the user's intent FIRST. This is what the toggle reflects
  // and it's a plain Firebase write that doesn't depend on FCM being
  // healthy. If we wait for getToken before writing prefs and FCM
  // happens to be flaky (token tombstoned, SW updating, network
  // blip), the toggle silently unchecks when the user re-opens
  // settings — even though the user explicitly asked for it on.
  try {
    await db.ref(`users/${uid}/notificationPrefs`).set({
      enabled: true,
      hourLocal,
      dailyReminder,
      streakWarning,
    });
  } catch (err) {
    console.warn('enableNotifications: prefs write failed:', err.message);
    return 'error';
  }

  // Now try to mint a token + write the subscription. If this leg
  // fails the user is still considered "enabled" — refreshTokenIfStale
  // on the next app load will retry getToken and persist a fresh
  // subscription. Until then the cron just skips us (no token to send
  // to), so the worst case is a couple of missed notifications, not a
  // silently-flipped toggle.
  try {
    const messaging = firebase.messaging();
    const reg = await navigator.serviceWorker.ready;
    // Reset both layers before minting a fresh token:
    //   (a) browser pushManager.unsubscribe() — kills the actual push
    //       subscription. messaging.getToken reuses an existing live
    //       subscription if one is present, so an OS/browser-level
    //       dead subscription persists across deleteToken cycles. The
    //       new FCM token then points at a dead endpoint and FCM 404s
    //       on send with "UNREGISTERED" the moment we try to deliver.
    //   (b) messaging.deleteToken() — clears FCM's IndexedDB cache so
    //       getToken doesn't short-circuit to the cached token before
    //       checking subscription state.
    // Both must run for getToken to actually create a new subscription
    // tied to the current SW lifecycle.
    try { const sub = await reg.pushManager.getSubscription(); if (sub) await sub.unsubscribe(); } catch {}
    try { await messaging.deleteToken(); } catch {}
    const token = await messaging.getToken({
      vapidKey: VAPID_PUBLIC_KEY,
      serviceWorkerRegistration: reg,
    });
    if (token) {
      await db.ref(`users/${uid}/pushSubscription`).set({
        token,
        subscribedAt: firebase.database.ServerValue.TIMESTAMP,
      });
    } else {
      console.warn('enableNotifications: getToken returned null');
      return 'token-null';
    }
  } catch (err) {
    console.warn('enableNotifications: token/subscription write failed:', err.message);
    return 'token-error';
  }

  return 'success';
}

/**
 * Disable push: deleteToken on FCM side, clear subscription + prefs in
 * Firebase. The user can also revoke browser permission directly; that
 * makes our token invalid on FCM's end anyway.
 */
export async function disableNotifications() {
  try {
    if (isPushSupported()) {
      try { await firebase.messaging().deleteToken(); } catch {}
    }
    const uid = getUid();
    if (uid && typeof firebase !== 'undefined' && firebase.database) {
      const db = firebase.database();
      await db.ref(`users/${uid}/pushSubscription`).remove();
      await db.ref(`users/${uid}/notificationPrefs/enabled`).set(false);
    }
    return 'success';
  } catch (err) {
    console.warn('disableNotifications failed:', err.message);
    return 'error';
  }
}

/**
 * Refresh the FCM token if notifications are enabled in Firebase but
 * the current page's token is missing or out of sync. Call on app load.
 *
 * Why this matters: events like "Check for Updates" (which unregisters
 * the SW), browser data clears, OS-level permission revocation, or
 * automatic FCM token rotation can all leave the Firebase record
 * pointing to a token that no longer maps to a live push subscription.
 * The cron then sends to that token, FCM returns 404, send-push.mjs
 * auto-clears the subscription, and the user gets no notifications until
 * they manually re-toggle. With this auto-heal in place, every app load
 * checks: enabled in Firebase but token mismatch (or token absent) →
 * call getToken and write the fresh one. Idempotent and silent.
 */
export async function refreshTokenIfStale() {
  if (!isPushSupported() || !VAPID_PUBLIC_KEY) return 'skip';
  if (Notification.permission !== 'granted') return 'skip';
  try {
    const uid = getUid();
    if (!uid || typeof firebase === 'undefined' || !firebase.database) return 'skip';
    const db = firebase.database();
    const prefsSnap = await db.ref(`users/${uid}/notificationPrefs`).once('value');
    const prefs = prefsSnap.val();
    if (!prefs || prefs.enabled !== true) return 'skip';

    const subSnap = await db.ref(`users/${uid}/pushSubscription`).once('value');
    const existingToken = subSnap.val()?.token || null;

    const reg = await navigator.serviceWorker.ready;
    const messaging = firebase.messaging();
    // Same two-layer reset as enableNotifications: kill the dead
    // browser pushManager subscription FIRST, then clear FCM's cached
    // token. Without the unsubscribe, getToken reuses the existing
    // (dead-after-SW-update) subscription and FCM 404s on send. With
    // it, getToken creates a brand-new subscription tied to the SW
    // currently controlling the page.
    try { const sub = await reg.pushManager.getSubscription(); if (sub) await sub.unsubscribe(); } catch {}
    try { await messaging.deleteToken(); } catch {}
    const currentToken = await messaging.getToken({
      vapidKey: VAPID_PUBLIC_KEY,
      serviceWorkerRegistration: reg,
    });
    if (!currentToken) return 'no-token';
    if (currentToken === existingToken) return 'unchanged';

    await db.ref(`users/${uid}/pushSubscription`).set({
      token: currentToken,
      subscribedAt: firebase.database.ServerValue.TIMESTAMP,
    });
    return 'refreshed';
  } catch (err) {
    console.warn('refreshTokenIfStale failed:', err.message);
    return 'error';
  }
}

/**
 * Read the current notification prefs from Firebase. Returns an object
 * shaped { enabled, hourLocal, dailyReminder, streakWarning } or
 * defaults if nothing is stored yet.
 */
export async function loadNotificationPrefs() {
  const defaults = { enabled: false, hourLocal: 9, dailyReminder: true, streakWarning: false };
  try {
    const uid = getUid();
    if (!uid || typeof firebase === 'undefined' || !firebase.database) return defaults;
    const snap = await firebase.database().ref(`users/${uid}/notificationPrefs`).once('value');
    if (!snap.exists()) return defaults;
    return { ...defaults, ...snap.val() };
  } catch (err) {
    console.warn('loadNotificationPrefs failed:', err.message);
    return defaults;
  }
}

/**
 * Update just the hour preference. Used when the user changes the
 * hour <select> while notifications are already enabled.
 */
export async function updateNotificationHour(hourLocal) {
  if (!Number.isInteger(hourLocal) || hourLocal < 0 || hourLocal > 23) return false;
  try {
    const uid = getUid();
    if (!uid || typeof firebase === 'undefined' || !firebase.database) return false;
    await firebase.database().ref(`users/${uid}/notificationPrefs/hourLocal`).set(hourLocal);
    return true;
  } catch (err) {
    console.warn('updateNotificationHour failed:', err.message);
    return false;
  }
}

/**
 * Toggle the streak-warning evening push. Fires at 8pm ET when the
 * user has a streak ≥ 3 and hasn't played today. Independent of the
 * morning daily-reminder hour preference.
 */
export async function updateStreakWarning(enabled) {
  try {
    const uid = getUid();
    if (!uid || typeof firebase === 'undefined' || !firebase.database) return false;
    await firebase.database().ref(`users/${uid}/notificationPrefs/streakWarning`).set(!!enabled);
    return true;
  } catch (err) {
    console.warn('updateStreakWarning failed:', err.message);
    return false;
  }
}

export { _isIOS as isIOS, _isInstalledPWA as isInstalledPWA };
