// The stale-mine-adjacency repair, and the two sweep guards it sits beside.
//
// The invariant: a mine carries no number, so its `adjacentMines` is ALWAYS 0.
// Four copies of the adjacency counter used to exist and disagreed on exactly
// that branch — the old `calculateAdjacency` SKIPPED mine cells, so a cell
// `swapMines` promoted from safe to mine kept the count it held while safe, and
// that stale value serialized into 15 canonical boards. The producer was fixed
// 2026-07-10; scripts/repair-mine-adjacency.mjs cleans up what was stored.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { staleMineCells, repairPayload, proveRepairInert } from '../scripts/repair-mine-adjacency.mjs';
import { verifyMetaAgainstBoard } from '../scripts/verify-canonical-boards.mjs';
import { serializeBoard, deserializeBoard } from '../src/firebase/dailyBoardSync.js';
import { generateBoard, cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import { isBoardSolvable } from '../src/logic/boardSolver.js';
import { computeDailyFeatures } from '../src/logic/dailyFeatures.js';
import { CANONICAL_ERA_START } from '../src/logic/archiveEligibility.js';

// Mirror verifyMetaAgainstBoard's own recompute so a test can build an
// exactly-matching "stored" features object and then perturb one key.
function recomputeFeatures(raw) {
  const d = deserializeBoard(raw);
  const fr = Math.floor(d.firstClick / d.cols), fc = d.firstClick % d.cols;
  const check = isBoardSolvable(d.board, d.rows, d.cols, fr, fc);
  cleanSolverArtifacts(d.board);
  return computeDailyFeatures(
    { board: d.board, rows: d.rows, cols: d.cols, totalMines: d.totalMines, activeGimmicks: d.activeGimmicks, rngSeed: d.rngSeed || '' },
    check,
  );
}

function rectPayload() {
  const board = generateBoard(9, 9, 12, 4, 4);
  const check = isBoardSolvable(board, 9, 9, 4, 4);
  assert.ok(check, 'fixture board should solve');
  return JSON.parse(JSON.stringify(serializeBoard({
    board, rows: 9, cols: 9, totalMines: 12, rngSeed: '2026-05-01', activeGimmicks: [],
  })));
}

test('staleMineCells finds a non-zero count on a mine, and only there', () => {
  const payload = rectPayload();
  assert.deepEqual(staleMineCells(payload), [], 'a freshly generated board must already be clean');

  // Plant the exact defect: a mine carrying the count it held while safe.
  const mineIdx = payload.cells.findIndex((c) => c.isMine === true);
  assert.ok(mineIdx >= 0, 'fixture has no mine');
  payload.cells[mineIdx].adjacentMines = 3;
  assert.deepEqual(staleMineCells(payload), [mineIdx]);

  // A SAFE cell with a non-zero count is the normal case and must not be
  // reported, or the repair would erase real clue numbers.
  const safeIdx = payload.cells.findIndex((c, i) => i !== mineIdx && !c.isMine && c.adjacentMines > 0);
  assert.ok(safeIdx >= 0, 'fixture has no numbered safe cell');
  assert.equal(staleMineCells(payload).includes(safeIdx), false);

  // A mine legitimately storing 0 is already correct. (serializeBoard prunes
  // adjacentMines: 0 only for booleans, so the key may be absent entirely —
  // both shapes must read as clean.)
  payload.cells[mineIdx].adjacentMines = 0;
  assert.deepEqual(staleMineCells(payload), []);
  delete payload.cells[mineIdx].adjacentMines;
  assert.deepEqual(staleMineCells(payload), []);
});

test('repairPayload zeroes every mine and touches nothing else', () => {
  const payload = rectPayload();
  for (const c of payload.cells) if (c.isMine) c.adjacentMines = 4;

  const repaired = repairPayload(payload);
  assert.deepEqual(staleMineCells(repaired), []);

  // Safe cells keep their numbers verbatim — the repair must never rewrite a
  // clue the player read.
  payload.cells.forEach((c, i) => {
    if (c.isMine) return;
    assert.deepEqual(repaired.cells[i], c, `safe cell ${i} was modified`);
  });
  // And the original is left alone (the caller writes the copy).
  assert.equal(payload.cells.find((c) => c.isMine).adjacentMines, 4);
});

test('proveRepairInert confirms the repair changes no displayed number or par', () => {
  const payload = rectPayload();
  for (const c of payload.cells) if (c.isMine) c.adjacentMines = 5;

  const proof = proveRepairInert(payload);
  assert.equal(proof.inert, true, 'zeroing a mine count must be unobservable');
  assert.equal(proof.displayedDiffs, 0);
  assert.deepEqual(proof.featureDiffs, []);
  assert.equal(proof.certSame, true);
  assert.equal(proof.par, proof.parAfter);
});

test('a mine\'s own count is read by NOTHING in the display path', () => {
  // The load-bearing reason the repair is safe on played boards. Poison every
  // mine with an absurd count; the numbers the player sees must not move.
  const payload = rectPayload();
  const before = deserializeBoard(payload).board.flat().map((c) => c.displayedMines);
  for (const c of payload.cells) if (c.isMine) c.adjacentMines = 99;
  const after = deserializeBoard(payload).board.flat().map((c) => c.displayedMines);
  assert.deepEqual(after, before);
});

// ── The sweep guards ─────────────────────────────────────────────

test('REGRESSION: the sweep guards the PAIR feature names, not the dead cell names', () => {
  // computeDailyFeatures emits wormholePairCount / mirrorPairCount; the sweep's
  // old allowlist carried wormholeCellCount / mirrorCellCount, which appear in
  // no feature vector. The comparison loop iterates the RECOMPUTED keys, so
  // those entries matched nothing and both modifier counts fell through to
  // warn-only — a fabricated wormhole or mirror count did not fail the sweep.
  //
  // Asserted by BEHAVIOR rather than by reading the list out of the source,
  // because there is no list any more: the sweep now defaults to hard-fail and
  // reads only the solver-derived tag from the producer (#180). A name-based
  // check could not have survived that, and a behavioural one is what the guard
  // was always trying to say.
  const payload = rectPayload();
  const meta = { writtenAt: Date.now(), features: recomputeFeatures(payload) };
  assert.equal(verifyMetaAgainstBoard(payload, meta).ok, true, 'the honest meta must pass');

  for (const live of ['wormholePairCount', 'mirrorPairCount']) {
    assert.ok(live in meta.features, `${live} must be a real emitted feature`);
    const lying = { ...meta, features: { ...meta.features, [live]: meta.features[live] + 2 } };
    const v = verifyMetaAgainstBoard(payload, lying);
    assert.equal(v.ok, false, `a fabricated ${live} must FAIL the sweep`);
    assert.match(v.reasons.join(' '), new RegExp(`features\\.${live}\\b`));
  }
  for (const dead of ['wormholeCellCount', 'mirrorCellCount']) {
    assert.ok(!(dead in meta.features),
      `${dead} is not a feature key — guarding that name guards nothing`);
  }
});

test('the pre-canonical era floor is a real date and matches the R refit', () => {
  assert.match(CANONICAL_ERA_START, /^\d{4}-\d{2}-\d{2}$/);
  // The refit draws the same line as DIGIT_ERA_START — it derives clue-digit
  // shares from stored boards, so it cannot reach back past the date those
  // boards start describing the game actually played. If one moves and the
  // other does not, the sweep and the fit disagree about which history is real.
  const r = readFileSync(new URL('../scripts/refit-par-model.R', import.meta.url), 'utf8');
  const m = r.match(/DIGIT_ERA_START\s*<-\s*"(\d{4}-\d{2}-\d{2})"/);
  assert.ok(m, 'DIGIT_ERA_START not found in the refit');
  assert.equal(m[1], CANONICAL_ERA_START,
    'CANONICAL_ERA_START and DIGIT_ERA_START must agree');
});
