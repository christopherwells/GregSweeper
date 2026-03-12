import { safeGet, safeSet, safeGetJSON, safeSetJSON } from '../storage/storageAdapter.js?v=1.0.8';
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
