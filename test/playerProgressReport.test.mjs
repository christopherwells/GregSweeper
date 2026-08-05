// The player-progress report's classifiers.
//
// The report answers "how far has everyone got", and the two ways it can lie
// are both pinned here.
//
// (1) THE UID COUNT IS NOT THE PLAYER COUNT. Every visitor gets an anonymous
// auth session on boot and a `users/{uid}/lastSeen` beacon lands after it, so
// the node accumulates one entry per BROWSER that ever opened the site. A
// report that called those players would put the real three at the bottom of
// a list of hundreds and quietly overstate the audience.
//
// (2) THE TWO LADDERS ARE DIFFERENT LADDERS. Post-reset progression lives in
// the epoch-gated `challenge250` node; the top-level `maxCheckpoint` is the
// retired 120-level ladder's history, which no current client reads. Merging
// them would report a pre-reset climb as a current position — the same
// resurrection issue #239 was about, in a reporting tool instead of the game.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { summarize, isPlayer, resolveName } from '../scripts/report-player-progress.mjs';
import { CHALLENGE_250_EPOCH } from '../src/logic/challenge250.js';

test('a visitor-only uid is never counted as a player', () => {
  // What a browser that opened the site and left actually leaves behind.
  const visitor = summarize('uidV', { lastSeen: 1754400000000 });
  assert.equal(isPlayer(visitor), false);
  assert.equal(visitor.ladder, null);
  assert.equal(visitor.dailiesRecorded, 0);

  // An empty node (the beacon lost its race) is likewise not a player.
  assert.equal(isPlayer(summarize('uidE', {})), false);
  assert.equal(isPlayer(summarize('uidN', null)), false);

  // A uid that has banked NOTHING but the default checkpoint of 1 is still a
  // visitor: the node exists the moment a checkpoint write lands, and level 1
  // is where everyone starts.
  assert.equal(isPlayer(summarize('uidOne', {
    challenge250: { epoch: CHALLENGE_250_EPOCH, maxCheckpoint: 1 },
  })), false);
});

test('any real progression makes a uid a player', () => {
  const cases = {
    'on the ladder': { challenge250: { epoch: CHALLENGE_250_EPOCH, maxCheckpoint: 16 } },
    'played dailies': { dailyHistory: { '2026-08-04': { time: 40 } } },
    'attempted a weekly': { weeklyAttempts: { '2026-08-03': { dayAttempts: { 1: true } } } },
    'holds a daily streak': { bestDailyStreak: 3 },
    'holds a week streak': { weekStreak: { streak: 0, best: 2, lastWeek: '2026-07-20' } },
    'pre-reset history only': { maxCheckpoint: 96 },
  };
  for (const [why, rec] of Object.entries(cases)) {
    assert.equal(isPlayer(summarize('u', rec)), true, why);
  }
});

test('the ladder position comes ONLY from the epoch-matched node', () => {
  const current = summarize('u', {
    maxCheckpoint: 96,                                   // pre-reset history
    challenge250: { epoch: CHALLENGE_250_EPOCH, maxCheckpoint: 23 },
  });
  assert.equal(current.ladder, 23, 'the live ladder is the epoch-matched value');
  assert.equal(current.legacyMax, 96, 'and the old one is reported beside it, never merged');

  // A node stamped with a DIFFERENT epoch is a future or foreign ladder and
  // has no position on this one.
  const wrongEpoch = summarize('u', {
    challenge250: { epoch: CHALLENGE_250_EPOCH + 1, maxCheckpoint: 40 },
  });
  assert.equal(wrongEpoch.ladder, null);
  assert.equal(wrongEpoch.ladderEpoch, CHALLENGE_250_EPOCH + 1, 'but the epoch is surfaced');

  // The legacy-only account: pre-reset climb, nothing on the new ladder. It
  // must NOT report 96 as a current position.
  const legacyOnly = summarize('u', { maxCheckpoint: 96 });
  assert.equal(legacyOnly.ladder, null);
  assert.equal(legacyOnly.legacyMax, 96);
});

test('streaks, molt and the week streak are read from their own shapes', () => {
  const s = summarize('u', {
    dailyStreak: 12, bestDailyStreak: 40, lastDailyDate: '2026-08-05',
    moltDay: { banked: 2, lastUse: { date: '2026-07-30' } },
    weekStreak: { streak: 7, best: 9, lastWeek: '2026-08-03' },
    dailyHistory: { '2026-08-04': {}, '2026-08-05': {} },
    weeklyAttempts: { '2026-07-27': {}, '2026-08-03': {} },
  });
  assert.equal(s.dailyStreak, 12);
  assert.equal(s.bestDailyStreak, 40);
  assert.equal(s.molt, 2);
  assert.equal(s.weekStreak, 7);
  assert.equal(s.bestWeekStreak, 9);
  assert.equal(s.lastWeek, '2026-08-03');
  assert.equal(s.dailiesRecorded, 2);
  assert.equal(s.weeksAttempted, 2);
});

test('a record carrying a push token never reaches the report', () => {
  // The report must be safe to paste into a run log. An FCM token is a
  // credential; nothing in the summary may carry it.
  const s = summarize('u', {
    dailyStreak: 4,
    pushSubscription: { token: 'SECRET-FCM-TOKEN', subscribedAt: 1 },
    notificationPrefs: { enabled: true, hourLocal: 9 },
  });
  assert.ok(!JSON.stringify(s).includes('SECRET-FCM-TOKEN'),
    'the summary must never carry a push token');
  assert.deepEqual(Object.keys(s).filter((k) => /push|notif|token/i.test(k)), []);
});

test('names join the way the leaderboard does: playerNames first, rows as fallback', () => {
  const rowNames = new Map([['u2', new Set(['Kate'])], ['u3', new Set(['Zed', 'Ada'])]]);
  assert.equal(resolveName('u1', { u1: 'Sebas' }, rowNames), 'Sebas');
  assert.equal(resolveName('u1', { u1: { name: 'Sebas' } }, rowNames), 'Sebas', 'object form too');
  assert.equal(resolveName('u2', {}, rowNames), 'Kate', 'falls back to a leaderboard row name');
  assert.equal(resolveName('u3', {}, rowNames), 'Ada', 'ties resolve deterministically');
  assert.equal(resolveName('u9', {}, rowNames), '(unnamed)');
  assert.equal(resolveName('u9', null, new Map()), '(unnamed)', 'a failed read is not a crash');
});
