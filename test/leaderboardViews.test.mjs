// Leaderboard view logic: handicap-adjusted ranking, friends filtering,
// and the EXACT multi-location write shapes for mutual friendship.
// The write-shape tests are the client side of the rules contract —
// users/$uid/friends/$friendUid has a strict $other catch-all, so a
// drifted payload field would reject the whole write in prod; here it
// fails CI first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rankAdjusted, filterToFriends,
  buildFriendAddUpdate, buildFriendRemoveUpdate,
} from '../src/logic/leaderboardViews.js';

const rows = [
  { uid: 'fast', name: 'Fast', time: 60 },
  { uid: 'slow', name: 'Slow', time: 100 },
  { uid: 'new', name: 'Newbie', time: 80 },
];

test('rankAdjusted: a large handicap overtakes a faster raw time', () => {
  // Slow carries a +50s handicap: adjusted 50 beats Fast's adjusted 55.
  const h = new Map([['fast', 5], ['slow', 50]]);
  const ranked = rankAdjusted(rows, h);
  assert.deepEqual(ranked.map(r => r.uid), ['slow', 'fast', 'new']);
  assert.equal(ranked[0].adjusted, 50);
  assert.equal(ranked[1].adjusted, 55);
});

test('rankAdjusted: missing uid is unrated, adjusted === raw', () => {
  const h = new Map([['fast', 5]]);
  const ranked = rankAdjusted(rows, h);
  const newbie = ranked.find(r => r.uid === 'new');
  assert.equal(newbie.rated, false);
  assert.equal(newbie.adjusted, 80);
  assert.equal(newbie.handicap, 0);
});

test('rankAdjusted: a fitted handicap of exactly 0 is still RATED', () => {
  const h = new Map([['fast', 0]]);
  const ranked = rankAdjusted(rows, h);
  assert.equal(ranked.find(r => r.uid === 'fast').rated, true);
});

test('rankAdjusted: negative handicap (faster than typical) adds time', () => {
  const h = new Map([['fast', -10]]);
  const ranked = rankAdjusted(rows, h);
  assert.equal(ranked.find(r => r.uid === 'fast').adjusted, 70);
});

test('rankAdjusted: accepts the PLAIN OBJECT form loadHandicaps() actually returns', () => {
  // handicaps.json ships {uid: seconds} — loadHandicaps() resolves that
  // object verbatim, NOT a Map. This is the production call shape; the
  // 2026-06-11 first cut assumed Map-only and ranked everyone unrated.
  const ranked = rankAdjusted(rows, { fast: 5, slow: 50 });
  assert.deepEqual(ranked.map(r => r.uid), ['slow', 'fast', 'new']);
  assert.equal(ranked.find(r => r.uid === 'fast').rated, true);
  assert.equal(ranked.find(r => r.uid === 'new').rated, false);
  // Object form must not treat inherited keys as handicaps.
  const polluted = rankAdjusted(rows, Object.create({ fast: 99 }));
  assert.equal(polluted.find(r => r.uid === 'fast').rated, false);
});

test('rankAdjusted: ties keep input (raw-time) order; empty map degrades to raw', () => {
  const tied = [
    { uid: 'a', name: 'A', time: 60 },
    { uid: 'b', name: 'B', time: 60 },
  ];
  assert.deepEqual(rankAdjusted(tied, new Map()).map(r => r.uid), ['a', 'b']);
  assert.deepEqual(rankAdjusted(rows, new Map()).map(r => r.uid), ['fast', 'new', 'slow']);
  assert.deepEqual(rankAdjusted([], new Map()), []);
});

test('filterToFriends: includes self even with no friends; excludes strangers', () => {
  assert.deepEqual(filterToFriends(rows, [], 'fast').map(r => r.uid), ['fast']);
  assert.deepEqual(filterToFriends(rows, ['slow'], 'fast').map(r => r.uid), ['fast', 'slow']);
  assert.deepEqual(filterToFriends(rows, ['slow'], null).map(r => r.uid), ['slow']);
  assert.deepEqual(filterToFriends([], ['slow'], 'fast'), []);
});

test('buildFriendAddUpdate: exactly two mirrored paths, exact field set', () => {
  const TS = { '.sv': 'timestamp' };
  const upd = buildFriendAddUpdate('me123', 'Chris', 'them456', 'Hieronymus Bosch', TS);
  assert.deepEqual(Object.keys(upd).sort(), [
    'users/me123/friends/them456',
    'users/them456/friends/me123',
  ]);
  // Field set pinned: rules' $other catch-all rejects anything extra.
  assert.deepEqual(Object.keys(upd['users/me123/friends/them456']).sort(), ['addedAt', 'name']);
  assert.equal(upd['users/me123/friends/them456'].name, 'Hieronymus Bosch');
  assert.equal(upd['users/them456/friends/me123'].name, 'Chris');
  assert.equal(upd['users/me123/friends/them456'].addedAt, TS);
});

test('buildFriendAddUpdate: names capped at the rules limit (20 chars)', () => {
  const upd = buildFriendAddUpdate('a', 'x'.repeat(30), 'b', 'y'.repeat(30), 1);
  assert.equal(upd['users/b/friends/a'].name.length, 20);
  assert.equal(upd['users/a/friends/b'].name.length, 20);
});

test('add/remove: self-friendship throws; remove nulls exactly both sides', () => {
  assert.throws(() => buildFriendAddUpdate('me', 'n', 'me', 'n', 1));
  assert.throws(() => buildFriendRemoveUpdate('me', 'me'));
  const upd = buildFriendRemoveUpdate('me123', 'them456');
  assert.deepEqual(upd, {
    'users/me123/friends/them456': null,
    'users/them456/friends/me123': null,
  });
});
