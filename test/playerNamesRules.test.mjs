// playerNames/{uid} rules structure contract.
//
// playerNames is the world-readable canonical name every leaderboard JOINS
// against by uid, so a Settings name change shows on every past record. Two
// things must hold: (1) it is world-READABLE (else the join reads nothing and
// every row silently falls back to its frozen stored name), and (2) unlike the
// write-once leaderboard rows, the owner can OVERWRITE their own node — that
// mutability is exactly what makes a name change propagate. This pins the read,
// the owner-only-and-not-write-once write, the name validation, and the strict
// $other guard.
//
// Run: node --test test/playerNamesRules.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rules = JSON.parse(readFileSync(new URL('../firebase-rules.json', import.meta.url), 'utf8')).rules;
const node = rules.playerNames;
const entry = node?.['$uid'];

test('playerNames is world-readable (the join needs it)', () => {
  assert.ok(node, 'playerNames block missing');
  assert.equal(node['.read'], true, 'must be world-readable or the name join reads nothing');
});

test('a uid entry is owner-writable and NOT write-once (name changes must overwrite)', () => {
  assert.ok(entry, 'playerNames/$uid block missing');
  const w = entry['.write'];
  assert.ok(w.includes('auth.uid === $uid'), 'only the owner may write their own name');
  assert.ok(!w.includes('!data.exists()'),
    'must NOT be write-once — a name change has to overwrite the existing node');
});

test('name is validated like the leaderboard rows (string, 1..20, no HTML/@ chars)', () => {
  const v = entry.name?.['.validate'];
  assert.ok(v, 'name child must be validated');
  assert.ok(v.includes('newData.isString()'));
  assert.ok(v.includes('<= 20'), 'max 20 chars');
  assert.ok(v.includes('>= 1'), 'non-empty');
  assert.ok(v.includes('[^<>&'), 'rejects the Firebase-hostile / injection chars the other name rules reject');
});

test('name is the one required child, and the node is nullable (deletable)', () => {
  const v = entry['.validate'];
  assert.ok(v.includes("'name'"), 'name is required when the node is present');
  assert.ok(v.includes('newData.val() === null'), 'a null (delete) is allowed');
});

test('updatedAt, when present, must be the server clock', () => {
  assert.ok(entry.updatedAt?.['.validate']?.includes('newData.val() === now'),
    'updatedAt must be the server sentinel, not a client Date.now()');
});

test('the entry rejects extra keys (strict $other)', () => {
  assert.equal(entry.$other?.['.validate'], false);
});
