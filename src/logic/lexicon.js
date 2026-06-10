// ── The Lexicon: generated single-technique lessons ────
// The generator writes the curriculum: each lesson board is REQUIRED to
// contain the target deduction class and NOTHING harder, verified by the
// five-bucket solver classification. Measured yield (2026-06-10,
// scripts/measure-lexicon-yield.mjs): 1-in-3 to 1-in-5 boards pass the
// 1-2 filter at small sizes, ~0.3-8ms per accepted board — live
// generation is cheap even on mobile.
//
// The teaching mechanic is the deducibility CLICK-GATE (lexiconUI.js):
// a click on a cell that is not currently provably safe bounces and the
// proving region of an available deduction pulses. The player physically
// cannot luck through a lesson — the epiphany is structural, and the
// pattern is NAMED only after they perform it.

import { isBoardSolvable } from './boardSolver.js';
import { generateBoard, cleanSolverArtifacts } from './boardGenerator.js';
import { createDailyRNG } from './seededRandom.js';

// Prototype curriculum: one technique. The filter is the lesson's
// admission predicate — the solver proves every accepted board both
// CONTAINS the pattern and requires nothing beyond it.
export const LESSONS = {
  subset12: {
    id: 'subset12',
    name: 'The 1-2 pattern',
    // Shown ONLY at completion — naming arrives after the epiphany.
    naming: 'That was the 1-2 pattern: when a 1 and a 2 share unknowns, subtracting one clue from the other pins the difference.',
    rows: 6, cols: 6, mines: 6,
    accepts: (r) =>
      (r.solvable || r.remainingUnknowns === 0)
      && r.canonicalSubsetMoves >= 1
      && r.genericSubsetMoves === 0
      && r.advancedLogicMoves === 0
      && r.disjunctiveMoves === 0
      && r.techniqueLevel === 1,
  },
};

const MAX_GENERATION_ATTEMPTS = 400; // yield ~1-in-3; 400 is a deep margin

/**
 * Generate one lesson board for a lesson def. Deterministic per
 * seedTag. Returns { board, rows, cols, fr, fc } or null if the
 * attempt budget runs out (statistically negligible at measured yield;
 * the caller should toast-and-bail rather than loop).
 */
export function generateLessonBoard(lesson, seedTag) {
  const { rows, cols, mines } = lesson;
  const fr = Math.floor(rows / 2), fc = Math.floor(cols / 2);
  for (let i = 0; i < MAX_GENERATION_ATTEMPTS; i++) {
    const rng = createDailyRNG(`lexicon-${lesson.id}-${seedTag}-${i}`);
    const board = generateBoard(rows, cols, mines, fr, fc, rng);
    cleanSolverArtifacts(board);
    const r = isBoardSolvable(board, rows, cols, fr, fc);
    cleanSolverArtifacts(board);
    if (lesson.accepts(r)) return { board, rows, cols, fr, fc };
  }
  return null;
}

/**
 * Apply the lesson's opening move: reveal the first-click cell and
 * flood-fill zeros (the same opening the solver's certification
 * assumed). Mutates cell.isRevealed. Returns the count of revealed cells.
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
