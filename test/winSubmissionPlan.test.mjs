// Daily score submission field-parity contract. A daily win submits from ONE
// place (auto in winLossHandler) via the shared buildDailyScoreExtras — a field
// missing from that extras object is dropped silently (the documented
// bombHitEvents/rngSeed data-loss). This pins the exact field set AND asserts
// the submit path uses the shared builder (never a hand-rolled extras).
//
// (Until the name-gate change there were TWO paths — the second was a
// dismissible manual name form in main.js that also submitted; it was removed
// once a nameless daily is gated before the end card, leaving one path.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDailyScoreExtras } from '../src/logic/winSubmissionPlan.js';

const FIELDS = ['uid', 'par', 'features', 'bombHitEvents', 'hintEvents', 'rngSeed', 'totalMines'];

test('the extras payload carries exactly the contracted field set', () => {
  const state = {
    dailyPar: 90, dailyFeatures: { rows: 9 }, dailyBombHitEvents: [{ t: 1 }],
    hintEvents: [{ t: 2, kind: 'region' }], dailyRngSeed: '2026-06-23:trial1', totalMines: 20,
  };
  const extras = buildDailyScoreExtras(state, '2026-06-23', 'uid-1');
  assert.deepEqual(Object.keys(extras).sort(), [...FIELDS].sort(),
    'extras field set changed — update the submit path and this contract together');
  assert.equal(extras.uid, 'uid-1');
  assert.equal(extras.par, 90);
  assert.deepEqual(extras.features, { rows: 9 });
  assert.deepEqual(extras.bombHitEvents, [{ t: 1 }]);
  assert.deepEqual(extras.hintEvents, [{ t: 2, kind: 'region' }]);
  assert.equal(extras.rngSeed, '2026-06-23:trial1');
  assert.equal(extras.totalMines, 20);
});

test('bombHitEvents and hintEvents default to empty arrays, rngSeed falls back to dateStr', () => {
  const extras = buildDailyScoreExtras({ dailyPar: 60, dailyFeatures: null, totalMines: 10 }, '2026-06-23', 'uid-2');
  assert.deepEqual(extras.bombHitEvents, []);
  assert.deepEqual(extras.hintEvents, []);
  assert.equal(extras.rngSeed, '2026-06-23', 'a plain-date board reports its date as the seed');
  assert.deepEqual(Object.keys(extras).sort(), [...FIELDS].sort());
});

test('the daily submit path uses the shared builder (no hand-rolled extras)', () => {
  // Source-level guard: the auto-submit path must not hand-roll the extras
  // object. If someone re-inlines it, this fails.
  const repoRoot = new URL('..', import.meta.url);
  const winLoss = readFileSync(new URL('src/game/winLossHandler.js', repoRoot), 'utf8');
  assert.ok(winLoss.includes('buildDailyScoreExtras('), 'winLossHandler auto-submit must use buildDailyScoreExtras');
});
