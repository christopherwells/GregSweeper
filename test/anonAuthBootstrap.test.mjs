// Regression guard for the "signed out for no reason" bug: a slow boot
// (Firebase's IndexedDB persistence read overrunning the wait) must NEVER
// trigger an anonymous sign-in, because that replaces the player's saved
// (often linked) session with a brand-new anonymous account — which then
// submits its own daily score in parallel to their real one.
//
// The anonymous sign-in is allowed ONLY off the authoritative first
// onAuthStateChanged fire reporting no user.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapAnonymousAuth } from '../src/firebase/anonAuthBootstrap.js';

// A fake auth-state subscription the test can fire on its own schedule.
function makeSubscribe() {
  let listener = null;
  return {
    subscribe: (cb) => { listener = cb; return () => { listener = null; }; },
    fire: (snap) => { if (listener) listener(snap); },
  };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('THE BUG: a uid arriving AFTER the first-fire timeout never triggers anonymous sign-in', async () => {
  const s = makeSubscribe();
  let anonCalls = 0;
  const p = bootstrapAnonymousAuth({
    subscribe: s.subscribe,
    signInAnon: async () => { anonCalls++; },
    firstFireTimeoutMs: 20,
    settleTimeoutMs: 20,
  });
  // Persistence read is slow: the real (linked) account surfaces only
  // after the bootstrap's bounded waits have already elapsed.
  setTimeout(() => s.fire({ uid: 'V07-linked' }), 60);
  const result = await p;
  assert.equal(anonCalls, 0, 'must NOT create an anonymous account on timeout');
  assert.equal(result.signedInAnon, false);
  assert.equal(result.timedOut, true, 'first fire did not arrive within the bounded wait');

  // And once the late fire lands, it is still NOT treated as "no user".
  await wait(80);
  assert.equal(anonCalls, 0, 'late real account must not be clobbered after the fact either');
});

test('fresh device: an authoritative first fire with no user DOES sign in anonymously', async () => {
  const s = makeSubscribe();
  let anonCalls = 0;
  const p = bootstrapAnonymousAuth({
    subscribe: s.subscribe,
    signInAnon: async () => { anonCalls++; s.fire({ uid: 'anon-new' }); },
    firstFireTimeoutMs: 200,
    settleTimeoutMs: 200,
  });
  s.fire({ uid: null }); // Firebase: persistence read done, no saved session
  const result = await p;
  assert.equal(anonCalls, 1, 'a genuinely empty device still gets an anonymous account');
  assert.equal(result.signedInAnon, true);
  assert.equal(result.firstFireUid, null);
  assert.equal(result.timedOut, false);
});

test('normal restore: a persisted uid on the first fire is kept, no anonymous sign-in', async () => {
  const s = makeSubscribe();
  let anonCalls = 0;
  const p = bootstrapAnonymousAuth({
    subscribe: s.subscribe,
    signInAnon: async () => { anonCalls++; },
    firstFireTimeoutMs: 200,
    settleTimeoutMs: 200,
  });
  s.fire({ uid: 'V07-linked' });
  const result = await p;
  assert.equal(anonCalls, 0);
  assert.equal(result.signedInAnon, false);
  assert.equal(result.firstFireUid, 'V07-linked');
  assert.equal(result.timedOut, false);
});

test('onAuthFire runs for every fire (the session-long listener), including a late one', async () => {
  const s = makeSubscribe();
  const seen = [];
  const p = bootstrapAnonymousAuth({
    subscribe: s.subscribe,
    signInAnon: async () => {},
    onAuthFire: (snap) => seen.push(snap && snap.uid),
    firstFireTimeoutMs: 20,
    settleTimeoutMs: 20,
  });
  setTimeout(() => s.fire({ uid: 'late' }), 50);
  await p;
  await wait(60);
  assert.deepEqual(seen, ['late'], 'the late fire is still delivered to the side-effect handler');
});

test('guards against missing dependencies', async () => {
  await assert.rejects(() => bootstrapAnonymousAuth({}), /requires subscribe/);
  await assert.rejects(
    () => bootstrapAnonymousAuth({ subscribe: () => {} }),
    /requires subscribe/,
  );
});
