/**
 * Friends system — Firebase I/O.
 *
 * Thin wrapper over the pure logic in src/logic/friendCodes.js and
 * src/logic/leaderboardViews.js (the regression suite pins those; this
 * file is only plumbing).
 *
 * Model (see firebase-rules.json):
 *  - friendCodes/{CODE} = { uid, name, createdAt } — ephemeral, 15-min
 *    life enforced SERVER-SIDE by the rules read gate (expired codes
 *    are unreadable). Multi-use within the window, deliberately: one
 *    code on a classroom projector serves the whole class. Creation is
 *    create-only-if-absent (no hijacking a live code).
 *  - users/{uid}/friends/{friendUid} = { name, addedAt } — MUTUAL:
 *    redeeming writes both sides in one multi-location update. The
 *    rules let a stranger write/delete only the entry keyed by their
 *    own uid. Lists are readable by their owner only.
 */

import { waitForFirebaseReady } from './waitForFirebase.js';
import { getUid } from './firebaseProgress.js';
import { getPlayerName } from '../storage/statsStorage.js';
import { safeGetJSON, safeSetJSON } from '../storage/storageAdapter.js';
import {
  generateCode, normalizeCode, isCodeFresh, CODE_TTL_MS,
} from '../logic/friendCodes.js';
import {
  buildFriendAddUpdate, buildFriendRemoveUpdate,
} from '../logic/leaderboardViews.js';

// Re-show a still-valid code (with countdown) when the tab reopens.
// createdAtLocal is the local clock at creation — display only; the
// rules gate expiry on the SERVER timestamp.
const MY_CODE_KEY = 'minesweeper_friend_code';

function db() {
  return firebase.database();
}

export function getCachedCode(now = Date.now()) {
  const cached = safeGetJSON(MY_CODE_KEY, null);
  if (!cached || !cached.code) return null;
  if (!isCodeFresh(cached.createdAtLocal, now)) return null;
  return cached;
}

/**
 * Create (or return the still-fresh cached) friend code.
 * @returns {Promise<{code: string, createdAtLocal: number}>}
 */
export async function createFriendCode() {
  const cached = getCachedCode();
  if (cached) return cached;

  const ready = await waitForFirebaseReady();
  const uid = getUid();
  if (!ready || !uid) throw new Error('offline');

  const payload = {
    uid,
    name: (getPlayerName() || 'Player').slice(0, 20),
    createdAt: firebase.database.ServerValue.TIMESTAMP,
  };
  // Collision odds at 30^6 are negligible, but the create-if-absent
  // transaction makes a clash a clean retry instead of a hijack.
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateCode();
    const result = await db().ref('friendCodes/' + code)
      .transaction(cur => (cur === null ? payload : undefined));
    if (result.committed) {
      const entry = { code, createdAtLocal: Date.now() };
      safeSetJSON(MY_CODE_KEY, entry);
      return entry;
    }
  }
  throw new Error('could not allocate a code');
}

/** Drop the cached code and mint a fresh one. */
export async function regenerateFriendCode() {
  const cached = safeGetJSON(MY_CODE_KEY, null);
  safeSetJSON(MY_CODE_KEY, null);
  // Best-effort cleanup of the old code (rules allow deleting existing
  // codes); ignore failures — the read gate expires it regardless.
  if (cached && cached.code) {
    db().ref('friendCodes/' + cached.code).remove().catch(() => {});
  }
  return createFriendCode();
}

/**
 * Redeem a friend's code: mutual add.
 * @returns {Promise<{uid: string, name: string}>} the new friend
 * @throws Error with .reason in {'invalid','offline','expired','self','failed'}
 */
export async function redeemFriendCode(input) {
  const code = normalizeCode(input);
  if (!code) { const e = new Error('invalid code'); e.reason = 'invalid'; throw e; }

  const ready = await waitForFirebaseReady();
  const myUid = getUid();
  if (!ready || !myUid) { const e = new Error('offline'); e.reason = 'offline'; throw e; }

  let snap = null;
  try {
    snap = await db().ref('friendCodes/' + code).once('value');
  } catch {
    // Rules deny reads of expired codes — indistinguishable from absent.
    const e = new Error('expired'); e.reason = 'expired'; throw e;
  }
  const entry = snap && snap.val();
  if (!entry || !entry.uid) { const e = new Error('expired'); e.reason = 'expired'; throw e; }
  if (entry.uid === myUid) { const e = new Error('self'); e.reason = 'self'; throw e; }

  const myName = (getPlayerName() || 'Player').slice(0, 20);
  const update = buildFriendAddUpdate(
    myUid, myName, entry.uid, entry.name || 'Player',
    firebase.database.ServerValue.TIMESTAMP,
  );
  try {
    await db().ref().update(update);
  } catch {
    const e = new Error('failed'); e.reason = 'failed'; throw e;
  }
  return { uid: entry.uid, name: entry.name || 'Player' };
}

/** @returns {Promise<Array<{uid, name, addedAt}>>} oldest first */
export async function fetchFriends() {
  const ready = await waitForFirebaseReady();
  const uid = getUid();
  if (!ready || !uid) return null; // null = offline (distinct from [])
  try {
    const snap = await db().ref(`users/${uid}/friends`).once('value');
    const val = snap.val() || {};
    return Object.entries(val)
      .map(([fuid, v]) => ({ uid: fuid, name: (v && v.name) || 'Player', addedAt: (v && v.addedAt) || 0 }))
      .sort((a, b) => a.addedAt - b.addedAt);
  } catch {
    return null;
  }
}

/** Unfriend — unlinks BOTH sides. */
export async function removeFriend(theirUid) {
  const ready = await waitForFirebaseReady();
  const myUid = getUid();
  if (!ready || !myUid) throw new Error('offline');
  await db().ref().update(buildFriendRemoveUpdate(myUid, theirUid));
}
