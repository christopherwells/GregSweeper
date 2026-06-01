// ET date math and the offline board cache. Off-by-one or rollover bugs
// here silently shift which board / which weekly day a player gets.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { addDays, getCachedDailyBoard, cacheDailyBoard,
        getCachedWeeklyBoard, cacheWeeklyBoard } = await import('../src/firebase/boardCache.js');
const { getWeekStart, getWeekDayIndex, getLocalDateString } = await import('../src/logic/seededRandom.js');

test('addDays handles forward, backward, month and year rollovers', () => {
  assert.equal(addDays('2026-05-25', 1), '2026-05-26');
  assert.equal(addDays('2026-05-25', -1), '2026-05-24');
  assert.equal(addDays('2026-05-25', 7), '2026-06-01');
  assert.equal(addDays('2026-05-31', 1), '2026-06-01');   // month rollover
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');   // year rollover
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');  // non-leap Feb
  assert.equal(addDays('2024-03-01', -1), '2024-02-29');  // leap Feb
});

test('weekStart is always a Monday and is consistent with the day index', () => {
  const ws = getWeekStart();
  assert.match(ws, /^\d{4}-\d{2}-\d{2}$/);
  // Parse as UTC and confirm it's a Monday (getUTCDay 1).
  const [y, m, d] = ws.split('-').map(Number);
  assert.equal(new Date(Date.UTC(y, m - 1, d)).getUTCDay(), 1, 'weekStart not a Monday');
  // The core consistency invariant: weekStart + dayIndex === today (ET).
  assert.equal(addDays(ws, getWeekDayIndex()), getLocalDateString(),
    'weekStart + dayIndex must equal today');
  // Day index is in range.
  const di = getWeekDayIndex();
  assert.ok(Number.isInteger(di) && di >= 0 && di <= 6, `dayIndex out of range: ${di}`);
});

test('board cache round-trips a valid board and rejects malformed payloads', () => {
  const good = { rows: 2, cols: 2, cells: [{}, {}, {}, {}], rngSeed: 'x', activeGimmicks: [] };
  cacheDailyBoard('2026-06-01', good);
  const got = getCachedDailyBoard('2026-06-01');
  assert.ok(got && got.rows === 2 && got.cells.length === 4);

  // Wrong cell count for the declared dimensions → not cached (would throw
  // in deserializeBoard), so getCached returns null for a bad write.
  cacheDailyBoard('2026-06-02', { rows: 2, cols: 2, cells: [{}], rngSeed: 'y' });
  assert.equal(getCachedDailyBoard('2026-06-02'), null);

  // Non-object / missing structural fields → null.
  assert.equal(getCachedDailyBoard('never-cached'), null);

  // Weekly mirror of the same contract.
  cacheWeeklyBoard('2026-06-01', good);
  assert.ok(getCachedWeeklyBoard('2026-06-01'));
  cacheWeeklyBoard('2026-06-08', { rows: 3, cols: 3, cells: [{}] });
  assert.equal(getCachedWeeklyBoard('2026-06-08'), null);
});
