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
  INVITE_SNOOZE_MS, INVITE_STATES, snoozeUntilFrom,
  inviteState, inviteShouldPopUp, partitionInvites,
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

// ── Invites: three answers, all reversible ──────────────────────────────

const NOW = 1750000000000;
const inv = (over = {}) => ({ matchId: 'm1', from: 'friend', code: 'K7XPQ4', sentAt: NOW, ...over });

test('an unanswered invite is pending and pops up', () => {
  assert.equal(inviteState(inv(), NOW), 'pending');
  assert.equal(inviteShouldPopUp(inv(), NOW), true);
});

test('"Later" means 24 hours, then it asks again (his ruling)', () => {
  assert.equal(INVITE_SNOOZE_MS, 86400000);
  const snoozed = inv({ state: 'snoozed', snoozedUntil: snoozeUntilFrom(NOW) });
  // Quiet for the whole day...
  assert.equal(inviteState(snoozed, NOW), 'snoozed');
  assert.equal(inviteShouldPopUp(snoozed, NOW + INVITE_SNOOZE_MS - 1), false);
  // ...and then it is a live question again, which is what makes it a
  // REMINDER rather than a dismissal.
  assert.equal(inviteState(snoozed, NOW + INVITE_SNOOZE_MS), 'pending');
  assert.equal(inviteShouldPopUp(snoozed, NOW + INVITE_SNOOZE_MS), true);
});

test('REGRESSION: declining is a STATE, never a deletion', () => {
  // His ruling makes "I don't want to play that" reviewable and reversible.
  // A deleted invite could not appear in the list at all, so the whole
  // change-your-mind surface would be impossible to honor.
  const declined = inv({ state: 'declined' });
  assert.equal(inviteState(declined, NOW), 'declined');
  assert.equal(inviteShouldPopUp(declined, NOW), false,
    'a turned-down invite must never interrupt again');
  // Still listed, so it can be reopened.
  assert.equal(partitionInvites([declined], NOW).declined.length, 1);
});

test('declining outlasts the snooze window: it never comes back on a timer', () => {
  // A previously-snoozed invite that was then declined must stay declined once
  // its old deadline passes, rather than the stale snoozedUntil resurrecting
  // it. Checked well past the snooze but still inside the match's own life,
  // since beyond that everything is expired for a different reason.
  const declined = inv({ state: 'declined', snoozedUntil: NOW + 1000 });
  assert.equal(inviteState(declined, NOW + INVITE_SNOOZE_MS * 5), 'declined');
  assert.equal(inviteShouldPopUp(declined, NOW + INVITE_SNOOZE_MS * 5), false);
});

test('an invite past its match\'s seven days is expired, whatever its state', () => {
  for (const state of [undefined, 'pending', 'snoozed', 'declined']) {
    assert.equal(inviteState(inv({ state }), NOW + MATCH_TTL_MS), 'expired');
  }
  assert.equal(inviteState(null, NOW), 'expired');
});

test('an unknown or missing state reads as PENDING, never as answered', () => {
  // Absence of an answer is not an answer. Reading a corrupt state as
  // "declined" would silently swallow a real invite.
  for (const state of [undefined, null, '', 'garbage', 42]) {
    assert.equal(inviteState(inv({ state }), NOW), 'pending', `${String(state)} must read pending`);
  }
  // A 'snoozed' marker with no usable deadline is pending too, rather than
  // quiet forever.
  assert.equal(inviteState(inv({ state: 'snoozed' }), NOW), 'pending');
  assert.equal(inviteState(inv({ state: 'snoozed', snoozedUntil: 'soon' }), NOW), 'pending');
});

test('partitionInvites sorts newest first and drops only the expired', () => {
  const list = [
    inv({ matchId: 'old', sentAt: NOW - 5000 }),
    inv({ matchId: 'new', sentAt: NOW }),
    inv({ matchId: 'later', sentAt: NOW, state: 'snoozed', snoozedUntil: NOW + 10 }),
    inv({ matchId: 'no', sentAt: NOW, state: 'declined' }),
    inv({ matchId: 'gone', sentAt: NOW - MATCH_TTL_MS }),
  ];
  const parts = partitionInvites(list, NOW);
  assert.deepEqual(parts.pending.map((i) => i.matchId), ['new', 'old']);
  assert.deepEqual(parts.snoozed.map((i) => i.matchId), ['later']);
  assert.deepEqual(parts.declined.map((i) => i.matchId), ['no']);
  assert.equal(JSON.stringify(parts).includes('gone'), false, 'expired invites are dropped');
});

test('partitionInvites survives garbage rather than throwing', () => {
  assert.deepEqual(partitionInvites(null, NOW), { pending: [], snoozed: [], declined: [] });
  assert.deepEqual(partitionInvites([null, undefined], NOW), { pending: [], snoozed: [], declined: [] });
});

test('rules parity: the invite states the client writes are the states the rules allow', () => {
  const v = rules.users?.$uid?.matchInvites?.$matchId?.state?.['.validate'];
  assert.ok(v, 'matchInvites.state has no rule, so every state write would be rejected');
  for (const s of INVITE_STATES) {
    assert.ok(v.includes(s), `the rules must allow the "${s}" state the client writes`);
  }
  // And the snooze deadline cannot outlive the match it belongs to.
  const su = rules.users?.$uid?.matchInvites?.$matchId?.snoozedUntil?.['.validate'];
  assert.ok(su.includes(String(MATCH_TTL_MS)),
    'a snooze must be bounded by the match\'s own seven days');
});

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
