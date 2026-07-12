// Chord eligibility across cell types. A chord reveals all neighbors of a
// satisfied number cell, so it MUST be blocked on cells whose displayed
// number isn't their own adjacent-mine count (liar, mystery, and the
// base-value gimmicks sonar/compass/wormhole/mirror) — otherwise chording
// pops a mine against a number that doesn't describe the neighbors.

import './helpers.mjs';
import { makeBoard, recalcAdjacency } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { chordReveal, unrevealChordMines } = await import('../src/logic/boardSolver.js');

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

// ── Multi-mine chord (2026-07-10 audit) ────────────────────────────────
// chordReveal keeps revealing after the first mine, so two wrong flags
// around a satisfied "2" expose BOTH real mines in one gesture. The consumer
// (handleChordReveal) used to un-reveal only the FIRST mine before routing
// it into the bomb-hit / lifeline / loss flow — every further mine stayed
// permanently revealed with no strike, no penalty, and no bombHits
// increment. unrevealChordMines is the challenge/timed/chaos resolution:
// hide EVERY exposed mine, hand back the first as the one the lifeline/loss
// flow processes. (Daily/weekly stopped re-fogging 2026-07-12 — every
// chord-exposed mine there is charged as its own strike; that batch is
// pinned in test/chordPerMine.test.mjs.)

// 3x3: center "2" with mines at (0,1) and (1,0), but the player flagged
// (0,0) and (2,2) instead — two wrong flags satisfying the count, so the
// chord fires and reveals both REAL mines.
function twoWrongFlagBoard() {
  const b = makeBoard(3, 3);
  b[0][1].isMine = true;
  b[1][0].isMine = true;
  recalcAdjacency(b);
  b[1][1].isRevealed = true;
  b[0][0].isFlagged = true; // wrong flag
  b[2][2].isFlagged = true; // wrong flag
  return b;
}

test('REGRESSION: a chord through two wrong flags exposes BOTH mines', () => {
  const b = twoWrongFlagBoard();
  const result = chordReveal(b, 1, 1);
  assert.equal(result.hitMine, true);
  const minesRevealed = result.revealed.filter((c) => c.isMine);
  assert.equal(minesRevealed.length, 2,
    'the reachable state: one chord reveals two mines (this is what the old find-first handling missed)');
  assert.ok(minesRevealed.every((c) => c.isRevealed));
});

test('REGRESSION: unrevealChordMines hides every chord-exposed mine and returns the first', () => {
  const b = twoWrongFlagBoard();
  const result = chordReveal(b, 1, 1);
  const primary = unrevealChordMines(result.revealed);
  // Every mine back under the fog — no free, penalty-less intel.
  for (const cell of result.revealed.filter((c) => c.isMine)) {
    assert.equal(cell.isRevealed, false, `mine at ${cell.row},${cell.col} must not stay revealed`);
  }
  // The primary drives the standard one-mine flow; safes stay revealed.
  assert.ok(primary && primary.isMine);
  assert.ok(result.revealed.filter((c) => !c.isMine).every((c) => c.isRevealed));
});

test('unrevealChordMines returns null when no mine was exposed', () => {
  assert.equal(unrevealChordMines([{ isMine: false, isRevealed: true }]), null);
});
