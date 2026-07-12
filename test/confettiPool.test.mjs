// The shared confetti engine (2026-07-12): ONE particle pool, ONE animation
// loop. Every prior burst ran its own loop whose every frame cleared the
// full shared canvas — and the victory ceremony fires three staggered
// bursts, so overlap was guaranteed on EVERY win: earlier bursts were
// erased each frame (only the newest showed) and the first loop to finish
// hid the canvas under the bursts still flying. The pool makes overlap
// additive: bursts accumulate, and teardown waits for the LAST particle.

import './domShim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Capture animation-frame callbacks so the test drives the loop by hand.
const rafQueue = [];
globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
if (globalThis.window) globalThis.window.requestAnimationFrame = globalThis.requestAnimationFrame;

const { setMuted } = await import('../src/audio/sounds.js');
const { showConfettiBurst, buildBurstParticles, stepParticles } = await import('../src/ui/effectsRenderer.js');
setMuted(true);

test('REGRESSION: a second burst joins the running loop instead of starting a competing one', () => {
  rafQueue.length = 0;
  // Burst A: fast decay (dies within ~3 frames). decay = base + rand*0.008.
  showConfettiBurst(0.5, 0.5, 8, { decayBase: 0.5 });
  assert.equal(rafQueue.length, 1, 'first burst starts THE loop');

  // Burst B while A is mid-flight: slow decay (~55+ frames of life).
  showConfettiBurst(0.5, 0.5, 8, { decayBase: 0.01 });
  assert.equal(rafQueue.length, 1,
    'the second burst must NOT register a second loop — two loops each clearRect the shared canvas every frame, erasing each other');

  // Drive the single loop until it stops re-registering.
  let frames = 0;
  while (rafQueue.length > 0 && frames < 500) {
    const cb = rafQueue.shift();
    cb();
    frames++;
  }
  assert.ok(frames < 500, 'the loop terminates once every particle is dead');
  assert.ok(frames > 30,
    `the loop must outlive burst A's ~3 frames and keep running for burst B's slow particles (ran ${frames} frames) — the old code's first-loop-dies teardown hid the canvas mid-ceremony`);
});

test('pure pool contract: spawning into a live pool preserves the earlier burst', () => {
  const colors = ['#fff'];
  const pool = buildBurstParticles(5, 100, 100, 0.5, 0.5, colors, { decayBase: 0.01 });
  stepParticles(pool);
  stepParticles(pool);
  const before = pool.length;
  pool.push(...buildBurstParticles(5, 100, 100, 0.3, 0.5, colors, { decayBase: 0.01 }));
  assert.equal(pool.length, before + 5, 'the new burst ADDS particles; nothing is cleared');
  assert.ok(pool.slice(0, 5).every(p => p.life > 0 && p.life < 1),
    'the first burst is mid-flight (decayed but alive), untouched by the second spawn');
});

test('pure pool contract: alive stays true until the LAST particle dies', () => {
  const colors = ['#fff'];
  const pool = buildBurstParticles(3, 100, 100, 0.5, 0.5, colors, { decayBase: 0.6 }); // dead in ~2 steps
  pool.push(...buildBurstParticles(3, 100, 100, 0.5, 0.5, colors, { decayBase: 0.02 })); // ~35+ steps
  let steps = 0;
  while (stepParticles(pool) && steps < 200) steps++;
  assert.ok(steps > 10, `teardown waited for the slow burst (${steps} steps), not the first death`);
  assert.ok(pool.every(p => p.life <= 0), 'termination means every particle is spent');
});
