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

// handicapMap is now uid -> k (a MULTIPLICATIVE ratio). adjusted = time / k.
const rows = [
  { uid: 'fast', name: 'Fast', time: 60 },
  { uid: 'slow', name: 'Slow', time: 100 },
  { uid: 'new', name: 'Newbie', time: 80 },
];

test('rankAdjusted: adjusted = time / k, and a slower-typ player can overtake', () => {
  // fast k=1.2 -> 60/1.2 = 50; slow k=2.2 -> 100/2.2 ≈ 45.45; new unrated -> 80.
  const ranked = rankAdjusted(rows, { fast: 1.2, slow: 2.2 });
  assert.deepEqual(ranked.map(r => r.uid), ['slow', 'fast', 'new']);
  assert.equal(ranked.find(r => r.uid === 'fast').adjusted, 50);
  assert.ok(Math.abs(ranked.find(r => r.uid === 'slow').adjusted - 45.4545) < 0.01);
});

test('REGRESSION: a very fast player on a tiny board is not ranked last (the +58s pathology)', () => {
  // Sebastien k=0.3, 1.2s run. Old additive: 1.2 - (-57) = 58.2 (dead last).
  // Ratio: 1.2 / 0.3 = 4.0 — sane, and never negative on a big board either.
  assert.equal(rankAdjusted([{ uid: 'seb', time: 1.2 }], { seb: 0.3 })[0].adjusted, 4);
  const big = rankAdjusted([{ uid: 'seb', time: 40 }], { seb: 0.3 })[0];
  assert.ok(Math.abs(big.adjusted - 133.333) < 0.01 && big.adjusted > 0);
});

test('REGRESSION: leveling — playing exactly to your own ratio ties at par', () => {
  // par 100: Sebastien k=0.3 plays 30, Kate k=1.2 plays 120 (each to type).
  const ranked = rankAdjusted(
    [{ uid: 'seb', time: 30 }, { uid: 'kate', time: 120 }],
    { seb: 0.3, kate: 1.2 },
  );
  assert.equal(ranked.find(r => r.uid === 'seb').adjusted, 100);
  assert.equal(ranked.find(r => r.uid === 'kate').adjusted, 100);
});

test('REGRESSION: equal fractional improvement gives equal adjusted (k cancels)', () => {
  // Both 10% under their ratio at par 100: Seb 27 (0.9*30), Kate 108 (0.9*120).
  const ranked = rankAdjusted(
    [{ uid: 'seb', time: 27 }, { uid: 'kate', time: 108 }],
    { seb: 0.3, kate: 1.2 },
  );
  assert.equal(ranked.find(r => r.uid === 'seb').adjusted, 90);
  assert.equal(ranked.find(r => r.uid === 'kate').adjusted, 90);
});

test('rankAdjusted: missing uid is unrated, adjusted === raw (k=1)', () => {
  const ranked = rankAdjusted(rows, { fast: 1.2 });
  const newbie = ranked.find(r => r.uid === 'new');
  assert.equal(newbie.rated, false);
  assert.equal(newbie.adjusted, 80);
  assert.equal(newbie.ratio, 1);
});

test('rankAdjusted: a fitted ratio of exactly 1.0 is still RATED', () => {
  const f = rankAdjusted(rows, { fast: 1.0 }).find(r => r.uid === 'fast');
  assert.equal(f.rated, true);
  assert.equal(f.adjusted, 60);
});

test('rankAdjusted: a non-positive / garbage ratio falls back to unrated (no div-by-zero)', () => {
  for (const bad of [0, -0.5, NaN]) {
    const r = rankAdjusted([{ uid: 'x', time: 60 }], { x: bad })[0];
    assert.equal(r.rated, false, `k=${bad} must be unrated`);
    assert.equal(r.adjusted, 60);
  }
});

test('rankAdjusted: accepts the PLAIN OBJECT form loadHandicaps() actually returns', () => {
  // getHandicapRatioMap() resolves a plain {uid: k} object, NOT a Map.
  const ranked = rankAdjusted(rows, { fast: 1.2, slow: 2.2 });
  assert.equal(ranked.find(r => r.uid === 'fast').rated, true);
  assert.equal(ranked.find(r => r.uid === 'new').rated, false);
  // Object form must not treat inherited keys as ratios.
  const polluted = rankAdjusted(rows, Object.create({ fast: 0.5 }));
  assert.equal(polluted.find(r => r.uid === 'fast').rated, false);
});

test('rankAdjusted: ties keep input (raw-time) order; empty map degrades to raw', () => {
  const tied = [
    { uid: 'a', name: 'A', time: 60 },
    { uid: 'b', name: 'B', time: 60 },
  ];
  assert.deepEqual(rankAdjusted(tied, {}).map(r => r.uid), ['a', 'b']);
  assert.deepEqual(rankAdjusted(rows, {}).map(r => r.uid), ['fast', 'new', 'slow']);
  assert.deepEqual(rankAdjusted([], {}), []);
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
