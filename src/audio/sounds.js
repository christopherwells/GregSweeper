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
  localStorage.setItem(MUTE_KEY, val ? '1' : '0');
  // Propagate mute state to music and SFX gain nodes
  updateMusicGainValue();
  updateSFXGainValue();
}

export function loadMuted() {
  muted = localStorage.getItem(MUTE_KEY) === '1';
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
  gain.gain.setValueAtTime(volume, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + duration);
}

export function playReveal() {
  playTone(600, 0.06, 'square', 0.08);
}

export function playFlag() {
  vibrate(15);
  playTone(800, 0.08, 'triangle', 0.1);
  setTimeout(() => playTone(1000, 0.06, 'triangle', 0.08), 50);
}

export function playUnflag() {
  playTone(500, 0.06, 'triangle', 0.08);
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
  gain.gain.setValueAtTime(0.2, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.5);
}

export function playCascade(count) {
  if (muted) return;
  // Quick ascending blips for flood-fill
  const steps = Math.min(count, 8);
  for (let i = 0; i < steps; i++) {
    setTimeout(() => playTone(400 + i * 80, 0.04, 'sine', 0.05), i * 30);
  }
}

export function playWin() {
  vibrate([30, 50, 30, 50, 100]);
  if (muted) return;
  const notes = [523, 659, 784, 1047]; // C5, E5, G5, C6
  notes.forEach((freq, i) => {
    setTimeout(() => playTone(freq, 0.2, 'square', 0.1), i * 120);
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
  gain.gain.setValueAtTime(0.08, ctx.currentTime);
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
  gain.gain.setValueAtTime(0.08, ctx.currentTime);
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

// ══════════════════════════════════════════════════════════
// ── Dynamic Background Music System ─────────────────────
// ══════════════════════════════════════════════════════════

const AUDIO_SETTINGS_KEY = 'minesweeper_audio_settings';

// ── Volume state ─────────────────────────────────────────
let musicVolume = 50;   // 0-100
let sfxVolume   = 100;  // 0-100

// ── Music state ──────────────────────────────────────────
let musicGainNode    = null;
let sfxGainNode      = null;
let musicPlaying     = false;
let musicSchedulerId = null;
let currentIntensity = 0; // 0-1
let activeLayers     = { melody: null, bass: null, harmony: null, percussion: null };

// ── Note frequency lookup ────────────────────────────────
const NOTE_FREQ = {
  C3: 130.81, D3: 146.83, E3: 164.81, F3: 174.61, G3: 196.00, A3: 220.00, B3: 246.94,
  C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.00, A4: 440.00, B4: 493.88,
  C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99,
};

// ── Melody definition (~8 seconds, 4 bars at ~120 BPM) ──
// Each note: [noteName, durationInBeats] — 1 beat = 0.5s
const MELODY_PATTERN = [
  ['E4', 1], ['G4', 1], ['C5', 1], ['B4', 0.5], ['A4', 0.5],
  ['G4', 1], ['E4', 1], ['D4', 1], ['C4', 1],
  ['E4', 1], ['G4', 1], ['A4', 1], ['G4', 0.5], ['E4', 0.5],
  ['D4', 1], ['E4', 1], ['C4', 2],
];

const BASS_PATTERN = [
  ['C3', 2], ['G3', 2],
  ['A3', 2], ['E3', 2],
  ['C3', 2], ['F3', 2],
  ['G3', 2], ['C3', 2],
];

const HARMONY_PATTERN = [
  ['G4', 2], ['E5', 2],
  ['C5', 2], ['B4', 2],
  ['G4', 2], ['A4', 2],
  ['B4', 2], ['G4', 2],
];

// Percussion: [freq, durationBeats, type] — uses short noise-like tones
const PERC_PATTERN = [
  [200, 0.25], [null, 0.25], [800, 0.25], [null, 0.25],
  [200, 0.25], [null, 0.25], [800, 0.25], [200, 0.25],
  [200, 0.25], [null, 0.25], [800, 0.25], [null, 0.25],
  [200, 0.25], [200, 0.25], [800, 0.25], [200, 0.25],
];

const BASE_BEAT_DURATION = 0.5; // seconds per beat at base tempo
const LOOP_BEATS = 16;          // total beats in a loop

// ── Gain node helpers ────────────────────────────────────

function getMusicGain() {
  if (!musicGainNode) {
    const ctx = getCtx();
    musicGainNode = ctx.createGain();
    musicGainNode.connect(ctx.destination);
  }
  updateMusicGainValue();
  return musicGainNode;
}

function getSFXGain() {
  if (!sfxGainNode) {
    const ctx = getCtx();
    sfxGainNode = ctx.createGain();
    sfxGainNode.connect(ctx.destination);
  }
  updateSFXGainValue();
  return sfxGainNode;
}

function updateMusicGainValue() {
  if (musicGainNode) {
    const effective = muted ? 0 : (musicVolume / 100) * 0.12;
    musicGainNode.gain.setTargetAtTime(effective, getCtx().currentTime, 0.05);
  }
}

function updateSFXGainValue() {
  if (sfxGainNode) {
    const effective = muted ? 0 : (sfxVolume / 100);
    sfxGainNode.gain.setTargetAtTime(effective, getCtx().currentTime, 0.05);
  }
}

// ── Layer scheduling ─────────────────────────────────────

function scheduleLayer(pattern, startTime, beatDur, destination, oscType, volume) {
  const ctx = getCtx();
  const nodes = [];
  let t = startTime;

  for (const entry of pattern) {
    const isPerc = typeof entry[0] === 'number' || entry[0] === null;
    const freq = isPerc ? entry[0] : (entry[0] ? NOTE_FREQ[entry[0]] : null);
    const beats = isPerc ? entry[1] : entry[1];
    const dur = beats * beatDur;

    if (freq) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = oscType;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(volume, t);
      gain.gain.setValueAtTime(volume, t + dur * 0.8);
      gain.gain.linearRampToValueAtTime(0, t + dur * 0.95);
      osc.connect(gain);
      gain.connect(destination);
      osc.start(t);
      osc.stop(t + dur);
      nodes.push(osc);
    }
    t += dur;
  }
  return nodes;
}

function schedulePercLayer(pattern, startTime, beatDur, destination) {
  const ctx = getCtx();
  const nodes = [];
  let t = startTime;

  for (const [freq, beats] of pattern) {
    const dur = beats * beatDur;
    if (freq) {
      const bufferSize = ctx.sampleRate * 0.05;
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
      }

      const noise = ctx.createBufferSource();
      noise.buffer = buffer;

      const bandpass = ctx.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.value = freq;
      bandpass.Q.value = 1.5;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.3, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);

      noise.connect(bandpass);
      bandpass.connect(gain);
      gain.connect(destination);
      noise.start(t);
      noise.stop(t + 0.06);
      nodes.push(noise);
    }
    t += dur;
  }
  return nodes;
}

// ── Core music loop scheduler ────────────────────────────

function scheduleLoop() {
  if (!musicPlaying) return;

  resumeCtx();
  const ctx = getCtx();
  const dest = getMusicGain();
  const tempoMultiplier = currentIntensity >= 0.75 ? 0.9 : 1.0;
  const beatDur = BASE_BEAT_DURATION * tempoMultiplier;
  const loopDuration = LOOP_BEATS * beatDur;
  const startTime = ctx.currentTime + 0.05; // tiny buffer to avoid glitches

  // Clean up previous layer references
  activeLayers.melody = null;
  activeLayers.bass = null;
  activeLayers.harmony = null;
  activeLayers.percussion = null;

  // Layer 1: Melody (always on)
  activeLayers.melody = scheduleLayer(
    MELODY_PATTERN, startTime, beatDur, dest, 'square', 0.4
  );

  // Layer 2: Bass line (25%+)
  if (currentIntensity >= 0.25) {
    activeLayers.bass = scheduleLayer(
      BASS_PATTERN, startTime, beatDur, dest, 'triangle', 0.3
    );
  }

  // Layer 3: Harmony (50%+)
  if (currentIntensity >= 0.50) {
    activeLayers.harmony = scheduleLayer(
      HARMONY_PATTERN, startTime, beatDur, dest, 'sine', 0.15
    );
  }

  // Layer 4: Percussion (75%+)
  if (currentIntensity >= 0.75) {
    activeLayers.percussion = schedulePercLayer(
      PERC_PATTERN, startTime, beatDur, dest
    );
  }

  // Schedule next loop
  const nextLoopMs = loopDuration * 1000;
  musicSchedulerId = setTimeout(scheduleLoop, nextLoopMs - 100);
}

// ── Public API ───────────────────────────────────────────

export function startMusic() {
  if (musicPlaying) return;
  musicPlaying = true;
  currentIntensity = 0;
  resumeCtx();
  getMusicGain(); // ensure gain node exists
  scheduleLoop();
}

export function stopMusic() {
  musicPlaying = false;
  if (musicSchedulerId !== null) {
    clearTimeout(musicSchedulerId);
    musicSchedulerId = null;
  }
  // Let any currently-playing oscillators finish naturally (they have stop times).
  // Clear layer references.
  activeLayers.melody = null;
  activeLayers.bass = null;
  activeLayers.harmony = null;
  activeLayers.percussion = null;
  currentIntensity = 0;
}

export function setMusicIntensity(progress) {
  // Clamp 0-1
  currentIntensity = Math.max(0, Math.min(1, progress));
  // Layer changes take effect on the next scheduled loop iteration.
}

export function setMusicVolume(vol) {
  musicVolume = Math.max(0, Math.min(100, vol));
  updateMusicGainValue();
  saveAudioSettings();
}

export function getMusicVolume() {
  return musicVolume;
}

export function setSFXVolume(vol) {
  sfxVolume = Math.max(0, Math.min(100, vol));
  updateSFXGainValue();
  saveAudioSettings();
}

export function getSFXVolume() {
  return sfxVolume;
}

// ── Persistence ──────────────────────────────────────────

function saveAudioSettings() {
  try {
    localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify({
      musicVolume,
      sfxVolume,
    }));
  } catch (_) { /* localStorage unavailable */ }
}

export function loadAudioSettings() {
  try {
    const raw = localStorage.getItem(AUDIO_SETTINGS_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (typeof data.musicVolume === 'number') musicVolume = Math.max(0, Math.min(100, data.musicVolume));
      if (typeof data.sfxVolume === 'number')   sfxVolume   = Math.max(0, Math.min(100, data.sfxVolume));
    }
  } catch (_) { /* parse error or localStorage unavailable */ }
}

// Load settings on module initialization
loadAudioSettings();
