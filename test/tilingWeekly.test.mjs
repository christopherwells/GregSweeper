// The tiling WEEKLY builder — the v1.10 launch week's Octagons board and any
// deliberate tiling weekly after it.
//
// There is no weekly shape ROTATION: which shape a week lands on is a call,
// not a draw. What this file pins is that when a tiling weekly IS built, it
// is built the way a weekly is (the same stacked modifier roll, certified,
// storable) and priced against the WEEKLY par band rather than the daily one
// — a week-long board chosen against a [20, 240]s band would be picked for a
// job it is not doing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTilingWeeklyBoard } from '../src/logic/shapeRotation.js';
import {
  TILING_BAND_CONFIGS, tilingConfigAttempts, tilingWeeklyConfigAttempts, priceBandEntry,
} from '../src/logic/tilingBandConfigs.js';
import { WEEKLY_PAR_BAND, DAILY_PAR_BAND } from '../src/logic/parBand.js';
import { TILING_TYPES, containerIsStorable, buildTiling } from '../src/logic/tilingGeometry.js';
import { TILING_SAFE_GIMMICKS } from '../src/logic/tilingGenerator.js';
import { getWeeklyGimmicks } from '../src/logic/gimmicks.js';
import { createDailyRNG } from '../src/logic/seededRandom.js';
import { serializeBoard, deserializeBoard } from '../src/firebase/dailyBoardSync.js';

// Real Mondays, all future at the time of writing.
const MONDAYS = ['2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31'];

test('a tiling weekly certifies, stacks weekly modifiers, and fits a storable container', () => {
  // One lattice per Monday keeps the suite quick while still covering the
  // cheap and the dear generators; rhombille is the slowest by two orders of
  // magnitude, so it gets exactly one board.
  const cases = [['4.8.8', MONDAYS[0]], ['hex', MONDAYS[1]], ['cairo', MONDAYS[2]], ['rhombille', MONDAYS[3]]];
  for (const [type, weekStart] of cases) {
    const built = buildTilingWeeklyBoard(weekStart, type);
    assert.ok(built, `${type} weekly for ${weekStart} failed to generate`);
    assert.ok(built.check.solvable || built.check.remainingUnknowns === 0,
      `${type} weekly for ${weekStart} came back uncertified`);

    // The weekly's identity is its stack: getWeeklyGimmicks draws 2 or 3
    // without replacement, and every one must survive onto the board.
    const expected = getWeeklyGimmicks(weekStart, createDailyRNG)
      .filter((g) => TILING_SAFE_GIMMICKS.includes(g));
    assert.deepEqual(built.activeGimmicks.slice().sort(), expected.slice().sort(),
      `${type} weekly must carry the weekly modifier roll`);
    assert.ok(built.activeGimmicks.length >= 2,
      `${type} weekly stacked only ${built.activeGimmicks.length} modifiers`);

    // A prime cell count forces a 1xN container the canonical rules reject.
    assert.ok(containerIsStorable(built.rows * built.cols),
      `${type} weekly: ${built.rows * built.cols} cells is not storable`);
    // The board carries its own lattice descriptor (serializeBoard reads it
    // off the board, never from a caller), and it must describe this board.
    const t = built.board._tiling;
    assert.equal(t.type, type);
    assert.equal(built.rows * built.cols, buildTiling(type, t.M, t.N).total);
  }
});

test('the same weekStart and shape always build the same board', () => {
  // The determinism a canonical rests on: two producers (the regenerate tool
  // and any future precompute) must land on identical bytes.
  for (const type of ['hex', '4.8.8']) {
    const a = buildTilingWeeklyBoard(MONDAYS[0], type);
    const b = buildTilingWeeklyBoard(MONDAYS[0], type);
    const bytes = (r) => JSON.stringify(serializeBoard({
      board: r.board, rows: r.rows, cols: r.cols, totalMines: r.totalMines,
      rngSeed: r.rngSeed, activeGimmicks: r.activeGimmicks, codeVersion: 'test',
      firstClick: r.firstClick,
    }));
    assert.equal(bytes(a), bytes(b), `${type} weekly must be deterministic`);
  }
});

test('a tiling weekly round-trips through the canonical payload with its topology intact', () => {
  const built = buildTilingWeeklyBoard(MONDAYS[0], '4.8.8');
  const payload = serializeBoard({
    board: built.board, rows: built.rows, cols: built.cols, totalMines: built.totalMines,
    rngSeed: built.rngSeed, activeGimmicks: built.activeGimmicks, codeVersion: 'test',
    firstClick: built.firstClick,
  });
  assert.ok(payload.cellNeighbors, 'the payload must carry the certified adjacency');
  assert.ok(payload.tiling && payload.tiling.type === '4.8.8');
  assert.equal(payload.firstClick, built.firstClick,
    'the opener must ride the payload: a tiling container centre is not the lattice centre');

  const back = deserializeBoard(payload);
  assert.equal(back.rows, built.rows);
  assert.equal(back.cols, built.cols);
  assert.ok(back.board._cellNeighbors, 'a restored tiling weekly must be a tiling, not a rectangle');
  assert.equal(back.firstClick, built.firstClick);
});

test('the weekly config draw uses the WEEKLY band, not the daily one', () => {
  // The load-bearing difference. Two independent checks so the test cannot
  // pass by the two draws happening to coincide on one date.
  assert.notEqual(WEEKLY_PAR_BAND.lo, DAILY_PAR_BAND.lo);
  assert.notEqual(WEEKLY_PAR_BAND.hi, DAILY_PAR_BAND.hi);

  // 1. The streams are disjoint: a weekStart IS a Monday date string, so a
  //    shared namespace would tie every weekly to that Monday's daily draw.
  //    Over a run of Mondays the two must disagree somewhere.
  const differs = MONDAYS.concat(['2026-09-07', '2026-09-14', '2026-09-21']).some((m) =>
    TILING_TYPES.some((t) => tilingWeeklyConfigAttempts(t, m)[0] !== tilingConfigAttempts(t, m)[0]));
  assert.ok(differs, 'the weekly config draw is indistinguishable from the daily one');

  // 2. Every draw is a real committed entry, and the attempt list keeps its
  //    fallback contract (drawn entry first, then the shape's fallback).
  for (const type of TILING_TYPES) {
    for (const m of MONDAYS) {
      const attempts = tilingWeeklyConfigAttempts(type, m);
      assert.ok(attempts.length >= 1 && attempts.length <= 2, `${type} ${m}: ${attempts.length} attempts`);
      for (const e of attempts) {
        assert.ok(TILING_BAND_CONFIGS[type].includes(e),
          `${type} ${m}: drew an entry that is not in the committed table`);
      }
      const fallback = TILING_BAND_CONFIGS[type].find((e) => e.fallback === true);
      assert.equal(attempts[attempts.length - 1], fallback,
        `${type} ${m}: the last attempt must be the shape's designated fallback`);
    }
  }
});

test('a malformed weekStart degrades to the fallback entry rather than throwing', () => {
  // Deterministic degenerate over a divergence: no production caller does
  // this, but a producer that threw here and one that did not would split.
  for (const type of TILING_TYPES) {
    const attempts = tilingWeeklyConfigAttempts(type, 'not-a-date');
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0], TILING_BAND_CONFIGS[type].find((e) => e.fallback === true));
  }
});

test('the weekly reaches for harder configs than the daily where a lattice allows it', () => {
  // Not a distribution test (four Mondays is no sample): a direct check that
  // the weekly band ADMITS entries the daily band excludes, which is the
  // reason the weekly draw exists at all. Every shape's dearest entry must
  // price inside the weekly band.
  for (const type of TILING_TYPES) {
    const dearest = Math.max(...TILING_BAND_CONFIGS[type].map((e) => priceBandEntry(type, e)));
    assert.ok(dearest >= WEEKLY_PAR_BAND.lo && dearest <= WEEKLY_PAR_BAND.hi,
      `${type}'s dearest config prices ${dearest.toFixed(0)}s, outside the weekly band`);
  }
});
