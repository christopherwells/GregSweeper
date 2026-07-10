// The daily-win "Remind me tomorrow" CTA outcome mapping, plus the
// enableNotifications return-value contract it depends on.
//
// 2026-07-10 audit: the win-modal CTA tested `result === true || result ===
// 'ok'` — two values enableNotifications never returns (its success value is
// the string 'success', which the Settings toggle checks correctly) — so a
// fully successful enable still rendered "Try again" on the app's best
// conversion moment, every time, while notifications were actually on.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { remindCtaOutcome } = await import('../src/logic/remindCta.js');

test("REGRESSION: 'success' maps to enabled (the old true/'ok' test never matched it)", () => {
  assert.equal(remindCtaOutcome('success'), 'enabled');
  // The values the old inline check looked for are NOT part of the
  // contract — they must fall through to retry, not silently pass.
  assert.equal(remindCtaOutcome(true), 'retry');
  assert.equal(remindCtaOutcome('ok'), 'retry');
});

test('the failure family maps to its specific CTA states', () => {
  assert.equal(remindCtaOutcome('ios-needs-install'), 'install');
  assert.equal(remindCtaOutcome('denied'), 'blocked');
  for (const r of ['no-key', 'unsupported', 'token-null', 'token-error', 'error', undefined, null]) {
    assert.equal(remindCtaOutcome(r), 'retry', `${r} must be a retry`);
  }
});

// Contract pin: enableNotifications resolves to the string 'success' on its
// short-circuit test-env path. If the success value ever changes shape again,
// this fails here instead of silently breaking both toggles' comparisons.
test("enableNotifications' success value is the string 'success' (test-env short-circuit)", async () => {
  const savedWindow = globalThis.window;
  globalThis.window = { ...savedWindow, location: { ...savedWindow.location, search: '?isTest=1' } };
  globalThis.location = globalThis.window.location; // env.js reads the bare global
  try {
    const { enableNotifications } = await import('../src/firebase/firebasePush.js');
    assert.equal(await enableNotifications({ hourLocal: 9 }), 'success');
  } finally {
    globalThis.window = savedWindow;
    delete globalThis.location;
  }
});
