// Row-matching rules for cross-device completion sync and submission
// dedupe. The load-bearing subtleties pinned here:
//  - rows omit rngSeed when it equals the dateString, so matching must
//    reconstruct the effective seed (a plain-date row must match a
//    plain-date target);
//  - matching is per BOARD (uid + effective seed), never per uid alone,
//    so a practice (?seed=) row in the same daily/{date} bucket can
//    neither block nor be blocked by the real daily, and a divergent
//    historical row does not block a canonical replay.

import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveRowSeed, findRowByUid, findRowForBoard } from '../src/logic/scoreRowMatch.js';

const TODAY = '2026-06-12';
const CANONICAL = '2026-06-12:trial8';
const ME = 'uid-me';
const OTHER = 'uid-other';

test('effectiveRowSeed reconstructs the omitted plain-date seed', () => {
  assert.equal(effectiveRowSeed({ rngSeed: CANONICAL }, TODAY), CANONICAL);
  assert.equal(effectiveRowSeed({}, TODAY), TODAY);
  assert.equal(effectiveRowSeed(null, TODAY), TODAY);
});

test('findRowByUid returns the earliest row for the uid', () => {
  const rows = {
    'push-a': { uid: OTHER, time: 50 },
    'push-b': { uid: ME, time: 61, rngSeed: CANONICAL },
    'push-c': { uid: ME, time: 44, rngSeed: CANONICAL },
  };
  assert.equal(findRowByUid(rows, ME).time, 61);
  assert.equal(findRowByUid(rows, 'uid-stranger'), null);
  assert.equal(findRowByUid(null, ME), null);
  assert.equal(findRowByUid(rows, null), null);
});

test('findRowByUid skips malformed and uid-less rows', () => {
  const rows = { a: null, b: { time: 10 }, c: { uid: ME, time: 33 } };
  assert.equal(findRowByUid(rows, ME).time, 33);
});

test('findRowForBoard matches same uid + same canonical seed', () => {
  const rows = { a: { uid: ME, time: 70, rngSeed: CANONICAL } };
  assert.ok(findRowForBoard(rows, ME, TODAY, CANONICAL));
});

test('a practice row never blocks the real daily (and vice versa)', () => {
  const practiceRow = { a: { uid: ME, time: 30, rngSeed: 'my-custom-seed' } };
  // Real-daily submission against a bucket holding only my practice row:
  assert.equal(findRowForBoard(practiceRow, ME, TODAY, CANONICAL), null);
  // Practice submission against a bucket holding only my real row:
  const realRow = { a: { uid: ME, time: 70, rngSeed: CANONICAL } };
  assert.equal(findRowForBoard(realRow, ME, TODAY, 'my-custom-seed'), null);
});

test('a divergent historical row does not block a canonical replay', () => {
  const divergent = { a: { uid: ME, time: 80, rngSeed: '2026-06-12:trial3' } };
  assert.equal(findRowForBoard(divergent, ME, TODAY, CANONICAL), null);
});

test('plain-date rows (omitted rngSeed) match a plain-date target', () => {
  const rows = { a: { uid: ME, time: 55 } }; // written when rngSeed === dateString
  assert.ok(findRowForBoard(rows, ME, TODAY, TODAY));
  assert.ok(findRowForBoard(rows, ME, TODAY)); // rngSeed defaults to dateString
  assert.equal(findRowForBoard(rows, ME, TODAY, CANONICAL), null);
});

test("another player's row for the same board never matches", () => {
  const rows = { a: { uid: OTHER, time: 41, rngSeed: CANONICAL } };
  assert.equal(findRowForBoard(rows, ME, TODAY, CANONICAL), null);
});

test('empty or missing buckets match nothing', () => {
  assert.equal(findRowForBoard(null, ME, TODAY, CANONICAL), null);
  assert.equal(findRowForBoard({}, ME, TODAY, CANONICAL), null);
});
