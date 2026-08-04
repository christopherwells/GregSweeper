// ── Coastline tiling-practice routing flags (Coastline) ────────────────────
//
// The ?coastline= deep link sets a small group of state flags that route
// newGame into the tiling branch. Two wiring bugs were fixed together here
// (found by the hex-tiling adversarial review, 2026-07-22):
//
//   1. FIELD DRIFT. switchMode cleared these flags but the checkpoint-selector
//      entry path (which bypasses switchMode) cleared only some of them — when
//      `coastlineType` was added it was NOT added to the checkpoint path, so a
//      real checkpoint run could inherit a tiling practice and record a
//      challenge run on a test board. Fixed by routing BOTH paths through the
//      single clearCoastlinePractice(), and pinned below by deriving the flag
//      set from `state` itself so a newly-added coastline field fails this test
//      until the reset covers it.
//
//   2. EMPTY MODIFIER BAR. newGame wiped activeGimmicks for every non-
//      daily/weekly mode, running AFTER the coastline branch had set them, so a
//      tiling board's active-modifier bar rendered empty. modifiersPreResolved
//      is the extracted predicate that guards the wipe.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { state, clearCoastlinePractice, modifiersPreResolved } from '../src/state/gameState.js';

// Every state key that names a coastline routing flag. Derived from the live
// state object so the guard tracks the real field set, not a hand-copied list.
function coastlineKeys() {
  return Object.keys(state).filter(k => /^coastline/i.test(k));
}

test('the coastline flag group is exactly the fields the router reads', () => {
  // A tripwire: if a coastline* field is added or renamed, this reminds the
  // author that BOTH the default and the reset must cover it.
  assert.deepEqual(
    coastlineKeys().slice().sort(),
    ['coastlineFeatures', 'coastlineGimmicks', 'coastlinePar', 'coastlinePractice',
      'coastlineSeed', 'coastlineType'].sort(),
  );
});

test('clearCoastlinePractice resets EVERY coastline field (field-drift guard)', () => {
  // Dirty every coastline flag as if a ?coastline=hex:sonar practice were live.
  state.coastlinePractice = true;
  state.coastlineSeed = 'hexfix-9';
  state.coastlineGimmicks = ['sonar', 'walls'];
  state.coastlineType = 'hex';
  state.coastlineFeatures = { cellCount: 63, totalMines: 13, tilingType: 'hex' };
  state.coastlinePar = 88.4;

  clearCoastlinePractice();

  // The bug was clearing SOME but not all; assert the whole group is neutral.
  // `coastlinePar` is a number, so ITS neutral value is 0 rather than null —
  // matching timedPar, whose reset is the same shape.
  for (const k of coastlineKeys()) {
    assert.ok(state[k] === false || state[k] === null || state[k] === 0,
      `clearCoastlinePractice left ${k} = ${JSON.stringify(state[k])} (a real entry path would inherit it)`);
  }
  assert.equal(state.coastlinePractice, false);
  assert.equal(state.coastlineType, null);
  // Spelled out, because the loop above would accept a null par too: a stale
  // par leaking into a real game is exactly what this guard exists to stop.
  assert.equal(state.coastlineFeatures, null);
  assert.equal(state.coastlinePar, 0);
});

test('modifiersPreResolved: pre-generated modes keep their bar, first-click modes reset', () => {
  // Daily/weekly canonical boards, coastline tiling boards, and — since the
  // Challenge 250 engine — challenge ladder boards resolve modifiers during
  // pre-generation, so newGame must NOT wipe activeGimmicks for them.
  assert.equal(modifiersPreResolved('daily', false), true);
  assert.equal(modifiersPreResolved('weekly', false), true);
  assert.equal(modifiersPreResolved('normal', true), true, 'coastline practice on a normal-mode board');
  assert.equal(modifiersPreResolved('normal', false), true, 'the C250 ladder authors + pre-draws its modifiers');

  // Timed / chaos still resolve on first click — the reset is correct.
  assert.equal(modifiersPreResolved('timed', false), false);
  assert.equal(modifiersPreResolved('chaos', false), false);

  // Coastline flag wins regardless of the (always 'normal') game mode it rides.
  assert.equal(modifiersPreResolved('chaos', true), true);
});
