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
    'bombHitEvents', 'rngSeed', 'totalBombPenalty', 'wormEvents',
  ]);
});

test('daily bombHitEvents entries: all per-hit fields are whitelisted', () => {
  // src/game/winLossHandler.js handleDailyBombHit event shape.
  assertWhitelist(rules.daily.$date.$entry.bombHitEvents.$idx, 'daily bombHitEvents/$idx', [
    't', 'row', 'col', 'penalty', 'infoValue',
  ]);
});

test('daily + archive wormEvents entries: all per-hatch fields are whitelisted', () => {
  // src/logic/worms.js wormHatchEvent + markWormBurrowed/finalizeWormEvents
  // shape: { t, r, c, len, life, pace, moves, tEnd? }. A dropped field here
  // silently kills the realized-worm-dose data stream (the bombHitEvents
  // incident class), so both row families pin the full set.
  const FIELDS = ['t', 'tEnd', 'r', 'c', 'len', 'life', 'pace', 'moves'];
  assertWhitelist(rules.daily.$date.$entry.wormEvents.$idx, 'daily wormEvents/$idx', FIELDS);
  assertWhitelist(rules.dailyArchive.$date.$entry.wormEvents.$idx, 'dailyArchive wormEvents/$idx', FIELDS);
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
  // moltDay rides the same saveProgress write — an un-whitelisted child would
  // make the WHOLE update() fail validation and drop silently (the 866683d
  // class). moltDayRules.test.mjs pins its inner shape; this pins that it's in
  // the master field list at all.
  assertWhitelist(rules.users.$uid, 'users/$uid', [
    'maxCheckpoint', 'dailyStreak', 'bestDailyStreak', 'lastDailyDate',
    'dailyHistory', 'weeklyAttempts', 'pushSubscription', 'notificationPrefs',
    'powerUps', 'moltDay', 'challenge250',
  ]);
});

test('dailyBoard/{date}: every stamped canonical field is whitelisted', () => {
  // Written by TWO paths — the Node precompute (daily-board-pipeline
  // buildCanonicalPayload) and the client's local-generation fallback
  // (gameActions), both stamping through experimentDesign.missionStamp on top
  // of serializeBoard's own fields. This node carries the same strict $other
  // as the score rows, so an un-whitelisted child drops the WHOLE canonical
  // write and the date silently falls back to per-client local generation.
  //
  // missionType / missionConfounder arrived with decorrelation missions
  // (Journal PR F1): a decorrelation board is not a study OF its feature, it
  // is a study of that feature apart from its confounder, and the Field Note
  // needs both names to say so without overclaiming.
  assertWhitelist(rules.dailyBoard.$date, 'dailyBoard/$date', [
    'rows', 'cols', 'totalMines', 'cells', 'writtenAt',
    'rngSeed', 'codeVersion', 'activeGimmicks', 'wallEdges', 'gatedCert', 'sig',
    'missionTarget', 'missionIsPrimary', 'missionType', 'missionConfounder',
  ]);
});

test('the top-level $other denies unknown roots (defense in depth)', () => {
  assert.equal(rules.$other['.read'], false);
  assert.equal(rules.$other['.write'], false);
});

test('users/{uid}/dailyHistory/{date}: time required; the #113 archive marker is whitelisted', () => {
  const node = rules.users.$uid.dailyHistory.$date;
  assertWhitelist(node, 'dailyHistory/$date', ['time', 'submittedAt', 'archive']);
  // Issue #99: the rule REQUIRES time, so a time-less "completed marker"
  // could never persist — the marker branch was removed from
  // saveDailyHistoryEntry; every row carries a real time.
  assert.match(node['.validate'], /hasChildren\(\['time', 'submittedAt'\]\)/);
  // Only `true` is storable — live rows omit the marker entirely.
  assert.equal(node.archive['.validate'], 'newData.val() === true');
});
