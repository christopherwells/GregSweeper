// Boot completion ↔ cloud reconciliation. The canonical-board cross-client
// divergence path: a wrong-board completion must be cleared so the player can
// replay the real canonical, and a cross-device completion must be adopted so
// the same board can't be finished twice — but a DIVERGENT row must never lock
// a player out of the canonical, and a missing/seedless row must trust the
// local flag (an earlier version cleared on missing-score and unlocked replays).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCompletionReconcile } from '../src/logic/startupReconcilePlan.js';

const UID = 'player-1';
const DATE = '2026-06-23';
const CANON = '2026-06-23:trial3'; // an improvement-day canonical (stored seed)

function rowsWith(...entries) {
  const out = {};
  entries.forEach((e, i) => { out['k' + i] = e; });
  return out;
}

test('no canonical seed or no uid is always a no-op', () => {
  assert.equal(planCompletionReconcile({ rows: null, uid: UID, dateString: DATE, canonicalSeed: null, localCompleted: true }).action, 'noop');
  assert.equal(planCompletionReconcile({ rows: null, uid: null, dateString: DATE, canonicalSeed: CANON, localCompleted: false }).action, 'noop');
});

test('completed locally + the account\'s row is a positively-divergent stored seed → clearLocal', () => {
  const rows = rowsWith({ uid: UID, rngSeed: '2026-06-23:trial7' });
  assert.equal(
    planCompletionReconcile({ rows, uid: UID, dateString: DATE, canonicalSeed: CANON, localCompleted: true }).action,
    'clearLocal');
});

test('completed locally + the account\'s row matches the canonical seed → noop', () => {
  const rows = rowsWith({ uid: UID, rngSeed: CANON });
  assert.equal(
    planCompletionReconcile({ rows, uid: UID, dateString: DATE, canonicalSeed: CANON, localCompleted: true }).action,
    'noop');
});

test('REGRESSION: completed locally + a seedless (plain-date) row trusts local, never clears', () => {
  // A row that omits rngSeed (plain-date board) has no STORED seed to diverge;
  // clearing on it would unlock a replay of an already-finished board.
  const rows = rowsWith({ uid: UID }); // no rngSeed
  assert.equal(
    planCompletionReconcile({ rows, uid: UID, dateString: DATE, canonicalSeed: CANON, localCompleted: true }).action,
    'noop');
});

test('REGRESSION: completed locally + no row at all trusts local (missing-score must not clear)', () => {
  assert.equal(
    planCompletionReconcile({ rows: null, uid: UID, dateString: DATE, canonicalSeed: CANON, localCompleted: true }).action,
    'noop');
  assert.equal(
    planCompletionReconcile({ rows: rowsWith({ uid: 'someone-else', rngSeed: CANON }), uid: UID, dateString: DATE, canonicalSeed: CANON, localCompleted: true }).action,
    'noop');
});

test('not completed + a row matching the canonical effective seed → adoptCompletion', () => {
  const rows = rowsWith({ uid: UID, rngSeed: CANON });
  assert.equal(
    planCompletionReconcile({ rows, uid: UID, dateString: DATE, canonicalSeed: CANON, localCompleted: false }).action,
    'adoptCompletion');
});

test('not completed + a plain-date canonical adopts a seedless row (effective seed = dateString)', () => {
  // Non-improvement day: canonical seed equals the dateString and rows omit
  // rngSeed, so the effective seeds match and the completion is adopted.
  const rows = rowsWith({ uid: UID }); // omitted rngSeed → effective seed = DATE
  assert.equal(
    planCompletionReconcile({ rows, uid: UID, dateString: DATE, canonicalSeed: DATE, localCompleted: false }).action,
    'adoptCompletion');
});

test('REGRESSION: not completed + only a divergent row → noop (a divergent row must not lock out the canonical)', () => {
  const rows = rowsWith({ uid: UID, rngSeed: '2026-06-23:trial7' });
  assert.equal(
    planCompletionReconcile({ rows, uid: UID, dateString: DATE, canonicalSeed: CANON, localCompleted: false }).action,
    'noop');
});

test('not completed + no rows → noop', () => {
  assert.equal(
    planCompletionReconcile({ rows: null, uid: UID, dateString: DATE, canonicalSeed: CANON, localCompleted: false }).action,
    'noop');
});
