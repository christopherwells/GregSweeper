// The Lexicon: every generated lesson board must actually contain the
// target technique and nothing harder (the admission predicate IS the
// curriculum), and the click-gate's underlying guarantee — the board is
// completable through provably-safe clicks alone — must hold end-to-end.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { LESSONS, generateLessonBoard, applyLessonOpening, lessonComplete } = await import('../src/logic/lexicon.js');
const { isBoardSolvable, findDeducibleFrontier } = await import('../src/logic/boardSolver.js');
const { cleanSolverArtifacts } = await import('../src/logic/boardGenerator.js');

test('generateLessonBoard returns boards passing the admission predicate, deterministically', () => {
  const lesson = LESSONS.subset12;
  const a = generateLessonBoard(lesson, 'unit-1');
  const b = generateLessonBoard(lesson, 'unit-1');
  assert.ok(a, 'generation must succeed within the attempt budget');
  // Determinism: same seedTag → same board.
  assert.deepEqual(
    a.board.map(row => row.map(c => c.isMine ? 1 : 0)),
    b.board.map(row => row.map(c => c.isMine ? 1 : 0)),
  );
  const r = isBoardSolvable(a.board, a.rows, a.cols, a.fr, a.fc);
  cleanSolverArtifacts(a.board);
  assert.ok(lesson.accepts(r), 'accepted board must re-verify against the predicate');
  assert.ok(r.canonicalSubsetMoves >= 1);
  assert.equal(r.advancedLogicMoves, 0);
  assert.equal(r.disjunctiveMoves, 0);
});

test('lesson is completable through provably-safe clicks alone (the click-gate guarantee)', () => {
  const lesson = LESSONS.subset12;
  const lb = generateLessonBoard(lesson, 'unit-2');
  assert.ok(lb);
  applyLessonOpening(lb);
  // Greedy play: repeatedly reveal every cell the frontier proves safe.
  // A certified lesson board must reach completion this way — if it
  // stalls, the gate would soft-lock the player.
  let guard = 200;
  while (!lessonComplete(lb) && guard-- > 0) {
    const f = findDeducibleFrontier(lb.board, { respectFlags: false });
    assert.ok(f.safe.length > 0, 'frontier must never be empty before completion');
    for (const s of f.safe) {
      lb.board[s.row][s.col].isRevealed = true;
    }
  }
  assert.ok(lessonComplete(lb), 'greedy provably-safe play must complete the lesson');
});
