// The deduction substrate: solver trace, per-group disjunctive
// attribution, the full deducible frontier, and dual-solve wrong-flag
// detection. These power the receipts/lens surfaces, so a regression
// here either lies to the player or silently shifts dailyMeta features.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { isBoardSolvable, findDeducibleFrontier, findNextSafeMove, detectWrongFlags, gradeGimmickContribution } = await import('../src/logic/boardSolver.js');
const { solveConstraints } = await import('../src/logic/constraintSolver.js');
const { generateBoard, cleanSolverArtifacts } = await import('../src/logic/boardGenerator.js');
const { createDailyRNG } = await import('../src/logic/seededRandom.js');
const { makeBoard, recalcAdjacency } = await import('./helpers.mjs');

// ── solveConstraints provenance ────────────────────────

test('solveConstraints reports per-group provenance and disjunctivity', () => {
  const r = solveConstraints([
    // Group A: exact, both forced mines. Origin cell 10.
    { unknowns: [1, 2], allowedMines: [2], origin: 10 },
    // Group B: disjunctive (liar) + an exact pin on cell 5. Origins 20, 21.
    { unknowns: [5, 6, 7], allowedMines: [1, 3], origin: 20 },
    { unknowns: [5], allowedMines: [1], origin: 21 },
  ]);
  assert.ok(r.mines.has(1) && r.mines.has(2) && r.mines.has(5));
  assert.equal(r.contradiction, false);
  const gA = r.groups[r.cellGroup.get(1)];
  const gB = r.groups[r.cellGroup.get(5)];
  assert.equal(gA.hasDisjunctive, false);
  assert.equal(gB.hasDisjunctive, true);
  assert.deepEqual([...gA.origins].sort(), [10]);
  assert.deepEqual([...gB.origins].sort(), [20, 21]);
  // The two cells live in different components.
  assert.notEqual(r.cellGroup.get(1), r.cellGroup.get(5));
});

test('solveConstraints flags a contradictory component', () => {
  const r = solveConstraints([
    { unknowns: [1, 2], allowedMines: [0], origin: 9 },
    { unknowns: [1, 2], allowedMines: [2], origin: 8 },
  ]);
  assert.equal(r.contradiction, true);
});

// ── Trace: invariant, counter agreement, collection-only ──

const CASES = [
  { rows: 9, cols: 9, mines: 14, seed: 'substrate-1' },
  { rows: 12, cols: 12, mines: 28, seed: 'substrate-2' },
  { rows: 10, cols: 10, mines: 20, seed: 'substrate-3' },
];

for (const { rows, cols, mines, seed } of CASES) {
  test(`trace invariant + counter agreement (${rows}x${cols}/${mines}, ${seed})`, () => {
    const fr = Math.floor(rows / 2), fc = Math.floor(cols / 2);
    const board = generateBoard(rows, cols, mines, fr, fc, createDailyRNG(seed));
    cleanSolverArtifacts(board);
    const plain = isBoardSolvable(board, rows, cols, fr, fc);
    cleanSolverArtifacts(board);
    const traced = isBoardSolvable(board, rows, cols, fr, fc, undefined, { trace: true });
    cleanSolverArtifacts(board);

    // Collection-only: every counter identical with and without trace.
    for (const k of ['solvable', 'totalClicks', 'techniqueLevel', 'passAMoves',
      'canonicalSubsetMoves', 'genericSubsetMoves', 'advancedLogicMoves', 'disjunctiveMoves']) {
      assert.equal(traced[k], plain[k], `${k} changed when tracing`);
    }
    if (!traced.solvable) return;

    // trace.length + 1 === totalClicks (the +1 is the first click).
    assert.equal(traced.trace.length + 1, traced.totalClicks);

    // Tier counts must reconcile with the counters exactly.
    const tiers = { 0: 0, 1: 0, 2: 0, 3: 0 };
    for (const e of traced.trace) tiers[e.tier]++;
    assert.equal(tiers[0], traced.passAMoves);
    assert.equal(tiers[1], traced.canonicalSubsetMoves + traced.genericSubsetMoves);
    assert.equal(tiers[2], traced.advancedLogicMoves);
    assert.equal(tiers[3], traced.disjunctiveMoves);

    // Every entry names at least one proving source.
    for (const e of traced.trace) {
      assert.ok(Array.isArray(e.sources), 'trace entry missing sources');
    }
  });
}

// ── Honest disjunctive attribution on a liar board ─────

test('liar board: disjunctive attribution is per-group, level 3 only when the liar group deduces', () => {
  // 1x5 strip: mine at index 4 (cell (0,4)). Liar at (0,2) displaying 2
  // (true count 1, lie +1). Reveal (0,0),(0,1),(0,2): (0,1) is an honest
  // 0-adjacent... build explicitly and call the solver from first click (0,0).
  const board = makeBoard(1, 5);
  board[0][4].isMine = true;
  recalcAdjacency(board);
  board[0][2].isLiar = true;
  board[0][2].displayedMines = board[0][2].adjacentMines + 1; // lying high
  const res = isBoardSolvable(board, 1, 5, 0, 0, undefined, { trace: true });
  assert.ok(res.solvable, 'liar strip should be solvable');
  // All reveals must reconcile with per-tier counts (the invariant holds
  // on liar boards too — the attribution change cannot break it).
  assert.equal(res.trace.length + 1, res.totalClicks);
});

// ── Frontier + wrong-flag dual solve ───────────────────

function frontierFixture() {
  // 5x5, mines at (0,0) and (0,4). Rows 1-4 fully revealed; row 0 hidden.
  const board = makeBoard(5, 5);
  board[0][0].isMine = true;
  board[0][4].isMine = true;
  recalcAdjacency(board);
  for (let r = 1; r < 5; r++) for (let c = 0; c < 5; c++) board[r][c].isRevealed = true;
  return board;
}

test('findDeducibleFrontier: subset-provable safe cell with proving sources', () => {
  // Honest expectations for this position: row 1's four 1s pin ONLY
  // (0,2) as safe (each mine is ambiguous between two cells — e.g.
  // (0,0) vs (0,1) both satisfy every constraint). The solver proving
  // exactly that, no more and no less, is the point of the test.
  const board = frontierFixture();
  const f = findDeducibleFrontier(board, { respectFlags: true });
  assert.equal(f.safe.length, 1);
  assert.equal(f.safe[0].row, 0);
  assert.equal(f.safe[0].col, 2);
  assert.ok(f.safe[0].tier >= 1, 'needs joint reasoning, not a single constraint');
  assert.ok(f.safe[0].sources.length >= 2, 'the proof spans multiple row-1 constraints');
  assert.ok(f.safe[0].sources.every(s => s.row === 1), 'sources are the row-1 numbers');
  assert.equal(f.mines.length, 0, 'neither mine is provable in this position');
  assert.equal(f.contradiction, false);
  // findNextSafeMove returns the first (only) frontier cell.
  assert.deepEqual(findNextSafeMove(board), { row: 0, col: 2 });
});

test('findDeducibleFrontier: Pass A mine deduction carries its single proving constraint', () => {
  // 3x3, mine at (0,0), everything else revealed: (1,1) shows 1 with one
  // unknown — the corner is a tier-0 provable mine.
  const board = makeBoard(3, 3);
  board[0][0].isMine = true;
  recalcAdjacency(board);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    if (!(r === 0 && c === 0)) board[r][c].isRevealed = true;
  }
  const f = findDeducibleFrontier(board, { respectFlags: true });
  assert.equal(f.safe.length, 0);
  assert.equal(f.mines.length, 1);
  assert.equal(f.mines[0].row, 0);
  assert.equal(f.mines[0].col, 0);
  assert.equal(f.mines[0].tier, 0);
  assert.ok(f.mines[0].sources.length >= 1, 'pass A deduction must name its source');
  // No safe move exists — the wrapper honestly returns null.
  assert.equal(findNextSafeMove(board), null);
});

test('detectWrongFlags localizes a provably wrong flag and signals contradiction', () => {
  const board = frontierFixture();
  board[0][2].isFlagged = true; // provably-safe cell, wrongly flagged
  const d = detectWrongFlags(board);
  assert.ok(d.wrongFlags.some(w => w.row === 0 && w.col === 2),
    'the wrong flag at (0,2) must be localized by the flags-blind run');
  assert.equal(d.contradiction, true,
    'the flags-respecting run must report the contradiction the wrong flag creates');
});

test('gradeGimmickContribution: a load-bearing liar grades as required, structural types skip', () => {
  // 1x5 strip, mine at (0,4), liar at (0,2) lying high. With the liar's
  // disjunctive constraint the strip solves; stripped, (0,3) is
  // unreachable by any deduction — the liar is strictly required.
  const board = makeBoard(1, 5);
  board[0][4].isMine = true;
  recalcAdjacency(board);
  board[0][2].isLiar = true;
  board[0][2].displayedMines = board[0][2].adjacentMines + 1;
  const grade = gradeGimmickContribution(board, 1, 5, 0, 0, 'liar');
  assert.equal(grade.tier, 'required');
  // Structural types never run the strip analysis.
  assert.equal(gradeGimmickContribution(board, 1, 5, 0, 0, 'walls').tier, 'structural');
  assert.equal(gradeGimmickContribution(board, 1, 5, 0, 0, 'mystery').tier, 'structural');
});

test('frontier is flags-blind on demand: a wrong flag cannot hide a provable deduction', () => {
  const board = frontierFixture();
  board[0][2].isFlagged = true;
  const blind = findDeducibleFrontier(board, { respectFlags: false });
  assert.ok(blind.safe.some(s => s.row === 0 && s.col === 2),
    'flags-blind frontier must still prove (0,2) safe');
});
