// Lexicon feasibility: measure the rejection-sampling yield of
// single-technique lesson boards BEFORE building the curriculum
// architecture (the dead Skill Trainer died of shell-first development).
//
// A "1-2 pattern lesson" board must be: solvable, require at least one
// canonical subset deduction, and require NOTHING harder (no generic
// subsets, no tank/gauss, no disjunctive reasoning). If the yield is
// 1-in-thousands on small boards, live generation dies on mobile CPU
// budgets and the design has to change.
//
// Usage: node scripts/measure-lexicon-yield.mjs

import '../test/helpers.mjs';

const { isBoardSolvable } = await import('../src/logic/boardSolver.js');
const { generateBoard, cleanSolverArtifacts } = await import('../src/logic/boardGenerator.js');
const { createDailyRNG } = await import('../src/logic/seededRandom.js');

const CONFIGS = [
  { rows: 5, cols: 5, mines: 4 },
  { rows: 5, cols: 5, mines: 5 },
  { rows: 6, cols: 6, mines: 6 },
  { rows: 6, cols: 6, mines: 7 },
  { rows: 7, cols: 7, mines: 8 },
  { rows: 7, cols: 7, mines: 10 },
];
const ATTEMPTS = 2000;

const isLessonBoard = (r) =>
  (r.solvable || r.remainingUnknowns === 0)
  && r.canonicalSubsetMoves >= 1
  && r.genericSubsetMoves === 0
  && r.advancedLogicMoves === 0
  && r.disjunctiveMoves === 0
  && r.techniqueLevel === 1;

for (const { rows, cols, mines } of CONFIGS) {
  const fr = Math.floor(rows / 2), fc = Math.floor(cols / 2);
  let hits = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < ATTEMPTS; i++) {
    const rng = createDailyRNG(`lexicon-yield-${rows}x${cols}-${mines}-${i}`);
    const board = generateBoard(rows, cols, mines, fr, fc, rng);
    cleanSolverArtifacts(board);
    const r = isBoardSolvable(board, rows, cols, fr, fc);
    cleanSolverArtifacts(board);
    if (isLessonBoard(r)) hits++;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const rate = hits / ATTEMPTS;
  const msPerHit = hits > 0 ? (ms / hits).toFixed(1) : 'inf';
  console.log(
    `${rows}x${cols}/${mines}: ${hits}/${ATTEMPTS} hits (1-in-${hits > 0 ? Math.round(1 / rate) : '∞'})` +
    ` · ${(ms / ATTEMPTS).toFixed(2)}ms/attempt · ~${msPerHit}ms per lesson board`
  );
}
