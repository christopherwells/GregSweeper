// Software-renderer detection. Pins the string match that decides whether the
// per-frame theme particle effects are skipped, so a real GPU never loses its
// effects and a software rasterizer always does (the weaker-device perf gate).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSoftwareRenderer } from '../src/logic/deviceCapability.js';

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
