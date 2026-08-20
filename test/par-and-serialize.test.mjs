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

test('predictPar on an all-zero feature vector returns the rounded baseline', () => {
  // Log model: baseline par = exp(intercept). Additive: the intercept itself.
  const expected = PAR_MODEL.scale === 'log'
    ? Math.round(Math.exp(PAR_MODEL.intercept) * 10) / 10
    : Math.round(PAR_MODEL.intercept * 10) / 10;
  assert.equal(predictPar({}), expected);
});

test('predictPar is monotonic in a positive-coefficient feature', () => {
  assert.ok(PAR_MODEL.secPerSearchMove > 0, 'precondition: search coef positive');
  // advancedLogicMoves feeds the derived `search` tier (searchMoves = advanced).
  //
  // The delta is measured on a REALISTIC board, not on an empty feature
  // vector. predictPar rounds to a tenth of a second, so the vector has to
  // produce a par where a tenth is negligible. An empty one used to do that
  // and stopped on 2026-08-20: the M1 refit moved the board's size into
  // log(cells), which dropped the intercept to exp(0.2159) = 1.24s, and at
  // that magnitude the rounding alone is 8% of the value. The old comment
  // said a wide delta kept the gap clear of rounding, which was true of the
  // gap and never of the RATIO the assertion actually checks.
  const board = { cellCount: 144, totalMines: 30, passAMoves: 30 };
  const lo = predictPar({ ...board, advancedLogicMoves: 1 });
  const hi = predictPar({ ...board, advancedLogicMoves: 20 });
  assert.ok(lo > 20, `precondition: the fixture must price above the rounding floor, got ${lo}`);
  assert.ok(hi > lo, `par should rise with search moves: ${lo} -> ${hi}`);
  if (PAR_MODEL.scale === 'log') {
    // Multiplicative: hi / lo IS exp(coef x delta), and on a board this size
    // it holds to about 2e-4, so the tolerance can say so.
    const expectedRatio = Math.exp(PAR_MODEL.secPerSearchMove * 19);
    assert.ok(Math.abs(hi / lo - expectedRatio) < 0.005, `ratio ${hi / lo} vs expected ${expectedRatio}`);
  } else {
    const expected = PAR_MODEL.secPerSearchMove * 19;
    assert.ok(Math.abs((hi - lo) - expected) < 0.3, `delta ${hi - lo} vs expected ${expected}`);
  }
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
  board[1][3].isWormEgg = true;
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
  // Worm egg positions are canonical — they must survive the wire, and a
  // non-egg cell must deserialize with the boolean default, not undefined.
  assert.equal(back.board[1][3].isWormEgg, true);
  assert.equal(back.board[0][1].isWormEgg, false);
  // Wall edges survive as a Set with the same members.
  assert.ok(back.board._wallEdges instanceof Set);
  assert.equal(back.board._wallEdges.size, 2);
  assert.ok(back.board._wallEdges.has('r0,c0-r0,c1'));
});
