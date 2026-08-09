// The shape intro card must stop the clock while it is read.
//
// showGimmickIntros has always paused (gameActions.js) and resumed on close.
// showShapeIntro did NEITHER: it was paused only incidentally, when a modifier
// card happened to fire on the same board, and that card only fires when the
// board carries a modifier the player has not SEEN. So a shape-debut level
// whose modifiers are already familiar ran the clock while the player read,
// and so did every shape card for anyone who had turned modifier explainers
// off -- that toggle deliberately does not suppress shape cards.
//
// state.modalPaused is the assertion target because it is the flag resumeTimer
// itself gates on (timerManager.js: "A blocking popup owns the pause"), so it
// IS the app's representation of "a card is holding the clock".

import './domShim.mjs';
import { stubEl, makeStateBoard } from './domShim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Controlled elements: the OK button so the close handler can be invoked, and
// the modifier overlay so its open/closed state can be posed. Everything else
// falls through to the shim.
let okBtn;
let gimmickOverlayHidden = true;
globalThis.document.getElementById = (id) => {
  if (id === 'shape-intro-ok') return okBtn;
  if (id === 'gimmick-intro-overlay') {
    return { classList: { contains: (c) => (c === 'hidden' ? gimmickOverlayHidden : false) } };
  }
  return stubEl();
};

const { state } = await import('../src/state/gameState.js');
const { setMuted } = await import('../src/audio/sounds.js');
const { revealCell } = await import('../src/game/gameActions.js');

setMuted(true);

// A hex board the player has never met, with no modifiers on it at all --
// the exact case the old code left unpaused, since with no unseen modifier
// showGimmickIntros never runs and nothing else touches the clock.
function freshChallengeBoard() {
  localStorage.clear();
  okBtn = { onclick: null };
  gimmickOverlayHidden = true;
  state.status = 'idle';
  state.gameMode = 'normal';
  // Big enough, and with a mine beside the opener, that the first reveal
  // opens one numbered cell rather than cascading the board to a win --
  // winning would tear the clock down through a different path entirely.
  state.rows = 5;
  state.cols = 5;
  state.board = makeStateBoard(5, 5, [[0, 1], [3, 3]]);
  // makeStateBoard leaves every cell at adjacentMines 0, which would cascade
  // the whole board open on the first reveal and win the game immediately --
  // and a win tears the clock down through a different path entirely.
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < 5 && nc >= 0 && nc < 5 && state.board[nr][nc].isMine) n++;
        }
      }
      state.board[r][c].adjacentMines = n;
    }
  }
  state.totalMines = 2;
  // Challenge boards are pre-resolved and frozen (modifiersPreResolved is
  // true for 'normal'), so the reveal takes the frozen branch rather than
  // the generate-on-first-click one that timed and chaos use.
  state.firstClick = false;
  state.challengeSpec = { shape: 'hex' };
  state.activeGimmicks = [];
  state.modalPaused = false;
  state.isLevelPractice = false;
  state.currentLevel = 26;
}

test('REGRESSION: the shape card stops the clock while it is open', () => {
  freshChallengeBoard();

  revealCell(0, 0);

  assert.equal(state.status, 'playing', 'the reveal started the game');
  assert.equal(state.modalPaused, true,
    'a shape card the player has never seen must hold the clock while they read it');
  assert.equal(typeof okBtn.onclick, 'function', 'the card wired its close handler');
});

test('REGRESSION: closing the shape card returns the clock', () => {
  freshChallengeBoard();

  revealCell(0, 0);
  assert.equal(state.modalPaused, true);

  okBtn.onclick();

  assert.equal(state.modalPaused, false,
    'dismissing the card must release the clock it took');
});

test('closing the shape card does NOT resume while the modifier card is still up', () => {
  freshChallengeBoard();
  revealCell(0, 0);
  assert.equal(state.modalPaused, true);

  // Both cards can be open at once: the shape card shows first and paints on
  // top (it is later in index.html, same z-index), with the modifier card
  // underneath. Closing the top one must not start a clock the card behind
  // it still needs stopped -- that card's own closeIntro owns the resume.
  gimmickOverlayHidden = false;
  okBtn.onclick();

  assert.equal(state.modalPaused, true,
    'the modifier card behind this one still owns the pause');
});

test('showShapeIntro calls pauseTimer and resumeTimer', () => {
  // Belt on the behavioural tests above: modalPaused proves the flag moved,
  // this proves the timer calls that flag accompanies are actually there.
  // pauseTimer/resumeTimer are module-private imports inside gameActions, so
  // there is no seam to spy on them through.
  const src = readFileSync(new URL('../src/game/gameActions.js', import.meta.url), 'utf8');
  const start = src.indexOf('function showShapeIntro(');
  assert.ok(start > 0, 'showShapeIntro still exists');
  const body = src.slice(start, src.indexOf('\nfunction ', start + 10));
  assert.match(body, /\bpauseTimer\(\)/, 'showShapeIntro must pause the clock');
  assert.match(body, /\bresumeTimer\(\)/, 'showShapeIntro must resume it on close');
});
