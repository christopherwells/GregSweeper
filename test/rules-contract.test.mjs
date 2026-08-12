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

// The weekly row's fields are DERIVED from the writer rather than restated,
// because a hand-kept list only ever pins the fields somebody remembered to add
// to it — and the failure it is supposed to catch is precisely the one nobody
// remembered. _doSubmitWeeklyScore writes through three shapes: the update()
// map, the set() payload of the first-write fallback, and the separate
// bestTime transaction. All three are read here.
function weeklyRowFieldsWrittenByClient() {
  const src = readFileSync(new URL('../src/firebase/firebaseLeaderboard.js', import.meta.url), 'utf8');
  const start = src.indexOf('async function _doSubmitWeeklyScore');
  assert.ok(start > 0, 'expected _doSubmitWeeklyScore to still exist');
  const body = src.slice(start, src.indexOf('\nfunction _queueFailedWeeklySubmission', start));
  const fields = new Set();
  // `updates.totalMoves = ...` / `payload.dayTimes = ...`
  for (const m of body.matchAll(/\b(?:updates|payload)\.([A-Za-z_]\w*)\s*=/g)) fields.add(m[1]);
  // `updates[`dayTimes/${day}`] = ...` — the child path's HEAD is the row field
  for (const m of body.matchAll(/\b(?:updates|payload)\[`([A-Za-z_]\w*)\//g)) fields.add(m[1]);
  // object-literal keys inside `const updates = { ... }` / `const payload = { ... }`
  for (const m of body.matchAll(/const (?:updates|payload) = \{([\s\S]*?)\n {4,6}\};/g)) {
    for (const k of m[1].matchAll(/^\s*([A-Za-z_]\w*)\s*[,:]/gm)) fields.add(k[1]);
  }
  // `ref.child('bestTime').transaction(...)` — written outside both shapes
  for (const m of body.matchAll(/\.child\('([A-Za-z_]\w*)'\)/g)) fields.add(m[1]);
  return [...fields];
}

test('weekly/{weekStart}/{uid}: all written fields are whitelisted', () => {
  // src/firebase/firebaseLeaderboard.js _doSubmitWeeklyScore, derived — see above.
  const derived = weeklyRowFieldsWrittenByClient();
  // Non-vacuity: the derivation must actually find the row's known shape. If a
  // refactor renames `updates`/`payload` this returns a short list and the
  // whitelist check below would pass by finding nothing to check.
  for (const known of ['name', 'bestTime', 'dayTimes', 'dayBombHits', 'totalMoves', 'timestamp']) {
    assert.ok(derived.includes(known),
      `the derivation missed "${known}" — it is no longer reading the writer, so this test is inert`);
  }
  assertWhitelist(rules.weekly.$weekStart.$uid, 'weekly/$uid', derived);
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
    'dailyHistory', 'weeklyAttempts', 'weeklyCompletions', 'weekStreak',
    'pushSubscription', 'notificationPrefs',
    'powerUps', 'moltDay', 'challenge250',
    // matchInvites is written by a FRIEND, not the owner, but it lives under
    // the same strict $other:false, so an un-whitelisted entry would drop the
    // whole progress write for everyone (the 866683d class). `matches` is the
    // owner's own list of matches they created or joined.
    'matchInvites', 'matches',
  ]);
});

test('users/{uid}/matches: the list that is the only way back into a match', () => {
  // The save slot holds ONE match, so without this list a player in two of
  // them could never return to the other.
  assertWhitelist(rules.users.$uid.matches.$matchId, 'users/$uid/matches/$matchId',
    ['code', 'host', 'joinedAt']);
  assert.match(rules.users.$uid.matches.$matchId['.validate'], /\$matchId\.matches/,
    'the key must be a real match id');
});

test('matches/{matchId}: the node the host writes is fully whitelisted', () => {
  // src/firebase/firebaseMatch.js createMatch writes this node WHOLE, once.
  assertWhitelist(rules.matches.$matchId, 'matches/$matchId', [
    'host', 'rules', 'boards', 'createdAt', 'playerCount', 'players',
  ]);
  assertWhitelist(rules.matches.$matchId.rules, 'matches/$matchId/rules', [
    'count', 'shapes', 'mods', 'time', 'density',
  ]);
  // A stored board is the five fields certifyStoredBoard reads, and no more.
  assertWhitelist(rules.matches.$matchId.boards.$idx, 'matches/$matchId/boards/$idx', [
    'seed', 'par', 'features', 'spec', 'payload',
  ]);
  assertWhitelist(rules.matches.$matchId.players.$uid, 'matches/$matchId/players/$uid', [
    'name', 'joinedAt', 'finishedAt', 'results',
  ]);
  assertWhitelist(rules.matches.$matchId.players.$uid.results.$idx,
    'matches/$matchId/players/$uid/results/$idx', ['time', 'penalty', 'strikes']);
});

test('matches: boards and results are CAPPED in the rules, not in the client', () => {
  // Anyone holding a six-character code can write a player entry, so the
  // bounds have to be server-side. Both ride a single-digit index regex,
  // which caps each at ten and matches MATCH_BOARD_MAX exactly.
  for (const [label, node] of [
    ['boards', rules.matches.$matchId.boards.$idx],
    ['results', rules.matches.$matchId.players.$uid.results.$idx],
  ]) {
    const v = node['.validate'];
    assert.match(v, /\$idx\.matches\(\/\^\[0-9\]\$\/\)/,
      `${label} must cap its index at one digit (ten entries)`);
  }
});

test('matches: a player slot is keyed by its OWN writer, and expiry gates the write', () => {
  // The users/{uid}/friends/{friendUid} grant idiom: the key IS the writer's
  // uid, so a stranger with the code writes exactly one slot and no other.
  const w = rules.matches.$matchId.players.$uid['.write'];
  assert.match(w, /auth\.uid === \$uid/, 'a player may write only their own slot');
  assert.match(w, /now </, 'and only while the match still accepts writes');
  // Reads deliberately carry NO expiry: his ruling freezes writes and leaves
  // results readable forever.
  const r = rules.matches.$matchId['.read'];
  assert.equal(r, 'auth != null');
  assert.ok(!/now/.test(r), 'reads must NOT expire — an old match stays readable');
  // And the node itself is not enumerable: only $matchId is readable.
  assert.equal(rules.matches['.read'], undefined,
    'the matches root must not be readable, or every match could be downloaded');
});

test('users/{uid}/matchInvites: a friend may write one, a stranger may not', () => {
  const w = rules.users.$uid.matchInvites.$matchId['.write'];
  assert.match(w, /auth\.uid === \$uid/, 'the owner can always dismiss their own invite');
  assert.match(w, /friends/, 'a non-owner must be an established friend of the recipient');
  assert.match(w, /auth\.uid === newData\.child\('from'\)\.val\(\)/,
    'and must name themselves as the sender');
  assertWhitelist(rules.users.$uid.matchInvites.$matchId, 'matchInvites/$matchId',
    ['from', 'code', 'sentAt', 'state', 'snoozedUntil']);
  // The sender's NAME is deliberately absent: it resolves from playerNames at
  // render time, so there is no unswept name-bearing field here.
  assert.ok(!('fromName' in rules.users.$uid.matchInvites.$matchId),
    'an invite must not store a display name — join-at-read from playerNames instead');
});

test('every match timestamp is the server sentinel, never a client clock', () => {
  // A field validated `=== now` written with Date.now() is silently rejected
  // and drops the WHOLE write (the 866683d incident froze stats for two weeks).
  const sentinel = 'newData.val() === now';
  assert.equal(rules.matches.$matchId.createdAt['.validate'], sentinel);
  assert.equal(rules.matches.$matchId.players.$uid.joinedAt['.validate'], sentinel);
  assert.equal(rules.matches.$matchId.players.$uid.finishedAt['.validate'], sentinel);
  assert.equal(rules.matchCodes.$code.createdAt['.validate'], sentinel);
  assert.equal(rules.users.$uid.matchInvites.$matchId.sentAt['.validate'], sentinel);
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
