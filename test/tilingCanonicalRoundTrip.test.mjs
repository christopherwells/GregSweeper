// A tiling board must survive the canonical round trip — Firebase write,
// JSON, read back — as the SAME board it was certified as.
//
// Before this, serializeBoard emitted `wallEdges` and nothing else topological,
// so a tiling canonical came back RECTANGULAR: the adjacency it was certified
// under was gone, both number layers recomputed against the 8-neighborhood, and
// every client on that date would have played a different board from the one
// the generator proved. That is the Phase 1 save-resume bug (a tiling game
// resumed rectangular mid-play) moved onto the path where the board IS the
// canonical, so nobody would have had a correct copy to disagree with.
//
// The tests deliberately go through JSON.parse(JSON.stringify(...)) rather than
// handing the payload straight back: the payload's whole purpose is to be
// JSON, and properties stamped on the board ARRAY (which is how every topology
// field is carried) are exactly what JSON silently drops.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { serializeBoard, deserializeBoard } from '../src/firebase/dailyBoardSync.js';
import { generateTilingBoard } from '../src/logic/tilingGenerator.js';
import {
  buildTiling, containerFor, containerIsStorable,
  CANONICAL_MIN_DIM, CANONICAL_MAX_DIM,
} from '../src/logic/tilingGeometry.js';
import { generateBoard } from '../src/logic/boardGenerator.js';
import { isBoardSolvable } from '../src/logic/boardSolver.js';
import { recalcAllAdjacency, recomputeDisplayedMines } from '../src/logic/gimmicks.js';
import { computeDailyFeatures } from '../src/logic/dailyFeatures.js';

const wire = (payload) => JSON.parse(JSON.stringify(payload));

function tilingBoard(type, M, N, gimmicks = [], seed = 'roundtrip') {
  const T = buildTiling(type, M, N);
  const res = generateTilingBoard({
    type, M, N,
    mines: Math.round(T.total * 0.2),
    seed: `${seed}:${type}:${gimmicks.join('+')}`,
    gimmicks,
  });
  assert.ok(res, `expected a certified ${type} board`);
  let totalMines = 0;
  for (const row of res.board) for (const cell of row) if (cell.isMine) totalMines++;
  return { ...res, T, totalMines };
}

function roundTrip(b, extra = {}) {
  const payload = wire(serializeBoard({
    board: b.board, rows: b.rows, cols: b.cols, totalMines: b.totalMines,
    rngSeed: 'seed-1', activeGimmicks: b.activeGimmicks,
    firstClick: b.firstClick, ...extra,
  }));
  return { payload, restored: deserializeBoard(payload) };
}

// ── The core property ────────────────────────────────────────────

test('REGRESSION: a tiling board round-trips with its topology, not as a rectangle', () => {
  for (const [type, M, N] of [['hex', 9, 7], ['4.8.8', 6, 7]]) {
    const b = tilingBoard(type, M, N);
    const { restored } = roundTrip(b);

    assert.ok(restored.board._cellNeighbors, `${type}: restored board lost its topology`);
    assert.deepEqual(
      restored.board._cellNeighbors.map((l) => [...l]),
      b.board._cellNeighbors.map((l) => [...l]),
      `${type}: adjacency must survive the trip exactly`,
    );
    assert.equal(restored.board._tiling.type, type);
    assert.equal(restored.board._tiling.M, M);
    assert.equal(restored.board._tiling.N, N);
    assert.ok(restored.board._cellPos, `${type}: renderer switch (_cellPos) must survive`);
    assert.equal(restored.board._cellPos.length, b.T.total);
  }
});

test('REGRESSION: both number layers recompute IDENTICALLY after the round trip', () => {
  // This is the check the nightly sweep runs, and the one that would have
  // hard-failed every tiling canonical: recalcAllAdjacency and
  // recomputeDisplayedMines both read the board's topology, so a board
  // restored as a rectangle recomputes a completely different number layer.
  for (const [type, M, N, gimmicks] of [
    ['hex', 9, 7, []],
    ['hex', 9, 7, ['sonar', 'liar']],
    ['4.8.8', 6, 7, []],
    ['4.8.8', 6, 7, ['walls']],
    ['4.8.8', 6, 7, ['compass']],
  ]) {
    const b = tilingBoard(type, M, N, gimmicks);
    const { restored } = roundTrip(b);
    const cells = restored.board.flat();
    const storedAdj = cells.map((c) => c.adjacentMines);
    const storedDisp = cells.map((c) => c.displayedMines);

    recalcAllAdjacency(restored.board);
    recomputeDisplayedMines(restored.board);

    const label = `${type}${gimmicks.length ? ` + ${gimmicks.join(',')}` : ''}`;
    assert.deepEqual(cells.map((c) => c.adjacentMines), storedAdj, `${label}: adjacentMines drifted`);
    assert.deepEqual(cells.map((c) => c.displayedMines), storedDisp, `${label}: displayedMines drifted`);
  }
});

test('REGRESSION: a compass ray survives, so the number is not silently zero', () => {
  // compassRay was absent from CELL_FIELDS. On an explicit topology a compass
  // is a geometry question the neighbour graph cannot answer, so the ray is
  // computed once and STAMPED; compassRayCells returns [] without it, which
  // makes every compass cell recompute to 0 -- a wrong number, not an error --
  // and the certifier then proves from a premise the board never displayed.
  let checked = 0;
  for (const [type, M, N] of [['4.8.8', 6, 7], ['hex', 9, 7]]) {
    const b = tilingBoard(type, M, N, ['compass'], 'compass-ray');
    const { restored } = roundTrip(b);
    for (let i = 0; i < b.rows * b.cols; i++) {
      const src = b.board[(i / b.cols) | 0][i % b.cols];
      if (!src.isCompass) continue;
      const dst = restored.board[(i / b.cols) | 0][i % b.cols];
      assert.deepEqual(dst.compassRay, src.compassRay,
        `${type}: compass ray at index ${i} did not survive`);
      checked++;
    }
  }
  // The assertion above is vacuous if no compass cell was ever placed.
  assert.ok(checked > 0, 'no compass cells were placed — fixture proves nothing');
});

test('a restored tiling board still CERTIFIES from its stored opener', () => {
  for (const [type, M, N] of [['hex', 9, 7], ['4.8.8', 6, 7]]) {
    const b = tilingBoard(type, M, N);
    const { payload, restored } = roundTrip(b);

    assert.equal(payload.firstClick, b.firstClick, `${type}: opener must be stored`);
    assert.equal(restored.firstClick, b.firstClick, `${type}: opener must be restored`);

    const fr = Math.floor(restored.firstClick / restored.cols);
    const fc = restored.firstClick % restored.cols;
    const check = isBoardSolvable(restored.board, restored.rows, restored.cols, fr, fc);
    assert.ok(check.solvable && check.remainingUnknowns === 0,
      `${type}: restored board must re-certify from the cell it was certified from`);
  }
});

test('the container centre is NOT reliably the opener (why firstClick is stored)', () => {
  // Why the nightly sweep could not keep deriving the opener as
  // floor(rows/2)*cols + floor(cols/2). The container is an arbitrary exact
  // factorization of the CELL COUNT, so whether its middle slot lands on the
  // tiling's centre cell is arithmetic luck:
  //
  //   4.8.8 always diverges — its cell count is 2MN-M-N+1, so the container
  //   bears no relation to the M x N lattice at all (6x7 -> 72 cells in an 8x9
  //   container; opener 17, container centre 40).
  //
  //   hex diverges on EVEN M and coincides on odd M (9x7 and 11x11 both land
  //   on 31 and 60 respectively, by coincidence; 8x13 gives 45 vs 58).
  //
  // The coincidences are the dangerous part: a derivation that happens to
  // agree on the first tiling shipped would look correct until the dimensions
  // changed. Both branches are asserted so neither can silently become vacuous.
  const diverges = [['4.8.8', 6, 7], ['4.8.8', 8, 9], ['hex', 8, 13], ['hex', 10, 7]];
  const coincides = [['hex', 9, 7], ['hex', 11, 11]];
  const containerCentreOf = (total) => {
    const { rows, cols } = containerFor(total);
    return Math.floor(rows / 2) * cols + Math.floor(cols / 2);
  };

  for (const [type, M, N] of diverges) {
    const T = buildTiling(type, M, N);
    assert.notEqual(T.centerIndex, containerCentreOf(T.total),
      `${type} ${M}x${N}: expected the container centre to diverge from the opener`);
  }
  for (const [type, M, N] of coincides) {
    const T = buildTiling(type, M, N);
    assert.equal(T.centerIndex, containerCentreOf(T.total),
      `${type} ${M}x${N}: expected a coincidence here — if this moved, the note above is stale`);
  }

  // And end-to-end on a shipped board: the stored opener is the tiling's own
  // centre, not the container's.
  const b = tilingBoard('4.8.8', 6, 7);
  assert.equal(b.firstClick, buildTiling('4.8.8', 6, 7).centerIndex);
  assert.notEqual(b.firstClick, Math.floor(b.rows / 2) * b.cols + Math.floor(b.cols / 2));
});

test('features on a restored tiling board match the original', () => {
  for (const [type, M, N, gimmicks] of [['hex', 9, 7, ['walls']], ['4.8.8', 6, 7, ['walls']]]) {
    const b = tilingBoard(type, M, N, gimmicks);
    const { restored } = roundTrip(b);
    const st = (x) => ({
      board: x.board, rows: x.rows, cols: x.cols,
      totalMines: b.totalMines, activeGimmicks: gimmicks, rngSeed: 'seed-1',
    });
    const before = computeDailyFeatures(st(b), b.check);
    const after = computeDailyFeatures(st(restored), b.check);
    assert.deepEqual(after, before, `${type}: feature vector changed across the round trip`);
    // Specifically the two that read topology, so a deepEqual pass cannot be
    // hiding "both are equally wrong because both restored as rectangles".
    assert.ok(after.wallEdgeCount > 0, `${type}: fixture has no walls — proves nothing`);
    assert.equal(after.tilingType, type);
  }
});

// ── Rectangles are untouched ─────────────────────────────────────

test('a rectangular payload is byte-identical to before (no new fields)', () => {
  const board = generateBoard(9, 9, 12, 4, 4);
  const payload = wire(serializeBoard({
    board, rows: 9, cols: 9, totalMines: 12, rngSeed: '2026-07-23', activeGimmicks: [],
  }));
  for (const key of ['tiling', 'cellNeighbors', 'cellPos', 'tilingWalls', 'firstClick']) {
    assert.equal(key in payload, false, `rectangular payload gained a ${key} field`);
  }
  const restored = deserializeBoard(payload);
  assert.equal(restored.board._cellNeighbors, undefined, 'a rectangle must stay implicit-topology');
  assert.equal(restored.board._tilingWalls, undefined, 'a rectangle must not gain a tiling wall list');
  // The historical contract: with no stored opener the centre is the container
  // centre, which is what every canonical ever written was certified from.
  assert.equal(restored.firstClick, Math.floor(9 / 2) * 9 + Math.floor(9 / 2));
});

// ── Corrupt input fails closed ───────────────────────────────────

test('a corrupt topology is REJECTED, not restored', () => {
  const b = tilingBoard('hex', 9, 7);
  const { payload } = roundTrip(b);

  // Asymmetry is the dangerous one: it does not crash anything downstream, it
  // quietly certifies a board nobody can solve, because one cell's clue counts
  // a mine the mine's own neighbourhood does not count back.
  const asym = wire(payload);
  const victim = asym.cellNeighbors[0][0];
  asym.cellNeighbors[victim] = asym.cellNeighbors[victim].filter((n) => n !== 0);
  assert.throws(() => deserializeBoard(asym), /symmetr|neighbor/i,
    'an asymmetric edge list must be refused');

  const oob = wire(payload);
  oob.cellNeighbors[0] = [9999];
  assert.throws(() => deserializeBoard(oob), /range|bound|neighbor/i,
    'an out-of-range neighbour must be refused');

  const wrongLen = wire(payload);
  wrongLen.cellNeighbors = wrongLen.cellNeighbors.slice(0, 3);
  assert.throws(() => deserializeBoard(wrongLen), /length|neighbor/i,
    'a truncated topology must be refused');

  const notArray = wire(payload);
  notArray.cellNeighbors = 'nope';
  assert.throws(() => deserializeBoard(notArray), /array/i);
});

// ── The storability constraint ───────────────────────────────────

test('a container the canonical rules would reject fails loudly at serialize', () => {
  // 4.8.8 at M=8,N=8 is 2*8*8-8-8+1 = 113 cells. 113 is PRIME, so containerFor
  // can only return 1x113 and the rules (rows >= 5) reject the write outright.
  // Without this guard the only symptom is a canonical that never appears.
  const T = buildTiling('4.8.8', 8, 8);
  assert.equal(T.total, 113, 'fixture assumes a prime cell count');
  assert.equal(containerFor(113).rows, 1);
  assert.equal(containerIsStorable(113), false);

  const b = tilingBoard('4.8.8', 8, 8, [], 'prime-container');
  assert.throws(
    () => serializeBoard({
      board: b.board, rows: b.rows, cols: b.cols, totalMines: b.totalMines,
      rngSeed: 's', activeGimmicks: [], firstClick: b.firstClick,
    }),
    /canonical dimension bounds/,
  );

  // Both shipped tiling sizes must remain storable, or the guard is a blocker.
  assert.equal(containerIsStorable(buildTiling('hex', 9, 7).total), true);
  assert.equal(containerIsStorable(buildTiling('4.8.8', 6, 7).total), true);
});

test('the mirrored dimension bounds still match firebase-rules.json', () => {
  // CANONICAL_MIN_DIM / MAX_DIM are a COPY of the rules' own bounds. If the
  // rules move and this copy does not, boards get refused locally that the
  // server would accept, or worse, accepted locally and dropped on write.
  const rules = JSON.parse(readFileSync(new URL('../firebase-rules.json', import.meta.url), 'utf8'));
  for (const block of ['dailyBoard', 'weeklyBoard']) {
    const node = rules.rules[block];
    const wildcard = Object.keys(node).find((k) => k.startsWith('$'));
    for (const dim of ['rows', 'cols']) {
      const v = node[wildcard][dim]['.validate'];
      assert.ok(v.includes(`>= ${CANONICAL_MIN_DIM}`),
        `${block}.${dim} lower bound moved away from CANONICAL_MIN_DIM (${v})`);
      assert.ok(v.includes(`<= ${CANONICAL_MAX_DIM}`),
        `${block}.${dim} upper bound moved away from CANONICAL_MAX_DIM (${v})`);
    }
  }
});

test('the tiling payload fields are whitelisted in BOTH rule blocks', () => {
  // dailyBoard/weeklyBoard end with "$other": {".validate": false}, so a field
  // the serializer emits without a rule entry makes the WHOLE write fail
  // validation and drop silently — the 866683d class.
  const rules = JSON.parse(readFileSync(new URL('../firebase-rules.json', import.meta.url), 'utf8'));
  for (const block of ['dailyBoard', 'weeklyBoard']) {
    const node = rules.rules[block];
    const wildcard = Object.keys(node).find((k) => k.startsWith('$'));
    assert.equal(node[wildcard].$other['.validate'], false, `${block} must stay closed`);
    for (const field of ['tiling', 'cellNeighbors', 'cellPos', 'tilingWalls', 'firstClick']) {
      assert.ok(node[wildcard][field], `${block} is missing a rule for ${field}`);
    }
  }
});
