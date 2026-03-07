// Web Audio API sound engine — no audio files needed
let audioCtx = null;
let muted = false;

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
  playTone(800, 0.08, 'triangle', 0.1);
  setTimeout(() => playTone(1000, 0.06, 'triangle', 0.08), 50);
}

export function playUnflag() {
  playTone(500, 0.06, 'triangle', 0.08);
}

export function playExplosion() {
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
