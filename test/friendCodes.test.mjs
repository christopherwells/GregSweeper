// Friend-code logic + the code↔rules parity contract. The rules enforce
// expiry server-side (read gate) and code shape (validate regex); this
// suite pins the pure module AND asserts the two stay character-equal,
// so neither side can drift without failing CI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CODE_ALPHABET, CODE_LENGTH, CODE_TTL_MS, CODE_REGEX,
  generateCode, normalizeCode, isCodeFresh, codeMsRemaining,
} from '../src/logic/friendCodes.js';

const rules = JSON.parse(readFileSync(new URL('../firebase-rules.json', import.meta.url), 'utf8')).rules;

test('generator: 500 draws are 6 chars, unambiguous alphabet, regex-valid', () => {
  for (let i = 0; i < 500; i++) {
    const code = generateCode();
    assert.equal(code.length, CODE_LENGTH);
    assert.match(code, CODE_REGEX);
    for (const ch of code) {
      assert.ok(!'0O1IL'.includes(ch), `ambiguous char ${ch} in ${code}`);
      assert.ok(CODE_ALPHABET.includes(ch));
    }
  }
});

test('generator: deterministic under a seeded rng', () => {
  let s = 42;
  const rng = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const a = generateCode(rng);
  s = 42;
  const b = generateCode(rng);
  assert.equal(a, b);
});

test('normalizeCode: forgiving input forms', () => {
  assert.equal(normalizeCode('k7xpq4'), 'K7XPQ4');
  assert.equal(normalizeCode('  K7X PQ4  '), 'K7XPQ4');
  assert.equal(normalizeCode('K7X-PQ4'), 'K7XPQ4');
  assert.equal(normalizeCode('K7XPQ'), null);      // too short
  assert.equal(normalizeCode('K7XPQ44'), null);    // too long
  assert.equal(normalizeCode('K7XPQ!'), null);     // bad char
  assert.equal(normalizeCode(''), null);
  assert.equal(normalizeCode(null), null);
  assert.equal(normalizeCode(42), null);
});

test('expiry boundary: fresh inside the window, expired at exactly TTL', () => {
  const t0 = 1750000000000;
  assert.equal(CODE_TTL_MS, 900000);
  assert.equal(isCodeFresh(t0, t0 + CODE_TTL_MS - 1), true);   // 14:59.999
  assert.equal(isCodeFresh(t0, t0 + CODE_TTL_MS), false);      // exactly 15:00
  assert.equal(isCodeFresh(t0, t0 + CODE_TTL_MS + 1), false);
  assert.equal(isCodeFresh(undefined, t0), false);
  assert.equal(codeMsRemaining(t0, t0 + 600000), 300000);
  assert.equal(codeMsRemaining(t0, t0 + CODE_TTL_MS + 5), 0);
});

test('rules parity: the friendCodes read gate carries the same TTL', () => {
  const read = rules.friendCodes?.$code?.['.read'];
  assert.ok(read, 'friendCodes.$code..read missing from firebase-rules.json');
  assert.ok(read.includes(`now - ${CODE_TTL_MS}`),
    `rules read gate (${read}) must embed CODE_TTL_MS=${CODE_TTL_MS}`);
});

test('rules parity: the $code validate regex matches CODE_REGEX exactly', () => {
  const validate = rules.friendCodes?.$code?.['.validate'];
  assert.ok(validate, 'friendCodes.$code..validate missing');
  const m = validate.match(/\$code\.matches\(\/(.+?)\/\)/);
  assert.ok(m, 'no $code.matches(...) in the validate rule');
  assert.equal(m[1], CODE_REGEX.source,
    'rules code pattern and CODE_REGEX drifted apart');
});
