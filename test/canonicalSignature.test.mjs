// Canonical-board signatures — the #114 trust-model close. Pins the signing
// round-trip, the deterministic serialization both sides must agree on, and
// the full trust-policy table (grandfathering, signature requirement, and
// the first-client-fallback writtenAt window).

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  canonicalStringify, signCanonicalPayload, verifyCanonicalPayloadSig,
  assessCanonicalTrust, unstorableShapeReason, SIGNATURE_EPOCH, PUBLIC_KEYS,
} = await import('../src/logic/canonicalSignature.js');
const { etDateStringOfMs } = await import('../src/logic/seededRandom.js');
const { serializeBoard } = await import('../src/firebase/dailyBoardSync.js');

// What Firebase Realtime DB does to a payload on the way to storage: it has no
// empty node, so a child whose value is [], {} or null is DELETED rather than
// stored. Verified against the live database (2026-07-27): not one of the 152
// stored dailyBoards contains an empty container or a null anywhere.
function throughFirebase(payload) {
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, raw] of Object.entries(v)) {
        const nv = strip(raw);
        const dropped = nv === null || nv === undefined
          || (Array.isArray(nv) && nv.length === 0)
          || (typeof nv === 'object' && !Array.isArray(nv) && Object.keys(nv).length === 0);
        if (!dropped) out[k] = nv;
      }
      return out;
    }
    return v;
  };
  return strip(payload);
}

// Throwaway keypair for these tests — the prod private key lives only in
// the Actions secret and is deliberately unavailable here.
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const TEST_PRIV = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64');
const TEST_PUB = Buffer.from(await crypto.subtle.exportKey('spki', kp.publicKey)).toString('base64');
const TEST_KEYS = [TEST_PUB];

const board = JSON.parse(readFileSync(new URL('./fixtures/dailyBoard-2026-06-14.json', import.meta.url), 'utf8'));

test('canonicalStringify is key-order independent and excludes sig/writtenAt', () => {
  const a = { rows: 9, cols: 8, cells: [{ isMine: true, adjacentMines: 0 }] };
  const b = { cells: [{ adjacentMines: 0, isMine: true }], cols: 8, rows: 9, sig: 'X', writtenAt: 123 };
  assert.equal(canonicalStringify(a), canonicalStringify(b));
});

test('sign → verify round-trips on a real canonical payload', async () => {
  const sig = await signCanonicalPayload(board, TEST_PRIV);
  assert.equal(await verifyCanonicalPayloadSig({ ...board, sig }, TEST_KEYS), true);
  // The stored writtenAt (resolved server ms) differing from the signing-time
  // sentinel must not break verification.
  assert.equal(await verifyCanonicalPayloadSig({ ...board, sig, writtenAt: 999 }, TEST_KEYS), true);
});

test('REGRESSION #114: any tampering after signing fails verification', async () => {
  const sig = await signCanonicalPayload(board, TEST_PRIV);
  const tampered = JSON.parse(JSON.stringify(board));
  const i = tampered.cells.findIndex((c) => !c.isMine);
  tampered.cells[i].isMine = true;   // one flipped mine
  assert.equal(await verifyCanonicalPayloadSig({ ...tampered, sig }, TEST_KEYS), false);
  assert.equal(await verifyCanonicalPayloadSig({ ...board, sig: sig.slice(0, -4) + 'AAAA' }, TEST_KEYS), false);
  assert.equal(await verifyCanonicalPayloadSig({ ...board }, TEST_KEYS), false, 'missing sig');
  assert.equal(await verifyCanonicalPayloadSig({ ...board, sig }, ['not-a-key']), false, 'garbage key never verifies');
});

test('trust policy: pre-epoch canonicals are grandfathered unsigned', async () => {
  const v = await assessCanonicalTrust(board, '2026-06-14', 'daily', etDateStringOfMs, TEST_KEYS);
  assert.equal(v.trusted, true);
});

test('trust policy: post-epoch signed boards must verify', async () => {
  const key = SIGNATURE_EPOCH; // first governed date
  const sig = await signCanonicalPayload(board, TEST_PRIV);
  const good = await assessCanonicalTrust({ ...board, sig }, key, 'daily', etDateStringOfMs, TEST_KEYS);
  assert.equal(good.trusted, true);
  const tampered = JSON.parse(JSON.stringify(board));
  tampered.totalMines = tampered.totalMines + 1;
  const bad = await assessCanonicalTrust({ ...tampered, sig }, key, 'daily', etDateStringOfMs, TEST_KEYS);
  assert.equal(bad.trusted, false, 'a bad signature is affirmative tamper evidence');
});

test('REGRESSION #114: an unsigned post-epoch board pre-written for a future date is rejected', async () => {
  // The poisoning shape: written days before its date (writtenAt << key).
  const writtenAt = Date.UTC(2026, 6, 1, 12); // 2026-07-01, key is later
  const v = await assessCanonicalTrust({ ...board, writtenAt }, '2026-07-20', 'daily', etDateStringOfMs, TEST_KEYS);
  assert.equal(v.trusted, false);
  // No usable writtenAt at all -> also rejected.
  const { writtenAt: _w, ...noStamp } = board;
  const v2 = await assessCanonicalTrust(noStamp, '2026-07-20', 'daily', etDateStringOfMs, TEST_KEYS);
  assert.equal(v2.trusted, false);
});

test('trust policy: the first-client fallback (unsigned, written same ET day) stays trusted', async () => {
  // 2026-07-20 12:00 ET == 16:00 UTC (EDT).
  const sameDay = Date.UTC(2026, 6, 20, 16);
  const v = await assessCanonicalTrust({ ...board, writtenAt: sameDay }, '2026-07-20', 'daily', etDateStringOfMs, TEST_KEYS);
  assert.equal(v.trusted, true);
});

test('trust policy: the weekly window spans Monday..Sunday', async () => {
  // Week of Monday 2026-07-20; a fallback write Thursday 07-23 is in-window,
  // a pre-write on 07-15 is not.
  const thursday = Date.UTC(2026, 6, 23, 16);
  const inWindow = await assessCanonicalTrust({ ...board, writtenAt: thursday }, '2026-07-20', 'weekly', etDateStringOfMs, TEST_KEYS);
  assert.equal(inWindow.trusted, true);
  const before = Date.UTC(2026, 6, 15, 16);
  const preWrite = await assessCanonicalTrust({ ...board, writtenAt: before }, '2026-07-20', 'weekly', etDateStringOfMs, TEST_KEYS);
  assert.equal(preWrite.trusted, false);
});

// ── Issue #143: the Firebase empty-container round-trip ───────────────────
// serializeBoard sent `activeGimmicks: []` for a gimmick-free daily. Firebase
// dropped it, so the payload read back was not the payload that was signed and
// every client rejected a legitimate board as tampered. It went live on
// dailyBoard/2026-08-03 — a decorrelation-mission board, which rolls the
// NATURAL gimmick lottery and so comes up gimmick-free far more often than a
// force-injected one.

test('REGRESSION #143: a gimmick-free board still verifies after the Firebase round-trip', async () => {
  const gimmickFree = { ...board, activeGimmicks: [] };
  const sig = await signCanonicalPayload(gimmickFree, TEST_PRIV);
  // What the database actually hands back: no activeGimmicks key at all.
  const stored = throughFirebase({ ...gimmickFree, sig, writtenAt: 1234567890 });
  assert.equal('activeGimmicks' in stored, false, 'Firebase drops the empty array');
  assert.equal(await verifyCanonicalPayloadSig(stored, TEST_KEYS), true,
    'the stored form of a signed gimmick-free board must verify');
});

test('REGRESSION #143: the round-trip invariant holds for ANY droppable field, not just activeGimmicks', async () => {
  // The point of normalizing in canonicalStringify rather than only omitting
  // at serialize: a field added later that forgets the omit-when-empty rule
  // must not be able to reopen this.
  const withEmpties = {
    ...board,
    activeGimmicks: [],
    someFutureList: [],
    someFutureMap: {},
    someFutureNull: null,
    // An object that becomes empty only once its own children are dropped —
    // Firebase cascades, so the normalization has to be bottom-up.
    nested: { inner: [] },
  };
  const sig = await signCanonicalPayload(withEmpties, TEST_PRIV);
  const stored = throughFirebase({ ...withEmpties, sig });
  for (const k of ['activeGimmicks', 'someFutureList', 'someFutureMap', 'someFutureNull', 'nested']) {
    assert.equal(k in stored, false, `${k} must be gone after the round-trip`);
  }
  assert.equal(await verifyCanonicalPayloadSig(stored, TEST_KEYS), true);
});

test('REGRESSION #143: serializeBoard omits activeGimmicks when the board has none', () => {
  const mk = (gimmicks) => {
    const b = [[{ isMine: false, adjacentMines: 0 }, { isMine: true, adjacentMines: 0 }]];
    return serializeBoard({
      board: b, rows: 1, cols: 2, totalMines: 1, rngSeed: 's', activeGimmicks: gimmicks,
    });
  };
  assert.equal('activeGimmicks' in mk([]), false, 'empty must be omitted, like wallEdges');
  assert.equal('activeGimmicks' in mk(undefined), false);
  assert.deepEqual(mk(['liar']).activeGimmicks, ['liar'], 'a real list still ships');
});

test('normalization cannot make two DIFFERENT stored payloads share a signature', async () => {
  // The malleability question: dropping empty properties from the signed
  // string is only safe if the dropped forms are indistinguishable AFTER
  // storage too — which they are, because Firebase drops them as well. A
  // payload that differs in anything the database can actually HOLD must
  // still break the signature.
  const sig = await signCanonicalPayload({ ...board, activeGimmicks: [] }, TEST_PRIV);
  const stored = throughFirebase({ ...board, activeGimmicks: [], sig });
  assert.equal(await verifyCanonicalPayloadSig(stored, TEST_KEYS), true);
  // Same board, but now claiming a modifier: storable, so it must NOT verify.
  assert.equal(
    await verifyCanonicalPayloadSig({ ...stored, activeGimmicks: ['liar'] }, TEST_KEYS), false,
    'a non-empty activeGimmicks is storable and must break the signature',
  );
  assert.equal(
    await verifyCanonicalPayloadSig({ ...stored, totalMines: stored.totalMines + 1 }, TEST_KEYS), false,
  );
});

test('signing REFUSES a payload Firebase cannot round-trip (empty at an array position)', async () => {
  // canonicalStringify absorbs empties at object-property positions because
  // that is what storage does. At an ARRAY-ELEMENT position storage instead
  // leaves a hole and returns a sparse OBJECT, which deserializeBoard rejects
  // outright — no normalization can fix a shape change, so the writer has to
  // hear about it at signing time.
  const holed = { ...board, cellNeighbors: [[1], [], [1]] };
  assert.match(unstorableShapeReason(holed) || '', /cellNeighbors\[1\]/);
  await assert.rejects(
    () => signCanonicalPayload(holed, TEST_PRIV),
    /cannot round-trip/,
  );
  // The real fixture, and a payload whose only empties are properties, are fine.
  assert.equal(unstorableShapeReason(board), null);
  assert.equal(unstorableShapeReason({ ...board, activeGimmicks: [] }), null);
});

test('REGRESSION #143: a non-finite number reproduces the same round-trip break, and signing refuses it', async () => {
  // NaN and ±Infinity have no JSON form — JSON.stringify renders them as
  // `null`, and Firebase drops nulls — so a payload carrying one signs over
  // `"x":null` and reads back with no key at all: #143 exactly, by a different
  // door. The two writer paths do not even agree (the JS SDK rejects a
  // non-finite; a REST PUT silently sends null), so it is refused at signing
  // rather than quietly signed around.
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.match(unstorableShapeReason({ ...board, someCount: bad }) || '', /non-finite/);
    await assert.rejects(() => signCanonicalPayload({ ...board, someCount: bad }, TEST_PRIV), /non-finite/);
  }
  // Deep inside a cell, too — that is where a generator bug would put one.
  const deep = JSON.parse(JSON.stringify(board));
  deep.cells[0].adjacentMines = 0;
  deep.cells[0].displayedMines = Number('x');   // NaN
  assert.match(unstorableShapeReason(deep) || '', /cells\[0\]\.displayedMines is NaN/);
  // A finite 0 is storable and must NOT be confused with an empty value.
  assert.equal(unstorableShapeReason({ ...board, someCount: 0 }), null);
  assert.match(canonicalStringify({ a: 0, b: false, c: '' }), /"a":0/);
});

test('a 0, false or "" is stored by Firebase and must survive normalization', async () => {
  // The failure mode of over-normalizing: these are all falsy but all storable,
  // and dropping any of them would silently change what a signature covers.
  const payload = { ...board, zeroCount: 0, flagOff: false, emptyString: '' };
  const sig = await signCanonicalPayload(payload, TEST_PRIV);
  const stored = throughFirebase({ ...payload, sig });
  for (const k of ['zeroCount', 'flagOff', 'emptyString']) {
    assert.ok(k in stored, `${k} must survive the round-trip`);
  }
  assert.equal(await verifyCanonicalPayloadSig(stored, TEST_KEYS), true);
  assert.equal(await verifyCanonicalPayloadSig({ ...stored, zeroCount: 1 }, TEST_KEYS), false);
});

test('the verifier is TOTAL — a malformed payload returns false, never throws', async () => {
  // gateCanonicalTrust fails OPEN on an exception, so a throw inside
  // verification would TRUST a malformed board. Every guard added for #143
  // must stay on the signing side.
  for (const bad of [
    { ...board, sig: 'x', cellNeighbors: [[1], [], [1]] },
    { ...board, sig: 'x', cells: [[], {}, null] },
    { sig: 'x' },
    { sig: '!!!not base64!!!' },
  ]) {
    assert.equal(await verifyCanonicalPayloadSig(bad, TEST_KEYS), false);
  }
  assert.doesNotThrow(() => canonicalStringify({ a: [[], {}, null], b: null }));
});

test('the shipped PUBLIC_KEYS entry is a real importable P-256 key', async () => {
  const bytes = new Uint8Array(Buffer.from(PUBLIC_KEYS[0], 'base64'));
  const key = await crypto.subtle.importKey('spki', bytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(key, 'prod public key must import cleanly');
});
