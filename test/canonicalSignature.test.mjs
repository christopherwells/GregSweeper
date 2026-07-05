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
  assessCanonicalTrust, SIGNATURE_EPOCH, PUBLIC_KEYS,
} = await import('../src/logic/canonicalSignature.js');
const { etDateStringOfMs } = await import('../src/logic/seededRandom.js');

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

test('the shipped PUBLIC_KEYS entry is a real importable P-256 key', async () => {
  const bytes = new Uint8Array(Buffer.from(PUBLIC_KEYS[0], 'base64'));
  const key = await crypto.subtle.importKey('spki', bytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(key, 'prod public key must import cleanly');
});
