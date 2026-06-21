/**
 * Anonymous-auth bootstrap decision (pure, dependency-injected).
 *
 * The ONLY safe trigger for creating a fresh anonymous account is the
 * AUTHORITATIVE first onAuthStateChanged fire reporting no user. At that
 * point Firebase has finished reading its IndexedDB persistence, so a null
 * uid genuinely means "no saved session on this device".
 *
 * The previous implementation triggered the anonymous sign-in on a 5-second
 * TIMEOUT instead: on a slow boot (cold start, slow CDN delivery of the
 * Firebase SDK, sluggish IndexedDB) the timeout fired BEFORE the saved
 * session had surfaced, and signInAnonymously then REPLACED the persisted —
 * often linked — account with a brand-new anonymous one. That is the
 * intermittent "I get signed out for no reason" bug, and the source of the
 * duplicate-leaderboard-row fallout (a stray anonymous uid submitting its
 * own daily score in parallel to the player's real account).
 *
 * This wires the auth listener, signs in anonymously ONLY from the
 * authoritative first null fire, and returns after bounded waits whose sole
 * job is to UNBLOCK boot — they never sign in. A slow persistence read can
 * therefore no longer clobber the saved session: the real uid simply
 * arrives a moment later via the same listener (boot consumes the uid
 * reactively).
 *
 * Dependencies are injected so this is unit-testable without the Firebase
 * SDK or a browser. The listener is intentionally never detached — it is
 * THE session-long auth listener that drives every later uid change.
 *
 * @param {object} deps
 * @param {(cb:(snap:{uid:?string})=>void)=>any} deps.subscribe   attach the auth listener
 * @param {()=>Promise<any>} deps.signInAnon                        create an anonymous account
 * @param {(snap:{uid:?string})=>void} [deps.onAuthFire]           per-fire side effects (real: _handleAuthChange)
 * @param {(msg:string)=>void} [deps.onError]                      failure sink (default: console.warn)
 * @param {number} [deps.firstFireTimeoutMs]                       boot-unblock cap on the first-fire wait
 * @param {number} [deps.settleTimeoutMs]                          boot-unblock cap on the uid-settle wait
 * @returns {Promise<{signedInAnon:boolean, firstFireUid:?string, timedOut:boolean}>}
 */
export async function bootstrapAnonymousAuth({
  subscribe,
  signInAnon,
  onAuthFire = () => {},
  onError = (m) => console.warn(m),
  firstFireTimeoutMs = 5000,
  settleTimeoutMs = 800,
} = {}) {
  if (typeof subscribe !== 'function' || typeof signInAnon !== 'function') {
    throw new Error('bootstrapAnonymousAuth requires subscribe + signInAnon functions');
  }

  const result = { signedInAnon: false, firstFireUid: null, timedOut: false };

  let resolveFirstFire;
  const firstFire = new Promise((resolve) => { resolveFirstFire = resolve; });
  let resolveSettled;
  const settled = new Promise((resolve) => { resolveSettled = resolve; });
  let firstFireDone = false;

  subscribe((snap) => {
    // Per-fire side effects (real impl updates _uid / cloud listener / etc.)
    // run on EVERY fire — this is the session-long auth listener.
    try { onAuthFire(snap); }
    catch (err) { onError('auth-fire handler error: ' + (err && err.message)); }

    if (!firstFireDone) {
      firstFireDone = true;
      result.firstFireUid = (snap && snap.uid) || null;
      // Authoritative: a null uid here means Firebase finished reading
      // persistence and found no session. ONLY now is creating a fresh
      // anonymous account safe.
      if (!snap || !snap.uid) {
        result.signedInAnon = true;
        Promise.resolve()
          .then(signInAnon)
          .catch((err) => onError('Anonymous auth failed: ' + (err && err.message)));
      }
      resolveFirstFire();
    }

    if (snap && snap.uid && resolveSettled) {
      resolveSettled();
      resolveSettled = null;
    }
  });

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Bounded wait for the authoritative first fire. The timeout only
  // UNBLOCKS boot; it does NOT sign in. If it wins, the uid arrives later
  // via the listener (and an anonymous account is created then, IF that
  // late fire reports no user).
  await Promise.race([firstFire, delay(firstFireTimeoutMs)]);
  result.timedOut = !firstFireDone;

  // Bounded wait for a uid to settle — covers the anonymous sign-in kicked
  // above on a fresh device. Again only a boot-unblock cap.
  await Promise.race([settled, delay(settleTimeoutMs)]);

  return result;
}
