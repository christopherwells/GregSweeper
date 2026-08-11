// The weekly's per-week COMPLETION record: users/{uid}/weeklyCompletions.
//
// The weekly had no record of a week being FINISHED, only weeklyAttempts,
// which is written on the first click, and two surfaces inferred completion
// from it: the streak heal banked past weeks that were merely opened, and
// the Past Weeklies list locked out ('done') weeks that were opened and
// abandoned. The record closes both, with the attempts-vs-completions
// boundary at WEEKLY_COMPLETIONS_EPOCH stated in bankableWeeks rather than
// implied (issue #254's remaining halves).
//
// The rules half fails silently (the 866683d class): users/{uid} ends with a
// strict $other:false, so an un-whitelisted child name rejects the write.
// Both directions are pinned here, the way test/weekStreak.test.mjs pins the
// weekStreak trio, and the wiring is pinned by source scan because the rule
// itself was already right where the defect was a caller reading the wrong
// node (the saveSlotOwnership pattern).

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  reconcileWeekStreakFromHistory, getWeekStreakRecord, invalidateStatsCache,
} = await import('../src/storage/statsStorage.js');
const { planWeeklyCompletionBackfill, backfillPayload } =
  await import('../scripts/backfill-weekly-completions.mjs');

const rules = JSON.parse(readFileSync(new URL('../firebase-rules.json', import.meta.url), 'utf8')).rules;
const node = rules.users?.['$uid']?.weeklyCompletions?.['$weekStart'];

function fresh() {
  localStorage.clear();
  invalidateStatsCache?.();
}

// ── Rules lockstep ───────────────────────────────────────────────────────

test('weeklyCompletions/$weekStart is whitelisted with the exact written shape', () => {
  assert.ok(node, 'weeklyCompletions must be whitelisted under users/$uid or its writes drop');
  assert.equal(rules.users.$uid.$other?.['.validate'], false,
    'the strict $other catch-all is why the whitelist is load-bearing');
  const children = Object.keys(node).filter((k) => !k.startsWith('.') && k !== '$other');
  // The client writes { timestamp }; the backfill adds backfilled. Nothing else.
  assert.deepEqual(children.sort(), ['backfilled', 'timestamp']);
  assert.equal(node.$other?.['.validate'], false, 'the sub-block needs its own strict guard');
  assert.equal(node.timestamp['.validate'], 'newData.val() === now',
    'server sentinel only: a client Date.now() never equals server now (866683d)');
  assert.equal(node.backfilled['.validate'], 'newData.val() === true',
    'only true is storable; live rows omit the marker, like dailyHistory.archive');
  assert.match(node['.validate'], /\$weekStart\.matches/, 'week-shaped keys only');
  assert.match(node['.validate'], /hasChildren\(\['timestamp'\]\)/, 'timestamp is required');
  assert.match(node['.write'], /!data\.exists\(\)/,
    'write-once, so the stamp stays the week\'s FIRST completion');
});

test('the client writer and the backfill both stay inside the whitelist', () => {
  const src = readFileSync(new URL('../src/firebase/firebaseProgress.js', import.meta.url), 'utf8');
  const start = src.indexOf('export function markWeeklyCompleted');
  assert.ok(start > 0, 'markWeeklyCompleted must exist');
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.match(body, /weeklyCompletions\/\$\{weekStart\}/, 'writes the node it claims to');
  assert.match(body, /\.set\(\{ timestamp: _serverTimestamp\(\) \}\)/,
    'exactly { timestamp }, with the server sentinel');
  assert.match(body, /isTestEnvironment\(\)/, 'test sessions never write real progression');

  // The backfill's payload keys must be whitelisted too. The service account
  // bypasses rules at write time, but the whitelist is the record of what may
  // exist at this path, and a key outside it is drift waiting to bite.
  const whitelisted = new Set(Object.keys(node).filter((k) => !k.startsWith('.') && k !== '$other'));
  const payload = backfillPayload();
  for (const k of Object.keys(payload)) {
    assert.ok(whitelisted.has(k), `backfill writes un-whitelisted key "${k}"`);
  }
  assert.equal(payload.backfilled, true);
  assert.deepEqual(payload.timestamp, { '.sv': 'timestamp' }, 'the REST server-sentinel spelling');
});

// ── The heal, with the record (storage-backed) ───────────────────────────
// All dates here are explicit and post- or pre-epoch by construction, so the
// cases cannot age: the epoch is frozen at 2026-08-10.

test('REGRESSION: a past week that was only OPENED banks nothing once the record covers its era', () => {
  fresh();
  // One post-epoch week, attempted (first click) and abandoned, now history.
  assert.equal(reconcileWeekStreakFromHistory(['2026-08-17'], '2026-08-31', []), false);
  assert.deepEqual(getWeekStreakRecord(), { streak: 0, best: 0, lastWeek: null },
    'no streak, and no monotonic best, from a board nobody finished');
});

test('completions bank post-epoch weeks, and a run crossing the epoch derives whole', () => {
  fresh();
  assert.equal(reconcileWeekStreakFromHistory(
    ['2026-07-27', '2026-08-03', '2026-08-17'],   // attempts; 08-17 was abandoned
    '2026-08-31',
    ['2026-08-10'],                               // the completed week
  ), true);
  const rec = getWeekStreakRecord();
  assert.equal(rec.streak, 3, 'two pre-epoch attempts plus the completed 08-10');
  assert.equal(rec.lastWeek, '2026-08-10', 'never the abandoned 08-17');
});

test('the pre-epoch generosity is unchanged: attempted history still restores a run', () => {
  fresh();
  assert.equal(reconcileWeekStreakFromHistory(
    ['2026-07-20', '2026-07-27', '2026-08-03'], '2026-08-31', null), true);
  assert.equal(getWeekStreakRecord().streak, 3);
});

// ── Wiring (source scans) ────────────────────────────────────────────────

test('the win path writes the record, first completion of the week only, inside the archive wall', () => {
  const src = readFileSync(new URL('../src/game/winLossHandler.js', import.meta.url), 'utf8');
  assert.match(src, /const banked = recordWeeklyCompletion\(state\.weeklySeed\);/);
  assert.match(src, /if \(banked\.extended\) markWeeklyCompleted\(state\.weeklySeed\);/,
    'gated on extended: a later completion of an already-banked week must not re-stamp');
  // The call must sit inside the isWeekly && !isWeeklyArchive block, between
  // the streak bank above it and the attempt marker below, both long pinned
  // to that block.
  const call = src.indexOf('markWeeklyCompleted(state.weeklySeed)');
  const wall = src.lastIndexOf('!state.isWeeklyArchive', call);
  assert.ok(wall > 0 && call - wall < 2000, 'the archive wall must cover the completion mark');
});

test('the archive list and the heal read the record, never attempts alone', () => {
  const title = readFileSync(new URL('../src/ui/titleScreen.js', import.meta.url), 'utf8');
  assert.match(title, /fetchCompletedWeeks/);
  assert.ok(!title.includes('fetchPlayedWeeks'),
    'Past Weeklies must not mark done from weeks that were merely opened (#254\'s sibling)');
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const start = main.indexOf('async function _reconcileWeekStreak(');
  assert.ok(start > 0);
  const body = main.slice(start, main.indexOf('\n}', start));
  assert.match(body, /fetchPlayedWeeks\(\)/, 'attempts still feed the pre-epoch half');
  assert.match(body, /fetchCompletedWeeks\(\)/, 'completions feed the post-epoch half');
});

// ── The backfill's decisions ─────────────────────────────────────────────

test('the backfill plans one record per leaderboard row and never clobbers an existing one', () => {
  const weeklyRoot = {
    '2026-05-04': { uidA: { bestTime: 120 }, uidB: { bestTime: 300 } },
    '2026-05-11': { uidA: { bestTime: 99 } },
    'garbage-key': { uidA: { bestTime: 50 } },     // not a weekStart: refused
    '2026-05-18': { uidC: { name: 'x' } },         // no bestTime: refused, not minted
  };
  const existing = new Map([['uidA', new Set(['2026-05-11'])]]);
  const { plan, skippedExisting, skippedMalformed } = planWeeklyCompletionBackfill(weeklyRoot, existing);
  assert.deepEqual(plan, [
    { weekStart: '2026-05-04', uid: 'uidA' },
    { weekStart: '2026-05-04', uid: 'uidB' },
  ]);
  assert.equal(skippedExisting, 1,
    'a record the win path already wrote is skipped, so a re-run never replaces a live stamp');
  assert.equal(skippedMalformed, 2, 'the junk week and the bestTime-less row');
  assert.deepEqual(planWeeklyCompletionBackfill(null).plan, [], 'an empty node plans nothing');
});
