// Lexicon feasibility: measure the rejection-sampling yield of every
// lesson predicate BEFORE leaning on live generation (the dead Skill
// Trainer died of shell-first development). Each lesson board must be
// solvable, require its target technique, and require nothing harder.
// Named-shape lessons (1-2-1, 1-2-2-1) additionally need the shape on the
// opened board's deducible frontier — the same classifier the gym and
// receipts use. If a lesson's yield is 1-in-thousands at its size, live
// generation dies on mobile CPU budgets and it needs curated seeds.
//
// Usage: node scripts/measure-lexicon-yield.mjs

import '../test/helpers.mjs';

const { isBoardSolvable, findDeducibleFrontier } = await import('../src/logic/boardSolver.js');
const { generateBoard, cleanSolverArtifacts } = await import('../src/logic/boardGenerator.js');
const { createDailyRNG } = await import('../src/logic/seededRandom.js');
const { LESSONS, LESSON_ORDER, applyLessonOpening, lessonShowsPattern } = await import('../src/logic/lexicon.js');

const ATTEMPTS = 4000;

for (const id of LESSON_ORDER) {
  const lesson = LESSONS[id];
  const { rows, cols, mines } = lesson;
  const fr = Math.floor(rows / 2), fc = Math.floor(cols / 2);
  let bucketHits = 0, fullHits = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < ATTEMPTS; i++) {
    const rng = createDailyRNG(`lexicon-yield-${id}-${i}`);
    const board = generateBoard(rows, cols, mines, fr, fc, rng);
    cleanSolverArtifacts(board);
    const r = isBoardSolvable(board, rows, cols, fr, fc);
    cleanSolverArtifacts(board);
    if (!lesson.accepts(r)) continue;
    bucketHits++;
    if (lesson.requiresPattern) {
      const lb = { board, rows, cols, fr, fc };
      applyLessonOpening(lb);
      if (!lessonShowsPattern(lb, lesson.requiresPattern)) continue;
    }
    fullHits++;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const rate = fullHits / ATTEMPTS;
  const msPerHit = fullHits > 0 ? (ms / fullHits).toFixed(1) : 'inf';
  const oneIn = fullHits > 0 ? Math.round(1 / rate) : '∞';
  console.log(
    `${id.padEnd(13)} ${rows}x${cols}/${mines}: ${fullHits}/${ATTEMPTS} (1-in-${oneIn})` +
    `${lesson.requiresPattern ? ` [bucket ${bucketHits}]` : ''}` +
    ` · ${(ms / ATTEMPTS).toFixed(2)}ms/attempt · ~${msPerHit}ms per board`
  );
}
