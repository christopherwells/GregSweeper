// Power-up area shapes on tilings (two of Christopher's petals reports,
// 2026-08-03). First: container-rectangular blasts land on geometrically
// scattered cells on a lattice ("the sonar and scan for petals doesn't look
// right"), so X-Ray reads the depth-2 corner-inclusive ball and Magnet
// extracts over depth-1 — his challenge-250 ruling, "each area effect
// generalizes the way sonar did". Second, correcting the first cut's Scan:
// "Scan should move in some reasonable way horizontally and vertically, not
// a blob" — Scan's identity is the CROSSING SWEEP, so scanLines traces the
// true horizontal and vertical lines through the target (every convex cell
// the line passes through, strict spanning). Rectangles keep row+column /
// 5x5 / 3x3 verbatim.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanRowCol, scanLines, xRayScan, magnetPull } from '../src/logic/powerUps.js';
import { sonarScanCells } from '../src/logic/adjacency.js';
import { buildTiling } from '../src/logic/tilingGeometry.js';

function rectBoard(rows, cols, mines = []) {
  const board = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) row.push({ isMine: false, row: r, col: c });
    board.push(row);
  }
  for (const [r, c] of mines) board[r][c].isMine = true;
  return board;
}

function tilingBoard(type, M, N, rows, cols, mineIdx = []) {
  const tiling = buildTiling(type, M, N);
  if (rows * cols !== tiling.total) throw new Error('container mismatch');
  const board = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) row.push({ isMine: false, row: r, col: c });
    board.push(row);
  }
  for (const idx of mineIdx) board[Math.floor(idx / cols)][idx % cols].isMine = true;
  board._cellNeighbors = tiling.adj;
  board._cellPos = tiling.cellPos;
  board._tiling = { type, M, N };
  return board;
}

test('rectangles keep their shapes verbatim: row+column scan, 5x5 x-ray, 3x3 magnet', () => {
  const board = rectBoard(9, 9, [[4, 0], [0, 4], [2, 3], [7, 7]]);
  const scan = scanRowCol(board, 4, 4);
  assert.equal(scan.rowMines, 1, 'row 4 holds one mine');
  assert.equal(scan.colMines, 1, 'col 4 holds one mine');

  const { mines, area } = xRayScan(board, 4, 4);
  assert.equal(area.length, 25, 'full 5x5 in the interior');
  assert.ok(mines.some(m => m.row === 2 && m.col === 3), 'the in-area mine is reported');
  assert.ok(!mines.some(m => m.row === 7 && m.col === 7), 'a mine outside the 5x5 is not');
  const corner = xRayScan(board, 0, 0);
  assert.equal(corner.area.length, 9, 'corner clamps to 3x3');

  const magnet = magnetPull(rectBoard(9, 9, [[4, 5]]), 4, 4);
  assert.equal(magnet.affectedArea.length, 9, 'interior magnet reach is the 3x3');
  assert.equal(magnet.extractedMines.length, 1);
});

test('REGRESSION: on a tiling every area power-up reads the GRAPH, not the container', () => {
  // Floret 2x4 = 48 cells in a 6x8 container. Mines placed so container
  // geometry and graph geometry disagree.
  const tiling = buildTiling('floret', 2, 4);
  const rows = 6, cols = 8;
  const origin = 20;
  const ball = new Set([origin, ...sonarScanCells(tilingBoard('floret', 2, 4, rows, cols), rows, cols, Math.floor(origin / cols), origin % cols)]);
  // A mine INSIDE the graph ball, and a mine in the same container row but
  // OUTSIDE the ball (the old row-sweep would have counted it).
  const inBall = [...ball].find(i => i !== origin);
  const sameRowOutside = (() => {
    const r = Math.floor(origin / cols);
    for (let c = 0; c < cols; c++) { const i = r * cols + c; if (!ball.has(i)) return i; }
    return null;
  })();
  assert.ok(sameRowOutside !== null, 'CONTROL: the container row must leave the ball, or this test is vacuous');

  const board = tilingBoard('floret', 2, 4, rows, cols, [inBall, sameRowOutside]);
  const r0 = Math.floor(origin / cols), c0 = origin % cols;

  // SCAN is the crossing sweep, not a blob (his correction, 2026-08-03:
  // "Scan should move in some reasonable way horizontally and vertically").
  // The lines must be LINE-shaped: thin in the crossing axis, long in their
  // own — and must NOT reproduce the depth-2 ball the first cut shipped.
  const scan = scanLines(board, rows, cols, r0, c0);
  const posOf = (idx) => tiling.cellPos[idx];
  const o = posOf(origin);
  assert.ok(scan.across.includes(origin) && scan.down.includes(origin), 'target sits on both lines');
  const acrossYSpread = Math.max(...scan.across.map(i => Math.abs(posOf(i).cy - o.cy)));
  const acrossXSpread = Math.max(...scan.across.map(i => Math.abs(posOf(i).cx - o.cx)));
  assert.ok(acrossYSpread < 0.75, `across is a thin band (y-spread ${acrossYSpread.toFixed(2)})`);
  assert.ok(acrossXSpread > 2, `across runs long horizontally (x-spread ${acrossXSpread.toFixed(2)})`);
  const downXSpread = Math.max(...scan.down.map(i => Math.abs(posOf(i).cx - o.cx)));
  const downYSpread = Math.max(...scan.down.map(i => Math.abs(posOf(i).cy - o.cy)));
  assert.ok(downXSpread < 0.75, `down is a thin band (x-spread ${downXSpread.toFixed(2)})`);
  assert.ok(downYSpread > 2, `down runs long vertically (y-spread ${downYSpread.toFixed(2)})`);
  // CONTROL vs the blob: the ball and the lines are different regions.
  const lineUnion = new Set([...scan.across, ...scan.down]);
  assert.ok([...ball].some(i => !lineUnion.has(i)), 'some ball cell is OFF the lines — this is not the blob');
  assert.ok([...lineUnion].some(i => !ball.has(i)), 'some line cell is OUTSIDE the ball — the lines reach further');
  // Mine accounting: mines count on the line that carries them.
  const acrossSet = new Set(scan.across);
  const expectAcross = scan.across.filter(i => board[Math.floor(i / cols)][i % cols].isMine).length;
  const expectDown = scan.down.filter(i => board[Math.floor(i / cols)][i % cols].isMine).length;
  assert.equal(scan.acrossMines, expectAcross);
  assert.equal(scan.downMines, expectDown);
  assert.ok(acrossSet.size >= 3 && scan.down.length >= 3, 'both lines actually contain cells');

  const xray = xRayScan(board, r0, c0);
  assert.deepEqual(xray.area.map(a => a.row * cols + a.col).sort((a, b) => a - b), [...ball].sort((a, b) => a - b),
    'x-ray reads the same ball');
  assert.equal(xray.mines.length, 1);
  assert.equal(xray.mines[0].row * cols + xray.mines[0].col, inBall);

  // Magnet: depth-1 — the target plus its graph neighbors, nothing more. A
  // mine sits ON a graph neighbor, and a second mine on a container-adjacent
  // cell OUTSIDE the neighborhood (the old 3x3 would have grabbed it).
  const d1 = new Set([origin, ...tiling.adj[origin]]);
  const d1Mine = tiling.adj[origin][0];
  const containerAdjacent = (() => {
    for (const idx of [origin - 1, origin + 1, origin - cols, origin + cols]) {
      if (idx >= 0 && idx < rows * cols && !d1.has(idx)) return idx;
    }
    return null;
  })();
  assert.ok(containerAdjacent !== null, 'CONTROL: a container-adjacent non-neighbor must exist, or the magnet case is vacuous');
  const magnet = magnetPull(tilingBoard('floret', 2, 4, rows, cols, [d1Mine, containerAdjacent]), r0, c0);
  assert.deepEqual(magnet.affectedArea.map(a => a.row * cols + a.col).sort((a, b) => a - b), [...d1].sort((a, b) => a - b),
    'magnet reach is the depth-1 neighborhood');
  assert.equal(magnet.extractedMines.length, 1, 'the graph-neighbor mine extracts');
  assert.equal(magnet.extractedMines[0].row * cols + magnet.extractedMines[0].col, d1Mine);

  // Empty pull stays a clean no-op on tilings too (the magnetExtract pin).
  const empty = magnetPull(tilingBoard('floret', 2, 4, rows, cols, []), r0, c0);
  assert.deepEqual(empty.affectedArea, []);
});

test('scan lines on the 4.8.8: an octagon-centered sweep is exactly its octagon row', () => {
  // The crispest pin available: octagon centers in one visual row share cy
  // exactly, the interstitial diamonds sit half a pitch off with a box too
  // short to reach the line, and STRICT spanning keeps grazing tips out.
  const tiling = buildTiling('4.8.8', 6, 7);
  const { containerFor } = { containerFor: null };
  const rows = 6, cols = 12; // 72 = 6x12
  const board = [];
  for (let r = 0; r < rows; r++) { const row = []; for (let c = 0; c < cols; c++) row.push({ isMine: false }); board.push(row); }
  board._cellNeighbors = tiling.adj;
  board._cellPos = tiling.cellPos;
  board._tiling = { type: '4.8.8', M: 6, N: 7 };
  const octIdx = tiling.cellPos.findIndex(p => p.shape === 'oct');
  const scan = scanLines(board, rows, cols, Math.floor(octIdx / cols), octIdx % cols);
  const o = tiling.cellPos[octIdx];
  for (const i of scan.across) {
    assert.equal(tiling.cellPos[i].shape, 'oct', `across from an octagon holds only octagons (got ${tiling.cellPos[i].shape} at ${i})`);
    assert.ok(Math.abs(tiling.cellPos[i].cy - o.cy) < 1e-9, 'across octagons share the exact center line');
  }
  assert.ok(scan.across.length >= 3, 'the row has octagons on it');
});
