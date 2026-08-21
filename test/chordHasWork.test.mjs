// chordHasWork is the read-only twin of chordReveal and the marathon camera's
// navigability judge: his ruling (2026-08-17) puts the double-tap-to-center
// gesture ONLY on unchordable cells ("already chorded or not yet chordable"),
// exactly the cells where chordHasWork is false. The two implementations
// share their decision structure but not their code (chordReveal mutates the
// board; a clone-per-query would be the expensive alternative), so this file
// pins them together DIFFERENTIALLY: over boards covering every eligibility
// branch, chordHasWork(board, r, c) must equal "chordReveal on a fresh copy
// of the same board revealed at least one cell" at EVERY cell. If either
// side's rules drift, some cell disagrees and the sweep names it.

import './helpers.mjs';
import { makeBoard, recalcAdjacency } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { chordHasWork, chordReveal } = await import('../src/logic/boardSolver.js');
const { wallKey } = await import('../src/logic/adjacency.js');

// Differential sweep over every cell of a board built fresh per query
// (chordReveal mutates, so each side gets its own copy from the builder).
function sweepBoard(name, build) {
  const probe = build();
  const rows = probe.length;
  const cols = probe[0].length;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const has = chordHasWork(build(), r, c);
      const res = chordReveal(build(), r, c);
      const revealed = !!(res && res.revealed && res.revealed.length > 0);
      assert.equal(has, revealed,
        `${name} (${r},${c}): chordHasWork says ${has}, chordReveal revealed ${revealed ? 'cells' : 'nothing'}`);
    }
  }
}

test('differential: a busy board with every eligibility branch', () => {
  // 5x5 exercising: satisfied-with-work, satisfied-with-nothing-left
  // (already chorded), unsatisfied, over-flagged, wrong flags, a revealed
  // zero, and unrevealed cells.
  sweepBoard('busy', () => {
    const b = makeBoard(5, 5);
    b[0][2].isMine = true;
    b[2][2].isMine = true;
    b[4][0].isMine = true;
    recalcAdjacency(b);
    // (1,1) revealed "1" with the (2,2) mine flagged: satisfied, and hidden
    // unflagged neighbors remain, so the chord has work.
    b[1][1].isRevealed = true;
    b[2][2].isFlagged = true;
    // (3,3) revealed "1", flag on (2,2) satisfies it too; neighbors partly
    // revealed so it still has work via the rest.
    b[3][3].isRevealed = true;
    // (4,4) revealed zero: never chordable.
    b[4][4].isRevealed = true;
    // (0,0) revealed "1" with NO flags among its neighbors: not yet
    // chordable (flag count 0 !== 1).
    b[0][0].isRevealed = true;
    // (3,1) revealed number over-flagged: two flags around a "1".
    b[3][1].isRevealed = true;
    b[4][0].isFlagged = true;
    b[4][2].isFlagged = true;
    return b;
  });
});

test('differential: already-chorded cells (satisfied, nothing left to reveal)', () => {
  sweepBoard('spent', () => {
    const b = makeBoard(3, 3);
    b[0][0].isMine = true;
    recalcAdjacency(b);
    b[0][0].isFlagged = true;
    // Everything else revealed: every number is satisfied with no hidden
    // unflagged neighbor, i.e. "already chorded", the navigable state.
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      if (!b[r][c].isMine) b[r][c].isRevealed = true;
    }
    return b;
  });
});

test('differential: every gimmick exclusion', () => {
  for (const props of [
    { isSonar: true, displayedMines: 1 },
    { isCompass: true, displayedMines: 1 },
    { isWormhole: true, displayedMines: 1 },
    { mirrorPair: { row: 1, col: 0, pairIndex: 0 }, displayedMines: 1 },
    { isLiar: true, liarOffset: 0, displayedMines: 1 },
    { isMystery: true },
  ]) {
    sweepBoard(`gimmick ${Object.keys(props)[0]}`, () => {
      const b = makeBoard(3, 3);
      b[2][2].isMine = true;
      recalcAdjacency(b);
      b[0][0].isFlagged = true;
      Object.assign(b[1][1], { isRevealed: true }, props);
      return b;
    });
  }
});

test('differential: a strike counts as a flag, a locked neighbor is not work', () => {
  sweepBoard('strike+locked', () => {
    const b = makeBoard(3, 3);
    b[0][1].isMine = true;
    b[2][1].isMine = true;
    recalcAdjacency(b);
    // (1,1) shows "2"; one real flag plus one strike satisfy it. A strike is
    // always a REVEALED cell (the daily bomb-hit leaves the mine on show);
    // an unrevealed strike is a state no game path produces, and building
    // one here made the differential flag a divergence that cannot occur.
    b[1][1].isRevealed = true;
    b[0][1].isFlagged = true;
    b[2][1].isStrike = true;
    b[2][1].isRevealed = true;
    // (1,0)'s only hidden unflagged neighbor pool includes a locked cell;
    // chordReveal skips locked cells, so lock state must count as no-work.
    b[1][0].isRevealed = true;
    b[2][0].isLocked = true;
    b[0][0].isLocked = true;
    return b;
  });
});

test('differential: wall-severed neighbors, both sides through the same topology', () => {
  sweepBoard('walled', () => {
    const b = makeBoard(3, 3);
    b[0][0].isMine = true;
    recalcAdjacency(b);
    // Sever the flag's edge to the number: the flag stops counting for it.
    b._wallEdges = new Set([wallKey(1, 1, 0, 0)]);
    recalcAdjacency(b);
    b[0][0].isFlagged = true;
    b[1][1].isRevealed = true;
    b[1][0].isRevealed = true;
    return b;
  });
});

// The ruling's own words, pinned directly rather than differentially: the
// navigable set is "already chorded or not yet chordable".
test('the gesture predicate: unchordable means already chorded or not yet chordable', () => {
  const b = makeBoard(3, 3);
  b[0][0].isMine = true;
  recalcAdjacency(b);
  b[1][1].isRevealed = true;
  // Not yet chordable: no flags, so the "1" is unsatisfied.
  assert.equal(chordHasWork(b, 1, 1), false);
  // Chord has work: flagged and hidden neighbors remain. NOT navigable.
  b[0][0].isFlagged = true;
  assert.equal(chordHasWork(b, 1, 1), true);
  // Already chorded: everything around it resolved.
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    if (!b[r][c].isMine) b[r][c].isRevealed = true;
  }
  assert.equal(chordHasWork(b, 1, 1), false);
});

// ── Cascade stagger, his 2026-08-21 lag report ──────────────────────
test('REGRESSION: a deep cascade cannot lock input past the stagger bound', async () => {
  // gameActions locks input for the cascade animation (`maxDelay + 100`), and
  // the delay was a flat 30ms per BFS step, a constant tuned on the
  // rectangular 8-neighbourhood where diagonals keep a region shallow. A
  // sparser lattice needs far more steps for the same area, so the same
  // constant drew a much longer animation and held the board unresponsive for
  // all of it: measured full-board depth against an equal-area rectangle, hex
  // 14 vs 9 and deltoidal 17 vs 14, i.e. 420ms and 510ms of a board ignoring
  // taps. That is the lag, and it is code rather than the device.
  const { floodFillReveal, CASCADE_STAGGER_MAX_MS } = await import('../src/logic/boardSolver.js');

  // A long thin all-zero board: every cell cascades and the graph is a path,
  // which is the deepest a walk can get for a given cell count.
  const rows = 1, cols = 60;
  const board = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({
    isMine: false, adjacentMines: 0, isRevealed: false, isFlagged: false, isLocked: false,
  })));
  const revealed = floodFillReveal(board, 0, 0);
  assert.equal(revealed.length, cols, 'the whole strip must cascade');

  const worst = Math.max(...revealed.map((c) => c.revealAnimDelay));
  // NON-VACUITY: unbounded, this walk would have run 59 * 30 = 1770ms.
  assert.ok((cols - 1) * 30 > CASCADE_STAGGER_MAX_MS * 2,
    'the fixture must be deep enough that the bound actually bites');
  assert.ok(worst <= CASCADE_STAGGER_MAX_MS,
    `a deep cascade must stay inside the bound, got ${worst}ms`);

  // And the order still reads outward: a bound that flattened every delay to
  // the same number would pass the check above while destroying the animation.
  assert.equal(revealed[0].revealAnimDelay, 0, 'the origin reveals first');
  assert.ok(worst > 0, 'and the far end still trails it');
});

test('a SHALLOW cascade keeps the historic 30ms step exactly', async () => {
  // The bound must not change the common case, or every classic board's feel
  // moves for a problem classic never had.
  const { floodFillReveal } = await import('../src/logic/boardSolver.js');
  const rows = 1, cols = 5;
  const board = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({
    isMine: false, adjacentMines: 0, isRevealed: false, isFlagged: false, isLocked: false,
  })));
  const revealed = floodFillReveal(board, 0, 0);
  const byCol = revealed.map((c, i) => c.revealAnimDelay).sort((a, b) => a - b);
  assert.deepEqual(byCol, [0, 30, 60, 90, 120],
    'a shallow cascade is untouched by the bound');
});
