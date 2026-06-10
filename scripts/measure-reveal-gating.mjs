// Measure the blast radius of reveal-gating BEFORE shipping it.
//
// The solver currently uses sonar / compass / wormhole constraints
// unconditionally — including from gimmick cells the player has not
// revealed yet (a fogged gimmick cell displays nothing). Gating those
// constraints on the origin cell being revealed strengthens the no-guess
// contract, but historical canonical boards were certified UNGATED, so
// this script re-certifies every dailyBoard/* and weeklyBoard/* canonical
// with the gate on and reports:
//
//   1. Boards that lose center certification (the actual certificate).
//   2. Of those, whether the client's rendered "Start here" cell (the
//      ungated suggested-start search result) still fully solves gated,
//      and whether ANY start anchor exists that does.
//   3. Feature drift on boards that STAY certified: techniqueLevel /
//      totalClicks / move-mix changes (dailyMeta features come from this
//      solver, so drift here = cross-version feature disagreement risk).
//   4. Boards carrying liar-stacked sonar/compass/wormhole cells — a
//      separate pre-existing issue: buildStaticGimmickConstraints emits
//      those cells' liar-adjusted displayed value as an EXACT constraint,
//      while isPureLiar's contract says such cells contribute nothing.
//
// Read-only: fetches the public canonicals, writes nothing.
//
// Usage: node scripts/measure-reveal-gating.mjs [--verbose]

import { isBoardSolvable, buildNeighborCache } from '../src/logic/boardSolver.js';
import { cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import { deserializeBoard } from '../src/firebase/dailyBoardSync.js';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';
const GATED_TYPES = ['sonar', 'compass', 'wormhole'];
const VERBOSE = process.argv.includes('--verbose');

async function fetchJson(path) {
  const r = await fetch(`${DB_BASE}/${path}`);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

const certified = (check) => check.solvable || check.remainingUnknowns === 0;

const moveMix = (c) =>
  `A${c.passAMoves}/c${c.canonicalSubsetMoves}/g${c.genericSubsetMoves}/t${c.advancedLogicMoves}/d${c.disjunctiveMoves}`;

// Mirror the client's suggested-start search (gameActions.js daily
// branch): zero-adjacency candidates first, then the rest, board-scan
// order; first FULL solve wins, else the candidate leaving the fewest
// unknowns.
function findStartAnchor(board, rows, cols, nbrCache, options) {
  const zero = [], nonZero = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (cell.isMine || cell.isLocked) continue;
      (cell.adjacentMines === 0 ? zero : nonZero).push({ r, c });
    }
  }
  let best = null, bestUnknowns = Infinity;
  for (const cand of [...zero, ...nonZero]) {
    const res = isBoardSolvable(board, rows, cols, cand.r, cand.c, nbrCache, options);
    cleanSolverArtifacts(board);
    if (certified(res)) return { anchor: cand, full: true };
    if (res.remainingUnknowns < bestUnknowns) {
      bestUnknowns = res.remainingUnknowns;
      best = cand;
    }
  }
  return { anchor: best, full: false };
}

function analyzeBoard(label, raw, totals) {
  let parsed;
  try {
    parsed = deserializeBoard(raw);
  } catch (err) {
    console.log(`  ${label}: UNPARSEABLE (${err.message})`);
    totals.unparseable++;
    return;
  }
  const { board, rows, cols, activeGimmicks } = parsed;
  const fr = Math.floor(rows / 2), fc = Math.floor(cols / 2);
  const nbrCache = buildNeighborCache(board, rows, cols);

  let liarStacked = 0;
  for (const row of board) {
    for (const cell of row) {
      if (cell.isLiar && (cell.isSonar || cell.isCompass || cell.isWormhole)) liarStacked++;
    }
  }
  if (liarStacked > 0) totals.liarStackedBoards.push({ label, count: liarStacked });

  const hasGatedType = activeGimmicks.some(g => GATED_TYPES.includes(g));
  totals.boards++;
  if (!hasGatedType) {
    totals.noGatedGimmick++;
    if (VERBOSE) console.log(`  ${label}: no sonar/compass/wormhole — unaffected`);
    return;
  }
  totals.withGatedGimmick++;

  const base = isBoardSolvable(board, rows, cols, fr, fc, nbrCache);
  cleanSolverArtifacts(board);
  const gated = isBoardSolvable(board, rows, cols, fr, fc, nbrCache, { gateGimmickOrigins: true });
  cleanSolverArtifacts(board);

  if (!certified(base)) {
    // Center never certified this board even ungated — daily/weekly
    // canonical certification anchors on center, so this would be a
    // pre-existing breach worth its own look.
    totals.baselineUncertified.push(label);
    console.log(`  ${label}: BASELINE UNCERTIFIED from center (pre-existing!) gimmicks=${activeGimmicks.join(',')}`);
    return;
  }

  if (certified(gated)) {
    const drift = gated.techniqueLevel !== base.techniqueLevel || gated.totalClicks !== base.totalClicks;
    if (drift) {
      totals.certifiedWithDrift.push(label);
      console.log(
        `  ${label}: stays certified, FEATURES DRIFT  technique ${base.techniqueLevel}->${gated.techniqueLevel}, ` +
        `clicks ${base.totalClicks}->${gated.totalClicks}, mix ${moveMix(base)} -> ${moveMix(gated)}  [${activeGimmicks.join(',')}]`
      );
    } else {
      totals.certifiedIdentical++;
      if (VERBOSE) console.log(`  ${label}: certified, identical features [${activeGimmicks.join(',')}]`);
    }
    return;
  }

  // Lost center certification. How bad is it for the actual player path?
  const ungatedStart = findStartAnchor(board, rows, cols, nbrCache, undefined);
  let startStillWorks = false;
  if (ungatedStart.anchor) {
    const fromStart = isBoardSolvable(
      board, rows, cols, ungatedStart.anchor.r, ungatedStart.anchor.c, nbrCache,
      { gateGimmickOrigins: true },
    );
    cleanSolverArtifacts(board);
    startStillWorks = certified(fromStart);
  }
  const gatedAnchor = startStillWorks
    ? { anchor: ungatedStart.anchor, full: true }
    : findStartAnchor(board, rows, cols, nbrCache, { gateGimmickOrigins: true });

  const entry = {
    label,
    gimmicks: activeGimmicks.join(','),
    remainingUnknowns: gated.remainingUnknowns,
    startStillWorks,
    anyGatedAnchor: gatedAnchor.full,
  };
  totals.lostCertification.push(entry);
  console.log(
    `  ${label}: LOSES center certification (${gated.remainingUnknowns} cells unprovable)  ` +
    `[${activeGimmicks.join(',')}]  rendered-start-still-solves=${startStillWorks ? 'YES' : 'no'}  ` +
    `any-gated-anchor=${gatedAnchor.full ? 'YES' : 'NO'}`
  );
}

(async () => {
  const totals = {
    boards: 0,
    unparseable: 0,
    noGatedGimmick: 0,
    withGatedGimmick: 0,
    certifiedIdentical: 0,
    certifiedWithDrift: [],
    lostCertification: [],
    baselineUncertified: [],
    liarStackedBoards: [],
  };

  console.log('fetching dailyBoard index...');
  const dailyIndex = await fetchJson('dailyBoard.json?shallow=true') || {};
  const dailyDates = Object.keys(dailyIndex).sort();
  console.log(`dailyBoard: ${dailyDates.length} dates`);
  for (const date of dailyDates) {
    const raw = await fetchJson(`dailyBoard/${date}.json`);
    analyzeBoard(`daily ${date}`, raw, totals);
  }

  console.log('fetching weeklyBoard index...');
  const weeklyIndex = await fetchJson('weeklyBoard.json?shallow=true') || {};
  const weekStarts = Object.keys(weeklyIndex).sort();
  console.log(`weeklyBoard: ${weekStarts.length} weeks`);
  for (const week of weekStarts) {
    const raw = await fetchJson(`weeklyBoard/${week}.json`);
    analyzeBoard(`weekly ${week}`, raw, totals);
  }

  console.log('\n================ SUMMARY ================');
  console.log(`boards analyzed:                 ${totals.boards} (${totals.unparseable} unparseable skipped)`);
  console.log(`no sonar/compass/wormhole:       ${totals.noGatedGimmick} (unaffected by gating)`);
  console.log(`with gated gimmick types:        ${totals.withGatedGimmick}`);
  console.log(`  certified, identical features: ${totals.certifiedIdentical}`);
  console.log(`  certified, features drift:     ${totals.certifiedWithDrift.length}`);
  console.log(`  LOSE center certification:     ${totals.lostCertification.length}`);
  const saved = totals.lostCertification.filter(e => e.startStillWorks).length;
  const reanchorable = totals.lostCertification.filter(e => !e.startStillWorks && e.anyGatedAnchor).length;
  const hopeless = totals.lostCertification.filter(e => !e.anyGatedAnchor).length;
  console.log(`    rendered start still solves: ${saved}`);
  console.log(`    re-anchorable (other cell):  ${reanchorable}`);
  console.log(`    NO gated anchor exists:      ${hopeless}`);
  console.log(`  baseline uncertified (!):      ${totals.baselineUncertified.length}`);
  console.log(`boards with liar-stacked sonar/compass/wormhole cells: ${totals.liarStackedBoards.length}`);
  for (const b of totals.liarStackedBoards) console.log(`    ${b.label}: ${b.count} cell(s)`);
})().catch(err => {
  console.error('measurement failed:', err);
  process.exit(1);
});
