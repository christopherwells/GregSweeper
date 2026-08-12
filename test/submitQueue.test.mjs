// Submission rate-limit + retry-queue identity contract.
//
// Issue #89: submitTimedScore, submitArchiveScore, and submitOnlineScore
// (daily / weekly_first) shared ONE module-level cooldown clock, so a timed
// win within 30s of a daily win silently suppressed the daily submission —
// and the cooldown branch dropped it without queueing. The clocks are now
// per-path and the daily cooldown branch queues instead of dropping.
//
// Issue #132: the offline retry queues froze the uid at enqueue time; after
// an account-link switch every flush failed the `uid === auth.uid` rule until
// the entry aged out. Identity now resolves at flush time via the restamp
// helpers pinned here.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  _submitCooldownOk, _stampSubmitCooldown,
  restampPendingEntry, restampPendingWeeklyEntry,
} = await import('../src/firebase/firebaseLeaderboard.js');

test('REGRESSION #89: a timed submission does not burn the daily cooldown clock', () => {
  const t0 = 1_000_000;
  _stampSubmitCooldown('timed', t0);
  assert.equal(_submitCooldownOk('daily', t0 + 1000), true,
    'daily must be submittable right after a timed win');
  assert.equal(_submitCooldownOk('archive', t0 + 1000), true,
    'archive must be submittable right after a timed win');
  assert.equal(_submitCooldownOk('timed', t0 + 1000), false,
    'the timed path itself is still rate-limited');
  assert.equal(_submitCooldownOk('timed', t0 + 31_000), true,
    'the timed cooldown expires after 30s');
});

test('each path cools down independently of the others', () => {
  const t0 = 2_000_000;
  _stampSubmitCooldown('daily', t0);
  assert.equal(_submitCooldownOk('daily', t0 + 1000), false);
  assert.equal(_submitCooldownOk('timed', t0 + 1000), true);
  assert.equal(_submitCooldownOk('archive', t0 + 1000), true);
  assert.equal(_submitCooldownOk('match', t0 + 1000), true);
});

test('the match path is registered, and is a real limit', () => {
  const t0 = 3_000_000;
  _stampSubmitCooldown('match', t0);
  assert.equal(_submitCooldownOk('match', t0 + 1000), false,
    'a match submission inside its own window must be refused');
  assert.equal(_submitCooldownOk('match', t0 + 31_000), true);
  assert.equal(_submitCooldownOk('daily', t0 + 1000), true,
    'and it must not burn the daily clock (the #89 shape)');
});

test('REGRESSION: EVERY kind the module submits under is registered in the clock map', () => {
  // The silent-trap this pins: `_submitCooldownOk` reads
  // `_lastSubmitByKind[kind] || 0`, so a kind that is NOT a key in that
  // literal is never rate-limited — it is always permitted, and every call
  // site reads exactly like one that works. Derived from the source rather
  // than hand-listed, because the failure it catches is a kind somebody
  // forgot to add, and a hand-kept list forgets the same one.
  const src = readFileSync(new URL('../src/firebase/firebaseLeaderboard.js', import.meta.url), 'utf8');

  const literal = src.match(/const _lastSubmitByKind = \{([^}]*)\}/);
  assert.ok(literal, 'the _lastSubmitByKind literal has moved — this test is now inert');
  const registered = new Set([...literal[1].matchAll(/(\w+)\s*:/g)].map((m) => m[1]));

  const used = new Set([...src.matchAll(/_(?:submitCooldownOk|stampSubmitCooldown)\('(\w+)'/g)]
    .map((m) => m[1]));
  // Non-vacuity: the scan must actually be finding the call sites.
  assert.ok(used.size >= 4, `only found ${used.size} cooldown call sites — the pattern has gone stale`);
  assert.ok(used.has('match') && used.has('daily'),
    'the derivation missed a known path, so it is not reading the module');

  const unregistered = [...used].filter((k) => !registered.has(k));
  assert.deepEqual(unregistered, [],
    `submission kinds used but NOT in _lastSubmitByKind (silently unlimited): ${unregistered.join(', ')}`);
});

test('REGRESSION #132: a queued daily entry is re-stamped to the CURRENT uid at flush', () => {
  const frozen = {
    dateString: '2026-07-01', name: 'Chris', time: 88, bombHits: 0,
    extras: { uid: 'anon-OLD', par: 96.2, rngSeed: '2026-07-01:trial3' },
    queuedAt: 1, attempts: 2,
  };
  const flushed = restampPendingEntry(frozen, 'linked-NEW');
  assert.equal(flushed.extras.uid, 'linked-NEW', 'the frozen uid must be replaced');
  assert.equal(flushed.extras.par, 96.2, 'other extras ride along untouched');
  assert.equal(flushed.extras.rngSeed, '2026-07-01:trial3');
  assert.equal(flushed.dateString, '2026-07-01');
  // An entry queued before auth ever settled (no uid at all) gains one.
  const uidless = restampPendingEntry({ dateString: '2026-07-02', name: 'K', time: 60, bombHits: 0 }, 'linked-NEW');
  assert.equal(uidless.extras.uid, 'linked-NEW');
});

test('REGRESSION #132: a queued weekly entry rebuilds its row path from the CURRENT uid', () => {
  const frozen = {
    weekStart: '2026-06-29', uid: 'anon-OLD', name: 'Chris', bestTime: 120,
    dayTimes: { 2: 120 }, extras: {}, queuedAt: 1, attempts: 0,
  };
  const flushed = restampPendingWeeklyEntry(frozen, 'linked-NEW');
  assert.equal(flushed.uid, 'linked-NEW');
  assert.deepEqual(flushed.dayTimes, { 2: 120 }, 'day times ride along untouched');
});
