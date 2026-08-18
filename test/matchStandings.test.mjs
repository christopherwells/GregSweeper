// The Challenge match's comparison surface and its fit rows.
//
// Both are decisions, not rendering: which player leads a live match, and
// which cleared boards become par-fit rows. They live in a pure module so a
// test can hand them inputs and read the answer, rather than a reviewer
// grepping a Firebase callback for the string that looks right.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchStandings, matchFinishedCount, matchFitRows, columnLeader, MATCH_FIT_MIN_TIME } from '../src/logic/matchStandings.js';
import { matchRowKey } from '../src/logic/matchCodes.js';

const node = (players, boards = 3) => ({
  host: 'host',
  boards: Array.from({ length: boards }, (_, i) => ({ seed: `s${i}` })),
  players,
});
const results = (...times) => times.map((t) => ({ time: t, penalty: 0, strikes: 0 }));

// ── Standings ───────────────────────────────────────────────────────────

test('ranks by ADJUSTED time, not raw (his adjusted-only ruling for the mode)', () => {
  // Slower on the clock but rated slower too, so the adjusted comparison
  // reverses the raw one. That reversal IS the ruling.
  const rows = matchStandings(node({
    fast: { name: 'Fast', results: results(30, 30, 30), finishedAt: 1 },
    slow: { name: 'Slow', results: results(45, 45, 45), finishedAt: 1 },
  }), { handicaps: { fast: 1.0, slow: 2.0 } });
  assert.deepEqual(rows.map((r) => r.name), ['Slow', 'Fast']);
  assert.equal(rows[0].adjusted, 67.5);   // 135 / 2.0
  assert.equal(rows[1].adjusted, 90);     // 90 / 1.0
});

test('an unrated player ranks on the raw clock and SAYS so', () => {
  const rows = matchStandings(node({
    rated: { name: 'Rated', results: results(60), finishedAt: 1 },
    plain: { name: 'Plain', results: results(50), finishedAt: 1 },
  }), { handicaps: { rated: 1.0 } });
  const plain = rows.find((r) => r.name === 'Plain');
  assert.equal(plain.rated, false, 'an unrated row must admit it');
  assert.equal(plain.adjusted, 50, 'and rank on its raw total, never a pretend rating');
});

test('FINISHED players sort above unfinished ones, whatever their partial total', () => {
  // The trap this exists to stop: a running total over one board is smaller
  // than a real total over three, so sorting them together would put whoever
  // has played least on top of the standings.
  const rows = matchStandings(node({
    done: { name: 'Done', results: results(30, 30, 30), finishedAt: 1 },
    started: { name: 'Started', results: results(5) },
  }), { handicaps: {} });
  assert.deepEqual(rows.map((r) => r.name), ['Done', 'Started']);
  assert.equal(rows[1].done, 1);
  assert.equal(rows[1].of, 3);
});

test('among unfinished players, the further along leads', () => {
  const rows = matchStandings(node({
    a: { name: 'A', results: results(90) },
    b: { name: 'B', results: results(40, 40) },
  }), { handicaps: {} });
  assert.deepEqual(rows.map((r) => r.name), ['B', 'A']);
});

test('finished is true when every board is banked, even with no finishedAt', () => {
  // The two writes can be split by a failure between them, so banking all of
  // them counts on its own.
  const rows = matchStandings(node({
    a: { name: 'A', results: results(10, 10, 10) },
  }), { handicaps: {} });
  assert.equal(rows[0].finished, true);
  assert.equal(matchFinishedCount(rows), 1);
});

test('times are LIVE for everyone, finished or not (his ruling)', () => {
  // No viewer argument reaches the ranking at all: there is no gate here to
  // accidentally leave open or closed.
  const n = node({
    them: { name: 'Them', results: results(20, 20, 20), finishedAt: 1 },
    me: { name: 'Me', results: results(25) },
  });
  for (const myUid of ['me', 'them', null]) {
    const rows = matchStandings(n, { handicaps: {}, myUid });
    assert.equal(rows.find((r) => r.name === 'Them').time, 60,
      'a finished opponent\'s total shows regardless of who is looking');
  }
});

test('marks the viewer, and the host', () => {
  const rows = matchStandings(node({
    host: { name: 'H', results: [] },
    me: { name: 'M', results: [] },
  }), { handicaps: {}, myUid: 'me' });
  assert.equal(rows.find((r) => r.uid === 'me').isMe, true);
  assert.equal(rows.find((r) => r.uid === 'host').isHost, true);
});

test('a garbage or empty node produces no rows rather than throwing', () => {
  for (const bad of [null, undefined, {}, { players: null }, { players: 'x' }]) {
    assert.deepEqual(matchStandings(bad, {}), []);
  }
  // A player entry with no results is a joiner who has not started.
  const rows = matchStandings(node({ a: { name: 'A' } }), {});
  assert.equal(rows[0].done, 0);
  assert.equal(rows[0].finished, false);
});

test('a nameless player row still renders, and never as undefined', () => {
  const rows = matchStandings(node({ a: { results: results(10) } }), {});
  assert.equal(rows[0].name, 'Player');
});

// ── Fit rows ────────────────────────────────────────────────────────────

const entry = (seed, mines = 10) => ({
  seed,
  par: 60,
  spec: { shape: 'rect', cells: 81, mines },
  features: { rows: 9, cols: 9, cellCount: 81, totalMines: mines },
  payload: {},
});

test('one row per cleared board, keyed off the board SEED', () => {
  const entries = [entry('seed-a'), entry('seed-b')];
  const { rows } = matchFitRows(entries, [
    { time: 40.25, strikes: 1, par: 60, bombHitEvents: [{ t: 1 }], wormEvents: [] },
    { time: 55, strikes: 0, par: 60 },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].key, matchRowKey('seed-a'));
  assert.equal(rows[1].key, matchRowKey('seed-b'));
  assert.equal(rows[0].time, 40.3, 'times round to a tenth, like every other row family');
  assert.equal(rows[0].bombHits, 1);
  assert.equal(rows[0].totalMines, 10, 'the anti-cheat denominator rides the row');
  assert.deepEqual(rows[0].features, entries[0].features);
});

test('the same board in two different matches files under the SAME key', () => {
  // This is the property the per-shape fit is starved of: four people playing
  // one Kites board across two matches is four observations of one board, not
  // four unrelated keys. It is also why the key is the seed and not page:idx,
  // which a full library rebuild re-sorts.
  const a = matchFitRows([entry('shared-seed')], [{ time: 30 }]).rows[0];
  const b = matchFitRows([entry('shared-seed')], [{ time: 44 }]).rows[0];
  assert.equal(a.key, b.key);
  assert.notEqual(a.time, b.time);
});

test('an unplayed board files nothing, and does not shift the others', () => {
  const { rows, unplayed } = matchFitRows(
    [entry('a'), entry('b'), entry('c')],
    [{ time: 30 }, null, { time: 50 }],
  );
  assert.equal(unplayed, 1);
  assert.deepEqual(rows.map((r) => r.key), [matchRowKey('a'), matchRowKey('c')]);
});

test('a board cleared under the row family\'s five-second floor is COUNTED, not silently dropped', () => {
  // The daily/$entry rule refuses time < 5, so such a row could never land.
  // Reporting the count is what makes a change in how often it happens
  // visible, instead of a left-censoring nobody can see.
  const { rows, tooFast } = matchFitRows([entry('a'), entry('b')], [
    { time: MATCH_FIT_MIN_TIME - 0.1 },
    { time: MATCH_FIT_MIN_TIME },
  ]);
  assert.equal(tooFast, 1);
  assert.equal(rows.length, 1, 'exactly at the floor is admitted');
});

test('an entry with no features files nothing: a row that cannot join the fit is not a row', () => {
  const bare = { seed: 'x', spec: { shape: 'rect', cells: 9, mines: 1 }, payload: {} };
  assert.equal(matchFitRows([bare], [{ time: 30 }]).rows.length, 0);
});

test('garbage in, empty out, never a throw', () => {
  for (const [e, r] of [[null, null], [undefined, []], ['x', 'y'], [[], null]]) {
    assert.deepEqual(matchFitRows(e, r).rows, []);
  }
});

// ── columnLeader: who the totals rows paint green (his ask 2026-08-16) ──

test('columnLeader picks the best FINISHED value; unfinished never competes', () => {
  const rows = [
    { uid: 'a', finished: true, time: 200, adjusted: 100 },
    { uid: 'b', finished: true, time: 180, adjusted: 120 },
    { uid: 'c', finished: false, time: 20, adjusted: 10 },  // partial, not a total
  ];
  // Raw and adjusted can lead to different players, and both greens show.
  assert.deepEqual(columnLeader(rows, 'time'), { value: 180, uids: ['b'], tied: false });
  assert.deepEqual(columnLeader(rows, 'adjusted'), { value: 100, uids: ['a'], tied: false });
});

test('columnLeader stays silent under two finished players, and flags a tie', () => {
  // A green on the only posted total would claim a win over nobody.
  assert.equal(columnLeader([{ uid: 'a', finished: true, time: 100 }], 'time'), null);
  assert.equal(columnLeader([], 'time'), null);
  const tie = columnLeader([
    { uid: 'a', finished: true, adjusted: 90 },
    { uid: 'b', finished: true, adjusted: 90 },
  ], 'adjusted');
  assert.equal(tie.tied, true, 'a tie leads nobody; the painter styles it as tied');
  assert.deepEqual(tie.uids, ['a', 'b']);
});

// ── The summary read (issue #331) ────────────────────────────────────────
// The review list fetches rules and players, never the frozen board
// payloads (a ten-board node runs 18-148 KB and the list reads three lines
// of it). A summary-shaped node carries NO boards array, so the board count
// resolves through matchBoardCountOf's rules.count fallback, which the
// rules REQUIRE on every node ever written.

test('matchBoardCountOf: boards array wins, rules.count covers a summary, junk reads 0', async () => {
  const { matchBoardCountOf } = await import('../src/logic/matchRules.js');
  assert.equal(matchBoardCountOf({ boards: [1, 2, 3], rules: { count: 5 } }), 3,
    'the dealt list is the ground truth where present');
  assert.equal(matchBoardCountOf({ rules: { count: 5 } }), 5, 'a summary falls back to rules.count');
  assert.equal(matchBoardCountOf({ rules: { count: 99 } }), 0, 'an out-of-band count is refused');
  assert.equal(matchBoardCountOf({}), 0);
  assert.equal(matchBoardCountOf(null), 0);
});

test('matchStandings works on a summary node: of from rules.count, finished via finishedAt', () => {
  const summary = {
    host: 'host-uid-1234567890',
    rules: { count: 4 },
    players: {
      'host-uid-1234567890': { name: 'Host', results: [{ timeSec: 60 }, { timeSec: 70 }], finishedAt: 0 },
      'guest-uid-123456789': { name: 'Guest', results: [{ timeSec: 50 }], finishedAt: 1234 },
    },
  };
  const rows = matchStandings(summary, { myUid: 'host-uid-1234567890' });
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.of, 4, 'the board count must come from rules.count on a summary');
  }
  const guest = rows.find((r) => r.uid === 'guest-uid-123456789');
  assert.equal(guest.finished, true, 'finishedAt still resolves finished with no boards array');
});

test('the review list and the invite card fetch summaries, never whole nodes (source scan)', async () => {
  const { readFileSync } = await import('node:fs');
  const fb = readFileSync(new URL('../src/firebase/firebaseMatch.js', import.meta.url), 'utf8');
  // PR 6 moved the mapping into fetchMatchSummaries so the paged finished
  // list shares it; the contract is unchanged: list rows go through the
  // summary fetch, and only real opens read whole nodes.
  assert.match(fb, /rows\.map\(\(r\) => fetchMatchSummary\(r\.matchId, opts\)\)/,
    'fetchMatchSummaries must map rows through fetchMatchSummary');
  assert.match(fb, /return fetchMatchSummaries\(refs\.slice\(0, limit\), opts\)/,
    'fetchMyMatches must page refs through fetchMatchSummaries');
  const lobby = readFileSync(new URL('../src/ui/matchLobby.js', import.meta.url), 'utf8');
  assert.match(lobby, /m\.fetchMatchSummary\(invite\.matchId\)/,
    'the invite offer reads the summary');
  // The full-node fetch survives ONLY where boards are dealt or installed.
  assert.doesNotMatch(fb, /rows\.map\(\(r\) => fetchMatch\(/,
    'the list path must never fetch whole nodes again');
});

// ── Issue #372: a row the fit would misread is refused, not filed ───────
//
// The payload writes `totalBombPenalty` only alongside per-hit events, and
// the R side reads `bombHits > 0 && totalBombPenalty == 0` as the RETIRED
// +10s/re-fog cohort, charging LEGACY_BOMB_RATE (15s a hit) against a true
// ramped cost of 3n + 0.75n(n-1). A cross-device resume rebuilds its earlier
// boards from the match node, which whitelists only {time, penalty, strikes},
// so those boards arrive with strikes and no events. Filing them poisons the
// per-shape coefficients on exactly the library boards Challenge exists to
// price, so they are refused instead.

test('REGRESSION #372: a board with strikes but no events files NO fit row', () => {
  const entries = [
    { seed: 's-clean', features: { cellCount: 80 }, spec: { mines: 12 } },
    { seed: 's-lost', features: { cellCount: 80 }, spec: { mines: 12 } },
    { seed: 's-kept', features: { cellCount: 80 }, spec: { mines: 12 } },
  ];
  const results = [
    // Clean board, no strikes: needs no events and files normally.
    { time: 44, strikes: 0, bombHitEvents: [] },
    // Rebuilt from the node: strikes survived, the events did not.
    { time: 70, strikes: 3 },
    // Played on this device: strikes AND events.
    { time: 66, strikes: 2, bombHitEvents: [{ t: 3, row: 1, col: 1, penalty: 3 }] },
  ];
  const out = matchFitRows(entries, results);
  const seeds = out.rows.map((r) => r.seed);
  assert.deepEqual(seeds, ['s-clean', 's-kept'],
    'the event-less strike row must be refused, the other two filed');
  assert.equal(out.eventless, 1, 'and the refusal is COUNTED, never silent');
  // The kept row still carries what it had.
  const kept = out.rows.find((r) => r.seed === 's-kept');
  assert.equal(kept.bombHits, 2);
  assert.equal(kept.bombHitEvents.length, 1);
});

// ── The provisional par must survive the deal (his report, 2026-08-18) ───
//
// He played an oversized honeycomb board and the end card showed a par of
// 10704s, 178 minutes, against his 11. No stored board is priced anywhere
// near that (the highest anywhere is 1789s), because the client RE-PRICED the
// stored features through predictPar at deal time. That re-price is right for
// a board the model has data at and exactly wrong past a shape's fit ceiling,
// which is the whole reason the lane stores an anchored par instead. The flag
// has to reach the consumer for the consumer to respect it.

test('REGRESSION: certifyStoredBoard carries parProvisional to the deal', async () => {
  const src = readFileSync(new URL('../src/game/climbDeal.js', import.meta.url), 'utf8');
  assert.ok(/parProvisional:\s*pick\.parProvisional === true/.test(src),
    'the certifier must carry the flag, or the consumer cannot tell an anchored par from a measured one');
  // And the consumer must actually branch on it.
  const actions = readFileSync(new URL('../src/game/gameActions.js', import.meta.url), 'utf8');
  assert.ok(/res\.parProvisional !== true/.test(actions),
    'the match re-price must skip a provisionally priced board');
});

test('REGRESSION: the match node whitelists parProvisional, so a guest sees the host price', () => {
  const rules = JSON.parse(readFileSync(new URL('../firebase-rules.json', import.meta.url), 'utf8'));
  const board = rules.rules.matches.$matchId.boards.$idx;
  assert.equal(board.$other['.validate'], false, 'the board whitelist must stay closed');
  const allowed = Object.keys(board).filter((k) => !k.startsWith('.') && k !== '$other');
  assert.ok(allowed.includes('parProvisional'),
    'the node carries parProvisional but the rules would refuse it, dropping the WHOLE match write');
});
