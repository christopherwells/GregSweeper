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
  matchExpiresAt,
  generateCode, normalizeCode,
  INVITE_SNOOZE_MS, INVITE_STATES, snoozeUntilFrom,
  inviteState, inviteShouldPopUp, partitionInvites, partitionMatchReview, matchResumePoint,
} from '../src/logic/matchCodes.js';
import { CODE_TTL_MS } from '../src/logic/friendCodes.js';

const rules = JSON.parse(readFileSync(new URL('../firebase-rules.json', import.meta.url), 'utf8')).rules;

// A live match node, minimal but structurally real.
// The match node EXACTLY as createMatch writes it, and as the rules permit it.
// It carries no `expiresAt`: the deadline is derived from the server-stamped
// createdAt on both sides. A fixture that invented one is what let the guest
// join break in production while this file stayed green, so the shape is
// pinned against firebase-rules.json below rather than trusted.
const nodeWith = (players, createdAt = 1750000000000) => ({
  host: 'uid-host',
  rules: { count: 3 },
  boards: [{ seed: 'a' }, { seed: 'b' }, { seed: 'c' }],
  createdAt,
  playerCount: Object.keys(players).length,
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

// ── The node shape, pinned against the rules that accept it ─────────────

test('REGRESSION: a guest can join a live match (the node carries no expiresAt)', () => {
  // THE PRODUCTION BREAK, 2026-08-12. planMatchJoin read `match.expiresAt`
  // straight off the node, and nothing writes that field: the deadline is
  // derived from the server createdAt on both the client and the rules side.
  // So every guest got matchIsExpired(undefined) === true and was told the
  // code had expired, while the HOST, who is already in `players`, returned
  // 'resume' before ever reaching the check. Both invite routes broke and
  // neither the host nor this suite could see it.
  const node = nodeWith({ 'uid-host': { name: 'Host', joinedAt: 1750000000000 } });
  assert.equal(node.expiresAt, undefined, 'the fixture must not invent the field');
  assert.equal(planMatchJoin({ match: node, uid: 'uid-guest', now: 1750000000000 }), 'join');
  // And still expires on its own createdAt, a week later.
  assert.equal(
    planMatchJoin({ match: node, uid: 'uid-guest', now: 1750000000000 + MATCH_TTL_MS }),
    'expired');
});

test('matchExpiresAt is derived, and a match with no createdAt reads as expired', () => {
  assert.equal(matchExpiresAt(1750000000000), 1750000000000 + MATCH_TTL_MS);
  for (const bad of [undefined, null, NaN, 'soon', {}]) {
    const node = { host: 'h', rules: {}, boards: [{ seed: 'a' }], players: {}, createdAt: bad };
    assert.equal(planMatchJoin({ match: node, uid: 'me', now: Date.now() }), 'expired',
      `createdAt ${String(bad)} must not read as a live match`);
  }
});

test('a fixture may not carry a field the rules would refuse', () => {
  // The guard that would have caught the break: `matches/$matchId` ends in
  // `$other: {validate:false}`, so the legal children are exactly the keys of
  // that block. A fixture outside them describes a node Firebase cannot hold,
  // and a test standing on one proves nothing about production.
  const rules = JSON.parse(readFileSync(new URL('../firebase-rules.json', import.meta.url), 'utf8'));
  const block = rules.rules.matches.$matchId;
  assert.equal(block.$other['.validate'], false, 'the whitelist must still be closed');
  const allowed = new Set(Object.keys(block).filter((k) => !k.startsWith('.') && k !== '$other'));
  assert.ok(allowed.size >= 6, `only ${allowed.size} fields parsed: the block shape moved`);
  for (const key of Object.keys(nodeWith({}))) {
    assert.ok(allowed.has(key),
      `the fixture carries "${key}", which the rules would refuse (allowed: ${[...allowed].join(', ')})`);
  }
});

// ── A finished run is not a resume ──────────────────────────────────────

test('REGRESSION: a player who FINISHED a match gets the standings, never the boards', () => {
  // His report: "why can I play the runs over again? It should save when I've
  // finished so I can't overwrite the play." Re-entering restarted at board 1
  // with an empty results array, and each posted result then overwrote the
  // real one at the same index.
  const node = nodeWith({
    me: { name: 'Me', joinedAt: 1, finishedAt: 1750000500000, results: [{ time: 30 }] },
  });
  assert.equal(planMatchJoin({ match: node, uid: 'me', now: 1750000600000 }), 'finished');
});

test('a run in progress still RESUMES, finished or not is the only difference', () => {
  const midRun = nodeWith({ me: { name: 'Me', joinedAt: 1, results: [{ time: 30 }] } });
  assert.equal(planMatchJoin({ match: midRun, uid: 'me', now: 1750000600000 }), 'resume');
  const untouched = nodeWith({ me: { name: 'Me', joinedAt: 1 } });
  assert.equal(planMatchJoin({ match: untouched, uid: 'me', now: 1750000600000 }), 'resume');
  // A malformed finishedAt is not a finish: it must not strand a live run.
  for (const bad of [null, undefined, 'yes', {}, NaN, 0, -1]) {
    const odd = nodeWith({ me: { name: 'Me', joinedAt: 1, finishedAt: bad } });
    assert.equal(planMatchJoin({ match: odd, uid: 'me', now: 1750000600000 }), 'resume',
      `finishedAt ${String(bad)} must not read as finished`);
  }
});

test('finished beats expiry: reads stay open forever (his ruling)', () => {
  const late = 1750000000000 + MATCH_TTL_MS * 10;
  const node = nodeWith({ me: { name: 'Me', joinedAt: 1, finishedAt: 2 } });
  assert.equal(planMatchJoin({ match: node, uid: 'me', now: late }), 'finished');
});

// ── The three places (his 2026-08-13 design) ────────────────────────────

const inviteAt = (id, over = {}) => ({ matchId: id, from: 'friend', code: 'ABC234', sentAt: 1750000000000, ...over });
const myMatch = (id, over = {}) => ({
  matchId: id, joinedAt: over.joinedAt ?? 1750000000000, code: 'ABC234',
  node: nodeWith(over.players ?? { me: { name: 'Me', joinedAt: 1 } }),
});
const REVIEW_NOW = 1750000100000;

test('the three places split by what each one is FOR', () => {
  const v = partitionMatchReview({
    invites: [
      inviteAt('m-pending'),
      inviteAt('m-snoozed', { state: 'snoozed', snoozedUntil: REVIEW_NOW + 1000 }),
      inviteAt('m-declined', { state: 'declined' }),
    ],
    matches: [
      myMatch('m-running'),
      myMatch('m-done', { players: { me: { name: 'Me', joinedAt: 1, finishedAt: 1750000050000 } } }),
    ],
    uid: 'me',
    now: REVIEW_NOW,
  });
  // Waiting on you: both open invites, plus the run you have not finished.
  assert.deepEqual(v.active.map((e) => e.kind), ['invite', 'invite', 'match']);
  assert.deepEqual(v.active.map((e) => e.invite?.matchId ?? e.match.matchId),
    ['m-pending', 'm-snoozed', 'm-running']);
  // Results of old games.
  assert.deepEqual(v.finished.map((e) => e.match.matchId), ['m-done']);
  // Turned down, still diggable.
  assert.deepEqual(v.declined.map((e) => e.invite.matchId), ['m-declined']);
});

test('a declined invite SCRUBS ITSELF when the code expires (his ruling)', () => {
  const stale = inviteAt('m-old', { state: 'declined', sentAt: REVIEW_NOW - MATCH_TTL_MS - 1 });
  const fresh = inviteAt('m-new', { state: 'declined' });
  const v = partitionMatchReview({ invites: [stale, fresh], matches: [], uid: 'me', now: REVIEW_NOW });
  assert.deepEqual(v.declined.map((e) => e.invite.matchId), ['m-new'],
    'an expired refusal must drop out of the list on its own');
  // And it comes back out separately, so the caller can delete the node too
  // rather than leaving it to accumulate forever in the player's own list.
  assert.deepEqual(v.expired.map((i) => i.matchId), ['m-old']);
});

test('an expired PENDING invite scrubs the same way', () => {
  // Nothing can be done with it either: the match behind it takes no joins.
  const v = partitionMatchReview({
    invites: [inviteAt('m-old', { sentAt: REVIEW_NOW - MATCH_TTL_MS - 1 })],
    matches: [], uid: 'me', now: REVIEW_NOW,
  });
  assert.deepEqual(v.active, []);
  assert.deepEqual(v.expired.map((i) => i.matchId), ['m-old']);
});

test('finished is decided by the same rule the join verdict uses', () => {
  // If these two disagreed, a run could sit under "results" and still hand
  // the player its boards, which is the overwrite he reported.
  for (const bad of [null, undefined, 'yes', {}, NaN, 0, -1]) {
    const row = myMatch('m', { players: { me: { name: 'Me', joinedAt: 1, finishedAt: bad } } });
    const v = partitionMatchReview({ invites: [], matches: [row], uid: 'me', now: REVIEW_NOW });
    assert.equal(v.finished.length, 0, `finishedAt ${String(bad)} must not read as finished`);
    assert.equal(v.active.length, 1);
    assert.equal(planMatchJoin({ match: row.node, uid: 'me', now: REVIEW_NOW }), 'resume',
      'and the join verdict must agree');
  }
  const done = myMatch('m', { players: { me: { name: 'Me', joinedAt: 1, finishedAt: 99 } } });
  assert.equal(partitionMatchReview({ invites: [], matches: [done], uid: 'me', now: REVIEW_NOW }).finished.length, 1);
  assert.equal(planMatchJoin({ match: done.node, uid: 'me', now: REVIEW_NOW }), 'finished');
});

test('an EXPIRED unfinished run rests in finished, marked ended (PR 6)', () => {
  // Past the seven days the rules refuse every result write, so "carry on
  // with this" is an intention the server no longer honors. The run moves to
  // the finished place with `ended` set, where the row can say the run
  // closed at board N; an unexpired unfinished run stays under active.
  const old = {
    matchId: 'm-stale', joinedAt: 5, code: 'ABC234',
    node: nodeWith({ me: { name: 'Me', joinedAt: 1, results: [{ time: 30 }] } },
      REVIEW_NOW - MATCH_TTL_MS - 1),
  };
  const live = myMatch('m-live');
  const v = partitionMatchReview({ invites: [], matches: [old, live], uid: 'me', now: REVIEW_NOW });
  assert.deepEqual(v.active.map((e) => e.match.matchId), ['m-live']);
  assert.deepEqual(v.finished.map((e) => [e.match.matchId, e.ended]), [['m-stale', true]]);
});

test('solo records interleave into finished by date, every entry stamped `at` (PR 6)', () => {
  const shared = myMatch('m-done', {
    joinedAt: 2000,
    players: { me: { name: 'Me', joinedAt: 1, finishedAt: 1750000050000 } },
  });
  const soloNew = { finishedAt: 3000, rules: { count: 1 }, boards: [{ seed: 's' }], results: [{ time: 9 }] };
  const soloOld = { finishedAt: 1000, rules: { count: 1 }, boards: [{ seed: 't' }], results: [{ time: 9 }] };
  const v = partitionMatchReview({
    invites: [], matches: [shared], uid: 'me', now: REVIEW_NOW,
    solo: [soloNew, soloOld],
  });
  assert.deepEqual(v.finished.map((e) => e.kind), ['solo', 'match', 'solo'],
    'newest first across BOTH kinds, by the shared `at` stamp');
  assert.ok(v.finished.every((e) => Number.isFinite(e.at)),
    'every finished entry must be groupable by its own at');
  // Solo records never reach the other places.
  assert.deepEqual(v.active, []);
  assert.deepEqual(v.declined, []);
});

test('an unreadable match is dropped, never guessed at', () => {
  const v = partitionMatchReview({
    invites: [],
    matches: [{ matchId: 'm', joinedAt: 1, node: null }, { matchId: 'n' }],
    uid: 'me', now: REVIEW_NOW,
  });
  assert.deepEqual(v.active, []);
  assert.deepEqual(v.finished, []);
});

test('each place is newest first, and a signed-out player still gets a list', () => {
  const v = partitionMatchReview({
    invites: [],
    matches: [myMatch('old', { joinedAt: 1 }), myMatch('new', { joinedAt: 9 })],
    uid: 'me', now: REVIEW_NOW,
  });
  assert.deepEqual(v.active.map((e) => e.match.matchId), ['new', 'old']);
  // No uid: nothing can be MINE, so nothing is finished, and the runs still
  // list rather than throwing.
  const anon = partitionMatchReview({
    invites: [], matches: [myMatch('m')], uid: null, now: REVIEW_NOW,
  });
  assert.equal(anon.finished.length, 0);
  assert.equal(anon.active.length, 1);
});

test('empty input yields three empty places, never undefined', () => {
  for (const args of [{}, { invites: null, matches: null, uid: null, now: REVIEW_NOW }]) {
    const v = partitionMatchReview(args);
    assert.deepEqual([v.active, v.finished, v.declined, v.expired], [[], [], [], []]);
  }
});

// ── Resuming a run keeps it (issue #317) ────────────────────────────────

test('REGRESSION: a resume carries the run forward, never restarting at board 1', () => {
  // Re-entering an unfinished shared match handed back {current: 0,
  // results: []}, so every board replayed posted under its index and
  // OVERWROTE the time already in the node. Same destruction the `finished`
  // verdict stops, left in place for the unfinished case.
  const n = nodeWith({ me: { name: 'Me', joinedAt: 1,
    results: [{ time: 30, penalty: 3, strikes: 1 }, { time: 40, penalty: 0, strikes: 0 }] } });
  const r = matchResumePoint(n, 'me');
  assert.equal(r.current, 2, 'resumes at the third board, not the first');
  assert.equal(r.results.length, 3);
  assert.deepEqual(r.results[0], { time: 30, penalty: 3, strikes: 1 });
  assert.deepEqual(r.results[1], { time: 40, penalty: 0, strikes: 0 });
  assert.equal(r.results[2], undefined, 'the unplayed board stays open');
  assert.equal(planMatchJoin({ match: n, uid: 'me', now: 1750000100000 }), 'resume');
});

test('a resume fills a GAP rather than appending past it', () => {
  // A post that failed while the next one landed leaves a hole. Resuming at
  // results.length would skip it forever and the match could never complete.
  const n = nodeWith({ me: { name: 'Me', joinedAt: 1,
    results: [{ time: 30 }, null, { time: 50 }] } });
  const r = matchResumePoint(n, 'me');
  assert.equal(r.current, 1, 'resumes INTO the gap');
  assert.equal(r.results[2].time, 50, 'and the later result is kept');
});

test('an untouched or unknown player resumes as a fresh run', () => {
  for (const [node, uid] of [
    [nodeWith({ me: { name: 'Me', joinedAt: 1 } }), 'me'],
    [nodeWith({ other: { name: 'O', joinedAt: 1 } }), 'me'],
    [nodeWith({}), null],
  ]) {
    const r = matchResumePoint(node, uid);
    assert.equal(r.current, 0);
    assert.equal(r.results.filter(Boolean).length, 0);
  }
  assert.deepEqual(matchResumePoint(null, 'me'), { results: [], current: 0 });
});

test('a garbage stored result is not read as a played board', () => {
  const n = nodeWith({ me: { name: 'Me', joinedAt: 1,
    results: [{ time: 'fast' }, { time: -1 }, { time: 20 }] } });
  const r = matchResumePoint(n, 'me');
  assert.equal(r.current, 0, 'the first unusable result is where play resumes');
  assert.equal(r.results[2].time, 20);
});

test('a fully played run reports current past the last board', () => {
  const n = nodeWith({ me: { name: 'Me', joinedAt: 1,
    results: [{ time: 1 }, { time: 2 }, { time: 3 }] } });
  assert.equal(matchResumePoint(n, 'me').current, 3);
});

// ── Issue #372: the node knows WHICH, the save knows WHAT ───────────────
//
// Re-entering an unfinished shared run from Your runs rebuilds the results
// from the match NODE, which whitelists exactly {time, penalty, strikes} and
// closes with $other: false. Everything the par fit needs beyond that (par,
// bombHitEvents, wormEvents, scrolled) lives only in the local result object,
// and the rebuild used to discard it. A row then reaching the fit with
// bombHits > 0 and no events is, on the R side, the exact signature of the
// retired +10s/re-fog cohort, so it is charged LEGACY_BOMB_RATE (15s a hit)
// against a true ramped cost of 3n + 0.75n(n-1).

test('REGRESSION #372: a resume keeps the local detail for boards this device played', () => {
  const node = {
    boards: [{}, {}, {}],
    players: {
      u1: {
        results: [
          { time: 40.5, penalty: 0, strikes: 0 },
          { time: 70.2, penalty: 6.75, strikes: 3 },
        ],
      },
    },
  };
  const local = [
    { time: 40.5, par: 55, bombHitEvents: [], wormEvents: [], scrolled: false, seed: 's0' },
    { time: 70.2, par: 88, bombHitEvents: [{ t: 5, row: 1, col: 2, penalty: 3 }], wormEvents: [], scrolled: true, seed: 's1' },
  ];
  const { results, current } = matchResumePoint(node, 'u1', local);
  assert.equal(current, 2, 'the node still decides where the run resumes');
  // The node's three fields stay authoritative...
  assert.equal(results[1].time, 70.2);
  assert.equal(results[1].strikes, 3);
  assert.equal(results[1].penalty, 6.75);
  // ...and the local detail rides along, which is what stops the misfile.
  assert.equal(results[1].par, 88);
  assert.equal(results[1].bombHitEvents.length, 1);
  assert.equal(results[1].scrolled, true);
  assert.equal(results[1].seed, 's1');
  assert.equal(results[0].scrolled, false, 'a measured false survives too');
});

test('#372: a save for a DIFFERENT run, or a disagreeing time, donates nothing', () => {
  const node = {
    boards: [{}, {}],
    players: { u1: { results: [{ time: 40.5, penalty: 0, strikes: 2 }] } },
  };
  // Same index, different board: the time disagrees, so the detail is refused.
  const wrongRun = [{ time: 99.9, par: 70, bombHitEvents: [{ t: 1 }] }];
  const r = matchResumePoint(node, 'u1', wrongRun);
  assert.equal(r.results[0].time, 40.5);
  assert.equal(r.results[0].par, undefined, 'a mismatched time must not donate its detail');
  assert.equal(r.results[0].bombHitEvents, undefined);
  // And no local results at all is the cross-device case: the three fields.
  const none = matchResumePoint(node, 'u1', null);
  assert.deepEqual(Object.keys(none.results[0]).sort(), ['penalty', 'strikes', 'time']);
});
