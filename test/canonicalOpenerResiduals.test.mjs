// The three canonical-read residuals of the certified-opener contract
// (issue #201, found by adversarial verification of #195 / PR #199).
//
// PR #199 converted the play paths and both parResolve functions to consume
// the opener deserializeBoard returns (stored firstClick on a tiling,
// container centre on a rectangle). Three more consumer sites kept
// hand-deriving floor(rows/2), floor(cols/2) — zero-impact on rectangles,
// where the two expressions agree, and wrong the day a tiling routes into
// the rotation:
//
//   1. winLossHandler._renderWinReceipt — the win receipt's crux solve: the
//      centre solve stalls at click 1, extractCrux returns null, and the
//      receipt confesses "A breather board" on a board with a real crux.
//   2. winLossHandler.handleDailyBombHit — bomb strike pricing: both
//      info-value solver runs stall from the centre, so every strike prices
//      off the failed solve, and that number rides into the SUBMITTED time.
//   3. cruxTeaser.showCruxTeaser — the share page's breather classification:
//      extractCrux with no anchor defaults to the centre, so a tiling date
//      would be publicly mislabeled a breather.
//
// Same fixture-precondition discipline as canonicalOpenerConsumers: the
// tiling fixture must certify from its stored opener, stall from the
// container centre, carry a tier>=1 crux from the opener only, AND price at
// least one mine differently between the two anchors — asserted up front so
// no pin can silently go vacuous. Rectangle controls prove byte-identical
// behavior through the REAL consumers (a rectangular canonical stores no
// firstClick, so the resolved opener IS the centre).

import './domShim.mjs';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const { state } = await import('../src/state/gameState.js');
const { liveBoardOpener, _renderWinReceipt, handleDailyBombHit } = await import('../src/game/winLossHandler.js');
const { showCruxTeaser } = await import('../src/ui/cruxTeaser.js');
const { generateTilingBoard } = await import('../src/logic/tilingGenerator.js');
const { serializeBoard, deserializeBoard } = await import('../src/firebase/dailyBoardSync.js');
const { isBoardSolvable } = await import('../src/logic/boardSolver.js');
const { generateBoard, cleanSolverArtifacts } = await import('../src/logic/boardGenerator.js');
const { extractCrux } = await import('../src/logic/cruxExtract.js');
const { computeBombInfoValue } = await import('../src/logic/bombInfoValue.js');
const { createDailyRNG } = await import('../src/logic/seededRandom.js');
const { markNoticeSeen } = await import('../src/storage/statsStorage.js');
const { setMuted } = await import('../src/audio/sounds.js');

setMuted(true); // no AudioContext in node

// ── Firebase global stub (the canonicalOpenerConsumers pattern) ────────
// showCruxTeaser fetches its own canonical (loadCrux, then loadDailyBoard),
// and waitForFirebaseReady reads the `firebase` global at CALL time. Paths
// not planted read as server-reachable-and-empty — for `cruxes/{date}` that
// is exactly the no-crux-node shape that routes the teaser into the
// board-solve breather classification under test.
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
const round1 = (x) => Math.round(x * 10) / 10;

// One frozen tiling canonical shared by every site. 4.8.8 at M=6,N=7 is 72
// cells in an 8x9 container whose opener ALWAYS diverges from the container
// centre; 22 mines (density 0.31, the constructive placer) is what gives the
// board a tier-2 crux and nonzero bomb info-values — the 14-mine fixture in
// canonicalOpenerConsumers is a genuine tier-0 breather from BOTH anchors,
// which cannot discriminate these three surfaces.
function makeTilingCanonical(rngSeed) {
  const res = generateTilingBoard({ type: '4.8.8', M: 6, N: 7, mines: 22, seed: rngSeed, gimmicks: [] });
  assert.ok(res, 'expected a certified 4.8.8 board');
  let totalMines = 0;
  for (const row of res.board) for (const cell of row) if (cell.isMine) totalMines++;
  return wire(serializeBoard({
    board: res.board, rows: res.rows, cols: res.cols, totalMines,
    rngSeed, activeGimmicks: res.activeGimmicks, firstClick: res.firstClick,
  }));
}

function makeRectCanonical(genSeed, rngSeed) {
  const rng = createDailyRNG(genSeed);
  const board = generateBoard(9, 9, 16, 4, 4, rng);
  cleanSolverArtifacts(board);
  let totalMines = 0;
  for (const row of board) for (const cell of row) if (cell.isMine) totalMines++;
  return wire(serializeBoard({
    board, rows: 9, cols: 9, totalMines, rngSeed, activeGimmicks: [],
  }));
}

// The dates double as the payloads' rngSeeds and sit before SIGNATURE_EPOCH
// (2026-07-06), so the unsigned test payloads are grandfathered by the
// trust gate rather than needing a play-window writtenAt.
const TILING_DATE = '2026-05-10';
const RECT_CRUX_DATE = '2026-06-21';     // tier-1 crux from the centre
const RECT_BREATHER_DATE = '2026-06-22'; // certifies tier 0 — a TRUE breather

const payload = makeTilingCanonical(TILING_DATE);
const rectCruxPayload = makeRectCanonical('rect-201-a', RECT_CRUX_DATE);
const rectBreatherPayload = makeRectCanonical('rect-opener-fixture', RECT_BREATHER_DATE);

const d0 = deserializeBoard(payload);
const centreIndex = Math.floor(d0.rows / 2) * d0.cols + Math.floor(d0.cols / 2);
const openerRC = { r: Math.floor(payload.firstClick / d0.cols), c: payload.firstClick % d0.cols };
const centreRC = { r: Math.floor(centreIndex / d0.cols), c: centreIndex % d0.cols };

// Every fixture derivation below solves a FRESH deserialize so no solver
// artifact from one run can bleed into the next measurement.
function freshBoard(raw) { return deserializeBoard(raw); }

function solveFrom(raw, flatIndex) {
  const d = freshBoard(raw);
  const check = isBoardSolvable(d.board, d.rows, d.cols, Math.floor(flatIndex / d.cols), flatIndex % d.cols);
  cleanSolverArtifacts(d.board);
  return check;
}

function cruxFrom(raw, rc) {
  const d = freshBoard(raw);
  const crux = extractCrux(d.board, d.rows, d.cols, rc.r, rc.c);
  cleanSolverArtifacts(d.board);
  return crux;
}

function infoValueFrom(raw, anchor, mine) {
  const d = freshBoard(raw);
  return round1(computeBombInfoValue(d.board, d.rows, d.cols, anchor.r, anchor.c, mine.r, mine.c, [], null).infoValue);
}

const openerCheck = solveFrom(payload, payload.firstClick);
const centreCheck = solveFrom(payload, centreIndex);
const cruxFromOpener = cruxFrom(payload, openerRC);
const cruxFromCentre = cruxFrom(payload, centreRC);

// The first mine (reading order) whose ROUNDED info-value differs between
// the two anchors — the bomb pin's discriminating cell.
function findDiscriminatingMine() {
  for (let r = 0; r < d0.rows; r++) {
    for (let c = 0; c < d0.cols; c++) {
      if (!d0.board[r][c].isMine) continue;
      const a = infoValueFrom(payload, openerRC, { r, c });
      const b = infoValueFrom(payload, centreRC, { r, c });
      if (a !== b) return { r, c, opener: a, centre: b };
    }
  }
  return null;
}
const diffMine = findDiscriminatingMine();

test('precondition: the tiling fixture discriminates all three surfaces', () => {
  assert.ok(Number.isInteger(payload.firstClick), 'the tiling payload must store its opener');
  assert.notEqual(payload.firstClick, centreIndex,
    '4.8.8 opener must diverge from the container centre or every pin is vacuous');
  assert.ok(openerCheck.solvable && openerCheck.remainingUnknowns === 0,
    'the stored opener must certify a full clear');
  assert.ok(!(centreCheck.solvable || centreCheck.remainingUnknowns === 0),
    'the container-centre solve must FAIL, or the two anchors are indistinguishable');
  // Receipt + teaser discriminator: a real crux from the opener, none from
  // the stalled centre solve.
  assert.ok(cruxFromOpener && cruxFromOpener.tier >= 1,
    'the fixture must carry a tier>=1 crux from the stored opener');
  assert.equal(cruxFromCentre, null,
    'the centre solve must yield NO crux — that null is what the pre-fix receipt/teaser misread as a breather');
  // Bomb discriminator: at least one mine prices differently (rounded, the
  // resolution the event log stores).
  assert.ok(diffMine,
    'some mine must price differently between the two anchors or the bomb pin is vacuous');
});

// ── The resolver itself ────────────────────────────────────────────────

test('REGRESSION: #201 — liveBoardOpener reads the stored opener from the canonical in play', () => {
  localStorage.clear();
  const base = () => {
    state.gameMode = 'daily';
    state.isDailyPractice = false;
    state.isArchivePlay = false;
    state._archiveRaw = null;
    state.dailySeed = TILING_DATE;
    state.canonicalDailyBoard = { date: TILING_DATE, raw: payload };
    state.canonicalWeeklyBoard = null;
    state.rows = d0.rows;
    state.cols = d0.cols;
  };

  base();
  assert.equal(liveBoardOpener(), payload.firstClick, 'daily canonical: the stored opener');

  base();
  state.isArchivePlay = true;
  state.canonicalDailyBoard = null;
  state._archiveRaw = { date: TILING_DATE, raw: payload };
  assert.equal(liveBoardOpener(), payload.firstClick, 'archive replay: the archive stash, not the today-stash');

  base();
  state.gameMode = 'weekly';
  state.weeklySeed = '2026-05-11';
  state.canonicalDailyBoard = null;
  state.canonicalWeeklyBoard = { weekStart: '2026-05-11', raw: payload };
  assert.equal(liveBoardOpener(), payload.firstClick, 'weekly canonical: the stored opener');

  // Every no-canonical shape falls back to the container centre — the
  // anchor the local generator built the board around.
  base();
  state.isDailyPractice = true;
  assert.equal(liveBoardOpener(), centreIndex, 'practice ?seed= never reads the today-stash');

  base();
  state.canonicalDailyBoard = { date: '2026-05-09', raw: payload };
  assert.equal(liveBoardOpener(), centreIndex, 'a stale-dated stash is not this board');

  base();
  state.canonicalDailyBoard = null;
  assert.equal(liveBoardOpener(), centreIndex, 'local-gen fallback: no stash, centre');

  base();
  state.rows = 9; state.cols = 9;
  assert.equal(liveBoardOpener(), 4 * 9 + 4,
    'a stash whose container disagrees with the live board (failed adoption) must not be trusted');
});

// ── Site 2: bomb strike pricing (rides into the submitted time) ────────

function freshBombState(raw, dateStr) {
  localStorage.clear();
  // Skip the first-strike explainer modal path (needs MutationObserver);
  // the transient-popup path is the one under test.
  markNoticeSeen('bombhit_explainer_v2');
  const d = deserializeBoard(raw);
  state.gameMode = 'daily';
  state.status = 'playing';
  state.isDailyPractice = false;
  state.isArchivePlay = false;
  state._archiveRaw = null;
  state.dailySeed = dateStr;
  state.canonicalDailyBoard = { date: dateStr, raw };
  state.canonicalWeeklyBoard = null;
  state.rows = d.rows;
  state.cols = d.cols;
  state.board = d.board;
  state.totalMines = d.totalMines;
  state.activeGimmicks = [];
  state.elapsedTime = 10;
  state.modalPaused = false;
  state.dailyBombHits = 0;
  state.dailyBombHitEvents = [];
  state.weeklyBombHits = 0;
  state.weeklyBombHitEvents = [];
  state.dailyFeatures = null;
  state.weeklyFeatures = null;
  return d;
}

test('REGRESSION: #201 — bomb strike pricing anchors on the stored opener, not the container centre', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    freshBombState(payload, TILING_DATE);
    handleDailyBombHit(diffMine.r, diffMine.c);

    assert.equal(state.dailyBombHitEvents.length, 1);
    const event = state.dailyBombHitEvents[0];
    assert.equal(event.infoValue, diffMine.opener,
      'the logged info-value must come from the stored-opener solve');
    assert.notEqual(event.infoValue, diffMine.centre,
      'the pre-fix number: a centre-anchored pair of solves that both stall at click 1');
  } finally {
    // Discard the pending popup timer: finishBombHit would resumeTimer and
    // start a real interval the test process then has to outlive.
    mock.timers.reset();
  }
});

test('rectangle control: bomb pricing is byte-identical through the real consumer', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const d = freshBombState(rectCruxPayload, RECT_CRUX_DATE);
    assert.equal('firstClick' in rectCruxPayload, false, 'rectangles must not store an opener');
    assert.equal(liveBoardOpener(), 4 * 9 + 4, 'the resolved opener IS the container centre');

    // A mine with a NONZERO centre-anchored price, so the control cannot
    // pass on a degenerate 0 === 0.
    let mine = null;
    for (let r = 0; r < 9 && !mine; r++) {
      for (let c = 0; c < 9 && !mine; c++) {
        if (d.board[r][c].isMine && infoValueFrom(rectCruxPayload, { r: 4, c: 4 }, { r, c }) > 0) mine = { r, c };
      }
    }
    assert.ok(mine, 'the rect fixture must carry a nonzero-priced mine or the control is vacuous');

    const centreValue = infoValueFrom(rectCruxPayload, { r: 4, c: 4 }, mine);
    handleDailyBombHit(mine.r, mine.c);
    assert.equal(state.dailyBombHitEvents[0].infoValue, centreValue,
      'a rectangular canonical still prices from the container centre — the pre-#201 number, unchanged');
  } finally {
    mock.timers.reset();
  }
});

// ── Site 1: the win receipt (the board's confession) ───────────────────

// The receipt's only output is the render, so the pin records what lands on
// #gameover-receipt: a class-tracking, text-recording element swapped in via
// document.querySelector (domHelpers' $ resolves it at call time).
function makeReceiptRecorder() {
  const classes = new Set(['hidden']);
  return {
    textContent: '',
    onclick: null,
    classList: {
      add: (...cs) => { for (const c of cs) classes.add(c); },
      remove: (...cs) => { for (const c of cs) classes.delete(c); },
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
      contains: (c) => classes.has(c),
    },
  };
}

function renderReceiptInto(recorder) {
  const origQS = document.querySelector;
  document.querySelector = (sel) => (sel === '#gameover-receipt' ? recorder : origQS(sel));
  try {
    _renderWinReceipt();
    mock.timers.tick(100); // the receipt defers its solver runs by 80ms
  } finally {
    document.querySelector = origQS;
  }
}

test('REGRESSION: #201 — the win receipt confesses the real crux, not a false breather', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    freshBombState(payload, TILING_DATE); // same live-canonical state shape a win ends in
    const rec = makeReceiptRecorder();
    renderReceiptInto(rec);

    assert.match(rec.textContent, /Hardest step/,
      'the receipt must name the crux the stored-opener solve found');
    assert.match(rec.textContent, /weighing a whole region at once/,
      'the fixture crux is tier 2 and the phrase must say so');
    assert.doesNotMatch(rec.textContent, /breather/i,
      'the pre-fix confession: the centre solve stalls, extractCrux returns null, and the receipt falsely claims a breather');
    assert.equal(rec.classList.contains('hidden'), false, 'the receipt line must actually show');
  } finally {
    mock.timers.reset();
  }
});

test('rectangle control: the receipt still reads from the centre on a rectangular canonical', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    freshBombState(rectCruxPayload, RECT_CRUX_DATE);
    // Fixture precondition: this rectangle's centre solve HAS a tier-1 crux.
    const rectCrux = cruxFrom(rectCruxPayload, { r: 4, c: 4 });
    assert.ok(rectCrux && rectCrux.tier === 1, 'rect fixture must carry a tier-1 crux from its centre');

    const rec = makeReceiptRecorder();
    renderReceiptInto(rec);
    assert.match(rec.textContent, /Hardest step/);
    assert.match(rec.textContent, /comparing two clues/,
      'the centre-anchored tier-1 phrase — byte-identical to pre-#201 behavior');
  } finally {
    mock.timers.reset();
  }
});

// ── Site 3: the crux teaser's breather classification ──────────────────

// No cruxes/{date} node is planted, so showCruxTeaser falls to the branch
// under test: solve the canonical to tell a genuine breather from a crux
// that just could not be cropped. The verdict is only observable in the
// fallback copy, so the pin records the innerHTML landing on #crux-teaser.
async function teaserHTMLFor(date) {
  const recorder = { innerHTML: '', classList: { add() {}, remove() {}, contains: () => false } };
  const origGEI = document.getElementById;
  document.getElementById = (id) => (id === 'crux-teaser' ? recorder : origGEI(id));
  try {
    await showCruxTeaser(date);
  } finally {
    document.getElementById = origGEI;
  }
  return recorder.innerHTML;
}

test('REGRESSION: #201 — the crux teaser classifies a tiling date from the stored opener', async () => {
  localStorage.clear();
  dbPayloads.set(`dailyBoard/${TILING_DATE}`, payload);
  const html = await teaserHTMLFor(TILING_DATE);
  assert.match(html, /No teaser for/,
    'a date with a real crux keeps the plain no-teaser line');
  assert.doesNotMatch(html, /breather/i,
    'the pre-fix claim: the centre-anchored solve stalls and the share page publicly calls the date a breather');
});

test('rectangle control: the share page still tells breathers from crux boards by the centre solve', async () => {
  localStorage.clear();
  dbPayloads.set(`dailyBoard/${RECT_BREATHER_DATE}`, rectBreatherPayload);
  dbPayloads.set(`dailyBoard/${RECT_CRUX_DATE}`, rectCruxPayload);

  // Fixture precondition: the breather control CERTIFIES from its centre at
  // tier 0, so "was a breather" is the true claim, not a stall misread.
  const breatherCheck = solveFrom(rectBreatherPayload, 4 * 9 + 4);
  assert.ok(breatherCheck.solvable && breatherCheck.remainingUnknowns === 0);
  assert.equal(cruxFrom(rectBreatherPayload, { r: 4, c: 4 }), null);

  assert.match(await teaserHTMLFor(RECT_BREATHER_DATE), /was a breather/,
    'a genuine tier-0 rectangle still reads as a breather');
  assert.match(await teaserHTMLFor(RECT_CRUX_DATE), /No teaser for/,
    'a rectangle with a centre crux still keeps the plain fallback');
});
