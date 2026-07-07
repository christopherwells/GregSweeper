// Merge semantics for the admin uid-consolidation tool
// (scripts/merge-player-uids.mjs) — the pure decision layer that rewrites
// player identity data, so every rule is pinned before the tool may run.
// Built 2026-07-06 for the device-fragmentation merges (the-anemone-guy /
// MJP+Stickleback / the two Hieronymus Bosch uids).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeUserNodes, mergeWeeklyRows, normalizeDaySlots } from '../scripts/merge-player-uids.mjs';

test('streak snapshot moves WHOLE from the later-lastDailyDate side (molt rides along)', () => {
  const target = { dailyStreak: 112, lastDailyDate: '2026-07-06', moltDay: { banked: 2 } };
  const source = { dailyStreak: 1, lastDailyDate: '2026-05-22', moltDay: { banked: 0 } };
  const { merged } = mergeUserNodes(target, source);
  assert.equal(merged.dailyStreak, 112);
  assert.equal(merged.lastDailyDate, '2026-07-06');
  assert.deepEqual(merged.moltDay, { banked: 2 });

  // and the reverse orientation adopts the source snapshot atomically
  const { merged: rev } = mergeUserNodes(source, target);
  assert.equal(rev.dailyStreak, 112);
  assert.equal(rev.lastDailyDate, '2026-07-06');
  assert.deepEqual(rev.moltDay, { banked: 2 }, 'bank must never pair with the other side\'s streak');
});

test('maxCheckpoint and bestDailyStreak take the max across sides', () => {
  const { merged } = mergeUserNodes(
    { bestDailyStreak: 3 },
    { maxCheckpoint: 8, bestDailyStreak: 2 },
  );
  assert.equal(merged.maxCheckpoint, 8, 'source-only checkpoint must survive');
  assert.equal(merged.bestDailyStreak, 3);
});

test('dailyHistory unions; a date collision keeps the target row', () => {
  const { merged, notes } = mergeUserNodes(
    { dailyHistory: { '2026-06-18': { time: 100 } } },
    { dailyHistory: { '2026-06-18': { time: 999 }, '2026-06-17': { time: 50 } } },
  );
  assert.equal(merged.dailyHistory['2026-06-18'].time, 100);
  assert.equal(merged.dailyHistory['2026-06-17'].time, 50);
  assert.ok(notes.some((n) => n.includes('collision on 2026-06-18')));
});

test('powerUps take the per-key MAX — merging must never double-grant consumables', () => {
  const { merged } = mergeUserNodes(
    { powerUps: { challenge: { shield: 2, xray: 0 } } },
    { powerUps: { challenge: { shield: 1, xray: 3, magnet: 1 } } },
  );
  assert.deepEqual(merged.powerUps.challenge, { shield: 2, xray: 3, magnet: 1 });
});

test('weeklyAttempts collision unions the day markers (no attempt vanishes, none duplicates)', () => {
  const { merged } = mergeUserNodes(
    { weeklyAttempts: { '2026-05-18': { dayAttempts: { 0: true, 3: true } } } },
    { weeklyAttempts: { '2026-05-18': { dayAttempts: { 3: true, 4: true } }, '2026-06-15': { dayAttempts: { 0: true } } } },
  );
  assert.deepEqual(merged.weeklyAttempts['2026-05-18'].dayAttempts, { 0: true, 3: true, 4: true });
  assert.deepEqual(merged.weeklyAttempts['2026-06-15'].dayAttempts, { 0: true });
});

test('friends union keeps the target entry on a shared friend', () => {
  const { merged } = mergeUserNodes(
    { friends: { abc: { name: 'Kate' } } },
    { friends: { abc: { name: 'K' }, xyz: { name: 'Sebas' } } },
  );
  assert.equal(merged.friends.abc.name, 'Kate');
  assert.equal(merged.friends.xyz.name, 'Sebas');
});

test('source-only unknown keys are copied verbatim (future-field defense)', () => {
  const { merged, notes } = mergeUserNodes({}, { someFutureThing: { a: 1 } });
  assert.deepEqual(merged.someFutureThing, { a: 1 });
  assert.ok(notes.some((n) => n.includes('someFutureThing')));
});

test('normalizeDaySlots handles both RTDB shapes: arrays with nulls and sparse numeric-key objects', () => {
  assert.deepEqual(
    normalizeDaySlots([191.5, null, 118.3]),
    [191.5, null, 118.3, null, null, null, null],
  );
  assert.deepEqual(
    normalizeDaySlots({ 4: 151.4 }),
    [null, null, null, null, 151.4, null, null],
  );
});

test('mergeWeeklyRows: per-day best, overall best, and a source-only day fills the target gap', () => {
  // the real 2026-05-18 shape: target played days 0,1,3,5,6; source only day 4
  const target = {
    bestTime: 118.3, name: 'the-anemone-guy', timestamp: 2, totalMoves: 69,
    dayTimes: [191.5, 131.6, null, 118.3, null, 144.6, 153.8],
    dayBombHits: [3, 2, null, 1, null, 2, 4],
  };
  const source = {
    bestTime: 151.4, name: 'Chris', timestamp: 1, totalMoves: 69,
    dayTimes: { 4: 151.4 }, dayBombHits: { 4: 1 },
  };
  const merged = mergeWeeklyRows(target, source);
  assert.equal(merged.bestTime, 118.3);
  assert.equal(merged.name, 'the-anemone-guy', 'identity fields follow the winning bestTime');
  assert.deepEqual(merged.dayTimes, [191.5, 131.6, null, 118.3, 151.4, 144.6, 153.8]);
  assert.deepEqual(merged.dayBombHits, [3, 2, null, 1, 1, 2, 4], 'the filled day carries the source run\'s bomb hits');
});

test('mergeWeeklyRows: when the source holds the better bestTime, identity follows it and shared days keep the faster run', () => {
  const target = { bestTime: 200, name: 'B', timestamp: 2, totalMoves: 10, dayTimes: [200, null], dayBombHits: [5, null] };
  const source = { bestTime: 150, name: 'A', timestamp: 1, totalMoves: 20, dayTimes: [150, 180], dayBombHits: [0, 1] };
  const merged = mergeWeeklyRows(target, source);
  assert.equal(merged.bestTime, 150);
  assert.equal(merged.name, 'A');
  assert.equal(merged.totalMoves, 20);
  assert.deepEqual(merged.dayTimes.slice(0, 2), [150, 180]);
  assert.deepEqual(merged.dayBombHits.slice(0, 2), [0, 1], 'day 0 bomb hits follow the kept (faster) run');
});
