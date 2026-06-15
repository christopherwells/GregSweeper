// ── The Lexicon: generated single-technique lessons ────
// The generator writes the curriculum: each lesson board is REQUIRED to
// contain the target deduction class and NOTHING harder, verified by the
// five-bucket solver classification, and for the named-shape lessons by
// the shared geometry detector (patternNames.js) — the SAME classifier
// the gym coaching and the receipts use, so a lesson can never teach a
// shape the receipts cannot recognize. Measured yield
// (scripts/measure-lexicon-yield.mjs, 2026-06-15): countingBasics 1-in-3,
// subset11 1-in-4, subset12 1-in-21 (~9ms/board — 2s are rarer than 1s on
// a sparse board, but a 400-attempt budget never gets close to
// exhausting), oneTwoOne 1-in-5, oneTwoTwoOne 1-in-12 (~30-44ms/board, the
// geometry check runs per candidate), oneThreeOneCorner 1-in-6 (~13ms).
// All live, no pre-baked content.
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
export const LESSON_ORDER = ['countingBasics', 'subset11', 'subset12', 'holes', 'triangles', 'oneTwoOne', 'oneTwoTwoOne', 'oneThreeOneCorner', 'twoTwoTwoCorner'];

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

  // Tier 1 — two EQUAL numbers looking at the same squares. The mine that
  // satisfies the first satisfies the second too, so the second's far
  // square is safe. The bucket gate (a canonical subset, nothing harder)
  // is shared with the 1-2; requiresPattern splits them by the two clue
  // digits, so the 1-1 lesson always features an actual 1-1.
  subset11: {
    id: 'subset11',
    name: 'The 1-1 pattern',
    blurb: 'Two equal neighbors.',
    rule: 'When two 1s sit side by side looking at the same squares, the mine that satisfies the first already satisfies the second. The square only the second 1 can see is safe.',
    naming: 'That was a 1-1: the first 1\'s mine sits in the squares both share, which satisfies the second 1 too, so its far square is safe.',
    rows: 6, cols: 6, mines: 6,
    requiresPattern: '1-1',
    requireShape: true,
    attempts: 2000,
    accepts: (r) =>
      (r.solvable || r.remainingUnknowns === 0)
      && r.canonicalSubsetMoves >= 1
      && r.genericSubsetMoves === 0
      && r.advancedLogicMoves === 0
      && r.disjunctiveMoves === 0
      && r.techniqueLevel === 1,
  },

  // Tier 1 — two numbers off by one. The bigger number's extra mine can
  // only sit in the square the smaller one cannot see; the smaller one's
  // far square is safe.
  subset12: {
    id: 'subset12',
    name: 'The 1-2 pattern',
    blurb: 'A 1 beside a 2.',
    rule: 'When two numbers look at the same squares, the smaller one\'s mines fit inside the squares they share. The square only the bigger number sees holds its extra mine, and the square only the smaller number sees is safe.',
    naming: 'That was a 1-2: the 2 needs one mine more than the 1, so it sits in the square only the 2 can see, and the 1\'s far square is safe.',
    rows: 6, cols: 6, mines: 6,
    requiresPattern: '1-2',
    requireShape: true,
    attempts: 3000,
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
    requireShape: true,
    attempts: 2000,
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
    requireShape: true,
    attempts: 4000,
    accepts: (r) =>
      (r.solvable || r.remainingUnknowns === 0)
      && r.disjunctiveMoves === 0
      && r.techniqueLevel <= 2,
  },

  // Advanced: the 1-3-1 corner. A 3 at the bend of an L with a 1 on each
  // arm sees five squares; the two 1s force the third mine into the
  // square only the 3 can see. The 1-2 idea bent around a corner — a
  // genuine tier-2 read, geometry-defined like the line patterns.
  oneThreeOneCorner: {
    id: 'oneThreeOneCorner',
    name: 'The 1-3-1 corner',
    blurb: 'A 3 in an L corner.',
    advanced: true,
    rule: 'When a 3 sits in the corner of an L with a 1 on each arm, the 3 sees five squares. Each 1 holds a pair of them to one mine, which forces a mine into the square only the 3 can see, and leaves each 1\'s far square safe.',
    naming: 'That was a 1-3-1 corner: the two 1s hold four of the 3\'s squares to two mines between them, so the fifth square, the one only the 3 sees, is a mine, and the 1s\' far squares are safe.',
    rows: 7, cols: 7, mines: 9,
    requiresPattern: '1-3-1',
    requireShape: true,
    attempts: 6000,
    accepts: (r) =>
      (r.solvable || r.remainingUnknowns === 0)
      && r.disjunctiveMoves === 0
      && r.techniqueLevel <= 2,
  },

  // Holes and triangles are the 1-1/1-2 OVERLAP read in a boxed-pocket
  // shape: a clue boxed to a small pocket pins its mine count, and a wider
  // clue sharing the pocket clears every other square it touches. Same
  // logic as subset11/subset12, but the wider clue is GENERIC (>=4 cells —
  // the cell cluster the canonical lessons cap out before), so these clear
  // several squares at once. A 2-cell pocket is a hole; a 3-cell a
  // triangle (classifyPattern names them by the boxed clue's size).
  holes: {
    id: 'holes',
    name: 'Holes',
    blurb: 'A boxed-in clue.',
    rule: 'When a clue is boxed in so it touches only a small pocket of squares, it counts the mines in that pocket exactly. A wider clue that shares the pocket then has its mine accounted for, so every other square it touches is safe.',
    naming: 'That was a hole: the boxed-in clue pinned the pocket, and the wider clue sharing it had nothing left for its other squares, so they were all safe.',
    rows: 7, cols: 7, mines: 9,
    requiresPattern: 'hole',
    requireShape: true,
    attempts: 2500,
    accepts: (r) =>
      (r.solvable || r.remainingUnknowns === 0)
      && r.disjunctiveMoves === 0
      && r.advancedLogicMoves === 0
      && r.techniqueLevel <= 1,
  },

  triangles: {
    id: 'triangles',
    name: 'Triangles',
    blurb: 'A three-square pocket.',
    rule: 'Same read as a hole, but the shared pocket is three squares. A boxed clue counts the mines in the three, and a wider clue overlapping them clears everything else it touches.',
    naming: 'That was a triangle: one clue counted the three-square pocket, and the wider clue that shares it cleared every square beyond.',
    rows: 7, cols: 7, mines: 9,
    requiresPattern: 'triangle',
    requireShape: true,
    attempts: 4000,
    accepts: (r) =>
      (r.solvable || r.remainingUnknowns === 0)
      && r.disjunctiveMoves === 0
      && r.advancedLogicMoves === 0
      && r.techniqueLevel <= 1,
  },

  // Advanced: the 2-2-2 corner is a tier-2 multi-clue read — a corner 2
  // whose two flanking 2s each force a mine into their own squares,
  // accounting for both of the corner 2's mines and freeing its last
  // square. Allows tier 2 (it needs the joint reasoning); no liar.
  twoTwoTwoCorner: {
    id: 'twoTwoTwoCorner',
    name: 'The 2-2-2 corner',
    blurb: 'Three 2s at a corner.',
    advanced: true,
    rule: 'When a 2 in a corner shares its squares with two flanking 2s, each flanking 2 forces a mine into its own pair of squares. That uses up both of the corner 2\'s mines, so the square only the corner 2 can see is safe.',
    naming: 'That was a 2-2-2 corner: the two flanking 2s each forced a mine into their own squares, accounting for both of the corner 2\'s mines, so its last square was safe.',
    rows: 7, cols: 7, mines: 10,
    requiresPattern: '2-2-2',
    requireShape: true,
    attempts: 4000,
    accepts: (r) =>
      (r.solvable || r.remainingUnknowns === 0)
      && r.disjunctiveMoves === 0
      && r.techniqueLevel <= 2,
  },
};

const MAX_GENERATION_ATTEMPTS = 400; // yield ~1-in-3 for the bucket lessons

// Will the lesson's named shape actually be PERFORMABLE during real play?
// Admission models the gym the way it is played: ONE cell at a time, not a
// whole frontier wave. This matters because some shapes are transient — a
// hole/triangle is a clue boxed to a pocket sitting inside a WIDER clue, and
// the instant a player reveals one of that wider clue's other neighbors it
// drops below four hidden cells and dissolves into a plain 1-1 pair. A
// wave-mode check (reveal the entire frontier each step, classify at its
// peak) sees the shape where a one-at-a-time player never gets to perform it
// (measured: triangles surfaced in ~100% of wave checks but only ~80% of
// one-at-a-time play; 2-2-2 corners ~67%). So we step one reveal at a time:
// at each step, if the target shape is the TOP read of any provable cell, the
// player could perform it right now → admit; otherwise make a single move and
// look again, letting fragile structures dissolve exactly as they would in
// play. A board admits only if the shape survives to a moment a player can
// actually do it. The reveal state is snapshotted and restored, so the board
// handed back to the gym still starts at the opening. Exported so the yield
// script and tests measure the same thing.
export function lessonShowsPattern(lessonBoard, patternName) {
  const { board, rows, cols } = lessonBoard;
  const snapshot = board.map(row => row.map(c => c.isRevealed));
  let found = false;
  let guard = 400;
  while (guard-- > 0) {
    const f = findDeducibleFrontier(board, { respectFlags: false });
    const candidates = [
      ...f.safe.map(s => ({ ...s, kind: 'safe' })),
      ...f.mines.map(m => ({ ...m, kind: 'mine' })),
    ];
    if (candidates.some(d => classifyPattern(board, d, { rows, cols }).name === patternName)) {
      found = true;
      break;
    }
    if (f.safe.length === 0) break;
    // Make exactly ONE move (flood from a single safe cell, like one click),
    // then re-look. One at a time so revealing a neighbor can collapse a
    // pocket before the player reaches it — the whole point of the faithful
    // model.
    const s = f.safe[0];
    const queue = [[s.row, s.col]];
    while (queue.length) {
      const [r, c] = queue.pop();
      const cc = board[r][c];
      if (cc.isRevealed || cc.isMine) continue;
      cc.isRevealed = true;
      if (cc.adjacentMines === 0) {
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) queue.push([nr, nc]);
          }
        }
      }
    }
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) board[r][c].isRevealed = snapshot[r][c];
  return found;
}

// Does the board REQUIRE the shape, not merely show it? The lighter
// "appears on a path" check (lessonShowsPattern) admitted boards where the
// shape was a cameo off the critical path — measured, 44% of Holes boards,
// 77% of Triangles, 60-78% of the corner shapes were finishable WITHOUT
// ever performing the shape (the player solves around it by counting and
// simple pairs, and never sees the lesson's technique). This gate models
// that directly: play the board gated, revealing every provably-safe cell
// EXCEPT ones whose top read is the target shape. If that play completes the
// board, the shape was avoidable → reject. If it stalls at a state whose only
// remaining progress is a target-shape cell (a safe reveal, or a forced mine
// flag — triangles often resolve as a forced mine), the player is forced to
// perform the shape → admit. Used for the GEOMETRY shapes (hole / triangle /
// 1-2-1 / 1-2-2-1 / 1-3-1 / 2-2-2), whose recognizers read the board, not the
// frontier's chosen sources. NOT used for the bare 1-1/1-2 pair lessons: their
// classification IS source-dependent, so this gate misreads them. Exported so
// the yield script and tests measure exactly what generation enforces.
export function lessonRequiresShape(lessonBoard, shapeNames) {
  const { board, rows, cols } = lessonBoard;
  const snapshot = board.map(row => row.map(c => c.isRevealed));
  const isTarget = (d, kind) =>
    shapeNames.includes(classifyPattern(board, { ...d, kind }, { rows, cols }).name);
  let required = false;
  let guard = 400;
  while (guard-- > 0) {
    const f = findDeducibleFrontier(board, { respectFlags: false });
    const allowed = f.safe.filter(s => !isTarget(s, 'safe'));
    if (allowed.length === 0) {
      // No non-shape progress left: the player is forced to the shape iff one
      // is on the frontier (as a safe reveal or a provable mine to flag).
      required = f.safe.some(s => isTarget(s, 'safe')) || f.mines.some(m => isTarget(m, 'mine'));
      break;
    }
    // Reveal each allowed cell by FLOODING zeros, exactly as a real click
    // does — otherwise a revealed 0 can sit with hidden neighbors, an
    // impossible board state that confuses the recognizers.
    for (const s of allowed) {
      const queue = [[s.row, s.col]];
      while (queue.length) {
        const [r, c] = queue.pop();
        const cc = board[r][c];
        if (cc.isRevealed || cc.isMine) continue;
        cc.isRevealed = true;
        if (cc.adjacentMines === 0) {
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (dr === 0 && dc === 0) continue;
              const nr = r + dr, nc = c + dc;
              if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) queue.push([nr, nc]);
            }
          }
        }
      }
    }
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) board[r][c].isRevealed = snapshot[r][c];
  return required;
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
      // Geometry shapes must be REQUIRED (the board can't be finished without
      // them); the bare 1-1/1-2 pairs keep the lighter "shows it" check.
      const ok = lesson.requireShape
        ? lessonRequiresShape(lessonBoard, [lesson.requiresPattern])
        : lessonShowsPattern(lessonBoard, lesson.requiresPattern);
      if (!ok) continue;
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
