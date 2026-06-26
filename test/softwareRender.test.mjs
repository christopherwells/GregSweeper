// Software-renderer detection. Pins the string match that decides whether the
// per-frame theme particle effects are skipped, so a real GPU never loses its
// effects and a software rasterizer always does (the weaker-device perf gate).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSoftwareRenderer, forceEffectsEnabled } from '../src/logic/deviceCapability.js';

test('flags known software rasterizers', () => {
  assert.equal(isSoftwareRenderer('ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)'), true);
  assert.equal(isSoftwareRenderer('Google SwiftShader'), true);
  assert.equal(isSoftwareRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))'), true);
  assert.equal(isSoftwareRenderer('llvmpipe (LLVM 15.0.6, 256 bits)'), true);
  assert.equal(isSoftwareRenderer('Software Rasterizer'), true);
});

test('leaves real GPUs (including integrated) alone', () => {
  assert.equal(isSoftwareRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 2080 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)'), false);
  assert.equal(isSoftwareRenderer('ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)'), false);
  assert.equal(isSoftwareRenderer('Apple M1'), false);
  assert.equal(isSoftwareRenderer('Mali-G78'), false);
  assert.equal(isSoftwareRenderer('Adreno (TM) 650'), false);
});

test('an unknown/blocked renderer string is NOT treated as software', () => {
  // Some browsers block WEBGL_debug_renderer_info for privacy and report ''.
  // We must not punish those users (real GPU, just hidden) by dropping effects.
  assert.equal(isSoftwareRenderer(''), false);
  assert.equal(isSoftwareRenderer(null), false);
  assert.equal(isSoftwareRenderer(undefined), false);
});

// REGRESSION: theme particle effects were invisible on a desktop whose Chrome
// had dropped to software compositing (the gate suppresses them there). `?fx=1`
// is the review override that forces them back on regardless of the renderer.
function withEnv(search, initialStore, fn) {
  const store = { ...initialStore };
  const origLoc = global.location, origLS = global.localStorage;
  global.location = { search };
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  try { return { result: fn(), store }; }
  finally { global.location = origLoc; global.localStorage = origLS; }
}

test('forceEffectsEnabled: ?fx=1 enables and persists the flag', () => {
  const { result, store } = withEnv('?fx=1', {}, forceEffectsEnabled);
  assert.equal(result, true);
  assert.equal(store['minesweeper_force_effects'], '1');
});

test('forceEffectsEnabled: ?fx=0 disables and clears the flag', () => {
  const { result, store } = withEnv('?fx=0', { minesweeper_force_effects: '1' }, forceEffectsEnabled);
  assert.equal(result, false);
  assert.equal('minesweeper_force_effects' in store, false);
});

test('forceEffectsEnabled: a persisted flag stays on with no param', () => {
  assert.equal(withEnv('', { minesweeper_force_effects: '1' }, forceEffectsEnabled).result, true);
});

test('forceEffectsEnabled: off by default (no param, no flag)', () => {
  assert.equal(withEnv('', {}, forceEffectsEnabled).result, false);
});
