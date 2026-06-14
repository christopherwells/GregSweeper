// cruxes/{date} rules structure contract. The crux teaser is precomputed
// (write-once at generation) and world-readable so the ?crux= share route
// works logged-out. The payload shape must stay pinned: a plain daily date
// key (never the weekly suffix), the required teaser fields, the
// server-sentinel timestamp, and a strict $other catch-all so no
// unvalidated field can ride in. Companion to test/cruxExtract.test.mjs.
//
// Run: node --test test/cruxRules.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rules = JSON.parse(readFileSync(new URL('../firebase-rules.json', import.meta.url), 'utf8')).rules;

test('cruxes: world-readable, write-once, plain-daily-date key', () => {
  const node = rules.cruxes;
  assert.ok(node, 'cruxes block missing');
  assert.equal(node['.read'], true, 'the teaser route reads logged-out — must be public');
  const w = node.$date?.['.write'];
  assert.ok(w?.includes('auth != null'), 'write requires auth');
  assert.ok(w?.includes('!data.exists()'), 'crux is write-once (like the canonical board)');
  const dateRe = node.$date?.['.validate'];
  assert.ok(dateRe.includes('\\d{4}-\\d{2}-\\d{2}'), 'must validate a YYYY-MM-DD key');
  assert.ok(!dateRe.includes('weekly_first'),
    'crux date key is daily-only (the teaser never shows weekly)');
});

test('cruxes.$date: required teaser fields are pinned', () => {
  const v = rules.cruxes?.$date?.['.validate'];
  for (const field of ['rows', 'cols', 'cells', 'answer', 'sources', 'tier', 'writtenAt']) {
    assert.ok(v.includes(`'${field}'`), `${field} must be a required child`);
  }
});

test('cruxes.$date: tier bounded 1..3, answer is an {r,c} pair', () => {
  const node = rules.cruxes?.$date;
  assert.ok(node.tier?.['.validate']?.includes('>= 1 && newData.val() <= 3'),
    'tier must be a 1..3 technique level');
  const ans = node.answer;
  assert.ok(ans?.['.validate']?.includes("'r'") && ans['.validate'].includes("'c'"),
    'answer must require r and c');
  assert.equal(ans?.$other?.['.validate'], false, 'answer must reject extra keys');
});

test('cruxes.$date: server-sentinel timestamp + strict whitelist', () => {
  const node = rules.cruxes?.$date;
  assert.equal(node.writtenAt?.['.validate'], 'newData.val() === now',
    'writtenAt must be the ServerValue.TIMESTAMP sentinel only');
  assert.equal(node.$other?.['.validate'], false,
    'strict $other catch-all must survive so no unvalidated field rides in');
});
