// Canonical-board integrity sweep (the #114 detection layer). The sweep is
// only worth its alarm if it actually bites on tampering, so these pin: real
// shipped canonicals PASS, and each tamper class FAILS with the right reason.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { verifyCanonicalPayload, verifyCruxPayload } =
  await import('../scripts/verify-canonical-boards.mjs');

const dailyRaw = JSON.parse(readFileSync(new URL('./fixtures/dailyBoard-2026-06-14.json', import.meta.url), 'utf8'));
const weeklyRaw = JSON.parse(readFileSync(new URL('./fixtures/weeklyBoard-2026-05-25.json', import.meta.url), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

test('real shipped canonicals verify clean (daily + weekly)', () => {
  assert.equal(verifyCanonicalPayload(dailyRaw).ok, true);
  assert.equal(verifyCanonicalPayload(weeklyRaw).ok, true);
});

test('REGRESSION #114: a lying displayed number is caught', () => {
  const tampered = clone(dailyRaw);
  // Find a numbered non-mine cell and shift its displayed value.
  const i = tampered.cells.findIndex((c) => !c.isMine && (c.displayedMines || 0) > 0);
  assert.ok(i >= 0, 'fixture has a numbered cell');
  tampered.cells[i].displayedMines = (tampered.cells[i].displayedMines || 0) + 1;
  const v = verifyCanonicalPayload(tampered);
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(' '), /inconsistent displayedMines/);
});

test('REGRESSION #114: a mine-count lie is caught', () => {
  const tampered = clone(dailyRaw);
  tampered.totalMines = tampered.totalMines + 3;
  const v = verifyCanonicalPayload(tampered);
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(' '), /mine count/);
});

test('REGRESSION #114: a relocated mine (stale numbers) is caught', () => {
  const tampered = clone(dailyRaw);
  const mineIdx = tampered.cells.findIndex((c) => c.isMine);
  const safeIdx = tampered.cells.findIndex((c) => !c.isMine);
  tampered.cells[mineIdx].isMine = false;
  tampered.cells[safeIdx].isMine = true;
  const v = verifyCanonicalPayload(tampered);
  assert.equal(v.ok, false, 'moving a mine without fixing the numbers must fail');
});

test('a structurally broken payload fails gracefully, never throws', () => {
  const broken = clone(dailyRaw);
  broken.cells = broken.cells.slice(0, 10);
  const v = verifyCanonicalPayload(broken);
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(' '), /deserialize failed/);
  assert.equal(verifyCanonicalPayload(null).ok, false);
});

test('crux soundness: an honest mini passes, a lying one fails', () => {
  // Classic 1-1 overlap: the corner 1 caps {(0,1),(1,0)} at one mine, a
  // subset of the center 1's neighborhood — so the center's remaining
  // neighbors, (2,2) included, are provably safe. (No revealed 0s: a real
  // crux never has an unflooded 0, and the frontier treats flood as a
  // mechanic, not a deduction.)
  const cells = [{ r: 1, c: 1, n: 1 }, { r: 0, c: 0, n: 1 }];
  assert.equal(verifyCruxPayload({ rows: 3, cols: 3, cells, answer: { r: 2, c: 2 } }).ok, true);
  // Same layout claiming an UNPROVABLE cell as the answer — a lying teaser.
  const wrongAnswer = verifyCruxPayload({ rows: 3, cols: 3, cells, answer: { r: 0, c: 1 } });
  assert.equal(wrongAnswer.ok, false);
  assert.match(wrongAnswer.reasons.join(' '), /not provably safe/);
  // An 8 makes every neighbor a provable MINE — no safe cell exists at all.
  const noSafe = verifyCruxPayload({ rows: 3, cols: 3, cells: [{ r: 1, c: 1, n: 8 }], answer: { r: 0, c: 0 } });
  assert.equal(noSafe.ok, false);
  assert.match(noSafe.reasons.join(' '), /NO provably safe/);
  assert.equal(verifyCruxPayload({ rows: 99, cols: 1, cells: [] }).ok, false);
  assert.equal(verifyCruxPayload(null).ok, false);
});
