// REGRESSION: a banked match result whose strike penalties were priced off
// the raw extrapolation is RE-DERIVED before it is filed (his report and his
// recovery ask, 2026-08-19: "The data are good though and that's 50 minutes
// of our time that won't go into the model. There has to be a way to recover
// it.").
//
// The loss mechanism, both halves pinned below: the match node validates
// `time` and `penalty` at <= 3600 so an inflated result's write is refused
// whole, and matchFitRows refuses the same range so the board never reaches
// the fit either. The repair replays each strike on the stored board under
// the fixed pricing, rebuilds the penalty and the penalty-inclusive time
// from the exact wall clock (`time - penalty`), and reports the indices it
// changed so the caller can re-post them.

import './domShim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { repairMatchResult, repairMatchResults } = await import('../src/game/matchRepair.js');
const { serializeBoard } = await import('../src/firebase/dailyBoardSync.js');
const { computeBombInfoValue } = await import('../src/logic/bombInfoValue.js');
const { generateBoard, cleanSolverArtifacts } = await import('../src/logic/boardGenerator.js');
const { createDailyRNG } = await import('../src/logic/seededRandom.js');
const { matchFitRows } = await import('../src/logic/matchStandings.js');

// A real generated board, serialized exactly as a dealt entry stores it.
function fixture() {
  const rows = 9, cols = 9, mines = 16;
  const fr = 4, fc = 4;
  const board = generateBoard(rows, cols, mines, fr, fc, createDailyRNG('unit-repair-9'));
  cleanSolverArtifacts(board);
  const strikes = [];
  for (let r = 0; r < rows && strikes.length < 2; r++) {
    for (let c = 0; c < cols && strikes.length < 2; c++) {
      if (board[r][c].isMine) strikes.push({ row: r, col: c });
    }
  }
  const payload = serializeBoard({
    board, rows, cols, totalMines: mines, rngSeed: 'unit-repair-9',
    activeGimmicks: [], firstClick: fr * cols + fc,
  });
  const features = { cellCount: rows * cols, totalMines: mines, zeroClusterCount: 2 };
  return { board, rows, cols, fr, fc, strikes, payload, features };
}

// What the FIXED pricing says those strikes cost at a given sane par.
function honestPenalties(fx, par) {
  const prior = [];
  const out = [];
  for (let i = 0; i < fx.strikes.length; i++) {
    const s = fx.strikes[i];
    const { infoValue } = computeBombInfoValue(
      fx.board, fx.rows, fx.cols, fx.fr, fx.fc, s.row, s.col,
      prior.slice(), fx.features, par,
    );
    out.push(Math.round((infoValue + 3 * (1 + 0.5 * i)) * 10) / 10);
    prior.push({ row: s.row, col: s.col });
  }
  return out;
}

test('an inflated result is re-derived exactly, and its wall clock survives', () => {
  const fx = fixture();
  const par = 600;
  const honest = honestPenalties(fx, par);
  const honestTotal = Math.round(honest.reduce((a, b) => a + b, 0) * 10) / 10;

  // The banked result as the broken build wrote it: the same strikes, priced
  // off the raw extrapolation (thousands of seconds each), with preciseTime
  // penalty-inclusive so the stored time carries the inflation too.
  const wall = 412.5;
  const inflated = [8100.4, 9200.7];
  const inflatedTotal = Math.round(inflated.reduce((a, b) => a + b, 0) * 10) / 10;
  const res = {
    seed: 'unit-repair-9',
    time: Math.round((wall + inflatedTotal) * 10) / 10,
    penalty: inflatedTotal,
    strikes: 2,
    par,
    bombHitEvents: fx.strikes.map((s, i) => ({
      t: 10 * (i + 1), row: s.row, col: s.col,
      penalty: inflated[i], infoValue: inflated[i] - 3 * (1 + 0.5 * i),
    })),
    wormEvents: [],
    scrolled: true,
  };
  assert.ok(res.time > 3600, 'precondition: the stored row must be out of range or nothing was lost');

  const fixed = repairMatchResult({ payload: fx.payload, features: fx.features }, res);
  assert.ok(fixed, 'an inflated result must be repaired');
  assert.equal(fixed.penalty, honestTotal, 'penalty is the re-derived total, not a scaled guess');
  assert.equal(fixed.time, Math.round((wall + honestTotal) * 10) / 10,
    'time is rebuilt from the exact wall clock (stored time minus stored penalty)');
  assert.ok(fixed.time <= 3600, 'the repaired row must now clear the range both destinations enforce');
  assert.deepEqual(fixed.bombHitEvents.map((e) => e.penalty), honest,
    'every event carries its own re-derived penalty');
  // Untouched fields ride through: the fit row needs them.
  assert.equal(fixed.seed, res.seed);
  assert.equal(fixed.scrolled, true);
  assert.equal(fixed.strikes, 2);
});

test('a repaired row is one the fit will actually take, where the inflated one was dropped', () => {
  const fx = fixture();
  const par = 600;
  const wall = 412.5;
  const inflatedTotal = 17301.1;
  const entry = { seed: 'unit-repair-9', payload: fx.payload, features: fx.features, spec: { mines: 16 } };
  const res = {
    seed: 'unit-repair-9',
    time: Math.round((wall + inflatedTotal) * 10) / 10,
    penalty: inflatedTotal,
    strikes: 2,
    par,
    bombHitEvents: fx.strikes.map((s, i) => ({
      t: 10 * (i + 1), row: s.row, col: s.col, penalty: inflatedTotal / 2, infoValue: inflatedTotal / 2 - 3,
    })),
    wormEvents: [],
  };
  // Before: the row is silently dropped, which is the 50 minutes lost.
  const before = matchFitRows([entry], [res]);
  assert.equal(before.rows.length, 0, 'precondition: the inflated row files nothing');
  assert.equal(before.tooFast, 1, 'and it is dropped by the range check');

  // After: the same play files a row.
  const match = { entries: [entry], results: [res] };
  const fixedIdx = repairMatchResults(match);
  assert.deepEqual(fixedIdx, [0], 'the repair reports the index it changed, for re-posting');
  const after = matchFitRows([entry], match.results);
  assert.equal(after.rows.length, 1, 'the repaired row reaches the model');
  assert.equal(after.rows[0].bombHits, 2, 'with its strikes intact');
  assert.ok(after.rows[0].bombHitEvents.every((e) => e.penalty > 0),
    'and per-hit events the R side can read the base sum from');
});

test('an already-honest result is left alone, byte for byte', () => {
  // The no-op contract that lets the repair run unconditionally: recomputing
  // a result the fixed build wrote reproduces it, so nothing is rewritten and
  // no "was this a bad build" marker is needed anywhere.
  const fx = fixture();
  const par = 600;
  const honest = honestPenalties(fx, par);
  const total = Math.round(honest.reduce((a, b) => a + b, 0) * 10) / 10;
  const res = {
    time: Math.round((100 + total) * 10) / 10,
    penalty: total,
    strikes: 2,
    par,
    bombHitEvents: fx.strikes.map((s, i) => ({
      t: 5, row: s.row, col: s.col, penalty: honest[i], infoValue: honest[i] - 3 * (1 + 0.5 * i),
    })),
  };
  assert.equal(repairMatchResult({ payload: fx.payload, features: fx.features }, res), null,
    'an honest result reports no change');
  const match = { entries: [{ payload: fx.payload, features: fx.features }], results: [res] };
  assert.deepEqual(repairMatchResults(match), [], 'and the batch reports nothing to re-post');
});

test('the repair refuses to guess: no board, no par, no events, no answer', () => {
  const fx = fixture();
  const ev = [{ t: 1, row: fx.strikes[0].row, col: fx.strikes[0].col, penalty: 9000, infoValue: 8997 }];
  const base = { time: 9400, penalty: 9000, strikes: 1, par: 600, bombHitEvents: ev };
  assert.equal(repairMatchResult(null, base), null);
  assert.equal(repairMatchResult({ payload: fx.payload }, null), null);
  assert.equal(repairMatchResult({ payload: null }, base), null, 'no board to replay on');
  assert.equal(repairMatchResult({ payload: fx.payload }, { ...base, par: 0 }), null,
    'no sane baseline to price against');
  assert.equal(repairMatchResult({ payload: fx.payload }, { ...base, bombHitEvents: [] }), null,
    'a clean board has nothing to repair');
});

test('the match-end path re-derives BEFORE filing, and re-posts what the node refused', () => {
  const src = readFileSync(new URL('../src/game/winLossHandler.js', import.meta.url), 'utf8');
  const finish = src.slice(src.indexOf('function _finishMatchRun'), src.indexOf('// ── Handle Win'));
  assert.ok(finish.includes('repairMatchResults(m)'), 'the finish path must re-derive');
  assert.ok(finish.indexOf('repairMatchResults(m)') < finish.indexOf('matchFitRows(m.entries, m.results)'),
    'the repair must run BEFORE the rows are built, or it files the inflated numbers');
  assert.ok(finish.includes('postMatchResult'),
    'a repaired result must be re-posted; the node refused it the first time');
});
