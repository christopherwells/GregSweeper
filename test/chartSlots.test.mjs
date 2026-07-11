// The daily-history chart's day columns (2026-07-11 audit): the slot walk
// is pure ET-date string arithmetic ending at the caller's getLocalDateString()
// value. The old walk used the BROWSER-local clock, so a player west of ET
// finishing after midnight ET had their newest (ET-dated) dot fall outside
// every slot — invisible until the next browser-day.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { chartDateSlots } = await import('../src/ui/dailyHistoryChart.js');
const { addCalendarDays } = await import('../src/logic/seededRandom.js');

test('REGRESSION: the last slot is exactly the ET date passed in', () => {
  const slots = chartDateSlots('2026-07-12', 30);
  assert.equal(slots.length, 30);
  assert.equal(slots[slots.length - 1], '2026-07-12',
    "an ET-today entry must have a slot to land in, whatever the browser's timezone says");
  assert.equal(slots[0], '2026-06-13');
});

test('slots are consecutive calendar days, DST seams included', () => {
  // 2026 US DST began March 8 — the walk must stay calendar-consecutive
  // across it (addCalendarDays anchors at noon).
  const slots = chartDateSlots('2026-03-10', 7);
  for (let i = 1; i < slots.length; i++) {
    assert.equal(slots[i], addCalendarDays(slots[i - 1], 1), `${slots[i - 1]} → ${slots[i]}`);
  }
  assert.ok(slots.includes('2026-03-08'), 'the DST transition day itself is present');
});
