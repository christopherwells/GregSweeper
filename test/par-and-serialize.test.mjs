// Par-model formula invariants + canonical-board serialize round-trip.
// predictPar drives every "Greg's Time" number; serializeBoard ↔
// deserializeBoard is how the same board reaches every device, so a
// silent change to either misreports times or splits the player base.

import './helpers.mjs';
import { makeBoard, recalcAdjacency } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { predictPar, breakdownPar } = await import('../src/logic/dailyFeatures.js');
const { PAR_MODEL } = await import('../src/logic/difficulty.js');
const { serializeBoard, deserializeBoard } = await import('../src/firebase/dailyBoardSync.js');

test('predictPar on an all-zero feature vector returns the rounded intercept', () => {
  assert.equal(predictPar({}), Math.round(PAR_MODEL.intercept * 10) / 10);
});

test('predictPar is monotonic in a positive-coefficient feature', () => {
  assert.ok(PAR_MODEL.secPerSearchMove > 0, 'precondition: search coef positive');
  // advancedLogicMoves feeds the derived `search` tier (searchMoves = advanced).
  const lo = predictPar({ advancedLogicMoves: 1 });
  const hi = predictPar({ advancedLogicMoves: 5 });
  assert.ok(hi > lo, `par should rise with search moves: ${lo} -> ${hi}`);
  // The increase equals coef × delta (within rounding).
  const expected = PAR_MODEL.secPerSearchMove * 4;
  assert.ok(Math.abs((hi - lo) - expected) < 0.15, `delta ${hi - lo} vs expected ${expected}`);
});

test('predictPar returns a finite number for a realistic feature vector', () => {
  const par = predictPar({
    passAMoves: 30, canonicalSubsetMoves: 4, genericSubsetMoves: 1, advancedLogicMoves: 2,
    cellCount: 144, totalMines: 30, wallEdgeCount: 8, liarCellCount: 0,
  });
  assert.ok(Number.isFinite(par), 'par not finite');
});

test('breakdownPar: positive terms, gimmick groups sorted desc, baseline last', () => {
  const terms = breakdownPar({
    passAMoves: 40, canonicalSubsetMoves: 6, advancedLogicMoves: 3,
    mysteryCellCount: 2, cellCount: 144, totalMines: 30,
  });
  assert.ok(Array.isArray(terms));
  for (const t of terms) assert.ok(t.seconds > 0, `non-positive term: ${JSON.stringify(t)}`);
  // The 'baseline' chip (intercept + size + flag count) is intentionally
  // appended LAST, after the gimmick/move groups are sorted descending.
  // So only the non-baseline prefix is required to be sorted.
  const baselineIdx = terms.findIndex(t => t.label === 'baseline');
  const sortable = baselineIdx === -1 ? terms : terms.slice(0, baselineIdx);
  if (baselineIdx !== -1) assert.equal(baselineIdx, terms.length - 1, 'baseline not last');
  for (let i = 1; i < sortable.length; i++) {
    assert.ok(sortable[i - 1].seconds >= sortable[i].seconds, 'non-baseline groups not sorted desc');
  }
});

test('serializeBoard ↔ deserializeBoard preserves mines, numbers, gimmicks and walls', () => {
  const rows = 4, cols = 4;
  const board = makeBoard(rows, cols);
  board[0][0].isMine = true;
  board[3][3].isMine = true;
  board[1][1].isMystery = true;
  board[2][2].isLiar = true;
  board[2][2].liarOffset = 1;
  recalcAdjacency(board);
  // Copy displayedMines for the liar cell the way the app would.
  board[2][2].displayedMines = board[2][2].adjacentMines + 1;
  board._wallEdges = new Set(['r0,c0-r0,c1', 'r1,c1-r2,c1']);

  const payload = serializeBoard({
    board, rows, cols, totalMines: 2, rngSeed: '2026-06-01:trial0',
    activeGimmicks: ['mystery', 'liar'], codeVersion: 'gregsweeper-vTEST',
  });
  // Payload is JSON-safe.
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(payload)));

  const back = deserializeBoard(JSON.parse(JSON.stringify(payload)));
  assert.equal(back.rows, rows);
  assert.equal(back.cols, cols);
  assert.equal(back.totalMines, 2);
  assert.equal(back.rngSeed, '2026-06-01:trial0');
  assert.deepEqual(back.activeGimmicks, ['mystery', 'liar']);

  // Mines + numbers survive the round-trip.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      assert.equal(back.board[r][c].isMine, board[r][c].isMine, `mine mismatch (${r},${c})`);
      assert.equal(back.board[r][c].adjacentMines, board[r][c].adjacentMines, `adj mismatch (${r},${c})`);
      assert.equal(back.board[r][c].row, r);
      assert.equal(back.board[r][c].col, c);
    }
  }
  assert.equal(back.board[1][1].isMystery, true);
  assert.equal(back.board[2][2].isLiar, true);
  assert.equal(back.board[2][2].displayedMines, board[2][2].displayedMines);
  // Wall edges survive as a Set with the same members.
  assert.ok(back.board._wallEdges instanceof Set);
  assert.equal(back.board._wallEdges.size, 2);
  assert.ok(back.board._wallEdges.has('r0,c0-r0,c1'));
});
