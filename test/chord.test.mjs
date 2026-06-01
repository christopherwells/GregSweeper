// Chord eligibility across cell types. A chord reveals all neighbors of a
// satisfied number cell, so it MUST be blocked on cells whose displayed
// number isn't their own adjacent-mine count (liar, mystery, and the
// base-value gimmicks sonar/compass/wormhole/mirror) — otherwise chording
// pops a mine against a number that doesn't describe the neighbors.

import './helpers.mjs';
import { makeBoard, recalcAdjacency } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { chordReveal } = await import('../src/logic/boardSolver.js');

// 3x3 with center revealed (a "1"), one flagged neighbor, one mine to
// chord into. A plain number cell here SHOULD chord; gimmick cells should
// not. We layer the gimmick prop onto the center cell.
function centerChordBoard(centerProps) {
  const b = makeBoard(3, 3);
  b[2][2].isMine = true;
  recalcAdjacency(b);
  b[0][0].isFlagged = true;            // 1 flag == the center's count
  Object.assign(b[1][1], { isRevealed: true, adjacentMines: 1 }, centerProps);
  return b;
}

function chords(centerProps) {
  const r = chordReveal(centerChordBoard(centerProps), 1, 1);
  return !!(r && r.revealed && r.revealed.length > 0);
}

test('a plain satisfied number cell chords', () => {
  assert.equal(chords({ displayedMines: undefined }), true);
});

for (const [label, props] of [
  ['sonar',    { isSonar: true, displayedMines: 1 }],
  ['compass',  { isCompass: true, displayedMines: 1 }],
  ['wormhole', { isWormhole: true, displayedMines: 1 }],
  ['mirror',   { mirrorPair: { row: 1, col: 0, pairIndex: 0 }, displayedMines: 1 }],
  ['liar',     { isLiar: true, liarOffset: 0, displayedMines: 1 }],
  ['mystery',  { isMystery: true }],
]) {
  test(`chording is blocked on a ${label} cell`, () => {
    assert.equal(chords(props), false, `${label} should not be chordable`);
  });
}
