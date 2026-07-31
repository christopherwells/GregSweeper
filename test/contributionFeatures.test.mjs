// Contribution features — the strip-and-resolve counterfactual kept as data
// (2026-07-30, Christopher's hypothesis: "instead of # of compass tiles, we'd
// want # of INTEGRAL compass tiles").
//
// Force-injection holds the raw gimmick cell counts nearly constant (every
// shipped compass daily carries exactly 3 compass cells), so within a type
// the count feature has no difficulty variance at all. The load-bearing
// filter already computes what varies — what the board would cost WITHOUT the
// gimmick — and discarded it after the accept/reject decision.
// computeContributionFeatures keeps it: per testable type, `<g>Required`
// (unsolvable without its information) and `<g>ClicksSaved` (deduction clicks
// it spares when the board survives the strip). No technique-delta output —
// Christopher's ruling, 2026-07-30.
//
// The load-bearing pin: these features and the win receipt's verdict come
// from ONE strip machinery, so the property tested here is AGREEMENT with
// gradeGimmickContribution across generated boards — if the two ever
// diverge, either the receipt or the recorded data is lying about the same
// counterfactual.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateBoard, cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import { applyGimmicks, clearGimmickProperties } from '../src/logic/gimmicks.js';
import {
  computeContributionFeatures, gradeGimmickContribution,
  CONTRIBUTION_FEATURE_KEYS, TESTABLE_GIMMICK_TYPES, isBoardSolvable,
} from '../src/logic/boardSolver.js';
import { computeDailyFeatures } from '../src/logic/dailyFeatures.js';
import { createDailyRNG } from '../src/logic/seededRandom.js';

function makeGimmickBoard(seed, gimmicks, rows = 9, cols = 9, mines = 12) {
  const fr = Math.floor(rows / 2), fc = Math.floor(cols / 2);
  const rng = createDailyRNG(seed);
  const board = generateBoard(rows, cols, mines, fr, fc, rng);
  cleanSolverArtifacts(board);
  if (gimmicks.length) {
    applyGimmicks(board, 2, gimmicks, createDailyRNG(seed + ':g'));
  }
  return { board, rows, cols, mines, fr, fc };
}

test('every key exists with zero defaults, in the exported order', () => {
  const { board, rows, cols, fr, fc } = makeGimmickBoard('contrib-plain', []);
  const out = computeContributionFeatures(board, rows, cols, fr, fc, []);
  assert.deepEqual(Object.keys(out).sort(), [...CONTRIBUTION_FEATURE_KEYS].sort());
  for (const k of CONTRIBUTION_FEATURE_KEYS) assert.equal(out[k], 0, `${k} defaults to 0`);
  // 2 keys per testable type, no more.
  assert.equal(CONTRIBUTION_FEATURE_KEYS.length, TESTABLE_GIMMICK_TYPES.length * 2);
});

test('PROPERTY: agreement with gradeGimmickContribution across seeded boards', () => {
  // The two consumers of the strip machinery must tell the same story:
  //   required   ⇔ <g>Required = 1 (and ClicksSaved reported 0 — undefined)
  //   technique  ⇒ Required 0 (clicks value is the honest strip delta)
  //   shortcut   ⇒ Required 0 and ClicksSaved >= 2 (the grade's own number)
  //   decorative ⇒ Required 0 and ClicksSaved <= 1
  const combos = [
    ['sonar'], ['compass'], ['wormhole'], ['liar'], ['mirror'],
    ['sonar', 'walls'], ['compass', 'mystery'],
  ];
  let checked = 0;
  for (const gimmicks of combos) {
    for (let s = 0; s < 6; s++) {
      const seed = `contrib-${gimmicks.join('+')}-${s}`;
      const { board, rows, cols, fr, fc } = makeGimmickBoard(seed, gimmicks);
      // Only certified boards carry features in production; mirror the gate.
      const check = isBoardSolvable(board, rows, cols, fr, fc);
      cleanSolverArtifacts(board);
      if (!(check.solvable || check.remainingUnknowns === 0)) continue;

      const out = computeContributionFeatures(board, rows, cols, fr, fc, gimmicks);
      for (const g of gimmicks) {
        if (!TESTABLE_GIMMICK_TYPES.includes(g)) continue;
        const grade = gradeGimmickContribution(board, rows, cols, fr, fc, g);
        checked++;
        if (grade.tier === 'required') {
          assert.equal(out[`${g}Required`], 1, `${seed}: ${g} required ⇒ flag 1`);
          assert.equal(out[`${g}ClicksSaved`], 0, `${seed}: clicksSaved undefined at required, reported 0`);
        } else {
          assert.equal(out[`${g}Required`], 0, `${seed}: ${g} ${grade.tier} ⇒ flag 0`);
          if (grade.tier === 'shortcut') {
            assert.ok(out[`${g}ClicksSaved`] >= 2,
              `${seed}: shortcut grade ⇒ >= 2 clicks saved (got ${out[`${g}ClicksSaved`]})`);
            assert.equal(out[`${g}ClicksSaved`], grade.clicksSaved,
              `${seed}: the recorded number IS the grade's number`);
          }
          if (grade.tier === 'decorative') {
            assert.ok(out[`${g}ClicksSaved`] <= 1,
              `${seed}: decorative ⇒ <= 1 click saved (got ${out[`${g}ClicksSaved`]})`);
          }
        }
      }
      // Types NOT on the board stay zero.
      for (const g of TESTABLE_GIMMICK_TYPES) {
        if (gimmicks.includes(g)) continue;
        assert.equal(out[`${g}Required`], 0);
        assert.equal(out[`${g}ClicksSaved`], 0);
      }
    }
  }
  assert.ok(checked >= 15, `property must actually exercise boards (checked ${checked})`);
});

test('deterministic: same board, same opener, same answer', () => {
  const { board, rows, cols, fr, fc } = makeGimmickBoard('contrib-det', ['compass']);
  const a = computeContributionFeatures(board, rows, cols, fr, fc, ['compass']);
  const b = computeContributionFeatures(board, rows, cols, fr, fc, ['compass']);
  assert.deepEqual(a, b);
});

test('locked split: mine + number counts partition lockedCellCount', () => {
  const { board, rows, cols, mines, fr, fc } = makeGimmickBoard('contrib-locked', ['locked']);
  const check = isBoardSolvable(board, rows, cols, fr, fc);
  cleanSolverArtifacts(board);
  const f = computeDailyFeatures(
    { board, rows, cols, totalMines: mines, activeGimmicks: ['locked'], rngSeed: 'contrib-locked' },
    check,
  );
  assert.equal(f.lockedMineCount + f.lockedNumberCount, f.lockedCellCount,
    'the split must partition the total');
  // Verify against the board directly — the split reads what is UNDER the lock.
  let mineLocks = 0, numberLocks = 0;
  for (const row of board) for (const cell of row) {
    if (!cell.isLocked) continue;
    if (cell.isMine) mineLocks++; else numberLocks++;
  }
  assert.equal(f.lockedMineCount, mineLocks);
  assert.equal(f.lockedNumberCount, numberLocks);
});

test('a board with no locked cells reports a zero split', () => {
  const { board, rows, cols, mines, fr, fc } = makeGimmickBoard('contrib-nolock', []);
  const check = isBoardSolvable(board, rows, cols, fr, fc);
  cleanSolverArtifacts(board);
  clearGimmickProperties(board);
  const f = computeDailyFeatures(
    { board, rows, cols, totalMines: mines, activeGimmicks: [], rngSeed: 'x' }, check,
  );
  assert.equal(f.lockedMineCount, 0);
  assert.equal(f.lockedNumberCount, 0);
});

test('unsolvable baseline returns the all-zero null rather than noise', () => {
  // Hand-build a board the solver cannot clear from the opener: a 3x3 with
  // mines boxing the center so no information flows.
  const rows = 3, cols = 3;
  const board = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      row.push({ row: r, col: c, isMine: !(r === 1 && c === 1), adjacentMines: 0, isRevealed: false, isFlagged: false });
    }
    board.push(row);
  }
  const out = computeContributionFeatures(board, rows, cols, 1, 1, ['sonar']);
  for (const k of CONTRIBUTION_FEATURE_KEYS) assert.equal(out[k], 0);
});
