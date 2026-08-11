// Issue #285: a Climb draw that exhausts left a persistable husk, kept the
// win card up, and let Next Level skip the level while banking its
// checkpoint.
//
// The challenge branch of newGame bailed with a bare `return` while the
// daily branch eleven lines down spelled out the abort contract: stamp
// 'aborted' (persistGameState refuses it, revealCell refuses it), clear
// the mode's own slot, toast, return to the title. The fix is ONE shared
// helper (abortModeStart) so a third mode cannot drift the same way, plus
// two handler repairs: the Next Level card dismisses itself instead of
// relying on newGame's tail (which an aborted draw never runs), and the
// checkpoint is banked only after a board actually exists for the level
// being entered.
//
// The branch itself cannot be forced headless (validator-proven specs make
// a real null draw a 3-salt coincidence), so the helper is call-tested
// directly and the call sites are held by source scan, the
// saveSlotOwnership precedent.

import './domShim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const gaSrc = readFileSync(new URL('../src/game/gameActions.js', import.meta.url), 'utf8');
const mainSrc = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

test('REGRESSION: the challenge draw-exhausted branch aborts like the daily', () => {
  const at = gaSrc.indexOf('draw exhausted');
  assert.ok(at >= 0, 'the exhausted branch exists');
  const branch = gaSrc.slice(at);
  const upToReturn = branch.slice(0, branch.indexOf('return;'));
  assert.match(upToReturn, /abortModeStart\(/,
    'the challenge exhausted branch must route through the shared abort (issue #285)');
});

test('one abort contract: only the shared helper stamps aborted', () => {
  const writes = [...gaSrc.matchAll(/state\.status = 'aborted'/g)];
  assert.equal(writes.length, 1,
    'a second hand-written abort is how the challenge branch drifted; call abortModeStart');
});

test('REGRESSION: Next Level dismisses its own card and banks only after the board exists', () => {
  const at = mainSrc.indexOf("$('#gameover-nextlevel')");
  assert.ok(at >= 0, 'the handler exists');
  const rest = mainSrc.slice(at);
  const handler = rest.slice(0, rest.indexOf('\n});') + 4);
  assert.match(handler, /hideModal\('gameover-overlay'\)/,
    'the card must dismiss itself, not rely on newGame’s tail, which an aborted draw never runs');
  const drawAt = handler.indexOf('await newGame()');
  const bankAt = handler.indexOf('saveCheckpoint');
  assert.ok(drawAt >= 0, 'the handler must await the draw before committing anything');
  assert.ok(bankAt > drawAt,
    'saveCheckpoint must come AFTER the draw: banking first is how L60 banked a level never played');
  assert.match(handler, /'aborted'/,
    'an aborted draw must stop the banking');
});

test('abortModeStart clears the slot and stamps a status persist refuses', async () => {
  const { state } = await import('../src/state/gameState.js');
  const { abortModeStart } = await import('../src/game/gameActions.js');
  const { persistGameState } = await import('../src/game/gamePersistence.js');
  const { saveGameState, loadGameState } = await import('../src/storage/statsStorage.js');

  // A husk-able state: mid-session challenge with a real save in the slot.
  state.gameMode = 'normal';
  state.status = 'idle';
  state.currentLevel = 60;
  state.rows = 5; state.cols = 6;
  state.board = [[{ row: 0, col: 0 }]];
  saveGameState({ gameMode: 'normal', currentLevel: 59, sentinel: true });
  assert.ok(loadGameState('challenge'), 'precondition: the slot holds a save');

  abortModeStart(state.gameMode, 'test abort');

  assert.equal(state.status, 'aborted', 'the abort stamps the one status persist refuses');
  assert.equal(loadGameState('challenge'), null,
    'the mode’s own slot is cleared so nothing already on disk resumes as a husk');

  persistGameState();
  assert.equal(loadGameState('challenge'), null,
    'persistGameState refuses an aborted game, so pagehide cannot write the husk back');
});
