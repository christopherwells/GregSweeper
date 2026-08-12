// Match identifiers: the invite code, the seven-day life, the join verdict,
// and the fit-row key. Plus the JS<->rules parity that stops any of them
// drifting from firebase-rules.json, which IS the deployed ruleset.
//
// REGRESSION (the 866683d class): a row key that fails the daily/dailyMeta
// `$date` regex drops the WHOLE write with no client error. That is the
// failure mode that froze stats for two weeks, and extending the regex to
// admit `match_<hash>` puts a new key shape in front of it, so both halves of
// the shape are pinned here in BOTH directions: what must be accepted, and
// what must still be refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MATCH_TTL_MS, MATCH_PLAYER_MAX, MATCH_ROW_KEY_REGEX, CODE_REGEX,
  matchRowKey, isMatchRowKey, matchIsExpired, matchDaysRemaining, planMatchJoin,
  generateCode, normalizeCode,
} from '../src/logic/matchCodes.js';
import { CODE_TTL_MS } from '../src/logic/friendCodes.js';

const rules = JSON.parse(readFileSync(new URL('../firebase-rules.json', import.meta.url), 'utf8')).rules;

// A live match node, minimal but structurally real.
const nodeWith = (players, createdAt = 1750000000000) => ({
  host: 'uid-host',
  rules: { count: 3 },
  boards: [{ seed: 'a' }, { seed: 'b' }, { seed: 'c' }],
  createdAt,
  expiresAt: createdAt + MATCH_TTL_MS,
  players,
});

// ── The lifetime ────────────────────────────────────────────────────────

test('one lifetime, seven days, for the code and the match alike', () => {
  assert.equal(MATCH_TTL_MS, 604800000);
  // His ruling was explicitly that a friend code's fifteen minutes is WRONG
  // for a match. If these two ever collapse to one number, that ruling has
  // been undone by accident.
  assert.notEqual(MATCH_TTL_MS, CODE_TTL_MS);
  assert.ok(MATCH_TTL_MS > CODE_TTL_MS);
});

test('expiry boundary: live up to the instant, expired at it', () => {
  const t0 = 1750000000000;
  assert.equal(matchIsExpired(t0 + MATCH_TTL_MS, t0), false);
  assert.equal(matchIsExpired(t0 + MATCH_TTL_MS, t0 + MATCH_TTL_MS - 1), false);
  assert.equal(matchIsExpired(t0 + MATCH_TTL_MS, t0 + MATCH_TTL_MS), true);
});

test('a missing or malformed expiry reads as EXPIRED, never as forever', () => {
  // Absence of a lifetime is not an unlimited one: a node whose deadline
  // cannot be established is one nothing should be written into.
  for (const bad of [undefined, null, NaN, Infinity, '2026-08-19', {}]) {
    assert.equal(matchIsExpired(bad, 1750000000000), true, `${String(bad)} must read expired`);
  }
});

test('days remaining rounds up, and floors at zero', () => {
  const t0 = 1750000000000;
  assert.equal(matchDaysRemaining(t0 + MATCH_TTL_MS, t0), 7);
  assert.equal(matchDaysRemaining(t0 + 86400000 + 1, t0), 2);   // a day and a moment
  assert.equal(matchDaysRemaining(t0 - 1, t0), 0);
});

// ── The join verdict ────────────────────────────────────────────────────

test('planMatchJoin: a free slot in a live match is a join', () => {
  assert.equal(planMatchJoin({ match: nodeWith({}), uid: 'me', now: 1750000000000 }), 'join');
});

test('planMatchJoin: a player already in it RESUMES, even past expiry', () => {
  // Deliberate: his ruling freezes WRITES at seven days and leaves reads open.
  // Someone already in the match must still be able to open it and read where
  // everyone landed; the write gate is what refuses their next result.
  const late = 1750000000000 + MATCH_TTL_MS + 1;
  const node = nodeWith({ me: { name: 'Me', joinedAt: 1 } });
  assert.equal(planMatchJoin({ match: node, uid: 'me', now: late }), 'resume');
});

test('planMatchJoin: an expired match refuses a NEW player', () => {
  const late = 1750000000000 + MATCH_TTL_MS + 1;
  assert.equal(planMatchJoin({ match: nodeWith({}), uid: 'me', now: late }), 'expired');
});

test('planMatchJoin: a full match refuses, and the cap is the one constant', () => {
  const players = {};
  for (let i = 0; i < MATCH_PLAYER_MAX; i++) players[`u${i}`] = { name: `P${i}`, joinedAt: 1 };
  assert.equal(planMatchJoin({ match: nodeWith(players), uid: 'me', now: 1750000000000 }), 'full');
  // One short is still a join, so the cap is exact rather than off by one.
  delete players.u0;
  assert.equal(planMatchJoin({ match: nodeWith(players), uid: 'me', now: 1750000000000 }), 'join');
});

test('planMatchJoin: a node with no boards is MISSING, not joinable', () => {
  // Half a node is the same thing as no node to a player, and joining one
  // would install a match with nothing to play.
  for (const bad of [null, undefined, {}, { boards: [] }, { boards: 'x' }]) {
    assert.equal(planMatchJoin({ match: bad, uid: 'me', now: 1 }), 'missing');
  }
});

// ── The fit-row key ─────────────────────────────────────────────────────

test('matchRowKey is deterministic, and distinct per seed', () => {
  const a = matchRowKey('match:rect|5x5|3|:1:5');
  assert.equal(a, matchRowKey('match:rect|5x5|3|:1:5'));
  assert.match(a, MATCH_ROW_KEY_REGEX);
  assert.notEqual(a, matchRowKey('match:rect|5x5|3|:1:6'));
  // A one-character difference must not collide: the whole point of the key
  // is that two boards never pool their rows under one dailyMeta.
  assert.notEqual(matchRowKey('a'), matchRowKey('b'));
});

test('matchRowKey spreads: 920 library-shaped seeds produce 920 distinct keys', () => {
  // Non-vacuity for the collision argument. The real library is ~920 boards,
  // so a hash that collided at this scale would silently merge two boards'
  // score rows under one meta, and nothing downstream would notice.
  const keys = new Set();
  for (const shape of ['rect', 'hex', '4.8.8', 'cairo', 'rhombille', 'floret', 'deltoidal']) {
    for (let i = 0; i < 140; i++) {
      keys.add(matchRowKey(`match:${shape}|9x9|12|walls:${i}:${i * 7}`));
    }
  }
  assert.equal(keys.size, 980);
});

test('matchRowKey is Firebase-key-safe for any seed it is handed', () => {
  // Firebase refuses . $ # [ ] / and control characters in a key. The hash
  // makes that true by construction, which is exactly why the raw seed (which
  // carries | and :) is not the key.
  for (const seed of ['a/b', 'a.b', 'a#b', 'a[b]', 'a$b', '', null, undefined, 'x'.repeat(500)]) {
    const key = matchRowKey(seed);
    assert.match(key, MATCH_ROW_KEY_REGEX, `${String(seed)} produced ${key}`);
  }
});

test('isMatchRowKey refuses everything that is not one', () => {
  assert.equal(isMatchRowKey(matchRowKey('x')), true);
  for (const bad of ['2026-08-12', '2026-08-04_weekly_first', 'match_', 'match_zzzz',
    'match_0123456789ABCDEF', 'match_0123456789abcde', 'match_0123456789abcdef0',
    '', null, undefined, 42]) {
    assert.equal(isMatchRowKey(bad), false, `${String(bad)} must not read as a match key`);
  }
});

// ── Parity with the deployed ruleset ────────────────────────────────────

test('rules parity: matchCodes carries the SAME seven-day TTL', () => {
  const read = rules.matchCodes?.$code?.['.read'];
  assert.ok(read, 'matchCodes.$code..read missing from firebase-rules.json');
  assert.ok(read.includes(`now - ${MATCH_TTL_MS}`),
    `rules read gate (${read}) must embed MATCH_TTL_MS=${MATCH_TTL_MS}`);
});

test('rules parity: the match expiry gates carry the SAME seven days', () => {
  // Both write gates derive the deadline from the server-stamped createdAt
  // rather than a stored expiresAt, because a client clock running fast would
  // otherwise fail to create a match at all.
  const gates = [
    rules.matches?.$matchId?.playerCount?.['.write'],
    rules.matches?.$matchId?.players?.$uid?.['.write'],
  ];
  for (const gate of gates) {
    assert.ok(gate, 'a match write gate is missing');
    assert.ok(gate.includes(String(MATCH_TTL_MS)),
      `write gate (${gate}) must embed MATCH_TTL_MS=${MATCH_TTL_MS}`);
    assert.ok(gate.includes('createdAt'),
      'the deadline must derive from the SERVER createdAt, never a client value');
  }
});

test('rules parity: the $code regex matches CODE_REGEX exactly', () => {
  const validate = rules.matchCodes?.$code?.['.validate'];
  const m = validate.match(/\$code\.matches\(\/(.+?)\/\)/);
  assert.ok(m, 'no $code.matches(...) in the matchCodes validate rule');
  assert.equal(m[1], CODE_REGEX.source, 'rules code pattern and CODE_REGEX drifted apart');
});

test('rules parity: the match player cap is the one constant', () => {
  const v = rules.matches?.$matchId?.playerCount?.['.validate'];
  assert.ok(v.includes(`<= ${MATCH_PLAYER_MAX}`),
    `playerCount validate (${v}) must embed MATCH_PLAYER_MAX=${MATCH_PLAYER_MAX}`);
});

// ── The key regex, in BOTH directions ───────────────────────────────────

// The rules regex is a string; exercise it as a real JS regex so the test is
// asserting behavior rather than the presence of a substring.
function keyRegexOf(validate) {
  const m = validate.match(/\$date\.matches\(\/(.+?)\/\)/);
  assert.ok(m, `no $date.matches(...) in: ${validate}`);
  return new RegExp(m[1].replace(/\\\\/g, '\\'));
}

const ACCEPTED = ['2026-08-12', '2026-01-01', '2026-08-04_weekly_first'];
const REFUSED = [
  '2026-8-12', '26-08-12', '2026-08-12_weekly', '2026-08-12_weekly_firstX',
  'match_', 'match_0123456789abcde', 'match_0123456789abcdef0',
  'match_0123456789ABCDEF', 'match_zzzzzzzzzzzzzzzz', 'matchx0123456789abcdef',
  '', 'x', '../evil', 'daily',
];

for (const [label, node] of [['daily', rules.daily.$date], ['dailyMeta', rules.dailyMeta.$date]]) {
  test(`${label} key regex still accepts every date form it accepted before`, () => {
    const re = keyRegexOf(node['.validate']);
    for (const k of ACCEPTED) {
      assert.ok(re.test(k), `${label} must still accept ${k} — widening the regex must not narrow it`);
    }
  });

  test(`${label} key regex accepts a match key, and REFUSES near misses`, () => {
    const re = keyRegexOf(node['.validate']);
    assert.ok(re.test(matchRowKey('any-seed')), `${label} must accept a real match key`);
    for (const k of REFUSED) {
      assert.equal(re.test(k), false,
        `${label} must refuse ${JSON.stringify(k)} — a key that fails drops the WHOLE write`);
    }
  });

  test(`${label} key regex agrees with MATCH_ROW_KEY_REGEX on the match form`, () => {
    // The two definitions live in different languages and files; this is the
    // assertion that keeps them one shape.
    const re = keyRegexOf(node['.validate']);
    for (const seed of ['a', 'b', 'match:hex|7x7|9|worm:3:11', 'x'.repeat(200)]) {
      const key = matchRowKey(seed);
      assert.equal(re.test(key), MATCH_ROW_KEY_REGEX.test(key));
    }
  });
}

// ── The code generator, inherited rather than re-declared ───────────────

test('the code shape is the friend code shape, one definition', () => {
  // A player reads a match code off a screen exactly the way they read a
  // friend code. Re-declaring the alphabet would let the two drift into
  // different ambiguity rules for no reason.
  for (let i = 0; i < 200; i++) {
    const code = generateCode();
    assert.match(code, CODE_REGEX);
    for (const ch of code) assert.ok(!'0O1IL'.includes(ch), `ambiguous ${ch}`);
  }
  assert.equal(normalizeCode('  k7x-pq4 '), 'K7XPQ4');
  assert.equal(normalizeCode('K7XPQ'), null);
});
