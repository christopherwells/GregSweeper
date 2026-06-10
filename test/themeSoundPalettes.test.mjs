// Theme sound palettes: shape, loudness discipline, and key integrity.
// A palette under a key that doesn't match a THEME_UNLOCKS entry silently
// never fires (the sakura confetti palette sat dead under its pre-rename
// 'cherry-blossom' key for weeks) — so key membership is a hard check.
//
// Run: node --test test/themeSoundPalettes.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { THEME_SOUND_PALETTES } from '../src/audio/sounds.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const themeManagerSrc = readFileSync(
  join(__dirname, '..', 'src', 'ui', 'themeManager.js'), 'utf8',
);

const OSC_TYPES = new Set(['sine', 'square', 'triangle', 'sawtooth']);
const MAX_TONE_VOL = 0.12;  // matches the loudest default-synth moment
const CASCADE_STEPS = 8;    // playCascade caps at 8 blips

function checkTone(theme, moment, t, i) {
  assert.ok(Number.isFinite(t.freq) && t.freq >= 60 && t.freq <= 4200,
    `${theme}.${moment}[${i}]: freq ${t.freq} out of audible-comfort range`);
  assert.ok(Number.isFinite(t.dur) && t.dur > 0 && t.dur <= 0.5,
    `${theme}.${moment}[${i}]: dur ${t.dur} out of range`);
  assert.ok(OSC_TYPES.has(t.type), `${theme}.${moment}[${i}]: bad oscillator type ${t.type}`);
  assert.ok(Number.isFinite(t.vol) && t.vol > 0 && t.vol <= MAX_TONE_VOL,
    `${theme}.${moment}[${i}]: vol ${t.vol} out of range`);
  if (t.delay !== undefined) {
    assert.ok(Number.isInteger(t.delay) && t.delay > 0 && t.delay <= 300,
      `${theme}.${moment}[${i}]: delay ${t.delay} out of range`);
  }
}

test('every palette key is a real THEME_UNLOCKS theme (no silent dead palettes)', () => {
  for (const key of Object.keys(THEME_SOUND_PALETTES)) {
    const pattern = new RegExp(`^\\s*(?:'${key}'|"${key}"|${key})\\s*:`, 'm');
    assert.ok(pattern.test(themeManagerSrc),
      `palette key "${key}" not found as a property in themeManager.js — it would never fire`);
  }
});

test('classic deliberately keeps the default synth voice', () => {
  assert.ok(!('classic' in THEME_SOUND_PALETTES),
    'classic must stay paletteless — the default synth is its identity');
});

test('all 25 non-classic themes have a palette', () => {
  // 26 themes minus classic. If a theme is added or renamed this count
  // moves and the key-membership test above localizes the mismatch.
  assert.equal(Object.keys(THEME_SOUND_PALETTES).length, 25);
});

test('palette shapes, loudness ceilings, and cascade positivity', () => {
  for (const [theme, p] of Object.entries(THEME_SOUND_PALETTES)) {
    assert.ok(Array.isArray(p.reveal) && p.reveal.length >= 1 && p.reveal.length <= 2,
      `${theme}: reveal must be 1-2 tones (it fires constantly)`);
    p.reveal.forEach((t, i) => checkTone(theme, 'reveal', t, i));
    for (const t of p.reveal) {
      assert.ok(t.vol <= 0.09, `${theme}: reveal vol ${t.vol} too loud for the highest-frequency moment`);
    }

    assert.ok(Array.isArray(p.flag) && p.flag.length >= 1 && p.flag.length <= 3,
      `${theme}: flag must be 1-3 tones`);
    p.flag.forEach((t, i) => checkTone(theme, 'flag', t, i));

    const c = p.cascade;
    assert.ok(c && Number.isFinite(c.base) && c.base > 0, `${theme}: cascade.base`);
    assert.ok(Number.isFinite(c.step), `${theme}: cascade.step`);
    assert.ok(OSC_TYPES.has(c.type), `${theme}: cascade.type`);
    const lastFreq = c.base + (CASCADE_STEPS - 1) * c.step;
    assert.ok(lastFreq >= 60 && lastFreq <= 4200,
      `${theme}: cascade runs to ${lastFreq} Hz at step 8 — descending palettes must stay audible`);
    if (c.vol !== undefined) {
      assert.ok(c.vol > 0 && c.vol <= 0.06, `${theme}: cascade.vol ${c.vol} out of range`);
    }

    const w = p.win;
    assert.ok(w && Array.isArray(w.notes) && w.notes.length >= 3 && w.notes.length <= 6,
      `${theme}: win needs 3-6 notes`);
    for (const n of w.notes) {
      assert.ok(Number.isFinite(n) && n >= 60 && n <= 4200, `${theme}: win note ${n}`);
    }
    assert.ok(OSC_TYPES.has(w.type), `${theme}: win.type`);
    assert.ok(w.dur > 0 && w.dur <= 0.5, `${theme}: win.dur`);
    if (w.vol !== undefined) {
      assert.ok(w.vol > 0 && w.vol <= 0.1, `${theme}: win.vol ${w.vol} out of range`);
    }
    // Sawtooth is harmonically rich — its wins must not ride the 0.1 default.
    if (w.type === 'sawtooth') {
      assert.ok(w.vol !== undefined && w.vol <= 0.08,
        `${theme}: sawtooth win must set vol <= 0.08 (default 0.1 is too loud for saw)`);
    }
    if (c.type === 'sawtooth') {
      assert.ok(c.vol !== undefined && c.vol <= 0.05,
        `${theme}: sawtooth cascade must set vol <= 0.05`);
    }
  }
});

test('voice distinctness: no two palettes are close on EVERY salient axis', () => {
  // Two voices collide only when they are near-identical across all of:
  // reveal timbre, reveal register (within 0.4 octave), reveal tone
  // count, reveal attack length, flag direction, and flag ending timbre.
  // Differing on ANY axis is enough to read as a different voice — the
  // gate forces future palettes to claim an unoccupied corner.
  const entries = Object.entries(THEME_SOUND_PALETTES);
  const flagDir = (f) => f.length < 2 ? 'single'
    : f[f.length - 1].freq > f[0].freq ? 'up'
    : f[f.length - 1].freq < f[0].freq ? 'down' : 'flat';

  for (let a = 0; a < entries.length; a++) {
    for (let b = a + 1; b < entries.length; b++) {
      const [tA, pA] = entries[a];
      const [tB, pB] = entries[b];
      const rA = pA.reveal[0], rB = pB.reveal[0];
      const similar =
        rA.type === rB.type
        && Math.abs(Math.log2(rA.freq / rB.freq)) < 0.4
        && pA.reveal.length === pB.reveal.length
        && Math.abs(rA.dur - rB.dur) < 0.03
        && flagDir(pA.flag) === flagDir(pB.flag)
        && pA.flag[pA.flag.length - 1].type === pB.flag[pB.flag.length - 1].type;
      assert.ok(!similar,
        `${tA} and ${tB} are near-identical on every voice axis — differentiate one`);
    }
  }
});
