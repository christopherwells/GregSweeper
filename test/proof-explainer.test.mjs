// Plain-language proof explanations: the sentence must match the actual
// board arithmetic (right numbers, right counts), never name jargon, and
// the Socratic style must never resolve the square it's hinting at.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { explainDeduction } = await import('../src/logic/proofExplainer.js');
const { findDeducibleFrontier } = await import('../src/logic/boardSolver.js');
const { makeBoard, recalcAdjacency } = await import('./helpers.mjs');

const JARGON = /provabl|frontier|enumerat|disjunctiv|constraint|tier/i;

test('tier-0 mine: sentence carries the real counts from the board', () => {
  // 3x3, mine at (0,0), everything else revealed: the 1 at (1,1) has one
  // hidden square left and still needs one mine.
  const board = makeBoard(3, 3);
  board[0][0].isMine = true;
  recalcAdjacency(board);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    if (!(r === 0 && c === 0)) board[r][c].isRevealed = true;
  }
  const f = findDeducibleFrontier(board, { respectFlags: false });
  const mine = f.mines[0];
  const full = explainDeduction(board, mine, { style: 'full', kind: 'mine' });
  assert.match(full, /needs 1 mine and has exactly 1 hidden square left/);
  assert.ok(!JARGON.test(full), `jargon leaked: ${full}`);

  const socratic = explainDeduction(board, mine, { style: 'socratic', kind: 'mine' });
  assert.match(socratic, /exactly as many mines as it has hidden squares/);
  assert.ok(!JARGON.test(socratic));
});

test('tier-0 safe after a strike: references the known mine honestly', () => {
  // 2x3, mine at (0,1) struck (revealed, still a mine). Every number is
  // satisfied; (1,0) and (1,2) are deducibly safe via their adjacent 1s.
  const board = makeBoard(2, 3);
  board[0][1].isMine = true;
  recalcAdjacency(board);
  board[0][0].isRevealed = true;
  board[0][2].isRevealed = true;
  board[1][1].isRevealed = true;
  board[0][1].isRevealed = true;
  board[0][1].isStrike = true;
  const f = findDeducibleFrontier(board, { respectFlags: false });
  const safe = f.safe.find(s => s.row === 1 && s.col === 0);
  assert.ok(safe, 'expected (1,0) provably safe');
  const full = explainDeduction(board, safe, { style: 'full', kind: 'safe' });
  assert.match(full, /already touches 1 known mine/);
  assert.match(full, /every other square around it is clear/);
  assert.ok(!JARGON.test(full));
});

test('subset deduction surfaces as tier 1 with exactly the two proving clues', () => {
  // The 5x5 fixture: (1,0)'s 1 is a subset of (1,1)'s 1, and the
  // difference proves (0,2) safe. Before the frontier grew its Pass B
  // mirror this surfaced as a whole-component tier-2 answer naming all
  // the row-1 clues at once; the minimal honest explanation is the PAIR.
  const board = makeBoard(5, 5);
  board[0][0].isMine = true;
  board[0][4].isMine = true;
  recalcAdjacency(board);
  for (let r = 1; r < 5; r++) for (let c = 0; c < 5; c++) board[r][c].isRevealed = true;
  const f = findDeducibleFrontier(board, { respectFlags: false });
  const safe = f.safe.find(s => s.row === 0 && s.col === 2);
  assert.ok(safe, 'expected (0,2) in the safe frontier');
  assert.equal(safe.tier, 1, 'a plain subset must surface as tier 1, not the whole component');
  assert.equal(safe.sources.length, 2, 'the minimal explanation is the two clues');

  const full = explainDeduction(board, safe, { style: 'full', kind: 'safe' });
  assert.match(full, /Compare the 1 and the 1/);
  assert.ok(!JARGON.test(full));

  const socratic = explainDeduction(board, safe, { style: 'socratic', kind: 'safe' });
  assert.match(socratic, /overlap/);
  assert.ok(!JARGON.test(socratic));
});

test('tier-2 copy: names the clue count, full resolves and socratic does not', () => {
  // Synthetic tier-2 deduction (the copy path reads only tier+sources).
  const board = makeBoard(3, 3);
  recalcAdjacency(board);
  const ded = { row: 0, col: 0, tier: 2, sources: [{ row: 1, col: 0 }, { row: 1, col: 1 }, { row: 1, col: 2 }, { row: 2, col: 0 }, { row: 2, col: 1 }, { row: 2, col: 2 }] };
  const full = explainDeduction(board, ded, { style: 'full', kind: 'safe' });
  assert.match(full, /all 6 highlighted clues/);
  assert.match(full, /this square is clear/);
  assert.ok(!JARGON.test(full));
  const socratic = explainDeduction(board, ded, { style: 'socratic', kind: 'safe' });
  assert.ok(!/this square/.test(socratic), 'socratic must not resolve the square');
  assert.ok(!JARGON.test(socratic));
});

test('graceful null on malformed input', () => {
  const board = makeBoard(3, 3);
  recalcAdjacency(board);
  assert.equal(explainDeduction(board, null), null);
  assert.equal(explainDeduction(board, { row: 0, col: 0, tier: 0, sources: [] }), null);
});
