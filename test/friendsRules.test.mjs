// Friends-system rules structure contract. Guards the two riskiest
// future edits: "simplifying" the users rules (which would silently
// kill the mutual-add exception) and loosening the ephemeral-code
// gate. Companion to test/rules-contract.test.mjs (field whitelists)
// and test/friendCodes.test.mjs (TTL/regex parity).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rules = JSON.parse(readFileSync(new URL('../firebase-rules.json', import.meta.url), 'utf8')).rules;

test('friendCodes.$code: create-only-if-absent + delete-only-on-existing write rule', () => {
  const w = rules.friendCodes?.$code?.['.write'];
  assert.ok(w, 'friendCodes.$code..write missing');
  assert.ok(w.includes('!data.exists()'), 'create must be gated on absence (no hijacking live codes)');
  assert.ok(w.includes("newData.child('uid').val() === auth.uid"), 'codes must point at their creator');
  assert.ok(w.includes('!newData.exists()'), 'existing codes must only accept deletion');
  assert.ok(w.includes('auth != null'), 'must require auth');
});

test('friendCodes.$code: createdAt is the server sentinel, fields whitelisted', () => {
  const node = rules.friendCodes?.$code;
  assert.equal(node?.createdAt?.['.validate'], 'newData.val() === now',
    'createdAt must validate === now (ServerValue.TIMESTAMP only)');
  assert.equal(node?.$other?.['.validate'], false, 'needs the strict $other catch-all');
  assert.ok(node?.uid?.['.validate']?.includes('isString'));
  assert.ok(node?.name?.['.validate']?.includes('length <= 20'),
    'code name cap must match the score-row name cap (20)');
});

test('users.$uid.friends.$friendUid: the mutual-write exception exists', () => {
  const node = rules.users?.$uid?.friends?.$friendUid;
  assert.ok(node, 'users.$uid.friends.$friendUid missing');
  const w = node['.write'];
  assert.ok(w.includes('auth.uid === $uid'), 'owner writes');
  assert.ok(w.includes('auth.uid === $friendUid'),
    'mutual exception: the friend may write/delete THEIR OWN key in another list');
  assert.ok(w.includes('auth != null'));
});

test('users.$uid.friends.$friendUid: no self-friendship, sentinel timestamp, whitelist', () => {
  const node = rules.users.$uid.friends.$friendUid;
  assert.ok(node['.validate'].includes('$friendUid !== $uid'), 'self-add must be rejected');
  assert.equal(node.addedAt?.['.validate'], 'newData.val() === now');
  assert.ok(node.name?.['.validate']?.includes('length <= 20'));
  assert.equal(node.$other?.['.validate'], false, 'needs the strict $other catch-all');
});

test('users.$uid keeps its strict shape: friends is a whitelisted child, reads stay owner-only', () => {
  const u = rules.users?.$uid;
  assert.equal(u['.read'], 'auth != null && auth.uid === $uid',
    'friend lists must NOT become readable by others');
  assert.equal(u.$other?.['.validate'], false,
    'users $other catch-all must survive (it is what forces explicit children)');
  assert.ok(u.friends, 'friends child must be explicitly declared (else $other rejects it)');
});
