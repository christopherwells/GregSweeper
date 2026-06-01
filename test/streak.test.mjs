// Daily streak derivation from completion history. The May-2026 incident
// proved this needs to be airtight: a wrong run-length or a failure to
// reset on a gap silently corrupts a player's streak.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { computeStreakFromHistory } = await import('../src/storage/statsStorage.js');

test('continuous run counts every consecutive day', () => {
  const dates = [];
  for (let d = 1; d <= 10; d++) dates.push(`2026-05-${String(d).padStart(2, '0')}`);
  const { streak, lastDate } = computeStreakFromHistory(dates);
  assert.equal(streak, 10);
  assert.equal(lastDate, '2026-05-10');
});

test('a gap resets the run to the tail segment only', () => {
  // Played 1-3, skipped 4, played 5-6. Run ending at the latest date is 2.
  const dates = ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-05', '2026-05-06'];
  const { streak, lastDate } = computeStreakFromHistory(dates);
  assert.equal(streak, 2);
  assert.equal(lastDate, '2026-05-06');
});

test('order and duplicates do not affect the result', () => {
  const { streak, lastDate } = computeStreakFromHistory(
    ['2026-05-24', '2026-05-22', '2026-05-24', '2026-05-23']);
  assert.equal(streak, 3);
  assert.equal(lastDate, '2026-05-24');
});

test('empty / malformed input yields zero', () => {
  assert.deepEqual(computeStreakFromHistory([]), { streak: 0, lastDate: null });
  assert.deepEqual(computeStreakFromHistory(null), { streak: 0, lastDate: null });
  assert.deepEqual(computeStreakFromHistory(['not-a-date', '']), { streak: 0, lastDate: null });
});

test('month boundary is a real consecutive day', () => {
  const { streak } = computeStreakFromHistory(['2026-05-30', '2026-05-31', '2026-06-01']);
  assert.equal(streak, 3);
});

test('reconstructs the real incident run lengths', () => {
  // Chris: 2026-03-17 .. 2026-05-25 inclusive should be 70.
  const dates = [];
  let d = new Date(Date.UTC(2026, 2, 17));
  const end = new Date(Date.UTC(2026, 4, 25));
  while (d <= end) { dates.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  assert.equal(computeStreakFromHistory(dates).streak, 70);
});
