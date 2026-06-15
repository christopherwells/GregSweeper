// The named-pattern detector must name a shape ONLY when the board
// geometry actually contains it: a wall/edge 1-2-1 or 1-2-2-1 (hidden
// front on one side), a two-clue 1-1 / 1-2 overlap, tier-0 counting. An
// incidental 1,2,1 digit run in open field (hidden on both sides) and a
// shapeless tier-2 region must NEVER be named — that is the honesty
// guarantee the receipts and the Gym both lean on.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { classifyPattern, isOneTwoOne, isOneThreeOneCorner, isTwoTwoTwoCorner, boardContainsNamedPattern } = await import('../src/logic/patternNames.js');
const { findDeducibleFrontier } = await import('../src/logic/boardSolver.js');
const { generateBoard, cleanSolverArtifacts } = await import('../src/logic/boardGenerator.js');
const { createDailyRNG } = await import('../src/logic/seededRandom.js');
const { makeBoard, recalcAdjacency } = await import('./helpers.mjs');

function floodOpen(board, rows, cols, fr, fc) {
  const q = [[fr, fc]];
  while (q.length) {
    const [r, c] = q.pop(); const cell = board[r][c];
    if (cell.isRevealed || cell.isMine) continue; cell.isRevealed = true;
    if (cell.adjacentMines === 0) for (let dr=-1;dr<=1;dr++) for (let dc=-1;dc<=1;dc++) if(dr||dc){const nr=r+dr,nc=c+dc; if(nr>=0&&nr<rows&&nc>=0&&nc<cols) q.push([nr,nc]);}
  }
}

// Reveal a cell as a plain clue with an explicit displayed count.
function clue(board, r, c, n) {
  board[r][c].isRevealed = true;
  board[r][c].adjacentMines = n;
}

test('1-2-1: a wall pattern (clues 1,2,1, hidden front below) is named', () => {
  // Rows 0-1 revealed (the wall + the clue row), row 2 hidden below.
  const board = makeBoard(3, 5);
  for (let c = 0; c < 5; c++) clue(board, 0, c, 0);
  clue(board, 1, 0, 0); clue(board, 1, 1, 1); clue(board, 1, 2, 2); clue(board, 1, 3, 1); clue(board, 1, 4, 0);
  const ded = { row: 2, col: 2, tier: 2, kind: 'safe', sources: [{ row: 1, col: 1 }, { row: 1, col: 2 }, { row: 1, col: 3 }] };
  assert.equal(classifyPattern(board, ded).name, '1-2-1');
});

test('1-2-2-1: a four-clue wall pattern is named, not mislabeled 1-2-1', () => {
  const board = makeBoard(3, 6);
  for (let c = 0; c < 6; c++) clue(board, 0, c, 0);
  clue(board, 1, 0, 0); clue(board, 1, 1, 1); clue(board, 1, 2, 2); clue(board, 1, 3, 2); clue(board, 1, 4, 1); clue(board, 1, 5, 0);
  const ded = { row: 2, col: 2, tier: 2, kind: 'safe', sources: [] };
  assert.equal(classifyPattern(board, ded).name, '1-2-2-1');
});

test('1-1: a real two-clue subset surfaces and is named from the digits', () => {
  // The proof-explainer fixture: (1,0)'s 1 ⊂ (1,1)'s 1 proves (0,2) safe.
  const board = makeBoard(5, 5);
  board[0][0].isMine = true;
  board[0][4].isMine = true;
  recalcAdjacency(board);
  for (let r = 1; r < 5; r++) for (let c = 0; c < 5; c++) board[r][c].isRevealed = true;
  const f = findDeducibleFrontier(board, { respectFlags: false });
  const safe = f.safe.find(s => s.row === 0 && s.col === 2);
  assert.ok(safe && safe.tier === 1, 'expected (0,2) as a tier-1 subset');
  const { name, family } = classifyPattern(board, { ...safe, kind: 'safe' });
  assert.equal(name, '1-1');
  assert.equal(family, '1-1');
});

test('1-2: a canonical two-clue overlap of a 1 and a 2 is named 1-2', () => {
  // The wide clue must see <=3 (canonical); reveal (2,2) so the 2 sees 3,
  // else a 4-cell wide clue would correctly read as a hole.
  const board = makeBoard(3, 3);
  clue(board, 2, 0, 1);
  clue(board, 2, 1, 2);
  clue(board, 2, 2, 2);
  const ded = { row: 0, col: 0, tier: 1, kind: 'safe', sources: [{ row: 2, col: 0 }, { row: 2, col: 1 }] };
  assert.equal(classifyPattern(board, ded).name, '1-2');
});

test('1-3-1 corner: the square only the 3 sees is a mine, the 1s far squares safe', () => {
  // Christopher's layout: 3 at (2,2) is the corner of an L, a 1 above it
  // (1,2) and a 1 to its left (2,1). The 3 sees five hidden squares; the
  // corner (3,3) is forced mine, (0,3) and (3,0) are forced safe.
  const board = makeBoard(4, 4);
  clue(board, 0, 0, 0); clue(board, 0, 1, 0); clue(board, 0, 2, 1);
  clue(board, 1, 0, 0); clue(board, 1, 1, 0); clue(board, 1, 2, 1);
  clue(board, 2, 0, 1); clue(board, 2, 1, 1); clue(board, 2, 2, 3);
  assert.equal(classifyPattern(board, { row: 3, col: 3, tier: 2, kind: 'mine', sources: [] }).name, '1-3-1');
  assert.equal(classifyPattern(board, { row: 0, col: 3, tier: 2, kind: 'safe', sources: [] }).name, '1-3-1');
  assert.equal(classifyPattern(board, { row: 3, col: 0, tier: 2, kind: 'safe', sources: [] }).name, '1-3-1');
});

test('NEGATIVE: a saturated 3 (three hidden squares) is not a 1-3-1 corner', () => {
  // A corner 3 that sees exactly three squares is plain counting (all
  // mines), not the five-square corner insight.
  const board = makeBoard(3, 3);
  clue(board, 0, 0, 3); // sees (0,1),(1,0),(1,1) only
  assert.equal(isOneThreeOneCorner(board, 3, 3, undefined, 1 * 3 + 1, 'mine'), false);
  assert.notEqual(classifyPattern(board, { row: 1, col: 1, tier: 2, kind: 'mine', sources: [] }).name, '1-3-1');
});

test('a bigger pair carries its family: 2-2 is the 1-1 family, 2-3 the 1-2 family', () => {
  // The gym's "1-1/1-2 in disguise" nod keys on this family.
  // (2,2) revealed so the wider clue stays canonical (<=3 cells) — a
  // 4-cell wide clue would read as a hole, which is a different lesson.
  const eq = makeBoard(3, 3);
  clue(eq, 2, 0, 2); clue(eq, 2, 1, 2); clue(eq, 2, 2, 2);
  const a = classifyPattern(eq, { row: 0, col: 0, tier: 1, kind: 'safe', sources: [{ row: 2, col: 0 }, { row: 2, col: 1 }] });
  assert.equal(a.name, 'pair');
  assert.equal(a.family, '1-1');

  const uneq = makeBoard(3, 3);
  clue(uneq, 2, 0, 2); clue(uneq, 2, 1, 3); clue(uneq, 2, 2, 2);
  const b = classifyPattern(uneq, { row: 0, col: 0, tier: 1, kind: 'safe', sources: [{ row: 2, col: 0 }, { row: 2, col: 1 }] });
  assert.equal(b.name, 'pair');
  assert.equal(b.family, '1-2');
});

test('hole: a boxed 1 sharing a 2-cell pocket with a wide 1 is named a hole', () => {
  // H1 from minesweeper.online: a bottom 1 touches only the 2-cell pocket;
  // the 1 above touches the pocket + a row of cells, so those extra cells
  // are safe. The boxed clue sees 2, the wide clue sees 5 (generic).
  const board = makeBoard(4, 5);
  for (let c = 0; c < 5; c++) clue(board, 3, c, 1); // bottom row of 1s
  clue(board, 2, 2, 1);                              // the boxed 1, between the pocket cells
  const f = findDeducibleFrontier(board, { respectFlags: false });
  const green = f.safe.find(s => s.row === 1 && s.col >= 1 && s.col <= 3);
  assert.ok(green, 'a cell above is provably safe');
  assert.equal(classifyPattern(board, { ...green, kind: 'safe' }, { rows: 4, cols: 5 }).name, 'hole');
});

test('triangle: a boxed-3 clue sharing its pocket with a wide clue is named a triangle', () => {
  // Boxed clue (3,2) sees exactly the 3-cell pocket (2,1),(2,2),(2,3); the
  // wide clue (1,2) sees those three plus the greens above (6 hidden), so
  // the greens are safe. The recognizer scans the board for the boxed-3
  // structure, independent of the frontier's chosen sources.
  const board = makeBoard(4, 5);
  clue(board, 1, 1, 1); clue(board, 1, 2, 1); clue(board, 1, 3, 1); // wide clue + flanks
  clue(board, 3, 1, 1); clue(board, 3, 2, 1); clue(board, 3, 3, 1); // boxed clue + flanks
  // pocket (2,1),(2,2),(2,3) and greens (0,1),(0,2),(0,3) stay hidden
  const ded = { row: 0, col: 2, tier: 1, kind: 'safe', sources: [{ row: 3, col: 2 }, { row: 1, col: 2 }] };
  assert.equal(classifyPattern(board, ded, { rows: 4, cols: 5 }).name, 'triangle');
});

test('NEGATIVE: an incidental 1,2,1 with hidden on BOTH sides is not a 1-2-1', () => {
  // Only the three clues revealed; rows 0 and 2 hidden, so the front is
  // not on one side and the pattern does not force.
  const board = makeBoard(3, 5);
  clue(board, 1, 1, 1); clue(board, 1, 2, 2); clue(board, 1, 3, 1);
  const ded = { row: 0, col: 2, tier: 2, kind: 'safe', sources: [] };
  assert.equal(classifyPattern(board, ded).name, 'region');
  assert.equal(isOneTwoOne(board, 3, 5, undefined, 0 * 5 + 2), false);
});

test('NEGATIVE: a shapeless tier-2 region stays "region"', () => {
  const board = makeBoard(3, 3);
  recalcAdjacency(board);
  const ded = { row: 0, col: 0, tier: 2, kind: 'safe', sources: [{ row: 1, col: 0 }, { row: 1, col: 1 }, { row: 1, col: 2 }] };
  assert.equal(classifyPattern(board, ded).name, 'region');
});

test('tier-0: a lone clue is plain counting', () => {
  const board = makeBoard(3, 3);
  clue(board, 1, 1, 1);
  const ded = { row: 0, col: 0, tier: 0, kind: 'safe', sources: [{ row: 1, col: 1 }] };
  assert.equal(classifyPattern(board, ded).name, 'count');
});

test('flag-reduction: a clue with a known (revealed) mine neighbor', () => {
  const board = makeBoard(2, 3);
  board[0][1].isMine = true;
  board[0][1].isRevealed = true; // a strike: revealed AND still a mine
  board[0][1].isStrike = true;
  clue(board, 0, 0, 1);
  const ded = { row: 1, col: 0, tier: 0, kind: 'safe', sources: [{ row: 0, col: 0 }] };
  assert.equal(classifyPattern(board, ded).name, 'flag-reduction');
});

test('2-2-2 recognizer is SOUND: every cell it names is provably safe', () => {
  // The honesty guard for the hardest recognizer. Sweep generated boards,
  // replay the greedy solve, and at each step assert every cell
  // isTwoTwoTwoCorner flags is in the flags-blind safe frontier — i.e. it
  // never claims a square the solver cannot independently prove safe.
  const rows = 7, cols = 7;
  let fired = 0;
  for (let s = 0; s < 120; s++) {
    const board = generateBoard(rows, cols, 10, 3, 3, createDailyRNG(`222-sound-${s}`));
    cleanSolverArtifacts(board);
    floodOpen(board, rows, cols, 3, 3);
    let guard = 60;
    while (guard-- > 0) {
      const f = findDeducibleFrontier(board, { respectFlags: false });
      const safeSet = new Set(f.safe.map(x => x.row * cols + x.col));
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const cell = board[r][c];
        if (cell.isRevealed || cell.isFlagged) continue;
        if (isTwoTwoTwoCorner(board, rows, cols, undefined, r * cols + c)) {
          fired++;
          assert.ok(safeSet.has(r * cols + c), `(${r},${c}) named 2-2-2 but solver cannot prove it safe (seed ${s})`);
        }
      }
      if (f.safe.length === 0) break;
      let progressed = false;
      for (const x of f.safe) { if (!board[x.row][x.col].isRevealed) { board[x.row][x.col].isRevealed = true; progressed = true; } }
      if (!progressed) break;
    }
  }
  assert.ok(fired > 0, 'the sweep should exercise the recognizer at least once');
});

test('malformed input returns a null name, never throws', () => {
  const board = makeBoard(3, 3);
  recalcAdjacency(board);
  assert.equal(classifyPattern(board, null).name, null);
  assert.equal(classifyPattern(board, { tier: 1 }).name, null);
});

test('boardContainsNamedPattern finds the wall 1-2-1 and rejects a blank board', () => {
  const board = makeBoard(3, 5);
  for (let c = 0; c < 5; c++) clue(board, 0, c, 0);
  clue(board, 1, 0, 0); clue(board, 1, 1, 1); clue(board, 1, 2, 2); clue(board, 1, 3, 1); clue(board, 1, 4, 0);
  assert.equal(boardContainsNamedPattern(board, 3, 5, '1-2-1'), true);

  const blank = makeBoard(3, 5);
  recalcAdjacency(blank);
  assert.equal(boardContainsNamedPattern(blank, 3, 5, '1-2-1'), false);
});
