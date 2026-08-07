// The offline board cache has to be prunable on BOTH storage backends.
//
// pruneOldCachedBoards is the only thing keeping this cache bounded, and it
// scanned raw localStorage while every write in the same module went through
// storageAdapter. On a device running the in-memory fallback — private
// browsing, or a quota failure that flipped the adapter mid-session — the
// boards land in the Map, the scan reads a localStorage that does not have
// them, and the sweep silently does nothing. The Map is the one backend with
// no eviction of its own, so it is exactly the backend that needed the sweep.
//
// statsStorage's pruneOldDailyKeys, the same sweep over the sibling key
// family, has always gone through safeKeys. This one was the odd one out.
//
// The localStorage stub is installed BEFORE the imports and throws on every
// call, which is what forces storageAdapter onto its Map. Without that the
// test would pass on the unfixed code, because a working localStorage is
// visible to both the old scan and the new one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = {
  get length() { throw new Error('storage denied'); },
  key() { throw new Error('storage denied'); },
  getItem() { throw new Error('storage denied'); },
  setItem() { throw new Error('storage denied'); },
  removeItem() { throw new Error('storage denied'); },
};

const {
  cacheDailyBoard, getCachedDailyBoard, cacheWeeklyBoard, getCachedWeeklyBoard,
  pruneOldCachedBoards, addDays, PREFETCH_DAILY_DAYS,
} = await import('../src/firebase/boardCache.js');
const { isStorageFailing } = await import('../src/storage/storageAdapter.js');

const board = (rows = 2, cols = 2) => ({
  rows, cols, cells: Array.from({ length: rows * cols }, () => ({})),
});

const TODAY = '2026-08-07';
const WEEK = '2026-08-03';

test('the harness really is on the in-memory fallback, or this file proves nothing', () => {
  cacheDailyBoard(TODAY, board());
  assert.equal(isStorageFailing(), true,
    'localStorage was expected to be refusing; a working one makes every assertion below vacuous');
  assert.ok(getCachedDailyBoard(TODAY), 'and the fallback must still round-trip a board');
});

test('REGRESSION: a stale daily is pruned on the in-memory backend', () => {
  const stale = addDays(TODAY, -30);
  cacheDailyBoard(stale, board());
  assert.ok(getCachedDailyBoard(stale), 'precondition: the stale board is cached');

  pruneOldCachedBoards(TODAY, WEEK);

  assert.equal(getCachedDailyBoard(stale), null,
    'a board 30 days old is outside the window and must be dropped');
});

test('pruning keeps the window it is supposed to keep', () => {
  // Non-vacuity: a sweep that deleted everything would pass the test above.
  const yesterday = addDays(TODAY, -1);   // the grace slot for a play across midnight ET
  const lastPrefetched = addDays(TODAY, PREFETCH_DAILY_DAYS - 1);
  cacheDailyBoard(yesterday, board());
  cacheDailyBoard(TODAY, board());
  cacheDailyBoard(lastPrefetched, board());

  pruneOldCachedBoards(TODAY, WEEK);

  assert.ok(getCachedDailyBoard(yesterday), 'yesterday is the documented grace slot');
  assert.ok(getCachedDailyBoard(TODAY), "today's board must obviously survive");
  assert.ok(getCachedDailyBoard(lastPrefetched), 'and so must the far end of the prefetch window');
});

test('weeklies prune on the same terms, keeping previous/current/next', () => {
  const old = addDays(WEEK, -21);
  cacheWeeklyBoard(old, board());
  cacheWeeklyBoard(addDays(WEEK, -7), board());
  cacheWeeklyBoard(WEEK, board());
  cacheWeeklyBoard(addDays(WEEK, 7), board());

  pruneOldCachedBoards(TODAY, WEEK);

  assert.equal(getCachedWeeklyBoard(old), null, 'three weeks back is outside the window');
  assert.ok(getCachedWeeklyBoard(addDays(WEEK, -7)), 'previous week is kept');
  assert.ok(getCachedWeeklyBoard(WEEK), 'current week is kept');
  assert.ok(getCachedWeeklyBoard(addDays(WEEK, 7)), 'next week is kept');
});
