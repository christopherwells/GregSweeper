// Reveal gating: sonar / compass / wormhole constraints are usable only
// once their number is on screen (origin cell revealed; for wormhole,
// either endpoint). The gate is per-board (`board._gatedCert`, stamped by
// createEmptyBoard, carried by canonical payloads and game saves) so
// historical boards certified ungated keep their original contract.
//
// Run: node --test test/revealGating.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { isBoardSolvable, findDeducibleFrontier } from '../src/logic/boardSolver.js';
import { createEmptyBoard, cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import { serializeBoard, deserializeBoard } from '../src/firebase/dailyBoardSync.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name) =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));

const certified = (check) => check.solvable || check.remainingUnknowns === 0;

// ── Synthetic fixtures ───────────────────────────────────────

// 4x4 board, mine at (0,3), wormhole pair A=(0,0) / B=(3,3) with
// non-overlapping neighborhoods. Both endpoints display the pair sum
// (0 here), so the constraint proves all six neighborhood cells safe —
// but only once an endpoint is on screen.
function buildWormholeBoard() {
  const board = [];
  for (let r = 0; r < 4; r++) {
    const row = [];
    for (let c = 0; c < 4; c++) {
      row.push({
        row: r, col: c,
        isMine: false, isRevealed: false, isFlagged: false,
        adjacentMines: 0, revealAnimDelay: 0,
      });
    }
    board.push(row);
  }
  board[0][3].isMine = true;
  // adjacency for the single mine at (0,3)
  board[0][2].adjacentMines = 1;
  board[1][2].adjacentMines = 1;
  board[1][3].adjacentMines = 1;

  const a = board[0][0], b = board[3][3];
  a.isWormhole = true;
  a.wormholePair = { row: 3, col: 3 };
  b.isWormhole = true;
  b.wormholePair = { row: 0, col: 0 };
  // both endpoints display the sum of the two true adjacencies: 0 + 0
  a.displayedMines = 0;
  b.displayedMines = 0;
  return board;
}

test('wormhole constraint is hidden until an endpoint is revealed (gated)', () => {
  const board = buildWormholeBoard();
  // Neither endpoint revealed: ungated frontier uses the constraint,
  // gated frontier must not.
  const ungated = findDeducibleFrontier(board, { gateGimmickOrigins: false });
  const gated = findDeducibleFrontier(board, { gateGimmickOrigins: true });
  const has = (list, r, c) => list.some(d => d.row === r && d.col === c);

  assert.ok(has(ungated.safe, 3, 2), 'ungated solver proves B-side neighborhood safe from the fogged constraint');
  assert.ok(!has(gated.safe, 3, 2), 'gated solver must not use a constraint the player cannot see');
});

test('wormhole constraint activates from EITHER endpoint (pair sum is on both)', () => {
  for (const endpoint of [[0, 0], [3, 3]]) {
    const board = buildWormholeBoard();
    board[endpoint[0]][endpoint[1]].isRevealed = true;
    const gated = findDeducibleFrontier(board, { gateGimmickOrigins: true });
    const has = (list, r, c) => list.some(d => d.row === r && d.col === c);
    assert.ok(has(gated.safe, 3, 2) && has(gated.safe, 0, 1),
      `revealing endpoint (${endpoint}) makes the pair-sum constraint usable`);
  }
});

// 3x3 board, mine at (0,0). Center cell is sonar + liar: sonarCount 1,
// liar offset +1, displayed 2. The displayed number includes the lie, so
// it must never be emitted as an exact constraint — the old behavior
// flagged BOTH remaining unknowns as mines, including the safe (0,1).
function buildLiarStackedSonarBoard() {
  const board = [];
  for (let r = 0; r < 3; r++) {
    const row = [];
    for (let c = 0; c < 3; c++) {
      row.push({
        row: r, col: c,
        isMine: false, isRevealed: true, isFlagged: false,
        adjacentMines: 0, revealAnimDelay: 0,
      });
    }
    board.push(row);
  }
  board[0][0].isMine = true;
  board[0][0].isRevealed = false;
  board[0][1].adjacentMines = 1;
  board[0][1].isRevealed = false; // safe unknown — the lie's victim
  board[1][0].adjacentMines = 1;
  board[1][1].adjacentMines = 1;

  const sonar = board[1][1];
  sonar.isSonar = true;
  sonar.sonarCount = 1;
  sonar.isLiar = true;
  sonar.liarOffset = 1;
  sonar.displayedMines = 2; // 1 true + 1 lie
  return board;
}

test('liar-stacked sonar cell contributes no exact constraint', () => {
  const board = buildLiarStackedSonarBoard();
  const f = findDeducibleFrontier(board, { respectFlags: false });
  const has = (list, r, c) => list.some(d => d.row === r && d.col === c);

  // The only real constraint here is (1,0)=1 over {(0,0),(0,1)} — one
  // mine between two cells, so NOTHING is provable. The old behavior
  // emitted the lying displayed value (2) as an exact constraint over
  // the same two unknowns and certified BOTH as mines, including the
  // safe (0,1).
  assert.ok(!has(f.mines, 0, 1), 'safe cell must not be certified a mine off the lying displayed value');
  assert.ok(!has(f.mines, 0, 0) && f.safe.length === 0,
    'a genuine 1-of-2 frontier proves nothing');
  assert.equal(f.contradiction, false, 'no contradiction on a consistent board');
});

// ── Contract plumbing ────────────────────────────────────────

test('createEmptyBoard stamps the gated contract; serialize/deserialize round-trips it', () => {
  const board = createEmptyBoard(4, 4);
  assert.equal(board._gatedCert, true, 'new boards carry the gated certification contract');

  const payload = serializeBoard({
    board, rows: 4, cols: 4, totalMines: 0, rngSeed: 'test', activeGimmicks: [],
  });
  assert.equal(payload.gatedCert, true, 'contract flag serializes into the canonical payload');

  const restored = deserializeBoard(payload);
  assert.equal(restored.board._gatedCert, true, 'contract flag survives deserialization');

  // Historical payloads (no flag) must come back ungated.
  delete payload.gatedCert;
  const historical = deserializeBoard(payload);
  assert.equal(historical.board._gatedCert, undefined, 'historical canonicals keep the ungated contract');
});

test('solver defaults to the board contract flag', () => {
  const board = buildWormholeBoard();
  const has = (list, r, c) => list.some(d => d.row === r && d.col === c);

  // No flag, no option: ungated (historical behavior).
  const def = findDeducibleFrontier(board);
  assert.ok(has(def.safe, 3, 2), 'unflagged board solves ungated by default');

  // Flagged board, no option: gated.
  board._gatedCert = true;
  const gatedDef = findDeducibleFrontier(board);
  assert.ok(!has(gatedDef.safe, 3, 2), 'flagged board solves gated by default');
});

// ── Real canonical boards (downloaded fixtures) ──────────────

test('daily 2026-06-14: ungated certificate relied on fogged compass info', () => {
  const { board, rows, cols } = deserializeBoard(loadFixture('dailyBoard-2026-06-14.json'));
  const fr = Math.floor(rows / 2), fc = Math.floor(cols / 2);

  const ungated = isBoardSolvable(board, rows, cols, fr, fc, undefined, { gateGimmickOrigins: false });
  cleanSolverArtifacts(board);
  const gated = isBoardSolvable(board, rows, cols, fr, fc, undefined, { gateGimmickOrigins: true });
  cleanSolverArtifacts(board);

  assert.ok(certified(ungated), 'historical certificate (ungated) holds');
  assert.ok(!certified(gated), 'gated solve correctly refuses the fogged-clue certificate');
});

test('weekly 2026-05-25: stays certified gated, but the solve path differs (feature drift)', () => {
  const { board, rows, cols } = deserializeBoard(loadFixture('weeklyBoard-2026-05-25.json'));
  const fr = Math.floor(rows / 2), fc = Math.floor(cols / 2);

  const ungated = isBoardSolvable(board, rows, cols, fr, fc, undefined, { gateGimmickOrigins: false });
  cleanSolverArtifacts(board);
  const gated = isBoardSolvable(board, rows, cols, fr, fc, undefined, { gateGimmickOrigins: true });
  cleanSolverArtifacts(board);

  assert.ok(certified(ungated) && certified(gated), 'both contracts certify this board');
  assert.notEqual(gated.totalClicks, ungated.totalClicks,
    'gating changes the deduction path — why the contract must travel with the board');

  // Move-type invariant holds under gating too.
  const sum = gated.passAMoves + gated.canonicalSubsetMoves + gated.genericSubsetMoves
    + gated.advancedLogicMoves + gated.disjunctiveMoves;
  assert.equal(sum + 1, gated.totalClicks, 'move-type invariant holds on gated solves');
});
