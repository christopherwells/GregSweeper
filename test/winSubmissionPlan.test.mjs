// Daily score submission field-parity contract. A daily win submits via two
// paths (auto in winLossHandler, manual in main.js) that pass an identical
// extras object to submitOnlineScore; a field in one but not the other is
// dropped silently (the documented bombHitEvents/rngSeed data-loss). This pins
// the exact field set AND asserts both call sites use the shared builder, so
// the two paths can never drift.

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
    'extras field set changed — update BOTH submit paths and this contract together');
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

test('both submit paths call the shared builder (so they cannot drift)', () => {
  // Source-level guard: the whole point is that neither path hand-rolls the
  // extras object. If someone re-inlines one, this fails.
  const repoRoot = new URL('..', import.meta.url);
  const winLoss = readFileSync(new URL('src/game/winLossHandler.js', repoRoot), 'utf8');
  const main = readFileSync(new URL('src/main.js', repoRoot), 'utf8');
  assert.ok(winLoss.includes('buildDailyScoreExtras('), 'winLossHandler auto-submit must use buildDailyScoreExtras');
  assert.ok(main.includes('buildDailyScoreExtras('), 'main.js manual-submit must use buildDailyScoreExtras');
});
