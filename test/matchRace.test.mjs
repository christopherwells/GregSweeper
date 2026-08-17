// The live race's decisions (PR 5, his rulings 2026-08-17): the in-play
// chip is position only, the gap card compares totals through the boards
// both players have banked, opponent finishes are held to the board gap,
// and presence is a fresh activeAt. All pure in src/logic/matchRace.js so
// the surfaces render verdicts a test has already read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  raceChipModel, raceBaseline, raceEvents, gapComparison, gapLineText,
  gapNewsText, nameList, fmtGap, isPresenceFresh,
  PRESENCE_BEAT_MS, PRESENCE_FRESH_MS,
} from '../src/logic/matchRace.js';

const node = (players, boards = 5) => ({
  host: 'me',
  boards: Array.from({ length: boards }, (_, i) => ({ seed: `s${i}` })),
  players,
});
const results = (...times) => times.map((t) => (t == null ? null : { time: t, penalty: 0, strikes: 0 }));

// ── The chip ────────────────────────────────────────────────────────────

test('the chip tracks the opponent furthest along, position only', () => {
  const m = raceChipModel(node({
    me: { name: 'Me', results: results(30) },
    kate: { name: 'Kate', results: results(30, 30, 30) },
    sebas: { name: 'Sebas', results: results(30) },
  }), { myUid: 'me', now: 1000 });
  assert.equal(m.uid, 'kate');
  assert.equal(m.done, 3);
  assert.equal(m.of, 5);
  assert.equal(m.others, 1);
  assert.equal(m.finished, false);
  // Position only: the model deliberately reports no time at all.
  assert.ok(!('time' in m) && !('adjusted' in m), 'his ruling: no times during a board');
});

test('a solo run shows no chip: no rivals, null model', () => {
  assert.equal(raceChipModel(node({ me: { name: 'Me', results: results(30) } }),
    { myUid: 'me', now: 1000 }), null);
  assert.equal(raceChipModel(null, { myUid: 'me', now: 1000 }), null);
});

test('a finished rival outranks an unfinished one at the same count', () => {
  // Same done count, different states: b's finishedAt landed even though a
  // result write failed (the gap finishedAt exists to cover, per the
  // standings' own rule), while a is genuinely mid-run.
  const m = raceChipModel(node({
    me: { name: 'Me', results: [] },
    a: { name: 'A', results: results(9, 9, 9, 9) },
    b: { name: 'B', results: results(9, 9, 9, 9), finishedAt: 1 },
  }), { myUid: 'me', now: 1000 });
  assert.equal(m.uid, 'b');
  assert.equal(m.finished, true);
});

test('the stored Player sentinel reads as an absent name, never a label', () => {
  const m = raceChipModel(node({
    me: { name: 'Me', results: [] },
    x: { name: 'Player', results: results(9) },
  }), { myUid: 'me', now: 1000 });
  assert.equal(m.name, null, 'the write-time fallback must not shadow join-at-read');
});

// ── Presence ────────────────────────────────────────────────────────────

test('presence is fresh inside the window, stale past it, absent when unstamped', () => {
  const now = 1000000;
  assert.equal(isPresenceFresh(now - PRESENCE_FRESH_MS + 1, now), true);
  assert.equal(isPresenceFresh(now - PRESENCE_FRESH_MS, now), false);
  assert.equal(isPresenceFresh(undefined, now), false);
  assert.equal(isPresenceFresh(null, now), false);
  assert.equal(isPresenceFresh(0, now), false);
  // A client clock behind the server puts activeAt in the local future;
  // that is a fresh stamp, not a stale one.
  assert.equal(isPresenceFresh(now + 5000, now), true);
});

test('the fresh window survives two missed beats, not three', () => {
  assert.ok(PRESENCE_FRESH_MS > 2 * PRESENCE_BEAT_MS,
    'a throttled tab writes late before it stops writing at all');
  assert.ok(PRESENCE_FRESH_MS < 4 * PRESENCE_BEAT_MS,
    'a pocketed phone must stop reading as present within a few beats');
});

// ── The gap comparison ──────────────────────────────────────────────────

test('the comparison runs over the boards BOTH players banked, never partial totals', () => {
  // I have banked three boards, Kate five. Comparable set: the three we
  // share. Her three fastest do not enter; her slots 0-2 do.
  const cmp = gapComparison(node({
    me: { name: 'Me', results: results(30, 30, 30) },
    kate: { name: 'Kate', results: results(20, 20, 20, 1, 1) },
  }), { myUid: 'me', handicaps: null });
  assert.equal(cmp.boards, 3);
  assert.equal(cmp.delta, 30, '90 mine against 60 hers over the shared three');
  assert.equal(cmp.rivalAhead, true, 'positive delta: the rival leads');
});

test('holes in a results array drop out of the comparable set on both sides', () => {
  const cmp = gapComparison(node({
    me: { name: 'Me', results: results(30, null, 30) },
    kate: { name: 'Kate', results: results(20, 20, null) },
  }), { myUid: 'me', handicaps: null });
  assert.equal(cmp.boards, 1, 'only slot 0 is banked by both');
  assert.equal(cmp.delta, 10);
});

test('adjusted where rated (the panel convention), and bothRated gates the word', () => {
  const base = node({
    me: { name: 'Me', results: results(60, 60) },
    kate: { name: 'Kate', results: results(60, 60) },
  });
  const rated = gapComparison(base, { myUid: 'me', handicaps: { me: 2.0, kate: 1.0 } });
  assert.equal(rated.delta, -60, 'my 120 adjusts to 60 against her raw-rated 120');
  assert.equal(rated.bothRated, true);
  const half = gapComparison(base, { myUid: 'me', handicaps: { me: 2.0 } });
  assert.equal(half.bothRated, false, 'one unrated side and the copy must not say adjusted');
});

test('the rival picked is the nearest one ahead, else the closest chaser', () => {
  const ahead = gapComparison(node({
    me: { name: 'Me', results: results(50) },
    near: { name: 'Near', results: results(45) },
    far: { name: 'Far', results: results(10) },
  }), { myUid: 'me', handicaps: null });
  assert.equal(ahead.name, 'Near', 'the race reads from the front, nearest first');
  const behind = gapComparison(node({
    me: { name: 'Me', results: results(20) },
    close: { name: 'Close', results: results(25) },
    trailing: { name: 'Trailing', results: results(90) },
  }), { myUid: 'me', handicaps: null });
  assert.equal(behind.name, 'Close', 'with nobody ahead, the closest chaser');
  assert.equal(behind.rivalAhead, false);
});

test('no comparison without my own banked board, a shared board, or any rival', () => {
  assert.equal(gapComparison(node({
    me: { name: 'Me', results: [] },
    kate: { name: 'Kate', results: results(20) },
  }), { myUid: 'me', handicaps: null }), null);
  assert.equal(gapComparison(node({
    me: { name: 'Me', results: results(30) },
    kate: { name: 'Kate', results: [] },
  }), { myUid: 'me', handicaps: null }), null);
  assert.equal(gapComparison(node({
    me: { name: 'Me', results: results(30) },
  }), { myUid: 'me', handicaps: null }), null);
});

// ── The copy ────────────────────────────────────────────────────────────

test('the gap line speaks the standing, tenths only under ten seconds', () => {
  assert.equal(
    gapLineText({ boards: 3, delta: 4.2, rivalAhead: true, tied: false, bothRated: true }, 'Kate'),
    'Through 3 boards: 4.2s behind Kate, adjusted.');
  assert.equal(
    gapLineText({ boards: 1, delta: -12.4, rivalAhead: false, tied: false, bothRated: false }, 'Kate'),
    'Through 1 board: 12s ahead of Kate.');
  assert.equal(
    gapLineText({ boards: 2, delta: 0, rivalAhead: false, tied: true, bothRated: true }, 'Kate'),
    'Through 2 boards: level with Kate, adjusted.');
});

test('fmtGap: tenths under ten seconds, whole seconds past it', () => {
  assert.equal(fmtGap(4.25), '4.3s');
  assert.equal(fmtGap(-4.25), '4.3s');
  assert.equal(fmtGap(12.6), '13s');
});

test('the news line reports finishes and presence in complete sentences', () => {
  assert.equal(gapNewsText(
    [{ uid: 'k', name: 'Kate', boards: [3], finishedRun: false }], []),
  'While you played: Kate finished board 4.');
  assert.equal(gapNewsText(
    [{ uid: 'k', name: 'Kate', boards: [2, 3], finishedRun: false },
      { uid: 's', name: 'Sebas', boards: [4], finishedRun: true }], ['Kate']),
  'While you played: Kate finished boards 3 and 4; Sebas finished the run. Kate is playing right now.');
  assert.equal(gapNewsText([], ['Kate', 'Sebas']), 'Kate and Sebas are playing right now.');
  assert.equal(gapNewsText([], []), '');
});

test('nameList: one name plain, two with and, three with the serial comma', () => {
  assert.equal(nameList(['Kate']), 'Kate');
  assert.equal(nameList(['Kate', 'Sebas']), 'Kate and Sebas');
  assert.equal(nameList(['Kate', 'Sebas', 'MJP']), 'Kate, Sebas, and MJP');
});

// ── The baseline diff (held to the gap, his ruling) ─────────────────────

test('raceEvents reports only what landed after the baseline', () => {
  const before = node({
    me: { name: 'Me', results: results(30) },
    kate: { name: 'Kate', results: results(20) },
  });
  const base = raceBaseline(before, 'me');
  const after = node({
    me: { name: 'Me', results: results(30, 30) },
    kate: { name: 'Kate', results: results(20, 20, 20) },
  });
  const evs = raceEvents(base, after, { myUid: 'me' });
  assert.equal(evs.length, 1);
  assert.deepEqual(evs[0].boards, [1, 2], 'board 0 was already banked at the baseline');
  assert.equal(evs[0].finishedRun, false);
});

test('a rival finishing the run is its own event, once', () => {
  const before = node({
    me: { name: 'Me', results: [] },
    kate: { name: 'Kate', results: results(9, 9, 9, 9) },
  });
  const base = raceBaseline(before, 'me');
  const after = node({
    me: { name: 'Me', results: results(30) },
    kate: { name: 'Kate', results: results(9, 9, 9, 9, 9), finishedAt: 1 },
  });
  const evs = raceEvents(base, after, { myUid: 'me' });
  assert.equal(evs[0].finishedRun, true);
  // Re-baselining after the gap card: the finish never reports twice.
  const rebase = raceBaseline(after, 'me');
  assert.deepEqual(raceEvents(rebase, after, { myUid: 'me' }), []);
});

test('a null baseline treats everything as old news, never a flood of events', () => {
  // The first snapshot IS the baseline: results posted before this player
  // ever saw the node did not happen while they played.
  const seen = node({
    me: { name: 'Me', results: [] },
    kate: { name: 'Kate', results: results(9, 9) },
  });
  const evs = raceEvents(raceBaseline(seen, 'me'), seen, { myUid: 'me' });
  assert.deepEqual(evs, []);
});
