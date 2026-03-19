import { safeGet, safeSet, safeGetJSON, safeSetJSON } from '../storage/storageAdapter.js';
/**
 * Collection Manager — emoji packs, effects, and titles
 * Handles unlock logic and localStorage persistence.
 */

import { loadStats } from '../storage/statsStorage.js';

// ── Emoji Packs ──────────────────────────────────────

export const EMOJI_PACKS = {
  default:  { name: 'Default',  mine: '💣', flag: '🚩', smiley: '😊', smileyWin: '😎', smileyLoss: '😵', unlock: null },
  pirate:   { name: 'Pirate',   mine: '💀', flag: '🏴‍☠️', smiley: '🦜', smileyWin: '🏴‍☠️', smileyLoss: '☠️', unlock: { type: 'level', value: 10 } },
  space:    { name: 'Space',    mine: '☄️', flag: '🛰️', smiley: '👨‍🚀', smileyWin: '🚀', smileyLoss: '💥', unlock: { type: 'level', value: 20 } },
  garden:   { name: 'Garden',   mine: '🐛', flag: '🌱', smiley: '🌻', smileyWin: '🌸', smileyLoss: '🥀', unlock: { type: 'level', value: 30 } },
  ocean:    { name: 'Ocean',    mine: '🦈', flag: '⚓', smiley: '🐠', smileyWin: '🐬', smileyLoss: '🫧', unlock: { type: 'level', value: 40 } },
  medieval: { name: 'Medieval', mine: '🐉', flag: '⚔️', smiley: '🛡️', smileyWin: '👑', smileyLoss: '💀', unlock: { type: 'level', value: 50 } },
  holiday:  { name: 'Holiday',  mine: '🎁', flag: '🎄', smiley: '🎅', smileyWin: '⭐', smileyLoss: '☃️', unlock: { type: 'level', value: 60 } },
};

// ── Effects ──────────────────────────────────────────

export const EFFECTS = {
  particles: {
    confetti:  { name: 'Confetti',  unlock: null },
    sparkles:  { name: 'Sparkles',  unlock: { type: 'level', value: 15 } },
    fire:      { name: 'Fire',      unlock: { type: 'level', value: 35 } },
    snow:      { name: 'Snow',      unlock: { type: 'level', value: 55 } },
    hearts:    { name: 'Hearts',    unlock: { type: 'level', value: 75 } },
  },
  borders: {
    none:    { name: 'None',    unlock: null },
    glow:    { name: 'Glow',    unlock: { type: 'level', value: 10 } },
    pulse:   { name: 'Pulse',   unlock: { type: 'level', value: 25 } },
    rainbow: { name: 'Rainbow', unlock: { type: 'level', value: 45 } },
  },
  reveals: {
    pop:    { name: 'Pop',    unlock: null },
    flip:   { name: 'Flip',   unlock: { type: 'level', value: 20 } },
    fade:   { name: 'Fade',   unlock: { type: 'level', value: 40 } },
    slide:  { name: 'Slide',  unlock: { type: 'level', value: 65 } },
    spiral: { name: 'Spiral', unlock: { type: 'level', value: 85 } },
  },
};

// ── Titles ───────────────────────────────────────────

export const TITLES = {
  rookie:         { name: 'Rookie',           unlock: null },
  mineWhisperer:  { name: 'Mine Whisperer',   unlock: { type: 'level', value: 10 } },
  bombDefuser:    { name: 'Bomb Defuser',     unlock: { type: 'level', value: 25 } },
  speedDemon:     { name: 'Speed Demon',      unlock: { type: 'level', value: 40 } },
  gimmickMaster:  { name: 'Modifier Master',   unlock: { type: 'level', value: 60 } },
  gregsChampion:  { name: "Greg's Champion",  unlock: { type: 'level', value: 80 } },
  legendary:      { name: 'Legendary',        unlock: { type: 'level', value: 100 } },
};

// ── Unlock Checks ────────────────────────────────────

function getMaxLevel() {
  const stats = loadStats();
  return stats.maxLevelReached || 1;
}

function isUnlocked(unlockReq) {
  if (!unlockReq) return true;
  if (unlockReq.type === 'level') return getMaxLevel() >= unlockReq.value;
  return false;
}

export function isPackUnlocked(packId) {
  const pack = EMOJI_PACKS[packId];
  return pack ? isUnlocked(pack.unlock) : false;
}

export function isEffectUnlocked(category, effectId) {
  const effect = EFFECTS[category]?.[effectId];
  return effect ? isUnlocked(effect.unlock) : false;
}

export function isTitleUnlocked(titleId) {
  const title = TITLES[titleId];
  return title ? isUnlocked(title.unlock) : false;
}

// ── Emoji Pack Persistence ───────────────────────────

export function loadEmojiPack() {
  try {
    return safeGet('minesweeper_emoji_pack') || 'default';
  } catch { return 'default'; }
}

export function saveEmojiPack(packId) {
  safeSet('minesweeper_emoji_pack', packId);
}

export function getActiveEmojiPack() {
  const id = loadEmojiPack();
  return EMOJI_PACKS[id] || EMOJI_PACKS.default;
}

// ── Effects Persistence ──────────────────────────────

const DEFAULT_EFFECTS = { particles: 'confetti', borders: 'none', reveals: 'pop' };

export function loadEffects() {
  try {
    const raw = safeGet('minesweeper_effects');
    if (!raw) return { ...DEFAULT_EFFECTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_EFFECTS, ...parsed };
  } catch { return { ...DEFAULT_EFFECTS }; }
}

export function saveEffects(effects) {
  safeSetJSON('minesweeper_effects', effects);
}

// ── Title Persistence ────────────────────────────────

export function loadTitle() {
  try {
    return safeGet('minesweeper_title') || 'rookie';
  } catch { return 'rookie'; }
}

export function saveTitle(titleId) {
  safeSet('minesweeper_title', titleId);
}
