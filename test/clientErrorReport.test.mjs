// Rolling errors/{uid}/{ts} up into something a person can read.
//
// The node is owner-read, so nothing without the service account can see it,
// and the reporter has been writing into it faithfully for months with no
// reader on the other end. That is why client-side divergence is still
// described in this repo as anecdotal rather than measured.
//
// These pin the two rules the rollup rests on, both of which look trivial and
// neither of which is: where the label actually lives, and what the report
// counts when it says a label is common.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseErrorLabel, stripErrorLabel, summarizePlatform, aggregateErrors,
} from '../scripts/report-client-errors.mjs';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/client-errors.example.json', import.meta.url), 'utf8'));

test('the label is parsed out of the MESSAGE, because that is where it lives', () => {
  // reportCaughtError composes `[caught:<label>] <message>`. There is no label
  // field to read, and the rules whitelist does not have one, so a rollup that
  // looked for row.label would group everything under undefined.
  assert.equal(parseErrorLabel('[caught:daily-canonical-unavailable] no canonical for 2026-08-06'),
    'daily-canonical-unavailable');
  assert.equal(stripErrorLabel('[caught:gate-daily-board-retry] timeout'), 'timeout');
});

test('an unlabelled row is uncaught, not dropped and not lumped with a real label', () => {
  // window.onerror and unhandledrejection write straight through with no
  // prefix. Those are the ones nobody chose to report, so they matter most.
  assert.equal(parseErrorLabel('Uncaught TypeError: undefined is not a function'), 'uncaught');
  assert.equal(parseErrorLabel(''), 'uncaught');
  assert.equal(parseErrorLabel(undefined), 'uncaught');
  assert.equal(parseErrorLabel('[caught:] something'), 'unlabeled');
});

test('platforms are summarized, never printed whole', () => {
  const ios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';
  assert.equal(summarizePlatform(ios, true), 'iOS PWA');
  assert.equal(summarizePlatform(ios, false), 'iOS');
  assert.equal(summarizePlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', false), 'Windows');
  assert.equal(summarizePlatform('', false), 'unknown');
  // Not a credential, but a full UA is a fingerprint and the report only ever
  // needs to know whether a label is an iOS-only story.
  assert.doesNotMatch(summarizePlatform(ios, true), /AppleWebKit/);
});

test('grouping is label x codeVersion, which is the whole question', () => {
  // The same label on an old bundle and on today's code are different
  // findings: one says updates are not reaching a device, the other says the
  // current build has a live problem. Merging them loses exactly that.
  const { groups } = aggregateErrors(FIXTURE, { sinceMs: 0 });
  const canon = groups.filter((g) => g.label === 'daily-canonical-unavailable');
  assert.equal(canon.length, 2, 'one group per code version');
  assert.deepEqual(canon.map((g) => g.codeVersion).sort(),
    ['gregsweeper-v1.10.14', 'gregsweeper-v1.10.9']);
});

test('ranking counts DISTINCT ACCOUNTS first, not events', () => {
  // One player in a retry loop can write ten rows in a session (the reporter's
  // own per-session cap), so ranking by event count would put a single bad
  // afternoon above a label ten different people hit once.
  const node = {
    loud: Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [String(1754600000000 + i),
        { message: '[caught:loop] x', codeVersion: 'v1', createdAt: 1754600000000 + i }]),
    ),
  };
  for (let i = 0; i < 3; i++) {
    node[`quiet${i}`] = {
      '1754600000000': { message: '[caught:widespread] y', codeVersion: 'v1', createdAt: 1754600000000 },
    };
  }
  const { groups } = aggregateErrors(node, { sinceMs: 0 });
  assert.equal(groups[0].label, 'widespread',
    '3 accounts once each must outrank 1 account nine times');
  assert.equal(groups[0].uids, 3);
  assert.equal(groups[1].events, 9, 'and the loud one still reports its event count honestly');
});

test('the window uses the SERVER stamp, so a wrong device clock cannot hide a row', () => {
  // The path key is the client's Date.now(); createdAt is the server sentinel.
  // Preferring the key would let a device with a skewed clock sort itself out
  // of every window it should appear in.
  const node = {
    u: { 1: { message: '[caught:x] y', codeVersion: 'v1', createdAt: 1754600000000 } },
  };
  const recent = aggregateErrors(node, { sinceMs: 1754500000000 });
  assert.equal(recent.total, 1, 'a bogus key must not exclude a row the server stamped in-window');
  const older = aggregateErrors(node, { sinceMs: 1754700000000 });
  assert.equal(older.total, 0);
  assert.equal(older.skippedOld, 1, 'and a row outside the window is counted, not silently vanished');
});

test('the label filter narrows without changing the rest of the shape', () => {
  const all = aggregateErrors(FIXTURE, { sinceMs: 0 });
  const one = aggregateErrors(FIXTURE, { sinceMs: 0, label: 'daily-canonical-unavailable' });
  assert.ok(one.total < all.total && one.total === 2);
  assert.ok(one.groups.every((g) => g.label === 'daily-canonical-unavailable'));
});

test('a junk node yields an empty report rather than throwing', () => {
  // This runs unattended in a workflow; a malformed row must not take the run
  // down and hide every well-formed one alongside it.
  for (const node of [null, undefined, {}, { u: null }, { u: { 1: null } }, { u: 'nope' }]) {
    const r = aggregateErrors(node, { sinceMs: 0 });
    assert.equal(r.total, 0);
    assert.deepEqual(r.groups, []);
  }
});
