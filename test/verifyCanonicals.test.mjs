// Canonical-board integrity sweep (the #114 detection layer). The sweep is
// only worth its alarm if it actually bites on tampering, so these pin: real
// shipped canonicals PASS, and each tamper class FAILS with the right reason.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { verifyCanonicalPayload, verifyCruxPayload, verifyMetaAgainstBoard } =
  await import('../scripts/verify-canonical-boards.mjs');
const { deserializeBoard } = await import('../src/firebase/dailyBoardSync.js');
const { isBoardSolvable } = await import('../src/logic/boardSolver.js');
const { cleanSolverArtifacts } = await import('../src/logic/boardGenerator.js');
const { computeDailyFeatures } = await import('../src/logic/dailyFeatures.js');

// Mirror verifyMetaAgainstBoard's own recompute so tests can build an
// exactly-matching "stored" features object to perturb.
function recomputeFeatures(raw) {
  const d = deserializeBoard(raw);
  const fr = Math.floor(d.rows / 2), fc = Math.floor(d.cols / 2);
  const check = isBoardSolvable(d.board, d.rows, d.cols, fr, fc);
  cleanSolverArtifacts(d.board);
  return computeDailyFeatures(
    { board: d.board, rows: d.rows, cols: d.cols, totalMines: d.totalMines, activeGimmicks: d.activeGimmicks },
    check,
  );
}

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

test('REGRESSION: a pre-worm meta (no wormCellCount key) passes on an egg-free board — pipeline vintage, not tampering', () => {
  // Future-dated boards precomputed before worm tiles shipped carry metas
  // without the wormCellCount key; the sweep recomputes 0 and must not
  // hard-fail every one of them the night the feature merges.
  const features = recomputeFeatures(dailyRaw);
  delete features.wormCellCount;
  const v = verifyMetaAgainstBoard(dailyRaw, { features });
  assert.equal(v.ok, true, `vintage meta must pass: ${v.reasons.join('; ')}`);
});

test('a tampered worm egg count is still a hard failure', () => {
  const features = recomputeFeatures(dailyRaw);
  // Stored claims eggs on an egg-free board.
  const lying = { ...features, wormCellCount: 2 };
  const v1 = verifyMetaAgainstBoard(dailyRaw, { features: lying });
  assert.equal(v1.ok, false);
  assert.match(v1.reasons.join(' '), /wormCellCount/);
  // Board carries an egg but the meta omits the key entirely — an old
  // pipeline cannot have produced an egg board, so vintage does not excuse it.
  const eggBoard = clone(dailyRaw);
  const safeIdx = eggBoard.cells.findIndex((c) => !c.isMine && (c.adjacentMines || 0) > 0);
  eggBoard.cells[safeIdx].isWormEgg = true;
  const vintage = recomputeFeatures(dailyRaw);
  delete vintage.wormCellCount;
  const v2 = verifyMetaAgainstBoard(eggBoard, { features: vintage });
  assert.equal(v2.ok, false, 'an egg board with a keyless meta must hard-fail');
  assert.match(v2.reasons.join(' '), /wormCellCount/);
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
