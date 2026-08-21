// The frame probe runs on TEST BUILDS ONLY (his ruling 2026-08-21: "This seems
// like something that should only be on the test branch so that others aren't
// bothered by it"). It is an instrument for one investigation, and it is a
// permanent animation-frame loop on every board, so the cost is real for every
// player even though nothing is drawn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  armFrameProbe, startFrameProbe, setFrameContext, frameProbeReport, resetFrameProbe,
} = await import('../src/logic/frameProbe.js');

test('an UNARMED probe is inert and says so', () => {
  armFrameProbe(false);
  resetFrameProbe();

  // Every entry point must be safe to call on a production build.
  setFrameContext({ shape: 'hex', cells: 120, action: 'reveal:37' });
  startFrameProbe();

  const r = frameProbeReport();
  assert.equal(r.armed, false, 'a production build reports itself unarmed');
  // NOT empty stats: "frames: 0, worst: []" would read as "measured, found no
  // jank", which is a different and misleading claim from "never measured".
  assert.equal(r.frames, undefined, 'an unarmed report must not fake a measurement');
  assert.ok(typeof r.note === 'string' && r.note.length > 0, 'and must explain itself');
});

test('arming is what turns it on, and disarming stops it', () => {
  armFrameProbe(true);
  resetFrameProbe();
  const r = frameProbeReport();
  assert.equal(r.armed, true);
  assert.equal(r.frames, 0, 'armed but not yet sampled');
  assert.ok(Array.isArray(r.worst), 'and carries the worst-frame ring');

  armFrameProbe(false);
  assert.equal(frameProbeReport().armed, false, 'disarming reverts it to inert');
});

test('the renderer arms it ONLY behind isTestEnvironment', () => {
  const src = readFileSync(new URL('../src/ui/boardRenderer.js', import.meta.url), 'utf8');
  const idxGate = src.indexOf('isTestEnvironment()');
  const idxArm = src.indexOf('armFrameProbe(true)');
  assert.ok(idxGate > 0, 'the renderer must consult the test-environment gate');
  assert.ok(idxArm > idxGate && idxArm - idxGate < 400,
    'arming must sit inside the test-environment branch, not beside it');
  // NON-VACUITY: the gate has to be reachable from the render path at all.
  assert.match(src, /export function renderBoard\(\)/);
  // And nothing may arm it unconditionally somewhere else.
  assert.equal((src.match(/armFrameProbe\(/g) || []).length, 1,
    'exactly one arming site, or the gate can be bypassed');
});
