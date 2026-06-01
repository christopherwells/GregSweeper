// Leaderboard hate-speech filter. Security-relevant: a regression that
// stops catching slurs lets them onto the public leaderboard, and one
// that over-matches scrubs innocent names. Slur strings are pulled from
// the existing content-warned module (hateSpeechTerms.js) rather than
// hardcoded here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { containsHateSpeech, normalizeForMatch } = await import('../src/logic/nameFilter.js');
const { HATE_SPEECH_TERMS_CLIENT_SAFE } = await import('../src/logic/hateSpeechTerms.js');

test('every client-safe slur term is caught by the filter', () => {
  assert.ok(HATE_SPEECH_TERMS_CLIENT_SAFE.length > 0, 'term list should be non-empty');
  for (const term of HATE_SPEECH_TERMS_CLIENT_SAFE) {
    assert.equal(containsHateSpeech(term), true, `filter missed its own term "${term}"`);
    // Also catch it embedded mid-name.
    assert.equal(containsHateSpeech('xX' + term + '99'), true, `filter missed embedded "${term}"`);
  }
});

test('leetspeak / separator evasions are normalized and caught', () => {
  // Derive an obfuscated variant from a real term WITHOUT hardcoding a
  // slur: reverse the normalizer's leetspeak map on the first term.
  const reverseLeet = { o: '0', i: '1', e: '3', a: '4', s: '5', t: '7', b: '8', g: '9' };
  const term = HATE_SPEECH_TERMS_CLIENT_SAFE[0];
  const leet = term.split('').map(ch => reverseLeet[ch] || ch).join('');
  assert.equal(containsHateSpeech(leet), true, `leetspeak "${leet}" of "${term}" should be caught`);
  // Separators stripped: insert dashes/spaces between every letter.
  const spaced = term.split('').join('-');
  assert.equal(containsHateSpeech(spaced), true, `separator-evasion "${spaced}" should be caught`);
  // 3+ repeated letters collapse to 2 (still contains the base term).
  const stretched = term.replace(term[0], term[0].repeat(4));
  assert.equal(containsHateSpeech(stretched), true, `repeat-stretch "${stretched}" should be caught`);
});

test('innocent names that COLLIDE with slur substrings are NOT flagged', () => {
  // Documented must-not-flag cases (CLAUDE.md): the client-safe list is
  // the low-collision subset specifically so these pass.
  for (const ok of ['Nigeria', 'Pakistani', 'RaccoonKing', 'SanDiego', 'Fagan', 'Chris', 'Kate', 'HellRaiser']) {
    assert.equal(containsHateSpeech(ok), false, `innocent name "${ok}" was wrongly flagged`);
  }
});

test('empty / non-string input is safe and unflagged', () => {
  assert.equal(containsHateSpeech(''), false);
  assert.equal(containsHateSpeech(null), false);
  assert.equal(containsHateSpeech(undefined), false);
  assert.equal(normalizeForMatch(42), '');
});

test('normalizeForMatch lowercases, maps leet, strips non-letters, collapses repeats', () => {
  assert.equal(normalizeForMatch('H3LL0-W0RLD'), 'helloworld');
  assert.equal(normalizeForMatch('aaaa'), 'aa');      // 4 → 2
  assert.equal(normalizeForMatch('Ab!!cd'), 'abiicd'); // each '!' → 'i'
});
