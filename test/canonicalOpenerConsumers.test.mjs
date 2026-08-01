// The client half of the certified-opener contract (issue #195).
//
// deserializeBoard has been the ONE definition of a canonical board's
// certified opener since 2026-07-23 (stored firstClick on a tiling, container
// centre on a rectangle). The Node consumers — nightly sweep, mine-adjacency
// repair, contribution backfill — were converted that day; the four CLIENT
// consumers (gameActions' daily and weekly canonical branches, both parResolve
// functions) were not, and kept hand-deriving floor(rows/2), floor(cols/2)
// from the container. On a rectangle the two expressions agree, which is why
// no existing test could tell them apart. On a tiling canonical the container
// is an arbitrary exact factorization, so its centre slot is an unrelated cell
// (sometimes literally a mine): measured over 18 round-trips of the shipped
// COASTLINE_BOARDS configs, the opener diverges on 12 and the container-centre
// solve loses certification on all 12, stalling at click 1 — features, par,
// and dailyMoves then come off the failed solve, a plausible number from the
// wrong cell, no error anywhere.
//
// Drives the REAL consumers headless: newGame()'s daily and weekly canonical
// branches through the shared DOM shim (canonical pre-stashed in state — the
// production fast path, so no network fires), and both parResolve functions
// through a firebase global stub serving the canonical over the real fetch +
// trust-gate path (pre-SIGNATURE_EPOCH dates, so the #114 gate grandfathers
// the unsigned payload).

import './domShim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { state } = await import('../src/state/gameState.js');
const { newGame } = await import('../src/game/gameActions.js');
const { computeDailyParForDate, computeWeeklyPar } = await import('../src/game/parResolve.js');
const { generateTilingBoard } = await import('../src/logic/tilingGenerator.js');
const { serializeBoard, deserializeBoard } = await import('../src/firebase/dailyBoardSync.js');
const { isBoardSolvable } = await import('../src/logic/boardSolver.js');
const { generateBoard, cleanSolverArtifacts } = await import('../src/logic/boardGenerator.js');
const { createDailyRNG, getLocalDateString, getWeekStart } = await import('../src/logic/seededRandom.js');
const { setMuted } = await import('../src/audio/sounds.js');

setMuted(true); // no AudioContext in node

// ── Firebase global stub ───────────────────────────────────────────────
// parResolve fetches its canonical itself (loadDailyBoard / loadWeeklyBoard),
// and waitForFirebaseReady reads the `firebase` global at CALL time — so a
// stub db here routes both functions through their real fetch + trust-gate
// path against payloads this file plants. Paths not planted read as
// server-reachable-and-empty (exists() false), the "no canonical" shape.
const dbPayloads = new Map();
globalThis.firebase = {
  apps: [{}],
  database: () => ({
    ref: (path) => ({
      once: async () => {
        const val = dbPayloads.has(path) ? dbPayloads.get(path) : undefined;
        return { exists: () => val !== undefined, val: () => (val === undefined ? null : val) };
      },
    }),
  }),
};

const wire = (p) => JSON.parse(JSON.stringify(p));

// One frozen tiling canonical shared by every consumer. 4.8.8 at M=6,N=7 is
// 72 cells in an 8x9 container, and a 4.8.8's opener ALWAYS diverges from the
// container centre (cell count 2MN-M-N+1 bears no relation to the M x N
// lattice). The precondition test asserts the divergence AND the stall, so
// the fixture can never silently go vacuous.
function makeTilingCanonical(rngSeed) {
  const res = generateTilingBoard({ type: '4.8.8', M: 6, N: 7, mines: 14, seed: rngSeed, gimmicks: [] });
  assert.ok(res, 'expected a certified 4.8.8 board');
  let totalMines = 0;
  for (const row of res.board) for (const cell of row) if (cell.isMine) totalMines++;
  return wire(serializeBoard({
    board: res.board, rows: res.rows, cols: res.cols, totalMines,
    rngSeed, activeGimmicks: res.activeGimmicks, firstClick: res.firstClick,
  }));
}

function solveFrom(raw, flatIndex) {
  const d = deserializeBoard(raw);
  const check = isBoardSolvable(d.board, d.rows, d.cols, Math.floor(flatIndex / d.cols), flatIndex % d.cols);
  cleanSolverArtifacts(d.board);
  return check;
}

// The date doubles as the payload's rngSeed and sits before SIGNATURE_EPOCH
// (2026-07-06), so the unsigned test payload is grandfathered by the trust
// gate rather than needing a play-window writtenAt.
const TILING_DATE = '2026-06-20';
const payload = makeTilingCanonical(TILING_DATE);
const d0 = deserializeBoard(payload);
const centreIndex = Math.floor(d0.rows / 2) * d0.cols + Math.floor(d0.cols / 2);
const openerCheck = solveFrom(payload, payload.firstClick);
const centreCheck = solveFrom(payload, centreIndex);

test('precondition: the fixture discriminates — stored opener certifies, container centre stalls', () => {
  assert.ok(Number.isInteger(payload.firstClick), 'the tiling payload must store its opener');
  assert.notEqual(payload.firstClick, centreIndex,
    '4.8.8 opener must diverge from the container centre or the pin is vacuous');
  assert.ok(openerCheck.solvable && openerCheck.remainingUnknowns === 0,
    'the stored opener must certify a full clear');
  assert.ok(openerCheck.totalClicks > 1);
  assert.ok(!(centreCheck.solvable || centreCheck.remainingUnknowns === 0),
    'the container-centre solve must FAIL, or the two anchors are indistinguishable');
  assert.ok(centreCheck.totalClicks < openerCheck.totalClicks,
    'the centre solve must stall well short of the certified click count');
});

test('REGRESSION: #195 — the daily play path solves from the stored opener, not the container centre', async () => {
  localStorage.clear();
  state.gameMode = 'daily';
  state.isDailyPractice = false;
  state.isArchivePlay = false;
  state._archiveRaw = null;
  state.currentLevel = 1;
  state.dailyFeatures = null;
  // The production fast path: the startup gate pre-stashed today's canonical,
  // so the daily branch reads it in memory and never touches the network.
  state.canonicalDailyBoard = { date: getLocalDateString(), raw: payload };

  await newGame();

  assert.equal(state.rows * state.cols, 72, 'the canonical tiling board must be adopted');
  assert.equal(state.dailyRngSeed, TILING_DATE, 'the payload rngSeed must be adopted');
  assert.equal(state.dailyMoves, openerCheck.totalClicks,
    'dailyMoves must come from the stored-opener solve');
  assert.equal(state.dailyFeatures.totalClicks, openerCheck.totalClicks,
    'the submitted feature vector must describe the stored-opener solve');
  assert.notEqual(state.dailyMoves, centreCheck.totalClicks,
    'the pre-fix number: a container-centre solve that stalls at the first click');
  assert.ok(state.dailyPar > 0, 'par must be computed from a certified solve');
});

test('REGRESSION: #195 — the weekly play path solves from the stored opener', async () => {
  localStorage.clear();
  state.gameMode = 'weekly';
  state.weeklyFeatures = null;
  state.canonicalWeeklyBoard = { weekStart: getWeekStart(), raw: payload };

  await newGame();

  assert.equal(state.rows * state.cols, 72, 'the canonical tiling board must be adopted');
  assert.equal(state.weeklyFeatures.totalClicks, openerCheck.totalClicks,
    'the weekly_first fit row must describe the stored-opener solve');
  assert.notEqual(state.weeklyFeatures.totalClicks, centreCheck.totalClicks,
    'the pre-fix number: a container-centre solve that stalls at the first click');
});

test('REGRESSION: #195 — computeDailyParForDate anchors par on the stored opener', async () => {
  localStorage.clear();
  state.dailyFeatures = null;
  dbPayloads.set(`dailyBoard/${TILING_DATE}`, payload);

  const { par, moves } = await computeDailyParForDate(TILING_DATE, true);

  // Pre-fix, the container-centre solve fails, the solvable gate rejects it,
  // and par silently reports 0 — the leaderboard/Daily-card badge blanks.
  assert.ok(par > 0, 'par must compute from the certified opener');
  assert.equal(moves, openerCheck.totalClicks,
    'the cached move count must come from the stored-opener solve');
});

test('REGRESSION: #195 — computeWeeklyPar anchors on the stored opener', async () => {
  localStorage.clear();
  const weekStart = '2026-06-15'; // pre-epoch, so the unsigned payload is grandfathered
  dbPayloads.set(`weeklyBoard/${weekStart}`, payload);

  const par = await computeWeeklyPar(weekStart);

  assert.ok(par > 0, 'pre-fix the centre solve fails its solvable gate and par reports 0');
});

test('rectangle fallback: no stored firstClick — the container centre, byte-identical behavior', async () => {
  localStorage.clear();
  // A rectangular canonical stores no opener (pinned in
  // tilingCanonicalRoundTrip), so deserializeBoard falls back to the container
  // centre — which is exactly the cell every rectangular canonical ever
  // written was certified from.
  const rng = createDailyRNG('rect-opener-fixture');
  const board = generateBoard(9, 9, 12, 4, 4, rng);
  cleanSolverArtifacts(board);
  const rectPayload = wire(serializeBoard({
    board, rows: 9, cols: 9, totalMines: 12, rngSeed: '2026-06-21', activeGimmicks: [],
  }));
  assert.equal('firstClick' in rectPayload, false, 'rectangles must not store an opener');

  const centreCheckRect = solveFrom(rectPayload, 4 * 9 + 4);
  assert.ok(centreCheckRect.solvable && centreCheckRect.remainingUnknowns === 0,
    'fixture must certify from its centre');

  // parResolve consumer.
  dbPayloads.set('dailyBoard/2026-06-21', rectPayload);
  state.dailyFeatures = null;
  const { par, moves } = await computeDailyParForDate('2026-06-21', true);
  assert.ok(par > 0);
  assert.equal(moves, centreCheckRect.totalClicks, 'the centre solve is unchanged for rectangles');

  // Daily play-path consumer.
  state.gameMode = 'daily';
  state.isDailyPractice = false;
  state.isArchivePlay = false;
  state._archiveRaw = null;
  state.dailyFeatures = null;
  state.canonicalDailyBoard = { date: getLocalDateString(), raw: rectPayload };
  await newGame();
  assert.equal(state.dailyMoves, centreCheckRect.totalClicks,
    'a rectangular canonical still solves from the container centre');
});
