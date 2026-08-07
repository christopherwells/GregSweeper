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

// ── The local board seed (2026-08-07) ───────────────────────────────────
// The submit guard (#252) refuses a divergent score, so the divergent ROW the
// clear branch above reads is exactly the row that stopped being written. The
// device therefore has to remember which board it finished.

test('REGRESSION: the local record names a different board → clearLocal with NO cloud row', () => {
  // The live 2026-08-07 shape: canonical :trial5, the player solved :trial3,
  // the submit refused it, so daily/{date} holds only OTHER players' rows.
  // Before the local seed was recorded this returned noop and the player was
  // locked out of the real board for the whole day.
  const rows = rowsWith({ uid: 'someone-else', rngSeed: CANON });
  assert.equal(
    planCompletionReconcile({
      rows, uid: UID, dateString: DATE, canonicalSeed: CANON,
      localCompleted: true, localSeed: '2026-06-23:trial7',
    }).action,
    'clearLocal');
  // And with no rows at all — the case where nobody has submitted yet.
  assert.equal(
    planCompletionReconcile({
      rows: null, uid: UID, dateString: DATE, canonicalSeed: CANON,
      localCompleted: true, localSeed: '2026-06-23:trial7',
    }).action,
    'clearLocal');
});

test('the local record naming the canonical is trusted — no clear, no cloud round trip', () => {
  assert.equal(
    planCompletionReconcile({
      rows: null, uid: UID, dateString: DATE, canonicalSeed: CANON,
      localCompleted: true, localSeed: CANON,
    }).action,
    'noop');
});

// ── The one-time vintage unlock ─────────────────────────────────────────
// For completions recorded BEFORE the seed was stored, "no row for this
// account" is the only evidence left. It is weak — a player with no name set,
// or one whose submission is still queued offline, has no row after finishing
// the real board — so it is spent once, ever.

test('REGRESSION: vintage record + no row for this account → clearLocal (one-time unlock)', () => {
  assert.equal(
    planCompletionReconcile({
      rows: rowsWith({ uid: 'someone-else', rngSeed: CANON }),
      uid: UID, dateString: DATE, canonicalSeed: CANON,
      localCompleted: true, localSeed: null, vintageUnlock: true,
    }).action,
    'clearLocal');
});

test('vintage unlock does NOT fire for a player who has a canonical row', () => {
  // The discriminator that keeps it off everyone who genuinely played the real
  // board. Without it the one-time migration would unlock the daily for the
  // whole player base.
  assert.equal(
    planCompletionReconcile({
      rows: rowsWith({ uid: UID, rngSeed: CANON }),
      uid: UID, dateString: DATE, canonicalSeed: CANON,
      localCompleted: true, localSeed: null, vintageUnlock: true,
    }).action,
    'noop');
});

test('vintage unlock is inert once spent, and inert on a record that names its board', () => {
  // Not granted → the historical missing-row rule applies again.
  assert.equal(
    planCompletionReconcile({
      rows: null, uid: UID, dateString: DATE, canonicalSeed: CANON,
      localCompleted: true, localSeed: null, vintageUnlock: false,
    }).action,
    'noop');
  // Granted but the record names the canonical → the seed wins, no unlock.
  assert.equal(
    planCompletionReconcile({
      rows: null, uid: UID, dateString: DATE, canonicalSeed: CANON,
      localCompleted: true, localSeed: CANON, vintageUnlock: true,
    }).action,
    'noop');
});

test('a vintage-unlocked player is RE-LOCKED by adoptCompletion if the row was really theirs', () => {
  // The safety net behind the one-time migration: the unlock clears the flag,
  // and the very next reconcile re-adopts anyone whose row matches the
  // canonical. This is why a coarse unlock cannot strand a real completion.
  const rows = rowsWith({ uid: UID, rngSeed: CANON });
  assert.equal(
    planCompletionReconcile({
      rows, uid: UID, dateString: DATE, canonicalSeed: CANON, localCompleted: false,
    }).action,
    'adoptCompletion');
});
