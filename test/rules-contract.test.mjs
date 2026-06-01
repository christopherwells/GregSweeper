// Code↔Firebase-rules contract. Every write path has a strict
// `$other: {.validate: false}` catch-all, so ANY field the client writes
// that isn't explicitly whitelisted gets the WHOLE write rejected. Two
// real ship-blockers came from exactly this: powerUps (users/{uid}) and
// totalBombPenalty / bombHitEvents.penalty,infoValue (daily/{date}).
//
// This locks the contract: the fields the client writes are enumerated
// here, and the test asserts each has a matching rule under its strict
// $other catch-all. When you add a field to a Firebase write, add it to
// firebase-rules.json AND to the list below — or this test fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rules = JSON.parse(readFileSync(new URL('../firebase-rules.json', import.meta.url), 'utf8')).rules;

function assertWhitelist(node, label, fields) {
  assert.equal(node?.$other?.['.validate'], false,
    `${label}: expected a strict $other catch-all (else this isn't a real contract)`);
  for (const f of fields) {
    assert.ok(f in node, `${label}: field "${f}" is written by the client but has NO rule — its write will be rejected`);
  }
}

test('daily/{date}/{entry}: all written score fields are whitelisted', () => {
  // src/firebase/firebaseLeaderboard.js _doSubmitOnlineScore payload.
  assertWhitelist(rules.daily.$date.$entry, 'daily/$entry', [
    'name', 'time', 'bombHits', 'par', 'uid', 'timestamp',
    'bombHitEvents', 'rngSeed', 'totalBombPenalty',
  ]);
});

test('daily bombHitEvents entries: all per-hit fields are whitelisted', () => {
  // src/game/winLossHandler.js handleDailyBombHit event shape.
  assertWhitelist(rules.daily.$date.$entry.bombHitEvents.$idx, 'daily bombHitEvents/$idx', [
    't', 'row', 'col', 'penalty', 'infoValue',
  ]);
});

test('weekly/{weekStart}/{uid}: all written fields are whitelisted', () => {
  // src/firebase/firebaseLeaderboard.js _doSubmitWeeklyScore payload.
  assertWhitelist(rules.weekly.$weekStart.$uid, 'weekly/$uid', [
    'name', 'bestTime', 'dayTimes', 'dayBombHits', 'totalMoves', 'timestamp',
  ]);
});

test('users/{uid}: all written progress fields are whitelisted', () => {
  // src/firebase/firebaseProgress.js saveProgress / saveDailyHistoryEntry /
  // markWeeklyDayAttempted + firebasePush pushSubscription/notificationPrefs.
  assertWhitelist(rules.users.$uid, 'users/$uid', [
    'maxCheckpoint', 'dailyStreak', 'bestDailyStreak', 'lastDailyDate',
    'dailyHistory', 'weeklyAttempts', 'pushSubscription', 'notificationPrefs', 'powerUps',
  ]);
});

test('the top-level $other denies unknown roots (defense in depth)', () => {
  assert.equal(rules.$other['.read'], false);
  assert.equal(rules.$other['.write'], false);
});
