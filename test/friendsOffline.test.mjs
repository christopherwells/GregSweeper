// Friends offline contract (2026-07-10 audit).
//
// Every function in firebaseFriends.js documents an offline behavior —
// fetchFriends returns null, the actions throw with reason/message
// 'offline' — but waitForFirebaseReady THROWS on its 8s timeout, and the
// raw throw leaked through all four functions: opening the Friends tab
// with Firebase unreachable rejected out of the click handler unhandled
// (no offline copy rendered), and createFriendCode's "Codes need a
// connection" message never fired because the error message wasn't
// 'offline'. The functions now route readiness through a catch that
// converts the timeout into the documented offline shapes.
//
// The 8s readiness poll runs on mocked timers so the suite stays fast.

import './helpers.mjs';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const { fetchFriends, createFriendCode } = await import('../src/firebase/firebaseFriends.js');

// Drive a promise to settlement while the readiness poll's setTimeout/Date
// are mocked: tick virtual time, then yield a real macrotask so the poll
// loop's awaits chain forward.
async function settleUnderMockTimers(promise) {
  let outcome = null;
  promise.then(
    (v) => { outcome = { resolved: true, value: v }; },
    (e) => { outcome = { resolved: false, error: e }; },
  );
  for (let i = 0; i < 400 && !outcome; i++) {
    mock.timers.tick(100);
    await new Promise((r) => setImmediate(r));
  }
  return outcome;
}

test('REGRESSION: fetchFriends resolves null (never rejects) when Firebase never initializes', async () => {
  assert.equal(typeof globalThis.firebase, 'undefined', 'precondition: no firebase SDK in this process');
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const outcome = await settleUnderMockTimers(fetchFriends());
    assert.ok(outcome, 'fetchFriends must settle once the readiness timeout elapses');
    assert.equal(outcome.resolved, true, 'the documented offline contract is a RESOLVED null, not a rejection');
    assert.equal(outcome.value, null);
  } finally {
    mock.timers.reset();
  }
});

test("REGRESSION: createFriendCode rejects with the 'offline' message the UI keys on", async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const outcome = await settleUnderMockTimers(createFriendCode());
    assert.ok(outcome, 'createFriendCode must settle once the readiness timeout elapses');
    assert.equal(outcome.resolved, false, 'no Firebase → the offline error');
    assert.equal(outcome.error && outcome.error.message, 'offline',
      "the Friends panel shows 'Codes need a connection' only for message === 'offline'");
  } finally {
    mock.timers.reset();
  }
});
