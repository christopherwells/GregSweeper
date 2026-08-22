// The pending-submission queues, and which rows may evict which.
//
// REGRESSION #423: a Challenge run's fit rows shared the daily queue, which
// holds ten entries and drops the OLDEST to make room. `rules.count` is 1 to
// 10, so ONE offline run pushed exactly PENDING_MAX_ENTRIES rows and cleared
// the queue of everything else in a single pass. The player wins the daily on
// a train with no signal, plays a ten-board Challenge to pass the time, and
// their daily score is silently gone: no leaderboard row, no adjusted rank,
// and nothing tells them, because `dailyHistory` is a separate write so the
// day still counts locally.
//
// The two things in that queue were never equal. A daily score is the
// player's own visible result; a match fit row is model data. A single
// recency-ordered queue cannot express that, so they are SEPARATED rather
// than ranked, which is the shape PENDING_WEEKLY_KEY already used.
//
// Run: node --test test/pendingQueueSplit.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import './domShim.mjs';
import { pendingQueueKeyFor, PENDING_KEY, PENDING_MATCH_KEY } from '../src/firebase/firebaseLeaderboard.js';
import { matchRowKey, MATCH_ROW_KEY_REGEX } from '../src/logic/matchCodes.js';

test('REGRESSION #423: a match fit row never queues where a daily score lives', () => {
  const dailyKeys = ['2026-08-22', '2026-01-01', '2026-08-22_weekly_first'];
  for (const k of dailyKeys) {
    assert.equal(pendingQueueKeyFor(k), PENDING_KEY, `${k} is a player-visible score`);
  }
  // A real match key, minted the way the submitter mints it.
  const mk = matchRowKey('some-board-seed-1234');
  assert.match(mk, MATCH_ROW_KEY_REGEX, 'fixture must be a real match row key');
  assert.equal(pendingQueueKeyFor(mk), PENDING_MATCH_KEY);

  // NON-VACUITY: the two queues must actually be different storage, or the
  // split is a rename and the eviction still crosses classes.
  assert.notEqual(PENDING_KEY, PENDING_MATCH_KEY);
});

test('the queue is DERIVED from the row key, so no caller can forget', () => {
  // The bug was not that someone chose the wrong queue, it was that the
  // choice was implicit in which function you happened to call. Deriving it
  // from the key means the match submitter cannot regress by passing nothing.
  const src = readFileSync(new URL('../src/firebase/firebaseLeaderboard.js', import.meta.url), 'utf8');
  const queueFn = src.slice(src.indexOf('function _queueFailedSubmission'));
  const body = queueFn.slice(0, queueFn.indexOf('\n}'));
  assert.ok(body.includes('pendingQueueKeyFor(dateString)'),
    '_queueFailedSubmission must derive its queue from the row key');
  assert.ok(!/safeSetJSON\(PENDING_KEY,/.test(body),
    '_queueFailedSubmission must not write a hardcoded queue');

  // And the match queue must actually DRAIN, or rows accumulate forever.
  assert.ok(/flushPendingMatchSubmissions\(\)/.test(src),
    'the match queue needs a flush');
  const boot = src.slice(src.indexOf('flushPendingSubmissions().catch'), src.indexOf('flushPendingSubmissions().catch') + 400);
  assert.ok(boot.includes('flushPendingMatchSubmissions'),
    'the match flush must be wired at boot beside the other two');
});
