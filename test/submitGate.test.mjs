// The submit gate, tested by BEHAVIOR.
//
// This file exists because test/divergenceGuards.test.mjs does not do this
// job. That file carries 22 assertions and imports no application code: it
// proves the string `return 'divergent'` sits near a read of the canonical
// seed. It cannot tell you that a divergent seed produces that outcome, that a
// matching one does not, or that a failed read falls open rather than eating a
// real score. Those are the properties the leaderboard's integrity actually
// rests on, and until now nothing executed them.
//
// The source scans stay where they are, as structural backstops. This is the
// other half.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planScoreSubmission, canonicalSeedPath } from '../src/logic/submitGate.js';

const UID = 'player-1';
const DATE = '2026-08-07';
const CANON = '2026-08-07:trial5';
const OTHER = '2026-08-07:trial3';

const rowsWith = (...entries) => Object.fromEntries(entries.map((e, i) => ['k' + i, e]));
const verdict = (over = {}) => planScoreSubmission({
  rows: null, uid: UID, bucketKey: DATE, playedSeed: CANON, canonicalSeed: CANON, ...over,
}).verdict;

// ── Divergence ───────────────────────────────────────────────────────────

test('a board that is not the day\'s canonical is refused', () => {
  // The live 2026-08-07 shape: canonical :trial5, played :trial3.
  assert.equal(verdict({ playedSeed: OTHER }), 'divergent');
});

test('the canonical board proceeds', () => {
  assert.equal(verdict(), 'proceed');
});

test('a plain-date board proceeds against a plain-date canonical', () => {
  // Non-experiment day: both seeds are the bare date.
  assert.equal(verdict({ playedSeed: DATE, canonicalSeed: DATE }), 'proceed');
});

test('REGRESSION: an unreadable canonical FAILS OPEN, it is not a mismatch', () => {
  // The property that keeps a Firebase hiccup from silently eating scores.
  // Expressed as null so a caller cannot turn an outage into a refusal.
  assert.equal(verdict({ canonicalSeed: null }), 'proceed');
  assert.equal(verdict({ canonicalSeed: undefined }), 'proceed');
  assert.equal(verdict({ canonicalSeed: '' }), 'proceed');
  // And a non-string value from a malformed node is not a mismatch either.
  assert.equal(verdict({ canonicalSeed: 12345 }), 'proceed');
});

// ── Dedupe ───────────────────────────────────────────────────────────────

test('a second submission on the same board reports duplicate', () => {
  const rows = rowsWith({ uid: UID, rngSeed: CANON });
  assert.equal(verdict({ rows }), 'duplicate');
});

test('another player\'s row on the same board does not block this one', () => {
  const rows = rowsWith({ uid: 'someone-else', rngSeed: CANON });
  assert.equal(verdict({ rows }), 'proceed');
});

test('dedupe matches the BOARD, so a practice row never blocks the real daily', () => {
  // A ?seed= practice row lands in the same bucket under the same uid, with the
  // custom seed stored. It describes a different board, so it must not dedupe.
  const rows = rowsWith({ uid: UID, rngSeed: 'my-practice-seed' });
  assert.equal(verdict({ rows }), 'proceed');
});

test('a row that OMITS rngSeed is read as the bucket key (effective seed)', () => {
  // Rows omit rngSeed when it equals the date, so a plain-date replay must
  // still dedupe against one.
  const rows = rowsWith({ uid: UID }); // no rngSeed
  assert.equal(verdict({ rows, playedSeed: DATE, canonicalSeed: DATE }), 'duplicate');
  // ...and must NOT dedupe against a trial board, which is a different board.
  assert.equal(verdict({ rows, playedSeed: CANON, canonicalSeed: CANON }), 'proceed');
});

test('REGRESSION: unreadable rows FAIL OPEN', () => {
  assert.equal(verdict({ rows: null }), 'proceed');
});

test('no uid means nothing to dedupe against, and divergence still applies', () => {
  const rows = rowsWith({ uid: UID, rngSeed: CANON });
  assert.equal(verdict({ rows, uid: null }), 'proceed');
  assert.equal(verdict({ rows, uid: null, playedSeed: OTHER }), 'divergent');
});

test('dedupe is checked BEFORE divergence', () => {
  // A player who already has a row for this board learns that, rather than
  // being told about a board they are not submitting.
  const rows = rowsWith({ uid: UID, rngSeed: OTHER });
  assert.equal(verdict({ rows, playedSeed: OTHER }), 'duplicate');
});

// ── Which canonical to compare against ───────────────────────────────────

test('REGRESSION: a weekly-first bucket reads the WEEKLY canonical', () => {
  // The daily guard read dailyBoard/{key}/rngSeed for every bucket. For
  // `{weekStart}_weekly_first` that node does not exist, so the read returned
  // null, `typeof null !== 'string'`, and the check was skipped — the guard
  // silently no-opped on every weekly fit row ever submitted.
  assert.equal(canonicalSeedPath('2026-08-03_weekly_first'), 'weeklyBoard/2026-08-03/rngSeed');
});

test('an ordinary date reads the daily canonical', () => {
  assert.equal(canonicalSeedPath(DATE), `dailyBoard/${DATE}/rngSeed`);
});

test('the two paths are never the same node for the same week', () => {
  // Non-vacuity: if a refactor collapsed these, the weekly rows would go back
  // to being compared against a node that does not exist.
  assert.notEqual(canonicalSeedPath('2026-08-03_weekly_first'), canonicalSeedPath('2026-08-03'));
});
