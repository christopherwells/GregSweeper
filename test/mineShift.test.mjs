// Mine Shift: how a mine moves, how often, and how many.
//
// Christopher's rulings (2026-08-04, while opening Chaos to the board
// shapes): move like the worm; not as often, between 2 and 20 seconds; and
// multiple mines can move if the difficulty rolls that way.
//
// The move rule is the load-bearing one. Mine Shift is Chaos-only and Chaos
// has always been rectangular, so its 8-neighborhood coordinate walk had
// never met a lattice. On a tiling, `(row±1, col±1)` indexes the CONTAINER —
// an arbitrary exact factorization of the cell count — so a mine would have
// "shifted" to a cell it does not touch, usually nowhere near it, and the
// numbers around both would have moved for no visible reason. Nothing would
// have thrown.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  performMineShift, applyGimmicks, mineShiftIsActive,
  MINESHIFT_MIN_SECONDS, MINESHIFT_MAX_SECONDS, MINESHIFT_MAX_MOVERS,
} from '../src/logic/gimmicks.js';
import { generateTilingBoard } from '../src/logic/tilingGenerator.js';
import { buildWormCrawlTopology } from '../src/logic/worms.js';
import { createDailyRNG } from '../src/logic/seededRandom.js';
import { buildTiling, buildWireframe } from '../src/logic/tilingGeometry.js';

/** A plain rectangular board with mines at the given flat indices. */
function rectBoard(rows, cols, mineIdx = []) {
  const set = new Set(mineIdx);
  const board = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => ({
    row: r, col: c, isMine: set.has(r * cols + c), isRevealed: false, isFlagged: false,
    adjacentMines: 0, displayedMines: 0,
  })));
  return board;
}

function minePositions(board) {
  const out = [];
  for (const row of board) for (const cell of row) if (cell.isMine) out.push(`${cell.row},${cell.col}`);
  return out.sort();
}

// ── The move rule ────────────────────────────────────────────────────────

test('REGRESSION: on a tiling a mine only moves to a cell it SHARES AN EDGE with', () => {
  for (const type of ['hex', '4.8.8', 'rhombille', 'cairo']) {
    const built = generateTilingBoard({ type, M: 6, N: 6, mines: 10, seed: `ms:${type}`, gimmicks: [] });
    assert.ok(built, `${type} failed to generate`);
    const { board, rows, cols } = built;

    // The truth to check against: pairs that share a polygon EDGE. A wireframe
    // entry exists only for a pair sharing exactly two vertices, so corner-only
    // neighbours are absent from it by construction — which is the point.
    const T = buildTiling(type, board._tiling.M, board._tiling.N);
    const sideOf = new Map();
    for (const e of buildWireframe(T).edges) {
      (sideOf.get(e.cellA) || sideOf.set(e.cellA, new Set()).get(e.cellA)).add(e.cellB);
      (sideOf.get(e.cellB) || sideOf.set(e.cellB, new Set()).get(e.cellB)).add(e.cellA);
    }

    const topology = buildWormCrawlTopology(board, rows, cols);
    assert.ok(topology, `${type} must carry a crawl topology`);

    let moved = 0;
    for (let tick = 0; tick < 40; tick++) {
      const shifted = performMineShift(board, createDailyRNG(`t${tick}:${type}`), topology, 3);
      for (const s of shifted) {
        moved++;
        const from = s.from.row * cols + s.from.col;
        const to = s.to.row * cols + s.to.col;
        assert.ok(sideOf.get(from) && sideOf.get(from).has(to),
          `${type}: a mine moved from cell ${from} to ${to}, which shares no edge with it`);
      }
    }
    assert.ok(moved > 0, `${type}: no mine ever moved, so nothing was tested`);
  }
});

test('CONTROL: the lattice really does offer non-edge neighbours to move to wrongly', () => {
  // Without this the regression above could pass on a lattice where every
  // container neighbour happens to be an edge neighbour, proving nothing.
  const built = generateTilingBoard({ type: 'rhombille', M: 4, N: 4, mines: 8, seed: 'ctl', gimmicks: [] });
  const { board, rows, cols } = built;
  const topology = buildWormCrawlTopology(board, rows, cols);

  // Corner-inclusive adjacency is strictly wider than the side-only crawl on
  // rhombille (interior valence 10 against 4 sides).
  const crawlCount = topology.neighborsOf(0, 0).length;
  const adjCount = board._cellNeighbors[0].length;
  assert.ok(adjCount > crawlCount,
    `rhombille cell 0 has ${adjCount} neighbours and ${crawlCount} crawl exits — no gap to test`);

  // And the container walk reaches cells that are neither.
  const containerNeighbours = [];
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const nr = 0 + dr, nc = 0 + dc;
    if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) containerNeighbours.push(nr * cols + nc);
  }
  const crawl = new Set(topology.neighborsOf(0, 0).map((p) => p.r * cols + p.c));
  assert.ok(containerNeighbours.some((i) => !crawl.has(i)),
    'the container walk reaches only crawl neighbours here, so the old bug was untestable');
});

test('on a rectangle a mine moves orthogonally, never diagonally', () => {
  // The worm's rule on a square grid, which is what "move like the worm"
  // means here. The old walk included diagonals.
  const board = rectBoard(7, 7, [24]); // centre
  let moves = 0;
  for (let tick = 0; tick < 30; tick++) {
    const before = minePositions(board);
    const shifted = performMineShift(board, createDailyRNG(`r${tick}`), null, 1);
    for (const s of shifted) {
      const dr = Math.abs(s.to.row - s.from.row);
      const dc = Math.abs(s.to.col - s.from.col);
      assert.equal(dr + dc, 1, `moved (${dr}, ${dc}) — not a single orthogonal step`);
      moves++;
    }
    assert.equal(minePositions(board).length, before.length, 'a shift must not create or destroy mines');
  }
  assert.ok(moves > 0, 'no mine moved, so nothing was tested');
});

test('flagged and revealed mines never move', () => {
  const board = rectBoard(5, 5, [12, 6]);
  board[2][2].isFlagged = true;   // flagged mine
  board[1][1].isRevealed = true;  // revealed mine
  for (let tick = 0; tick < 25; tick++) {
    const shifted = performMineShift(board, createDailyRNG(`f${tick}`), null, MINESHIFT_MAX_MOVERS);
    assert.deepEqual(shifted, [], 'the only mines on the board are pinned, so nothing may move');
  }
  assert.ok(board[2][2].isMine && board[1][1].isMine, 'both pinned mines are still where they were');
});

test('a mine never lands on another mine, a revealed cell, or a flag', () => {
  const board = rectBoard(6, 6, [14, 15, 20, 21]); // a 2x2 block of mines
  // Marked cells must be SAFE ones, or the assertion tests nothing: a mine
  // that was revealed where it stood is still a mine and always will be.
  board[0][0].isRevealed = true;
  board[1][2].isRevealed = true;   // touches the block, a plausible landing
  board[2][1].isFlagged = true;    // ditto
  const blocked = [[0, 0], [1, 2], [2, 1]];

  for (let tick = 0; tick < 40; tick++) {
    const shifted = performMineShift(board, createDailyRNG(`d${tick}`), null, 4);
    assert.equal(minePositions(board).length, 4, 'mine count must be conserved');
    for (const s2 of shifted) {
      const dest = board[s2.to.row][s2.to.col];
      assert.ok(!dest.isRevealed, `a mine landed on revealed (${s2.to.row}, ${s2.to.col})`);
      assert.ok(!dest.isFlagged, `a mine landed on a flag at (${s2.to.row}, ${s2.to.col})`);
    }
    for (const [r, c] of blocked) {
      assert.ok(!board[r][c].isMine, `(${r}, ${c}) is marked and must never hold a mine`);
    }
  }
});

// ── The dials ────────────────────────────────────────────────────────────

test('the interval lands between 2 and 20 seconds', () => {
  // His ruling. The old range was 30-45s.
  assert.equal(MINESHIFT_MIN_SECONDS, 2);
  assert.equal(MINESHIFT_MAX_SECONDS, 20);
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const board = rectBoard(6, 6, [0, 7, 14]);
    const applied = applyGimmicks(board, 45, ['mineShift'], createDailyRNG(`i${i}`));
    const iv = applied.mineShift.interval;
    assert.ok(iv >= MINESHIFT_MIN_SECONDS && iv <= MINESHIFT_MAX_SECONDS,
      `interval ${iv}s is outside [${MINESHIFT_MIN_SECONDS}, ${MINESHIFT_MAX_SECONDS}]`);
    seen.add(iv);
  }
  // The roll must actually spread, not sit on one value.
  assert.ok(seen.size >= 8, `only ${seen.size} distinct intervals over 400 rolls`);
});

test('how many mines move is the difficulty dial, capped', () => {
  // His ruling: "multiple mines can move, if the difficulty rolls that way."
  // The count comes from getIntensity, the same ramp every other modifier
  // reads, so it must actually vary with level and stay inside the cap.
  const counts = new Set();
  for (const level of [41, 45, 50, 60, 80, 100, 120]) {
    for (let i = 0; i < 20; i++) {
      const board = rectBoard(8, 8, [0, 9, 18, 27, 36]);
      const applied = applyGimmicks(board, level, ['mineShift'], createDailyRNG(`c${level}:${i}`));
      const n = applied.mineShift.count;
      assert.ok(Number.isInteger(n) && n >= 1 && n <= MINESHIFT_MAX_MOVERS,
        `count ${n} at level ${level} is outside [1, ${MINESHIFT_MAX_MOVERS}]`);
      counts.add(n);
    }
  }
  assert.ok(counts.has(1), 'a low roll must still move a single mine');
  assert.ok(Math.max(...counts) > 1, 'the dial never rolled above one mine');
});

test('the mover count is honoured, and a thin board moves what it has', () => {
  // Asking for five movers on a board with two shiftable mines moves two,
  // rather than looping or throwing.
  const many = rectBoard(9, 9, [10, 12, 14, 30, 32, 34, 50, 52, 54]);
  const shifted = performMineShift(many, createDailyRNG('many'), null, 4);
  assert.equal(shifted.length, 4, 'four movers were asked for and are available');

  const thin = rectBoard(6, 6, [7, 9]);
  const few = performMineShift(thin, createDailyRNG('thin'), null, MINESHIFT_MAX_MOVERS);
  assert.equal(few.length, 2, 'only two mines exist, so only two may move');

  const empty = rectBoard(5, 5, []);
  assert.deepEqual(performMineShift(empty, createDailyRNG('empty'), null, 3), [],
    'a board with no mines shifts nothing');
});

test('the numbers are recomputed after a shift', () => {
  // A mine that moves without the clue layer following it is the whole
  // mechanic broken silently.
  const board = rectBoard(5, 5, [12]);
  // Seed the layer as if generation had run.
  for (const row of board) for (const c of row) { c.adjacentMines = 0; c.displayedMines = 0; }
  for (const [r, c] of [[1, 1], [1, 2], [1, 3], [2, 1], [2, 3], [3, 1], [3, 2], [3, 3]]) {
    board[r][c].adjacentMines = 1;
    board[r][c].displayedMines = 1;
  }
  const shifted = performMineShift(board, createDailyRNG('recompute'), null, 1);
  assert.equal(shifted.length, 1);
  const { row, col } = shifted[0].to;
  // Every neighbour of the mine's NEW home counts it.
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = row + dr, nc = col + dc;
      if (nr < 0 || nr > 4 || nc < 0 || nc > 4) continue;
      if (board[nr][nc].isMine) continue;
      assert.ok(board[nr][nc].adjacentMines >= 1,
        `(${nr}, ${nc}) neighbours the moved mine but counts ${board[nr][nc].adjacentMines}`);
    }
  }
});

// ── The shifter's LIFETIME (issue #238) ──────────────────────────────────
// The interval used to remember its cadence in a module variable that only
// stopTimer cleared, so it outlived the board that rolled it: leaving a Chaos
// round through the title screen paused the interval but kept the memory, and
// the next resumeTimer — a tab return, an unlocked phone, a dismissed bomb
// popup — restarted it against whatever game had been loaded since. On a
// resumed Daily that meant mines relocating inside a CANONICAL board mid-play.
//
// The predicate below is what both the restart and the tick now ask, so the
// answer comes from the live board instead of from a remembered number.

test('REGRESSION #238: only a live Chaos board that rolled mineShift may shift', () => {
  // The leak, stated as the states it used to run in.
  assert.equal(mineShiftIsActive({ gameMode: 'chaos', activeGimmicks: ['mineShift'] }), true,
    'the board that rolled it is the one board that shifts');

  assert.equal(mineShiftIsActive({ gameMode: 'daily', activeGimmicks: ['mineShift'] }), false,
    'a canonical daily never shifts, even if the flag rode along');
  assert.equal(mineShiftIsActive({ gameMode: 'weekly', activeGimmicks: ['mineShift'] }), false);
  assert.equal(mineShiftIsActive({ gameMode: 'normal', activeGimmicks: ['mineShift'] }), false,
    'a resumed challenge board never shifts');

  // Chaos WITHOUT the modifier: the leaked cadence used to restart here too,
  // because the old guard only asked whether the game was playing.
  assert.equal(mineShiftIsActive({ gameMode: 'chaos', activeGimmicks: ['walls', 'liar'] }), false);
  assert.equal(mineShiftIsActive({ gameMode: 'chaos', activeGimmicks: [] }), false);

  // Malformed / absent state is never a licence to mutate a board.
  assert.equal(mineShiftIsActive({ gameMode: 'chaos' }), false);
  assert.equal(mineShiftIsActive(null), false);
  assert.equal(mineShiftIsActive({}), false);
});
