// usedPowerUps (the purist-feat flag) is stamped where a charge is SPENT,
// never on an arm/disarm toggle (2026-07-11 audit): arming Scan and tapping
// it off again consumes nothing, but the old activate* toggles set
// usedPowerUps anyway — a purist run lost its feat to a mis-tap.

import './domShim.mjs';
import { makeStateBoard } from './domShim.mjs';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const { state } = await import('../src/state/gameState.js');
const { setMuted } = await import('../src/audio/sounds.js');
const { activateScan, performScan, activateMagnet, activateXRay } = await import('../src/game/powerUpActions.js');

setMuted(true);

function freshState() {
  state.status = 'playing';
  state.gameMode = 'normal';
  state.rows = 2; state.cols = 2;
  state.board = makeStateBoard(2, 2, [[1, 1]]);
  state.powerUps = { revealSafe: 0, shield: 0, lifeline: 0, scanRowCol: 2, magnet: 1, xray: 1 };
  state.usedPowerUps = false;
  state.scanMode = false;
  state.magnetMode = false;
  state.xrayMode = false;
}

test('REGRESSION: arming then disarming a mode power-up keeps the purist flag', () => {
  freshState();
  activateScan();
  assert.equal(state.scanMode, true);
  assert.equal(state.usedPowerUps, false, 'arming spends nothing');
  activateScan(); // toggle back off
  assert.equal(state.scanMode, false);
  assert.equal(state.usedPowerUps, false, 'disarming without use must not strip the purist feat');

  activateMagnet();
  activateMagnet();
  assert.equal(state.usedPowerUps, false, 'magnet arm/disarm spends nothing');

  activateXRay();
  activateXRay();
  assert.equal(state.usedPowerUps, false, 'x-ray arm/disarm spends nothing');
});

test('actually spending the charge stamps usedPowerUps', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    freshState();
    activateScan();
    performScan(0, 0);
    assert.equal(state.usedPowerUps, true, 'the spend is what breaks purist');
    assert.equal(state.powerUps.scanRowCol, 1, 'the charge was consumed');
    mock.timers.tick(5000); // drain the scan-highlight cleanup timer
  } finally {
    mock.timers.reset();
  }
});
