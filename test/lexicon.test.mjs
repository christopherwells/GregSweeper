// The Lexicon: every generated lesson board must actually contain the
// target technique and nothing harder (the admission predicate IS the
// curriculum), and the click-gate's underlying guarantee — the board is
// completable through provably-safe clicks alone — must hold end-to-end
// for EVERY lesson in the registry.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { LESSONS, LESSON_ORDER, generateLessonBoard, applyLessonOpening, lessonComplete, lessonShowsPattern, lessonRequiresShape } = await import('../src/logic/lexicon.js');
const { isBoardSolvable, findDeducibleFrontier } = await import('../src/logic/boardSolver.js');
const { cleanSolverArtifacts } = await import('../src/logic/boardGenerator.js');
const { classifyPattern } = await import('../src/logic/patternNames.js');

// Greedy provably-safe play must reach completion — if it stalls, the
// gate would soft-lock the player. Reveals FLOOD zeros, exactly as a real
// click does: without flooding, a revealed 0-clue sits with hidden
// neighbors (an impossible state) and the solver spuriously stalls.
function floodReveal(board, rows, cols, r, c) {
  const q = [[r, c]];
  while (q.length) {
    const [rr, cc] = q.pop();
    const cell = board[rr][cc];
    if (cell.isRevealed || cell.isMine) continue;
    cell.isRevealed = true;
    if (cell.adjacentMines === 0) {
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nr = rr + dr, nc = cc + dc;
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) q.push([nr, nc]);
      }
    }
  }
}
function playToCompletion(lb) {
  let guard = 400;
  while (!lessonComplete(lb) && guard-- > 0) {
    const f = findDeducibleFrontier(lb.board, { respectFlags: false });
    assert.ok(f.safe.length > 0, 'frontier must never be empty before completion');
    for (const s of f.safe) floodReveal(lb.board, lb.rows, lb.cols, s.row, s.col);
  }
  assert.ok(lessonComplete(lb), 'greedy provably-safe play must complete the lesson');
}

test('curriculum order lists exactly the registered lessons', () => {
  assert.deepEqual([...LESSON_ORDER].sort(), Object.keys(LESSONS).sort());
});

for (const id of ['countingBasics', 'subset11', 'subset12', 'holes', 'triangles', 'oneTwoOne', 'oneTwoTwoOne', 'oneThreeOneCorner', 'twoTwoTwoCorner']) {
  test(`${id}: generates deterministically and re-verifies its predicate`, () => {
    const lesson = LESSONS[id];
    const a = generateLessonBoard(lesson, 'unit-1');
    const b = generateLessonBoard(lesson, 'unit-1');
    assert.ok(a, `${id} must generate within its attempt budget`);
    assert.deepEqual(
      a.board.map(row => row.map(c => (c.isMine ? 1 : 0))),
      b.board.map(row => row.map(c => (c.isMine ? 1 : 0))),
      'same seedTag must yield the same board',
    );
    const r = isBoardSolvable(a.board, a.rows, a.cols, a.fr, a.fc);
    cleanSolverArtifacts(a.board);
    assert.ok(lesson.accepts(r), 'accepted board must re-verify against the predicate');
  });

  test(`${id}: completable through provably-safe clicks alone`, () => {
    const lb = generateLessonBoard(LESSONS[id], 'unit-2');
    assert.ok(lb);
    applyLessonOpening(lb);
    playToCompletion(lb);
  });
}

test('counting board needs no pattern, only single-number counting', () => {
  const r = (() => {
    const lb = generateLessonBoard(LESSONS.countingBasics, 'unit-3');
    const res = isBoardSolvable(lb.board, lb.rows, lb.cols, lb.fr, lb.fc);
    cleanSolverArtifacts(lb.board);
    return res;
  })();
  assert.equal(r.techniqueLevel, 0);
  assert.equal(r.canonicalSubsetMoves, 0);
  assert.equal(r.genericSubsetMoves, 0);
});

test('STRICT lessons REQUIRE their shape (force the technique, no cheaper path)', () => {
  // The require-gate plays flags-aware and asks the SOUND engine for each
  // cell's CHEAPEST proof: a board is admitted only if it cannot be finished
  // using anything simpler than the lesson's shape. These seven shapes each
  // have a genuinely irreducible deduction — an ambiguous pocket (hole /
  // triangle), a forced corner mine (1-3-1), a multi-clue corner (2-2-2), or
  // the bare 1-1 / 1-2 whose payload has no cheaper proof.
  for (const [id, name] of [['subset11', '1-1'], ['subset12', '1-2'], ['holes', 'hole'], ['triangles', 'triangle'], ['oneThreeOneCorner', '1-3-1'], ['twoTwoTwoCorner', '2-2-2']]) {
    assert.equal(LESSONS[id].requireShape, true, `${id} must use the require-gate`);
    const lb = generateLessonBoard(LESSONS[id], 'unit-5');
    assert.ok(lb, `${id} must generate`);
    assert.ok(lessonRequiresShape(lb, [name]), `${id} board must REQUIRE a ${name}, not merely show one`);
  }
});

test('RECOGNITION lessons (1-2-1 / 1-2-2-1) SHOW their shape + need subset reasoning', () => {
  // A 1-2-1 ALWAYS decomposes — its two outer mines are each a plain 1-2, so
  // a flagging player flags those and the middle counts out. It can never be
  // REQUIRED the way the strict shapes are (proven 2026-06-16); it IS a pair
  // of 1-2s. So these two are recognition lessons: the gate is "needs real
  // subset reasoning (techniqueLevel >= 1, not pure counting) + the shape is
  // on the solving path" (lessonShowsPattern, requireShape off).
  for (const [id, name] of [['oneTwoOne', '1-2-1'], ['oneTwoTwoOne', '1-2-2-1']]) {
    assert.equal(LESSONS[id].requireShape, false, `${id} is a recognition lesson, not a forced one`);
    const lb = generateLessonBoard(LESSONS[id], 'unit-5');
    assert.ok(lb, `${id} must generate`);
    assert.ok(lessonShowsPattern(lb, name), `${id} board must SHOW a ${name} on the solving path`);
    const r = isBoardSolvable(lb.board, lb.rows, lb.cols, lb.fr, lb.fc);
    cleanSolverArtifacts(lb.board);
    assert.ok(r.techniqueLevel >= 1, `${id} must need real subset reasoning, not pure counting`);
  }
});
