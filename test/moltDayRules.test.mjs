// users/{uid}/moltDay rules structure contract. The users block ends with a
// strict "$other": false, so ANY child the client writes that is not
// explicitly whitelisted makes the WHOLE progress update() fail validation and
// drop silently (the 866683d class of bug). This pins that moltDay is
// whitelisted, that its shape matches what saveProgress writes, and that the
// silent-drop guard itself is still in place.
//
// Run: node --test test/moltDayRules.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rules = JSON.parse(readFileSync(new URL('../firebase-rules.json', import.meta.url), 'utf8')).rules;
const user = rules.users?.['$uid'];

test('users block still has the strict $other guard (why moltDay must be whitelisted)', () => {
  assert.ok(user, 'users/$uid block missing');
  assert.equal(user.$other?.['.validate'], false,
    'the $other:false catch-all is what silently drops an unwhitelisted field — it must stay');
});

test('moltDay is whitelisted, optional, and nullable', () => {
  const node = user.moltDay;
  assert.ok(node, 'moltDay must be whitelisted under users/$uid or the whole progress write drops');
  assert.ok(node['.validate'].includes("'banked'"), 'banked is the one required child');
  assert.ok(node['.validate'].includes('newData.val() === null'), 'a null moltDay is allowed');
  // Optional: a gimmick-free streak still saves with no moltDay child.
  assert.ok(!user['.validate'] || !String(user['.validate']).includes("'moltDay'"),
    'moltDay must not be a REQUIRED child of users (older accounts have none)');
});

test('banked is bounded to the cap (0..2)', () => {
  const v = user.moltDay?.banked?.['.validate'];
  assert.ok(v.includes('newData.isNumber()'));
  assert.ok(v.includes('>= 0') && v.includes('<= 2'), 'banked must be a 0..2 integer count');
});

test('lastUse pins the spend record shape with a strict whitelist', () => {
  const lu = user.moltDay?.lastUse;
  assert.ok(lu, 'lastUse must be whitelisted');
  assert.ok(lu['.validate'].includes("'date'"), 'lastUse requires a date when present');
  assert.ok(lu['.validate'].includes('newData.val() === null'), 'lastUse may be null (no spend yet)');
  assert.ok(lu.date?.['.validate']?.includes('length === 10'), 'date is a YYYY-MM-DD string');
  assert.ok(lu.streakKept?.['.validate']?.includes('newData.isNumber()'), 'streakKept is a number');
  assert.ok(lu.covered?.$idx?.['.validate']?.includes('length === 10'),
    'covered is an array of YYYY-MM-DD date strings');
  assert.equal(lu.$other?.['.validate'], false, 'lastUse rejects extra keys');
});

test('moltDay rejects extra keys', () => {
  assert.equal(user.moltDay?.$other?.['.validate'], false);
});

test('every field saveProgress writes under moltDay is accounted for by the rule', () => {
  // The exact object winLossHandler builds: { banked, lastUse: {date, covered, streakKept} }.
  // Each key must resolve to a rule node (or the strict $other would drop the write).
  const moltNode = user.moltDay;
  for (const k of ['banked', 'lastUse']) {
    assert.ok(moltNode[k], `moltDay.${k} must be whitelisted`);
  }
  for (const k of ['date', 'covered', 'streakKept']) {
    assert.ok(moltNode.lastUse[k], `moltDay.lastUse.${k} must be whitelisted`);
  }
});
