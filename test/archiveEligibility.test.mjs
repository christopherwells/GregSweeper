// Daily archive eligibility contract. Pins the two pure gates that decide
// (1) which past dates the calendar offers and (2) what an archive
// completion writes. Both feed real Firebase writes and the par fit, so a
// silent change here would either lose fit data or double-count it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isArchivableDate,
  archiveSubmitPlan,
  FIRST_ARCHIVE_DATE,
  ARCHIVE_FIT_EPOCH,
} from '../src/logic/archiveEligibility.js';

test('constants: first archive date and fit epoch are the documented anchors', () => {
  // 2026-03-06 is the app launch (boards before 04-27 were regenerated and
  // backfilled); 2026-05-07 is the dailyHistory ship. Changing either
  // silently widens or narrows the archive.
  assert.equal(FIRST_ARCHIVE_DATE, '2026-03-06');
  assert.equal(ARCHIVE_FIT_EPOCH, '2026-05-07');
  // The epoch can never precede the first archivable date, or a date could be
  // offered yet never able to earn a fit row for a reason that is not the
  // epoch's intent.
  assert.ok(ARCHIVE_FIT_EPOCH >= FIRST_ARCHIVE_DATE);
});

test('isArchivableDate: stored past dates only, today and the future excluded', () => {
  const today = '2026-06-14';
  // A normal past date inside the window.
  assert.equal(isArchivableDate('2026-05-10', today), true);
  // The first archivable date (app launch) is inclusive.
  assert.equal(isArchivableDate(FIRST_ARCHIVE_DATE, today), true);
  // The day before launch was never a daily at all.
  assert.equal(isArchivableDate('2026-03-05', today), false);
  // Dates before canonical storage (04-27) are now offered too — their
  // boards were regenerated and backfilled.
  assert.equal(isArchivableDate('2026-04-26', today), true);
  // Today is the live Daily's job, never the archive's.
  assert.equal(isArchivableDate(today, today), false);
  // The future is never archivable.
  assert.equal(isArchivableDate('2026-06-15', today), false);
});

test('isArchivableDate: non-string inputs are rejected, not coerced', () => {
  assert.equal(isArchivableDate(null, '2026-06-14'), false);
  assert.equal(isArchivableDate('2026-05-10', undefined), false);
  assert.equal(isArchivableDate(20260510, '2026-06-14'), false);
});

test('archiveSubmitPlan: a replay (history present) records nothing', () => {
  // First completion wins: a second run on a date the player already
  // finished (live or archived) must not submit a fit row or rewrite history.
  assert.deepEqual(archiveSubmitPlan('2026-05-10', 'present'),
    { submitFit: false, writeHistory: false });
  // Even a pre-epoch replay records nothing.
  assert.deepEqual(archiveSubmitPlan('2026-04-28', 'present'),
    { submitFit: false, writeHistory: false });
});

test('archiveSubmitPlan: a fresh post-epoch date submits a fit row and writes history', () => {
  assert.deepEqual(archiveSubmitPlan('2026-05-10', 'absent'),
    { submitFit: true, writeHistory: true });
  // The epoch is inclusive: a play exactly on the epoch still feeds the fit.
  assert.deepEqual(archiveSubmitPlan(ARCHIVE_FIT_EPOCH, 'absent'),
    { submitFit: true, writeHistory: true });
});

test('archiveSubmitPlan: a fresh pre-epoch date records history but never a fit row', () => {
  // The board predates per-user history, so a live play could have left no
  // row to dedupe against. It stays playable and chartable, but out of the
  // fit so it can never double-count.
  assert.deepEqual(archiveSubmitPlan('2026-05-06', 'absent'),
    { submitFit: false, writeHistory: true });
  assert.deepEqual(archiveSubmitPlan(FIRST_ARCHIVE_DATE, 'absent'),
    { submitFit: false, writeHistory: true });
});

test('REGRESSION: archiveSubmitPlan fails closed when the history read is unknown', () => {
  // A failed/early dailyHistory read used to return null and be treated as
  // "no prior completion" (fail-open), so a flaky read on a REPLAY double-fed
  // the par fit (push-keyed dailyArchive rows don't overwrite) and overwrote
  // the first-completion chart row. 'unknown' must now record NOTHING, even on
  // a post-epoch date that would otherwise feed the fit.
  assert.deepEqual(archiveSubmitPlan('2026-05-10', 'unknown'),
    { submitFit: false, writeHistory: false });
  assert.deepEqual(archiveSubmitPlan('2026-04-28', 'unknown'),
    { submitFit: false, writeHistory: false });
  // Any non-'absent' status is treated as "do not record" — defends against a
  // future caller passing an unexpected value (fail closed, never open).
  assert.deepEqual(archiveSubmitPlan('2026-05-10', undefined),
    { submitFit: false, writeHistory: false });
});
