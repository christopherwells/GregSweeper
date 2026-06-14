// dailyArchive rules structure contract. The archive feeds the par fit, so
// the row shape has to stay honest: archivePlay must be a required, literal
// true; the write must be uid-owned and append-only; the date key must be a
// plain daily date (never the weekly suffix); and the strict $other catch-all
// must survive so no unvalidated field can ride in. Companion to
// test/archiveEligibility.test.mjs (client gates) and rules-contract.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rules = JSON.parse(readFileSync(new URL('../firebase-rules.json', import.meta.url), 'utf8')).rules;

test('dailyArchive: world-readable, time-indexed, plain-daily-date key', () => {
  const node = rules.dailyArchive;
  assert.ok(node, 'dailyArchive block missing');
  assert.equal(node['.read'], true, 'leaderboard reads must stay public');
  assert.equal(node.$date?.['.read'], true);
  assert.deepEqual(node.$date?.['.indexOn'], ['time'], 'time index for sorted reads');
  const dateRe = node.$date?.['.validate'];
  assert.ok(dateRe.includes('\\d{4}-\\d{2}-\\d{2}'), 'must validate a YYYY-MM-DD key');
  // Archive is daily-only: it must NOT inherit daily/'s weekly-first suffix.
  assert.ok(!dateRe.includes('weekly_first'),
    'archive date key must reject the _weekly_first suffix (daily-only)');
});

test('dailyArchive.$entry: append-only, uid-owned write', () => {
  const w = rules.dailyArchive?.$date?.$entry?.['.write'];
  assert.ok(w, 'dailyArchive entry .write missing');
  assert.ok(w.includes('auth != null'), 'must require auth');
  assert.ok(w.includes('!data.exists()'), 'entries are append-only (push keys)');
  assert.ok(w.includes("newData.child('uid').val() === auth.uid"),
    'a row must be owned by its writer');
});

test('dailyArchive.$entry: archivePlay is required and pinned to literal true', () => {
  const entry = rules.dailyArchive?.$date?.$entry;
  assert.ok(entry['.validate'].includes("'archivePlay'"),
    'archivePlay must be a required child so a daily row can never masquerade as archive');
  assert.equal(entry.archivePlay?.['.validate'], 'newData.isBoolean() && newData.val() === true',
    'archivePlay must be exactly boolean true');
});

test('dailyArchive.$entry: cruxViewed is an optional boolean (PR 4 hook)', () => {
  const entry = rules.dailyArchive?.$date?.$entry;
  assert.equal(entry.cruxViewed?.['.validate'], 'newData.isBoolean()');
  // Optional: not in the required hasChildren list.
  assert.ok(!entry['.validate'].includes("'cruxViewed'"),
    'cruxViewed must stay optional (absent on pre-PR4 rows)');
});

test('dailyArchive.$entry: server-sentinel timestamp, score bounds, strict whitelist', () => {
  const entry = rules.dailyArchive?.$date?.$entry;
  assert.equal(entry.timestamp?.['.validate'], 'newData.val() === now',
    'timestamp must be the ServerValue.TIMESTAMP sentinel only');
  assert.ok(entry.time?.['.validate']?.includes('>= 5 && newData.val() <= 3600'),
    'time bounds must match the daily score bounds');
  assert.ok(entry.name?.['.validate']?.includes('length <= 20'),
    'name cap must match the 20-char leaderboard cap');
  assert.ok(entry.uid?.['.validate']?.includes('=== auth.uid'));
  assert.equal(entry.$other?.['.validate'], false,
    'strict $other catch-all must survive so no unvalidated field rides in');
});
