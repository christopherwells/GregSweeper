import { safeGet, safeSet, safeGetJSON, safeSetJSON } from '../storage/storageAdapter.js';
import { state } from '../state/gameState.js';
// Web Audio API sound engine — no audio files needed
let audioCtx = null;
let muted = false;

// Haptic feedback (mobile)
function vibrate(pattern) {
  if (!muted && navigator.vibrate) navigator.vibrate(pattern);
}

const MUTE_KEY = 'minesweeper_muted';

function getCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function resumeCtx() {
  const ctx = getCtx();
  if (ctx.state === 'suspended') ctx.resume();
}

export function isMuted() {
  return muted;
}

export function setMuted(val) {
  muted = val;
  safeSet(MUTE_KEY, val ? '1' : '0');
}

export function loadMuted() {
  muted = safeGet(MUTE_KEY) === '1';
  return muted;
}

function playTone(freq, duration, type = 'square', volume = 0.12) {
  if (muted) return;
  resumeCtx();
  const ctx = getCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  // Scale volume by SFX slider (0–100)
  const scaledVol = volume * (sfxVolume / 100);
  gain.gain.setValueAtTime(scaledVol, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + duration);
}

// ── Per-theme sound palettes ──────────────────────────
// The audio half of the per-theme objects + moments contract: a theme
// re-voices the four highest-frequency moment sounds (reveal, flag,
// cascade, win) in its own idiom. Anything not overridden falls back to
// the default synth. `classic` is deliberately paletteless — the default
// synth IS its voice, the game's original sound.
//
// Voice design rules (keep new palettes inside these):
//   - Distinctness comes from timbre x register x interval direction.
//     No two themes share all three.
//   - Reveal fires constantly: single short tone (or one quick pair),
//     vol <= 0.09. Sawtooth is harmonically loud — cap saw vols ~0.08
//     and use the optional cascade.vol / win.vol fields to pull saw
//     moments below the 0.05 / 0.1 defaults.
//   - Cascade may DESCEND (negative step; matrix rain, noir smoke) but
//     base + 7*step must stay > 0 — playCascade runs up to 8 steps.
//   - Exported for the shape/key regression test (themeSoundPalettes).
export const THEME_SOUND_PALETTES = {
  // Apothecary: glass vials — high clinks, stopper-pop sparkle.
  apothecary: {
    reveal: [{ freq: 1319, dur: 0.04, type: 'triangle', vol: 0.05 }],
    flag: [{ freq: 1568, dur: 0.06, type: 'triangle', vol: 0.06 }, { freq: 2093, dur: 0.07, type: 'triangle', vol: 0.05, delay: 50 }],
    cascade: { base: 988, step: 95, type: 'triangle' },
    win: { notes: [1047, 1319, 1760, 2093], type: 'triangle', dur: 0.22 },
  },
  // Aurora: glassy shimmer — long soft sines, wide bright intervals.
  aurora: {
    reveal: [{ freq: 1047, dur: 0.16, type: 'sine', vol: 0.05 }],
    flag: [{ freq: 1175, dur: 0.18, type: 'sine', vol: 0.06 }, { freq: 1760, dur: 0.16, type: 'sine', vol: 0.04, delay: 110 }],
    cascade: { base: 784, step: 90, type: 'sine' },
    win: { notes: [880, 1109, 1319, 1760], type: 'sine', dur: 0.45 },
  },
  // Blueprint: drafting table — precise pencil ticks, quartal win.
  blueprint: {
    reveal: [{ freq: 520, dur: 0.04, type: 'triangle', vol: 0.08 }],
    flag: [{ freq: 620, dur: 0.05, type: 'triangle', vol: 0.08 }, { freq: 930, dur: 0.05, type: 'triangle', vol: 0.06, delay: 45 }],
    cascade: { base: 440, step: 55, type: 'triangle' },
    win: { notes: [523, 698, 784, 1047], type: 'triangle', dur: 0.15 },
  },
  // Candy: bubblegum — a two-tone bubble-POP from the mid register
  // (circuitboard owns the single high square blip), saccharine sparkle.
  candy: {
    reveal: [{ freq: 740, dur: 0.03, type: 'square', vol: 0.06 }, { freq: 1175, dur: 0.04, type: 'square', vol: 0.055, delay: 30 }],
    flag: [{ freq: 1047, dur: 0.05, type: 'square', vol: 0.06 }, { freq: 1568, dur: 0.05, type: 'square', vol: 0.05, delay: 40 }],
    cascade: { base: 700, step: 130, type: 'square' },
    win: { notes: [1047, 1319, 1568, 2093], type: 'square', dur: 0.13 },
  },
  // Cartography: harbor chart — low warm sines, buoy-bell flag toll.
  cartography: {
    reveal: [{ freq: 392, dur: 0.08, type: 'sine', vol: 0.08 }],
    flag: [{ freq: 262, dur: 0.12, type: 'sine', vol: 0.09 }, { freq: 330, dur: 0.1, type: 'sine', vol: 0.07, delay: 80 }],
    cascade: { base: 330, step: 45, type: 'sine' },
    win: { notes: [262, 330, 392, 523], type: 'sine', dur: 0.3 },
  },
  // Chalkboard: felt taps on slate.
  chalkboard: {
    reveal: [{ freq: 340, dur: 0.05, type: 'sine', vol: 0.09 }],
    flag: [{ freq: 460, dur: 0.07, type: 'sine', vol: 0.1 }, { freq: 540, dur: 0.05, type: 'sine', vol: 0.07, delay: 50 }],
    cascade: { base: 260, step: 50, type: 'sine' },
    win: { notes: [392, 494, 587, 784], type: 'sine', dur: 0.25 },
  },
  // Circuit board: logic-probe blips on copper.
  circuitboard: {
    reveal: [{ freq: 880, dur: 0.03, type: 'square', vol: 0.06 }],
    flag: [{ freq: 1200, dur: 0.05, type: 'square', vol: 0.07 }, { freq: 1600, dur: 0.04, type: 'square', vol: 0.05, delay: 40 }],
    cascade: { base: 600, step: 120, type: 'square' },
    win: { notes: [659, 880, 1175, 1760], type: 'square', dur: 0.12 },
  },
  // Nest: birdsong — soft high sine whistles, a two-note chirp flag, an
  // ascending dawn-chorus win.
  nest: {
    reveal: [{ freq: 1397, dur: 0.05, type: 'sine', vol: 0.05 }],
    flag: [{ freq: 1175, dur: 0.05, type: 'sine', vol: 0.06 }, { freq: 1760, dur: 0.05, type: 'sine', vol: 0.05, delay: 40 }],
    cascade: { base: 1047, step: 120, type: 'sine' },
    win: { notes: [1047, 1319, 1568, 2093], type: 'sine', dur: 0.18 },
  },
  // Dark: hushed night — low soft sines, falling flag, minor-lift win.
  dark: {
    reveal: [{ freq: 320, dur: 0.07, type: 'sine', vol: 0.07 }],
    flag: [{ freq: 392, dur: 0.08, type: 'sine', vol: 0.08 }, { freq: 330, dur: 0.09, type: 'sine', vol: 0.06, delay: 70 }],
    cascade: { base: 220, step: 40, type: 'sine' },
    win: { notes: [330, 392, 440, 523], type: 'sine', dur: 0.3 },
  },
  // Editorial: newsroom — typebar strikes, carriage-return ding.
  editorial: {
    reveal: [{ freq: 1100, dur: 0.025, type: 'square', vol: 0.06 }],
    flag: [{ freq: 900, dur: 0.03, type: 'square', vol: 0.07 }, { freq: 1568, dur: 0.08, type: 'triangle', vol: 0.06, delay: 60 }],
    cascade: { base: 1000, step: 15, type: 'square' },
    win: { notes: [784, 784, 1175, 1568], type: 'triangle', dur: 0.18 },
  },
  // Forest: dawn chorus — two-note bird chirps, fluttering cascade.
  forest: {
    reveal: [{ freq: 988, dur: 0.03, type: 'triangle', vol: 0.045 }, { freq: 1319, dur: 0.03, type: 'triangle', vol: 0.045, delay: 25 }],
    flag: [{ freq: 1319, dur: 0.05, type: 'triangle', vol: 0.06 }, { freq: 1760, dur: 0.04, type: 'triangle', vol: 0.05, delay: 40 }],
    cascade: { base: 880, step: 110, type: 'triangle' },
    win: { notes: [784, 988, 1175, 1568], type: 'triangle', dur: 0.18 },
  },
  // Galaxy: deep space — sub-bass thrums, star-ping answered by the void.
  galaxy: {
    reveal: [{ freq: 160, dur: 0.08, type: 'sine', vol: 0.09 }],
    flag: [{ freq: 1568, dur: 0.07, type: 'sine', vol: 0.05 }, { freq: 196, dur: 0.12, type: 'sine', vol: 0.09, delay: 60 }],
    cascade: { base: 130, step: 60, type: 'sine' },
    win: { notes: [262, 392, 587, 880, 1319], type: 'sine', dur: 0.3 },
  },
  // Inferno: hellfire — low sawtooth growls, minor brass win.
  inferno: {
    reveal: [{ freq: 175, dur: 0.08, type: 'sawtooth', vol: 0.08 }],
    flag: [{ freq: 220, dur: 0.1, type: 'sawtooth', vol: 0.08 }, { freq: 165, dur: 0.12, type: 'sawtooth', vol: 0.08, delay: 70 }],
    cascade: { base: 110, step: 30, type: 'sawtooth', vol: 0.04 },
    win: { notes: [220, 262, 330, 440], type: 'sawtooth', dur: 0.3, vol: 0.08 },
  },
  // Legendary: coronation — herald sawtooth brass in rising fifths.
  legendary: {
    reveal: [{ freq: 349, dur: 0.06, type: 'sawtooth', vol: 0.06 }],
    flag: [{ freq: 440, dur: 0.08, type: 'sawtooth', vol: 0.06 }, { freq: 659, dur: 0.1, type: 'sawtooth', vol: 0.06, delay: 60 }],
    cascade: { base: 294, step: 74, type: 'sawtooth', vol: 0.04 },
    win: { notes: [392, 523, 587, 784, 988], type: 'sawtooth', dur: 0.3, vol: 0.08 },
  },
  // Matrix: digital rain — high glyph ticks, the cascade falls DOWN,
  // win is the unlock blooming major out of the green gloom.
  matrix: {
    reveal: [{ freq: 1397, dur: 0.03, type: 'square', vol: 0.045 }],
    flag: [{ freq: 740, dur: 0.05, type: 'square', vol: 0.06 }, { freq: 587, dur: 0.06, type: 'square', vol: 0.06, delay: 45 }],
    cascade: { base: 1245, step: -115, type: 'square' },
    win: { notes: [440, 554, 659, 880], type: 'square', dur: 0.2 },
  },
  // Neon: a flickering tube — same-pitch double-sputter reveal
  // (synthwave owns the single saw blip), E-major flash on the win.
  neon: {
    reveal: [{ freq: 660, dur: 0.03, type: 'sawtooth', vol: 0.045 }, { freq: 660, dur: 0.025, type: 'sawtooth', vol: 0.035, delay: 40 }],
    flag: [{ freq: 880, dur: 0.05, type: 'sawtooth', vol: 0.05 }, { freq: 1320, dur: 0.04, type: 'sawtooth', vol: 0.04, delay: 45 }],
    cascade: { base: 440, step: 100, type: 'sawtooth', vol: 0.04 },
    win: { notes: [659, 831, 988, 1319], type: 'sawtooth', dur: 0.14, vol: 0.08 },
  },
  // Noir: smoky bar — muted low triangles, everything falls; the win
  // is a jazz chord that never quite resolves.
  noir: {
    reveal: [{ freq: 294, dur: 0.07, type: 'triangle', vol: 0.07 }],
    flag: [{ freq: 349, dur: 0.09, type: 'triangle', vol: 0.08 }, { freq: 294, dur: 0.11, type: 'triangle', vol: 0.06, delay: 80 }],
    cascade: { base: 466, step: -38, type: 'triangle' },
    win: { notes: [294, 349, 415, 554], type: 'triangle', dur: 0.35 },
  },
  // Ocean: deep water — slow low sines, anchor-drop flag, tiny bubble steps.
  ocean: {
    reveal: [{ freq: 260, dur: 0.1, type: 'sine', vol: 0.08 }],
    flag: [{ freq: 330, dur: 0.1, type: 'sine', vol: 0.08 }, { freq: 196, dur: 0.14, type: 'sine', vol: 0.08, delay: 90 }],
    cascade: { base: 196, step: 36, type: 'sine' },
    win: { notes: [262, 294, 392, 466], type: 'sine', dur: 0.35 },
  },
  // Origami: paper folds — crisp triangle crease-snaps, light D-major win.
  origami: {
    reveal: [{ freq: 700, dur: 0.05, type: 'triangle', vol: 0.07 }],
    flag: [{ freq: 780, dur: 0.04, type: 'triangle', vol: 0.07 }, { freq: 1040, dur: 0.05, type: 'triangle', vol: 0.06, delay: 35 }],
    cascade: { base: 520, step: 95, type: 'triangle' },
    win: { notes: [587, 740, 880, 1175], type: 'triangle', dur: 0.2 },
  },
  // Sakura: koto plucks on the hirajoshi scale, falling to the root.
  sakura: {
    reveal: [{ freq: 523, dur: 0.07, type: 'triangle', vol: 0.07 }],
    flag: [{ freq: 659, dur: 0.08, type: 'triangle', vol: 0.07 }, { freq: 440, dur: 0.1, type: 'triangle', vol: 0.06, delay: 70 }],
    cascade: { base: 440, step: 73, type: 'triangle' },
    win: { notes: [440, 523, 659, 880], type: 'triangle', dur: 0.3 },
  },
  // Split-flap: departure board — dry mechanical double-ticks, rapid
  // near-monotone flap shuffle, and a DESCENDING PA boarding chime.
  splitflap: {
    reveal: [{ freq: 240, dur: 0.025, type: 'square', vol: 0.07 }],
    flag: [{ freq: 240, dur: 0.025, type: 'square', vol: 0.07 }, { freq: 240, dur: 0.025, type: 'square', vol: 0.07, delay: 35 }],
    cascade: { base: 220, step: 8, type: 'square' },
    win: { notes: [784, 659, 587, 523], type: 'triangle', dur: 0.3 },
  },
  // Stained glass: bell tones through colored light.
  stainedglass: {
    reveal: [{ freq: 740, dur: 0.12, type: 'triangle', vol: 0.07 }],
    flag: [{ freq: 988, dur: 0.12, type: 'triangle', vol: 0.08 }, { freq: 1319, dur: 0.1, type: 'triangle', vol: 0.06, delay: 70 }],
    cascade: { base: 523, step: 88, type: 'triangle' },
    win: { notes: [523, 659, 784, 1047], type: 'triangle', dur: 0.35 },
  },
  // Sumi-e: ink and silence — soft slow triangles, a serene min7 wash.
  sumie: {
    reveal: [{ freq: 440, dur: 0.12, type: 'triangle', vol: 0.06 }],
    flag: [{ freq: 587, dur: 0.14, type: 'triangle', vol: 0.07 }, { freq: 523, dur: 0.12, type: 'triangle', vol: 0.05, delay: 90 }],
    cascade: { base: 294, step: 66, type: 'triangle' },
    win: { notes: [294, 349, 440, 523], type: 'triangle', dur: 0.4 },
  },
  // Supernova: stellar blast — bright sawtooth zap (apothecary owns the
  // high triangle clink), charge-and-flash flag, blazing octave win.
  supernova: {
    reveal: [{ freq: 1568, dur: 0.04, type: 'sawtooth', vol: 0.04 }],
    flag: [{ freq: 988, dur: 0.06, type: 'sawtooth', vol: 0.05 }, { freq: 1976, dur: 0.08, type: 'triangle', vol: 0.05, delay: 50 }],
    cascade: { base: 660, step: 165, type: 'triangle' },
    win: { notes: [659, 988, 1319, 1976, 2637], type: 'triangle', dur: 0.2 },
  },
  // Synthwave: retrowave arps — sawtooth Cm7 climb, neon-grid pulse.
  synthwave: {
    reveal: [{ freq: 587, dur: 0.05, type: 'sawtooth', vol: 0.05 }],
    flag: [{ freq: 784, dur: 0.06, type: 'sawtooth', vol: 0.05 }, { freq: 1175, dur: 0.06, type: 'sawtooth', vol: 0.045, delay: 55 }],
    cascade: { base: 392, step: 98, type: 'sawtooth', vol: 0.04 },
    win: { notes: [523, 622, 784, 932, 1047], type: 'sawtooth', dur: 0.25, vol: 0.08 },
  },
};

function _palette() {
  return THEME_SOUND_PALETTES[state && state.theme] || null;
}

function _playSeq(seq) {
  for (const t of seq) {
    if (t.delay) setTimeout(() => playTone(t.freq, t.dur, t.type, t.vol), t.delay);
    else playTone(t.freq, t.dur, t.type, t.vol);
  }
}

export function playReveal() {
  const p = _palette();
  if (p && p.reveal) return _playSeq(p.reveal);
  playTone(600, 0.06, 'square', 0.08);
}

export function playFlag() {
  vibrate(15);
  const p = _palette();
  if (p && p.flag) return _playSeq(p.flag);
  playTone(800, 0.08, 'triangle', 0.1);
  setTimeout(() => playTone(1000, 0.06, 'triangle', 0.08), 50);
}

export function playUnflag() {
  playTone(500, 0.06, 'triangle', 0.08);
}

// Greg's Gym click-gate rejection: a soft, friendly descending "not
// yet". Deliberately quiet and unthemed — it fires often while a
// learner probes, and it must read as the board shaking its head, not
// as punishment or breakage.
export function playGateBounce() {
  playTone(220, 0.06, 'triangle', 0.06);
  setTimeout(() => playTone(185, 0.08, 'triangle', 0.05), 60);
}

export function playExplosion() {
  vibrate([50, 30, 100]);
  if (muted) return;
  resumeCtx();
  const ctx = getCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(200, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.4);
  const vol = 0.2 * (sfxVolume / 100);
  gain.gain.setValueAtTime(vol, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.5);
}

export function playCascade(count) {
  if (muted) return;
  // Quick blips for flood-fill (palettes may run them DOWNWARD via a
  // negative step). Optional palette vol keeps sawtooth cascades quiet.
  const p = _palette();
  const base = p && p.cascade ? p.cascade.base : 400;
  const step = p && p.cascade ? p.cascade.step : 80;
  const type = p && p.cascade ? p.cascade.type : 'sine';
  const vol = p && p.cascade && p.cascade.vol ? p.cascade.vol : 0.05;
  const steps = Math.min(count, 8);
  for (let i = 0; i < steps; i++) {
    setTimeout(() => playTone(base + i * step, 0.04, type, vol), i * 30);
  }
}

export function playWin() {
  vibrate([30, 50, 30, 50, 100]);
  if (muted) return;
  const p = _palette();
  const notes = p && p.win ? p.win.notes : [523, 659, 784, 1047]; // C5, E5, G5, C6
  const type = p && p.win ? p.win.type : 'square';
  const dur = p && p.win ? p.win.dur : 0.2;
  const vol = p && p.win && p.win.vol ? p.win.vol : 0.1;
  notes.forEach((freq, i) => {
    setTimeout(() => playTone(freq, dur, type, vol), i * 120);
  });
}

export function playPowerUp() {
  playTone(880, 0.1, 'sine', 0.1);
  setTimeout(() => playTone(1100, 0.15, 'sine', 0.08), 80);
}

export function playShieldBreak() {
  playTone(300, 0.15, 'sawtooth', 0.1);
  setTimeout(() => playTone(500, 0.1, 'triangle', 0.08), 100);
}

export function playLevelUp() {
  if (muted) return;
  const notes = [440, 554, 659, 880, 1047];
  notes.forEach((freq, i) => {
    setTimeout(() => playTone(freq, 0.15, 'square', 0.1), i * 100);
  });
}

// ── Dedicated Power-Up Sounds ────────────────────────

export function playLifelineSave() {
  // Dramatic rescue — ascending chord burst
  vibrate([50, 30, 80]);
  if (muted) return;
  playTone(400, 0.15, 'triangle', 0.1);
  setTimeout(() => playTone(600, 0.15, 'triangle', 0.1), 80);
  setTimeout(() => playTone(800, 0.2, 'sine', 0.08), 160);
  setTimeout(() => playTone(1200, 0.25, 'sine', 0.06), 240);
}

export function playMagnet() {
  // Magnetic hum — low pulse with ascending sweep
  vibrate([30, 20, 60]);
  if (muted) return;
  resumeCtx();
  const ctx = getCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(100, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.3);
  const vol = 0.08 * (sfxVolume / 100);
  gain.gain.setValueAtTime(vol, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.4);
  setTimeout(() => playTone(600, 0.1, 'sine', 0.06), 250);
}

export function playXRay() {
  // Electronic scan sweep
  if (muted) return;
  resumeCtx();
  const ctx = getCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(300, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.3);
  const vol = 0.08 * (sfxVolume / 100);
  gain.gain.setValueAtTime(vol, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.4);
}


export function playTimeRecord() {
  // Triumphant fanfare
  vibrate([30, 50, 30, 50, 100]);
  if (muted) return;
  const fanfare = [523, 659, 784, 1047, 1319];
  fanfare.forEach((freq, i) => {
    setTimeout(() => playTone(freq, 0.25, 'square', 0.1), i * 150);
  });
}

// ── SFX Volume Control ──────────────────────────────────

const AUDIO_SETTINGS_KEY = 'minesweeper_audio_settings';
let sfxVolume = 100; // 0-100

export function setSFXVolume(vol) {
  sfxVolume = Math.max(0, Math.min(100, vol));
  try {
    safeSetJSON(AUDIO_SETTINGS_KEY, { sfxVolume });
  } catch (_) { /* localStorage unavailable */ }
}

export function getSFXVolume() {
  return sfxVolume;
}

export function loadAudioSettings() {
  try {
    const data = safeGetJSON(AUDIO_SETTINGS_KEY, null);
    if (data && typeof data.sfxVolume === 'number') {
      sfxVolume = Math.max(0, Math.min(100, data.sfxVolume));
    }
  } catch (_) { /* parse error or localStorage unavailable */ }
}

// Load settings on module initialization
loadAudioSettings();
