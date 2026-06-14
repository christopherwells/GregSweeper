// The dailyArchive submit payload is the data contract with the firebase
// rules. A dropped `archivePlay` or a stray field would only surface as a
// silent rules rejection on a real write (which the test env skips), so the
// payload builder is pinned here against the rule whitelist.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal browser stubs so firebaseLeaderboard and its deps import in node.
// Set before the dynamic import (a static import would hoist above these).
globalThis.localStorage = globalThis.localStorage || (() => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k), clear: () => m.clear(), key: () => null, get length() { return m.size; } };
})();
globalThis.window = globalThis.window || { location: { search: '', hostname: 'localhost', pathname: '/' }, addEventListener() {} };
globalThis.document = globalThis.document || { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };

const { buildArchivePayload } = await import('../src/firebase/firebaseLeaderboard.js');
const TS = '__SERVER_TS__';

test('payload carries the required archive fields', () => {
  const p = buildArchivePayload('2026-05-12', 'Kate', 42.5, 0, { uid: 'uid123' }, TS);
  assert.equal(p.archivePlay, true, 'archivePlay must be literal true (the rule requires it)');
  assert.equal(p.name, 'Kate');
  assert.equal(p.time, 42.5);
  assert.equal(p.bombHits, 0);
  assert.equal(p.uid, 'uid123');
  assert.equal(p.timestamp, TS, 'must carry the passed server-timestamp sentinel');
});

test('cruxViewed rides only when explicitly true', () => {
  assert.equal('cruxViewed' in buildArchivePayload('2026-05-12', 'K', 10, 0, {}, TS), false);
  assert.equal('cruxViewed' in buildArchivePayload('2026-05-12', 'K', 10, 0, { cruxViewed: false }, TS), false);
  assert.equal(buildArchivePayload('2026-05-12', 'K', 10, 0, { cruxViewed: true }, TS).cruxViewed, true);
});

test('rngSeed is omitted when it equals the date, kept when it differs', () => {
  // A trial-variant seed differs from the date and must be stored.
  assert.equal(buildArchivePayload('2026-05-12', 'K', 10, 0, { rngSeed: '2026-05-12:trial3' }, TS).rngSeed, '2026-05-12:trial3');
  // A plain-date seed equals the date, so it is reconstructed and omitted.
  assert.equal('rngSeed' in buildArchivePayload('2026-05-12', 'K', 10, 0, { rngSeed: '2026-05-12' }, TS), false);
});

test('bomb events denormalize totalBombPenalty; events attach only when present', () => {
  const p = buildArchivePayload('2026-05-12', 'K', 60, 2, {
    bombHitEvents: [{ t: 5, row: 1, col: 1, penalty: 3.2 }, { t: 9, row: 2, col: 2, penalty: 4.0 }],
    hintEvents: [{ t: 7, kind: 'region' }],
  }, TS);
  assert.equal(p.bombHitEvents.length, 2);
  assert.equal(p.totalBombPenalty, 7.2);
  assert.equal(p.hintEvents.length, 1);
  const q = buildArchivePayload('2026-05-12', 'K', 60, 0, {}, TS);
  assert.equal('bombHitEvents' in q, false);
  assert.equal('totalBombPenalty' in q, false);
  assert.equal('hintEvents' in q, false);
});

test('payload never emits a field outside the dailyArchive rule whitelist', () => {
  // The rule's $other catch-all rejects any extra field, so a future field
  // added to the payload but not the rules would silently fail every write.
  const allowed = new Set(['name', 'time', 'bombHits', 'archivePlay', 'timestamp',
    'uid', 'par', 'cruxViewed', 'bombHitEvents', 'totalBombPenalty', 'hintEvents', 'rngSeed']);
  const p = buildArchivePayload('2026-05-12', 'K', 60, 1, {
    uid: 'u', par: 55, cruxViewed: true, rngSeed: '2026-05-12:trial1',
    bombHitEvents: [{ t: 1, row: 0, col: 0, penalty: 3 }], hintEvents: [{ t: 2, kind: 'region' }],
  }, TS);
  for (const k of Object.keys(p)) assert.ok(allowed.has(k), `unexpected payload field: ${k}`);
});
