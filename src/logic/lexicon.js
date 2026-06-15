// ── The Lexicon: generated single-technique lessons ────
// The generator writes the curriculum: each lesson board is REQUIRED to
// contain the target deduction class and NOTHING harder, verified by the
// five-bucket solver classification, and for the named-shape lessons by
// the shared geometry detector (patternNames.js) — the SAME classifier
// the gym coaching and the receipts use, so a lesson can never teach a
// shape the receipts cannot recognize. Measured yield
// (scripts/measure-lexicon-yield.mjs, 2026-06-15): countingBasics 1-in-3
// (~0.4ms), subset12 1-in-3 (~1ms), oneTwoOne 1-in-5 (~3ms), oneTwoTwoOne
// 1-in-12 (~44ms/board — the geometry check runs per candidate, ~12
// attempts typical, so live generation stays imperceptible).
//
// The teaching mechanic is the deducibility CLICK-GATE (lexiconUI.js):
// a click on a cell that is not currently provably safe bounces and the
// proving region of an available deduction pulses. The player physically
// cannot luck through a lesson — the epiphany is structural, and the
// pattern is NAMED only after they perform it.

import { isBoardSolvable, findDeducibleFrontier } from './boardSolver.js';
import { generateBoard, cleanSolverArtifacts } from './boardGenerator.js';
import { createDailyRNG } from './seededRandom.js';
import { classifyPattern } from './patternNames.js';

// The curriculum, easiest first. lexiconUI renders the lesson-select
// screen in this order; the Field Notebook lists techniques in it too.
export const LESSON_ORDER = ['countingBasics', 'subset12', 'oneTwoOne', 'oneTwoTwoOne'];

// Each lesson's `accepts(r)` is the bucket gate over the isBoardSolvable
// result. Named-shape lessons additionally set `requiresPattern`, which
// generateLessonBoard verifies geometrically on the opened board. Copy
// (name / blurb / rule / naming) is the single source of truth the
// lesson cards, the Notebook, and the completion line all read.
export const LESSONS = {
  // Tier 0 — a single number settles a square. This is the skill the 1-2
  // pattern is built on, and the home of the flag-reduction beat (a known
  // mine drops a number's count).
  countingBasics: {
    id: 'countingBasics',
    name: 'Counting',
    blurb: 'Read one number at a time.',
    rule: 'A number says how many mines touch it. Once you have found that many, every other square it touches is safe. And when the squares it still needs equal the hidden squares it has left, those are all mines.',
    naming: 'Every square you opened was settled by one number on its own. Count what a number still needs, and the rest follows. That is the whole game in one move.',
    rows: 5, cols: 5, mines: 4,
    accepts: (r) =>
      (r.solvable || r.remainingUnknowns === 0)
      && r.techniqueLevel === 0
      && r.passAMoves >= 3,
  },

  // Tier 1 — two numbers looking at the same squares (the 1-1 / 1-2
  // family). Unchanged admission from the original prototype.
  subset12: {
    id: 'subset12',
    name: 'The 1-2 pattern',
    blurb: 'Compare two neighbors.',
    rule: 'When two numbers look at the same squares, the smaller one\'s mines fit inside the squares they share. The square only the bigger number sees holds its extra mine, and the square only the smaller number sees is safe.',
    naming: 'That was a pair read: two numbers looking at the same squares, where the smaller one\'s mines settle what the bigger one has left.',
    rows: 6, cols: 6, mines: 6,
    accepts: (r) =>
      (r.solvable || r.remainingUnknowns === 0)
      && r.canonicalSubsetMoves >= 1
      && r.genericSubsetMoves === 0
      && r.advancedLogicMoves === 0
      && r.disjunctiveMoves === 0
      && r.techniqueLevel === 1,
  },

  // The iconic 1-2-1. The shape can resolve at tier 1 or tier 2 depending
  // on the flanking clues, so the gate is "solvable, no liar" plus the
  // geometry check — never a tier number.
  oneTwoOne: {
    id: 'oneTwoOne',
    name: 'The 1-2-1',
    blurb: 'A 2 flanked by two 1s.',
    rule: 'Along a wall, a 1-2-1 forces a mine under each 1 and leaves the square under the 2 safe. The two 1s pin the mines; the 2 confirms there is no room for a third.',
    naming: 'That was a 1-2-1: the only way to give the 2 its two mines while keeping both 1s honest is a mine under each 1, which leaves the middle square safe.',
    rows: 6, cols: 6, mines: 6,
    requiresPattern: '1-2-1',
    accepts: (r) =>
      (r.solvable || r.remainingUnknowns === 0)
      && r.disjunctiveMoves === 0
      && r.techniqueLevel <= 2,
  },

  // Advanced: the 1-2-2-1 needs the whole four-clue region weighed at
  // once (neither 2 settles alone), so it is a genuine tier-2 lesson.
  // Yield is lower; generateLessonBoard gets a deeper attempt budget and
  // falls back to curated seeds if measurement shows live sampling is too
  // thin.
  oneTwoTwoOne: {
    id: 'oneTwoTwoOne',
    name: 'The 1-2-2-1',
    blurb: 'Four numbers in a row.',
    advanced: true,
    rule: 'A 1-2-2-1 along a wall puts both mines in the middle, under the two 2s, and clears the four outer squares. No other layout satisfies all four numbers at once.',
    naming: 'That was a 1-2-2-1: the only layout that satisfies all four numbers at once puts both mines in the center, under the 2s, and clears the rest.',
    rows: 7, cols: 7, mines: 9,
    requiresPattern: '1-2-2-1',
    attempts: 800,
    accepts: (r) =>
      (r.solvable || r.remainingUnknowns === 0)
      && r.disjunctiveMoves === 0
      && r.techniqueLevel <= 2,
  },
};

const MAX_GENERATION_ATTEMPTS = 400; // yield ~1-in-3 for the bucket lessons

// Does the OPENED board put the lesson's named shape on the current
// deducible frontier? Ties admission to the exact classifier the gym
// coaching and receipts use, so the three can never disagree.
function lessonShowsPattern(lessonBoard, patternName) {
  const { board, rows, cols } = lessonBoard;
  const f = findDeducibleFrontier(board, { respectFlags: false });
  const candidates = [
    ...f.safe.map(s => ({ ...s, kind: 'safe' })),
    ...f.mines.map(m => ({ ...m, kind: 'mine' })),
  ];
  return candidates.some(d => classifyPattern(board, d, { rows, cols }).name === patternName);
}

/**
 * Generate one lesson board for a lesson def. Deterministic per
 * seedTag. Returns { board, rows, cols, fr, fc } or null if the
 * attempt budget runs out (the caller should toast-and-bail rather than
 * loop). For named-shape lessons the returned board is already opened
 * (the geometry check needs the opening); applyLessonOpening is then a
 * harmless no-op.
 */
export function generateLessonBoard(lesson, seedTag) {
  const { rows, cols, mines } = lesson;
  const fr = Math.floor(rows / 2), fc = Math.floor(cols / 2);
  const attempts = lesson.attempts || MAX_GENERATION_ATTEMPTS;
  for (let i = 0; i < attempts; i++) {
    const rng = createDailyRNG(`lexicon-${lesson.id}-${seedTag}-${i}`);
    const board = generateBoard(rows, cols, mines, fr, fc, rng);
    cleanSolverArtifacts(board);
    const r = isBoardSolvable(board, rows, cols, fr, fc);
    cleanSolverArtifacts(board);
    if (!lesson.accepts(r)) continue;
    const lessonBoard = { board, rows, cols, fr, fc };
    if (lesson.requiresPattern) {
      applyLessonOpening(lessonBoard);
      if (!lessonShowsPattern(lessonBoard, lesson.requiresPattern)) continue;
    }
    return lessonBoard;
  }
  return null;
}

/**
 * Apply the lesson's opening move: reveal the first-click cell and
 * flood-fill zeros (the same opening the solver's certification
 * assumed). Mutates cell.isRevealed. Returns the count of revealed cells.
 * Idempotent: already-revealed cells are skipped, so calling it on an
 * already-opened named-shape board is a no-op.
 */
export function applyLessonOpening(lessonBoard) {
  const { board, rows, cols, fr, fc } = lessonBoard;
  const queue = [[fr, fc]];
  let revealed = 0;
  while (queue.length > 0) {
    const [r, c] = queue.pop();
    const cell = board[r][c];
    if (cell.isRevealed || cell.isMine) continue;
    cell.isRevealed = true;
    revealed++;
    if (cell.adjacentMines === 0) {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) queue.push([nr, nc]);
        }
      }
    }
  }
  return revealed;
}

/** True when every non-mine cell is revealed — the lesson is complete. */
export function lessonComplete(lessonBoard) {
  const { board } = lessonBoard;
  for (const row of board) {
    for (const cell of row) {
      if (!cell.isMine && !cell.isRevealed) return false;
    }
  }
  return true;
}
