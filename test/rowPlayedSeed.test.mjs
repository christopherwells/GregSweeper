// Which seed did this score row play, and when can that not be answered?
//
// The nightly sweep compares every score row against its board's canonical.
// Until 2026-08-07 it walked one family of the three that exist, and it walked
// it in a way that silently dropped a second:
//
//   daily/{date}/{pushId}                  — the day-of rows, checked
//   daily/{weekStart}_weekly_first/{pushId} — the fit rows, SKIPPED
//   weekly/{weekStart}/{uid}                — the leaderboard, not looked at
//
// The fit rows were skipped rather than reported, which is worse: the seed was
// looked up at `dailyBoard/{weekStart}_weekly_first`, a node that does not
// exist, so the "no canonical to compare against" guard dropped all 36 of them
// while the run printed a clean line. That is the same defect canonicalSeedPath
// was extracted to fix on the submit side (#260).
//
// The rule below is the other half. It is pure because the alternative is a
// fourth source scan over a script, and CLAUDE.md's own remedy for a guard that
// never executes is to extract the decision and test the decision.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowPlayedSeed, effectiveRowSeed } from '../src/logic/scoreRowMatch.js';

const WEEK = '2026-08-03';
const FIRST = `${WEEK}_weekly_first`;

test('a stored seed is used verbatim, in every family', () => {
  assert.deepEqual(rowPlayedSeed('daily', '2026-08-07', { rngSeed: '2026-08-07:trial5' }), { seed: '2026-08-07:trial5' });
  assert.deepEqual(rowPlayedSeed('daily', FIRST, { rngSeed: `${WEEK}:trial2` }), { seed: `${WEEK}:trial2` });
  assert.deepEqual(rowPlayedSeed('weekly', WEEK, { rngSeed: `${WEEK}:trial2` }), { seed: `${WEEK}:trial2` });
});

test('a daily row with no seed means the plain date, which is the writer\'s convention', () => {
  // _doSubmitOnlineScore omits rngSeed when it equals the dateString, so an
  // absent one here is information, not a gap.
  assert.deepEqual(rowPlayedSeed('daily', '2026-08-07', { name: 'x' }), { seed: '2026-08-07' });
  // And it agrees with the function that has always encoded that convention.
  assert.equal(rowPlayedSeed('daily', '2026-08-07', {}).seed, effectiveRowSeed({}, '2026-08-07'));
});

test('REGRESSION: a weekly-first row with no seed is UNVERIFIABLE, never the bucket key', () => {
  // The bucket key is '{weekStart}_weekly_first', which is not a board seed and
  // never equals one. Applying the daily convention here would report every
  // single fit row as divergent — an alarm that fires 36 times is not an alarm.
  assert.deepEqual(rowPlayedSeed('daily', FIRST, {}), { unverifiable: 'weeklyFirst' });
  assert.notEqual(rowPlayedSeed('daily', FIRST, {}).seed, FIRST);
});

test('REGRESSION: a weekly row with no seed is UNVERIFIABLE, not "played the plain seed"', () => {
  // The weekly writer stores rngSeed whenever it has one and omits nothing by
  // convention (#262), so absent means the row predates the guard. Measured
  // against production on 2026-08-07: 34 of 36 weekly rows are in this state.
  assert.deepEqual(rowPlayedSeed('weekly', WEEK, {}), { unverifiable: 'weekly' });
  assert.deepEqual(rowPlayedSeed('weekly', WEEK, { rngSeed: '' }), { unverifiable: 'weekly' });
});

test('unverifiable is distinguishable from clean, which is the whole point', () => {
  // A helper that returned a seed for every input would satisfy a sweep that
  // only asked "did it match", and the sweep would then report a green line
  // over rows it had not checked.
  const outcomes = [
    rowPlayedSeed('daily', '2026-08-07', {}),
    rowPlayedSeed('daily', FIRST, {}),
    rowPlayedSeed('weekly', WEEK, {}),
  ];
  assert.equal(outcomes.filter((o) => o.unverifiable).length, 2);
  assert.equal(outcomes.filter((o) => o.seed).length, 1);
});

test('a junk row never yields a junk seed', () => {
  for (const row of [null, undefined, {}, { rngSeed: 42 }, { rngSeed: null }]) {
    const out = rowPlayedSeed('weekly', WEEK, row);
    assert.equal(out.unverifiable, 'weekly', `weekly row ${JSON.stringify(row)} must be unverifiable`);
  }
  assert.equal(rowPlayedSeed('daily', '2026-08-07', { rngSeed: 42 }).seed, '2026-08-07',
    'a non-string seed falls back to the daily convention rather than comparing a number');
});
