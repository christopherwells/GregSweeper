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

test('REGRESSION: an honest result is not re-priced from the opener (issue #410)', () => {
  // The live handler prices a strike from the PLAYER'S board (resumeFromLiveState
  // defaults on, his 2026-08-20 ruling). This module was written the day before
  // that, when from-scratch was the shipped rule, and when the rule changed it
  // was given { liveState: false } to keep working on stored payloads. That
  // pinned it to the OLD basis while the live path moved on, and its premise
  // (a no-op on an honest result) stopped holding: the opener answer is
  // systematically LARGER, so ordinary honest boards were rewritten upward by
  // tens of seconds and that number reached the shared standings and the fit.
  //
  // Measured on shipped library boards at the time: +8.9s to +57.7s PER STRIKE.
  // A DENSER board than the shared fixture. On a plain 9x9 every mine prices
  // 0 on both bases because the whole board cascades, so the gap this test
  // exists to catch cannot appear there at all.
  const rows = 14, cols = 14, mines = 45, fr = 7, fc = 7;
  const board = generateBoard(rows, cols, mines, fr, fc, createDailyRNG('unit-410-dense'));
  cleanSolverArtifacts(board);
  const features = { cellCount: rows * cols, totalMines: mines, zeroClusterCount: 2 };
  const payload = serializeBoard({
    board, rows, cols, totalMines: mines, rngSeed: 'unit-410-dense',
    activeGimmicks: [], firstClick: fr * cols + fc,
  });
  const fx = { board, rows, cols, fr, fc, features, payload };
  const par = 600;

  // THE BOARD MUST BE HALF-PLAYED, or this proves nothing: on an untouched
  // board the live and opener readings are the SAME number, which is why a
  // fresh-board fixture passes even against the broken code. The inflation
  // only appears once the player has already done some of the deduction the
  // opener basis then charges them for again.
  const played = fx.board.map((row) => row.map((c) => ({ ...c })));
  let revealed = 0;
  outer: for (let r = 0; r < fx.rows; r++) {
    for (let c = 0; c < fx.cols; c++) {
      if (played[r][c].isMine) continue;
      played[r][c].isRevealed = true;
      if (++revealed >= Math.floor((rows * cols - mines) * 0.5)) break outer;
    }
  }

  // Pick the mine with the biggest gap between the two bases, which is the
  // strike the broken repair would inflate hardest. Scanning rather than
  // assuming: most mines anchor no deduction at all and price 0 either way.
  let target = null, live = null, fromOpener = null;
  for (let r = 0; r < fx.rows; r++) {
    for (let c = 0; c < fx.cols; c++) {
      if (!fx.board[r][c].isMine) continue;
      const l = computeBombInfoValue(played, fx.rows, fx.cols, fx.fr, fx.fc, r, c, [], fx.features, par);
      const o = computeBombInfoValue(
        fx.board, fx.rows, fx.cols, fx.fr, fx.fc, r, c, [], fx.features, par, { liveState: false });
      if (!target || (o.infoValue - l.infoValue) > (fromOpener.infoValue - live.infoValue)) {
        target = { row: r, col: c }; live = l; fromOpener = o;
      }
    }
  }
  assert.ok(target, 'the fixture must offer a mine to price');
  // NON-VACUITY: the two bases must actually disagree here, and the opener
  // must be the larger one, which is the overcharge the issue measured.
  assert.ok(fromOpener.infoValue - live.infoValue > 1,
    `the two bases must differ materially (live ${live.infoValue}, opener ${fromOpener.infoValue})`);
  assert.ok(live.patternBefore != null && live.searchAfter != null,
    'precondition: the live pricing must carry the counts this fix reads');

  // The row as the game actually banked it: charged on the live basis, with
  // the counts that measured that board state.
  const honestPenalty = Math.round((live.infoValue + 3) * 10) / 10;
  const res = {
    seed: 'unit-repair-9',
    time: Math.round((300 + honestPenalty) * 10) / 10,
    penalty: honestPenalty,
    strikes: 1,
    par,
    bombHitEvents: [{
      t: 10, row: target.row, col: target.col,
      penalty: honestPenalty, infoValue: Math.round(live.infoValue * 10) / 10,
      patternBefore: live.patternBefore, searchBefore: live.searchBefore,
      patternAfter: live.patternAfter, searchAfter: live.searchAfter,
    }],
    wormEvents: [],
  };
  assert.ok(res.time < 3600, 'precondition: this row is one both destinations accept');

  const out = repairMatchResult({ payload: fx.payload, features: fx.features }, res);
  assert.equal(out, null,
    'an honest, in-range row priced from its own stored counts must be left alone');
});

test('REGRESSION: a legacy row with no counts is left alone unless the destinations refuse it (#410)', () => {
  // Pre-2026-08-20 events carry no counts, so the only answer available is the
  // opener basis, which is NOT the rule those boards were charged under.
  // Applying it to an in-range row would rewrite a number the game accepted,
  // so it fires only where the row is already refused by BOTH destinations
  // (the match node validates <= 3600, matchFitRows refuses the same range).
  const fx = fixture();
  const ev = [{ t: 1, row: fx.strikes[0].row, col: fx.strikes[0].col, penalty: 40, infoValue: 37 }];

  // In range: untouched, even though the opener basis would give a different
  // number. This is the case the unconditional run was corrupting.
  const inRange = { time: 340, penalty: 40, strikes: 1, par: 600, bombHitEvents: ev };
  assert.equal(repairMatchResult({ payload: fx.payload, features: fx.features }, inRange), null,
    'an in-range legacy row must not be re-priced on a basis that cannot reproduce it');

  // Out of range: this is the cohort the module exists for, so it repairs.
  const inflated = {
    time: 9400, penalty: 9000, strikes: 1, par: 600,
    bombHitEvents: [{ ...ev[0], penalty: 9000, infoValue: 8997 }],
  };
  const fixed = repairMatchResult({ payload: fx.payload, features: fx.features }, inflated);
  assert.ok(fixed, 'a row both destinations would refuse must still be repaired');
  assert.ok(fixed.time <= 3600, 'and the repaired row must now clear their range');
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

test('REGRESSION: a run whose result post failed does not claim to be finished (#396)', () => {
  // Each board posts its result fire-and-forget. A post that did not land was
  // never re-sent, and the run still wrote finishedAt, so the standings read
  // that player as FINISHED on a total missing a board. A short total is a
  // SMALLER total, so they outranked everyone who banked all of theirs and the
  // report named the wrong winner, permanently.
  //
  // Pinned at the source, because the failure lives in an async import chain
  // that a unit test cannot reach without standing up Firebase: the finish
  // must re-post every banked index and must gate finishMatch on all of them
  // landing.
  const src = readFileSync(new URL('../src/game/winLossHandler.js', import.meta.url), 'utf8');
  const finish = src.slice(src.indexOf('function _finishMatchRun'), src.indexOf('// ── Handle Win'));
  assert.ok(finish.length > 200, 'the finish path was not found');

  // Every banked result is re-posted, not just the ones the repair touched.
  assert.ok(/for \(let i = 0; i < m\.results\.length; i\+\+\) if \(m\.results\[i\]\) idxs\.push\(i\)/.test(finish),
    'the finish must collect EVERY banked result index, not a subset');
  assert.ok(/postMatchResult\(m\.id, i, m\.results\[i\]\)/.test(finish),
    'and re-post each of them');

  // finishMatch is GATED: it must sit after the missing-check, not before it.
  const missingAt = finish.indexOf('const missing = idxs.filter');
  const finishAt = finish.indexOf('finishMatch(m.id)');
  assert.ok(missingAt > 0 && finishAt > 0, 'both the reconcile and the finish must exist');
  assert.ok(missingAt < finishAt,
    'finishMatch must come AFTER the reconcile, or the run claims finished on an incomplete node');
  assert.ok(/if \(missing\.length > 0\)[\s\S]{0,900}?return;/.test(finish),
    'a failed reconcile must RETURN before finishMatch, leaving the run unfinished');

  // The narrower repair-only re-post is gone, subsumed rather than duplicated.
  assert.ok(!/repaired\.map\(\(i\) => mod\.postMatchResult/.test(src),
    'the repair-only re-post should be subsumed by the full reconcile');
});

test('postMatchResult reports failure to its caller, on both paths', async () => {
  // The reconcile can only gate on something it can see. Both early exits
  // return false rather than throwing or resolving undefined: the offline
  // path (no Firebase, no uid) and the refused-write path.
  const src = readFileSync(new URL('../src/firebase/firebaseMatch.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function postMatchResult'),
    src.indexOf('export async function touchMatchPresence'));
  assert.ok(fn.length > 100, 'postMatchResult was not found');
  assert.ok(/if \(!ready \|\| !uid \|\| !matchId\) return false;/.test(fn),
    'the offline path must report false, which is the branch a phone actually takes');
  assert.ok(/return false;[\s\S]{0,40}\}\s*$/.test(fn.trim()) || (fn.match(/return false;/g) || []).length >= 2,
    'the refused-write path must report false too');
  assert.ok(/return true;/.test(fn), 'and success must be distinguishable');
});
