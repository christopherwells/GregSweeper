// Audit recent canonical daily boards against the current solver.
//
// Pulls the last N days of dailyBoard/{date} from Firebase, runs the
// live isBoardSolvable() against each, and flags any whose solver
// verdict disagrees with the assumption baked into the canonical
// pipeline (i.e. the canonical was supposed to be solvable when it
// shipped). Use this whenever a player reports a forced-guess board
// to determine whether the symptom is in the canonical itself or
// downstream in rendering.
//
// Usage:
//   node scripts/audit-solver-recent.mjs            (default: last 14 days)
//   node scripts/audit-solver-recent.mjs --days 30
//   node scripts/audit-solver-recent.mjs 2026-05-07 (single date)
//
// Read-only. Does not write to Firebase.

import { deserializeBoard } from '../src/firebase/dailyBoardSync.js';
import { isBoardSolvable } from '../src/logic/boardSolver.js';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';

// ET-anchored date string for an arbitrary Date instance.
const _ET_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
});

function etDateString(d = new Date()) {
  return _ET_FMT.format(d);
}

function nDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return etDateString(d);
}

async function fetchJson(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    return j;
  } catch {
    return null;
  }
}

async function auditDate(date) {
  const raw = await fetchJson(`${DB_BASE}/dailyBoard/${date}.json`);
  if (!raw) {
    return { date, status: 'NO_CANONICAL' };
  }

  let board, rows, cols, totalMines, activeGimmicks, rngSeed;
  try {
    const d = deserializeBoard(raw);
    board = d.board;
    rows = d.rows;
    cols = d.cols;
    totalMines = d.totalMines;
    activeGimmicks = d.activeGimmicks;
    rngSeed = d.rngSeed;
  } catch (err) {
    return { date, status: 'DESERIALIZE_FAILED', error: err.message };
  }

  const fr = Math.floor(rows / 2);
  const fc = Math.floor(cols / 2);

  let check;
  try {
    check = isBoardSolvable(board, rows, cols, fr, fc);
  } catch (err) {
    return { date, status: 'SOLVER_CRASHED', error: err.message, rows, cols, totalMines };
  }

  // Cross-check scores: pull daily/{date} and report any score whose
  // rngSeed disagrees with the canonical's. Pre-canonical-board scores
  // (before 2026-04-27 for normal play) won't have rngSeed; those are
  // skipped.
  const scores = await fetchJson(`${DB_BASE}/daily/${date}.json`);
  let divergent = 0;
  let totalScores = 0;
  if (scores && typeof scores === 'object') {
    for (const k of Object.keys(scores)) {
      const s = scores[k];
      if (!s || typeof s !== 'object') continue;
      totalScores++;
      if (s.rngSeed && s.rngSeed !== rngSeed) divergent++;
    }
  }

  return {
    date,
    status: check.solvable ? 'SOLVABLE' : (check.remainingUnknowns === 0 ? 'COMPLETE' : 'UNSOLVABLE'),
    rngSeed,
    codeVersion: raw.codeVersion || '(missing)',
    rows, cols, totalMines,
    activeGimmicks,
    techniqueLevel: check.techniqueLevel,
    remainingUnknowns: check.remainingUnknowns,
    totalClicks: check.totalClicks,
    moves: {
      passA: check.passAMoves,
      canonicalSubset: check.canonicalSubsetMoves,
      genericSubset: check.genericSubsetMoves,
      advancedLogic: check.advancedLogicMoves,
      disjunctive: check.disjunctiveMoves,
    },
    totalScores,
    divergentScores: divergent,
  };
}

function printRow(r) {
  if (r.status === 'NO_CANONICAL') {
    console.log(`  ${r.date}  (no canonical)`);
    return;
  }
  if (r.status === 'DESERIALIZE_FAILED') {
    console.log(`  ${r.date}  !! DESERIALIZE FAILED: ${r.error}`);
    return;
  }
  if (r.status === 'SOLVER_CRASHED') {
    console.log(`  ${r.date}  !! SOLVER CRASHED: ${r.error}  (${r.rows}x${r.cols}, ${r.totalMines} mines)`);
    return;
  }
  const flag = r.status === 'UNSOLVABLE' ? '!! UNSOLVABLE  ' : '              ';
  const gims = r.activeGimmicks.length ? r.activeGimmicks.join(',') : '(none)';
  const div = r.divergentScores > 0
    ? `  div=${r.divergentScores}/${r.totalScores}`
    : (r.totalScores > 0 ? `  scores=${r.totalScores}` : '');
  console.log(
    `  ${r.date}  ${flag}t${r.techniqueLevel}  ${r.rows}x${r.cols}  ${r.totalMines}m  ` +
    `[${gims}]  ${r.codeVersion}  seed=${r.rngSeed}` +
    `  passA=${r.moves.passA} cs=${r.moves.canonicalSubset} gs=${r.moves.genericSubset} ` +
    `adv=${r.moves.advancedLogic} dis=${r.moves.disjunctive}` +
    (r.status === 'UNSOLVABLE' ? `  remaining=${r.remainingUnknowns}` : '') +
    div,
  );
}

(async () => {
  const args = process.argv.slice(2);

  // Single-date mode: literal YYYY-MM-DD argument.
  const single = args.find(a => /^\d{4}-\d{2}-\d{2}(_bonus)?$/.test(a));
  let dates;
  if (single) {
    dates = [single];
  } else {
    let n = 14;
    const di = args.indexOf('--days');
    if (di >= 0 && args[di + 1]) n = parseInt(args[di + 1], 10) || 14;
    dates = Array.from({ length: n }, (_, i) => nDaysAgo(i)).reverse();
  }

  console.log(`auditing ${dates.length} canonical daily board${dates.length === 1 ? '' : 's'}`);
  console.log(`(today ET = ${etDateString()})`);
  console.log('');

  let unsolvableCount = 0;
  let divergentCount = 0;

  for (const date of dates) {
    const r = await auditDate(date);
    printRow(r);
    if (r.status === 'UNSOLVABLE') unsolvableCount++;
    if (r.divergentScores > 0) divergentCount++;
  }

  console.log('');
  console.log(`summary: ${unsolvableCount} UNSOLVABLE, ${divergentCount} dates with divergent scores`);
  if (unsolvableCount > 0) {
    console.log('!! ACTION REQUIRED: at least one canonical is objectively unsolvable.');
    process.exit(2);
  }
})().catch(err => {
  console.error('audit failed:', err.stack || err.message);
  process.exit(1);
});
