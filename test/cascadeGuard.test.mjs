// The loss cascade must never leak into the next game (2026-07-11 audit).
//
// chainRevealMines staggers one setTimeout per mine (120ms apart) plus a
// settle delay. The game-over modal only appears AFTER the cascade, so the
// R restart shortcut works DURING it — newGame swaps state.board, and the
// unguarded timeouts then stamped isStrike onto the NEW game's cells at the
// old coordinates: a phantom strike that renders on reveal and counts as a
// flag for chording. Every deferred step now checks board identity, and
// handleLoss's modal-show checks the status is still 'lost'.

import './domShim.mjs';
import { makeStateBoard } from './domShim.mjs';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const { state } = await import('../src/state/gameState.js');
const { setMuted } = await import('../src/audio/sounds.js');
const { chainRevealMines } = await import('../src/ui/effectsRenderer.js');

setMuted(true); // no AudioContext in node

function startCascade() {
  state.rows = 2; state.cols = 2;
  state.status = 'lost';
  state.hitMine = { row: 0, col: 0 };
  state.board = makeStateBoard(2, 2, [[0, 0], [1, 1]]);
  const original = state.board;
  const promise = chainRevealMines(0, 0);
  return { original, promise };
}

test('control: an undisturbed cascade stamps isStrike on its own board', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { original } = startCascade();
    mock.timers.tick(10_000);
    assert.equal(original[0][0].isStrike, true);
    assert.equal(original[1][1].isStrike, true);
  } finally {
    mock.timers.reset();
  }
});

test('REGRESSION: a restart mid-cascade leaves the NEW board untouched', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { original } = startCascade();
    // Simulate newGame() racing the cascade: fresh board, fresh status.
    const fresh = makeStateBoard(2, 2, [[0, 0], [1, 1]]);
    state.board = fresh;
    state.status = 'idle';
    mock.timers.tick(10_000);
    for (const row of fresh) {
      for (const cell of row) {
        assert.equal(cell.isStrike, false,
          `fresh board cell ${cell.row},${cell.col} must carry no phantom strike`);
      }
    }
    // The abandoned board may keep partial strikes (harmless — it is
    // unreachable), but the hit mine fired before the swap in real play;
    // what matters is the fresh board's purity above and that the original
    // was the only mutation target before the swap.
    assert.equal(original[0][0].isStrike, false,
      'no timeout ran before the swap in this simulation');
  } finally {
    mock.timers.reset();
  }
});
