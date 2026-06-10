import { $, $$ } from './domHelpers.js';
import { loadStats } from '../storage/statsStorage.js';

// ── Lazy Theme CSS Loading ────────────────────────────
// classic + dark are eagerly loaded in index.html.
// All other themes are loaded on-demand here.
const EAGER_THEMES = new Set(['classic', 'dark']);
const _loadedThemes = new Set(['classic', 'dark']);

export function loadThemeCSS(themeName) {
  if (EAGER_THEMES.has(themeName) || _loadedThemes.has(themeName)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  // In live theme-preview mode (localhost + ?previewthemes=1) the service worker
  // is bypassed and the goal is to always see the freshest CSS, so cache-bust
  // the href — otherwise the browser serves a stale cached theme file and new
  // token edits (e.g. a theme's --cell-gap-seal) silently don't apply. In
  // production the SW + CACHE_NAME handle versioning, so no buster is added.
  const preview = /[?&]previewthemes=1\b/.test(location.search) &&
    /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  link.href = 'src/styles/themes/' + themeName + '.css' + (preview ? '?v=' + Date.now() : '');
  document.head.appendChild(link);
  _loadedThemes.add(themeName);
}

// ── Theme Unlock Progression ──────────────────────────
// Themes unlock based on highest level ever beaten (permanent).
// Dying in normal mode resets current level to 1 but keeps unlocks.
//
// THE LADDER RULE: classic + dark are free at level 0; the other 24
// themes unlock one per checkpoint — every 5 challenge levels, L5
// through L120 — ordered by IN-YOUR-FACE-NESS. Quiet print-and-paper
// worlds come first so new players have classic-feeling boards; the
// loud, animated, high-saturation worlds are late-game rewards. When
// adding or cutting a theme, keep the levels exactly the multiples of
// 5 with no gaps or doubles, and place it by visual intensity (color
// saturation + ambient motion + background busyness), not by age —
// test/themeUnlockLadder.test.mjs enforces the structure. Entries are
// listed in unlock order; the Collection grid renders in this order.
//
// (2026-06 catalog trim note: cut themes live in git history; restoring
// one means restoring its CSS file + entries here, in THEME_EFFECTS,
// and in the confetti palette, bringing it up to the objects+moments
// contract, AND giving it a ladder slot — which bumps everything after
// it.)
export const THEME_UNLOCKS = {
  classic:          { levelRequired: 0,   displayName: 'Classic',        mine: '💣', flag: '🚩', smiley: '😊', smileyWin: '😎', smileyLoss: '😵' },
  dark:             { levelRequired: 0,   displayName: 'Dark',           mine: '💣', flag: '🚩', smiley: '😊', smileyWin: '😎', smileyLoss: '😵' },
  // Quiet print & paper — muted palettes, little or no ambient motion.
  editorial:        { levelRequired: 5,   displayName: 'Editorial',      mine: '⬛', flag: '✒️', strikeCell: '💢', smiley: '📰', smileyWin: '🎩', smileyLoss: '☕' },
  sumie:            { levelRequired: 10,  displayName: 'Sumi-e',         mine: '⚫', flag: '🖌️', strikeCell: '💢', smiley: '🎴', smileyWin: '🌸', smileyLoss: '🌑' },
  blueprint:        { levelRequired: 15,  displayName: 'Blueprint',      mine: '🔩', flag: '📍', strikeCell: '⚠️', smiley: '📐', smileyWin: '✏️', smileyLoss: '❌' },
  cartography:      { levelRequired: 20,  displayName: 'Cartography',    mine: '❌', flag: '⛵', strikeCell: '🐙', smiley: '🧭', smileyWin: '💰', smileyLoss: '🐙' },
  origami:          { levelRequired: 25,  displayName: 'Origami',        mine: '🕊️', flag: '🔖', strikeCell: '🗯️', smiley: '🦢', smileyWin: '🎏', smileyLoss: '🗯️' },
  chalkboard:       { levelRequired: 30,  displayName: 'Chalkboard',     mine: '☠️', flag: '⚑', strikeCell: '💨', smiley: '✏️', smileyWin: '💯', smileyLoss: '💨' },
  noir:             { levelRequired: 35,  displayName: 'Noir',           mine: '🎱', flag: '🔍', strikeCell: '🩸', smiley: '🕵️', smileyWin: '🥃', smileyLoss: '🚬' },
  // Gentle nature — soft color, slow ambient drift.
  ocean:            { levelRequired: 40,  displayName: 'Ocean',          mine: '🐡', flag: '⚓', strikeCell: '🌊', smiley: '🐟', smileyWin: '🐬', smileyLoss: '🫧' },
  forest:           { levelRequired: 45,  displayName: 'Forest',         mine: '🌰', flag: '🐿️', strikeCell: '🌳', smiley: '🌲', smileyWin: '🦉', smileyLoss: '🪵' },
  sakura:           { levelRequired: 50,  displayName: 'Sakura',         mine: '🎴', flag: '🏮', strikeCell: '🌸', smiley: '🌸', smileyWin: '🎎', smileyLoss: '🍂' },
  apothecary:       { levelRequired: 55,  displayName: 'Apothecary',     mine: '🧪', flag: '🗝️', strikeCell: '☠️', smiley: '⚗️', smileyWin: '✨', smileyLoss: '💀' },
  splitflap:        { levelRequired: 60,  displayName: 'Split-Flap',     mine: '🧳', flag: '🏷️', strikeCell: '💥', smiley: '🛫', smileyWin: '🛬', smileyLoss: '⛔' },
  // Rich light — saturated color and glow, steady motion.
  stainedglass:     { levelRequired: 65,  displayName: 'Stained Glass',  mine: '🕯️', flag: '⚜️', strikeCell: '🔥', smiley: '⛪', smileyWin: '😇', smileyLoss: '💀' },
  aurora:           { levelRequired: 70,  displayName: 'Aurora',         mine: '❄️', flag: '🌌', strikeCell: '🌨️', smiley: '🌀', smileyWin: '🌈', smileyLoss: '🌫️' },
  galaxy:           { levelRequired: 75,  displayName: 'Galaxy',         mine: '☄️', flag: '🛸', strikeCell: '💫', smiley: '🪐', smileyWin: '🌟', smileyLoss: '🌑' },
  candy:            { levelRequired: 80,  displayName: 'Candy',          mine: '🍬', flag: '🍭', strikeCell: '💥', smiley: '🧁', smileyWin: '🎂', smileyLoss: '🍩' },
  // Loud — high contrast, busy ambient animation, maximum saturation.
  comic:            { levelRequired: 85,  displayName: 'Comic',          mine: '💣', flag: '❗', strikeCell: '💥', smiley: '😮', smileyWin: '🦸', smileyLoss: '💀' },
  circuitboard:     { levelRequired: 90,  displayName: 'Circuit Board',  mine: '🐛', flag: '🔧', strikeCell: '⚡', smiley: '🤖', smileyWin: '💡', smileyLoss: '🔥' },
  matrix:           { levelRequired: 95,  displayName: 'Matrix',         mine: '🟢', flag: '🔴', strikeCell: '❌', smiley: '👁️', smileyWin: '🔓', smileyLoss: '🔒' },
  neon:             { levelRequired: 100, displayName: 'Neon',           mine: '⚡', flag: '🎯', strikeCell: '💥', smiley: '💡', smileyWin: '🔆', smileyLoss: '💤' },
  synthwave:        { levelRequired: 105, displayName: 'Synthwave',      mine: '🎹', flag: '🎧', strikeCell: '📺', smiley: '🎛️', smileyWin: '🎶', smileyLoss: '📴' },
  inferno:          { levelRequired: 110, displayName: 'Inferno',        mine: '🔥', flag: '💀', strikeCell: '🌋', smiley: '😈', smileyWin: '👹', smileyLoss: '💀' },
  supernova:        { levelRequired: 115, displayName: 'Supernova',      mine: '💥', flag: '🚀', strikeCell: '🌟', smiley: '🛰️', smileyWin: '⭐', smileyLoss: '🌑' },
  legendary:        { levelRequired: 120, displayName: 'Legendary',      mine: '🐉', flag: '🏰', strikeCell: '🔥', smiley: '⚔️', smileyWin: '🐉', smileyLoss: '💀' },
};

// Dev-only theme preview: `?previewthemes=1` on localhost unlocks every theme
// in the Collection so designs can be reviewed live (with effects). Gated to
// localhost so it is inert on any deployed build (christopherwells.github.io).
function isThemePreview() {
  try {
    const h = location.hostname;
    const isLocal = h === 'localhost' || h === '127.0.0.1' || h === '';
    return isLocal && new URLSearchParams(location.search).has('previewthemes');
  } catch {
    return false;
  }
}

export function getUnlockedThemes() {
  const stats = loadStats();
  const maxLevel = stats.maxLevelReached || 1;
  const preview = isThemePreview();
  const unlocked = {};
  for (const [theme, info] of Object.entries(THEME_UNLOCKS)) {
    unlocked[theme] = preview || maxLevel >= info.levelRequired;
  }
  return unlocked;
}

export function updateThemeSwatches() {
  const unlocked = getUnlockedThemes();
  let lockedCount = 0;
  for (const swatch of $$('.theme-swatch')) {
    const theme = swatch.dataset.theme;
    const isUnlocked = unlocked[theme] !== false;
    const lockEl = swatch.querySelector('.swatch-lock');
    const nameEl = swatch.querySelector('.swatch-name');

    if (isUnlocked) {
      swatch.classList.remove('locked', 'locked-collapsed');
      if (lockEl) lockEl.classList.add('hidden');
      if (nameEl) nameEl.classList.remove('hidden');
    } else {
      swatch.classList.add('locked');
      // Collapse locked themes by default
      const toggleBtn = $('#toggle-locked-themes');
      if (toggleBtn && !toggleBtn.classList.contains('expanded')) {
        swatch.classList.add('locked-collapsed');
      }
      if (lockEl) lockEl.classList.remove('hidden');
      if (nameEl) nameEl.classList.add('hidden');
      lockedCount++;
    }
  }
  // Update toggle button
  const toggleBtn = $('#toggle-locked-themes');
  const countSpan = $('#locked-theme-count');
  if (toggleBtn) {
    if (lockedCount > 0) {
      toggleBtn.classList.remove('hidden');
      if (countSpan) countSpan.textContent = lockedCount;
    } else {
      toggleBtn.classList.add('hidden');
    }
  }
}

export function checkThemeUnlocks(prevMaxLevel, currentMaxLevel) {
  const newlyUnlocked = [];
  for (const [theme, info] of Object.entries(THEME_UNLOCKS)) {
    if (info.levelRequired > 0 && prevMaxLevel < info.levelRequired && currentMaxLevel >= info.levelRequired) {
      newlyUnlocked.push({ theme, displayName: info.displayName });
    }
  }
  return newlyUnlocked;
}

export function showThemeUnlockToasts(unlocked) {
  const toast = $('#theme-unlock-toast');
  if (!toast) return;
  let index = 0;

  function showNext() {
    if (index >= unlocked.length) return;
    const item = unlocked[index];
    toast.querySelector('.theme-unlock-toast-name').textContent = item.displayName;
    toast.classList.remove('hidden', 'hiding');

    setTimeout(() => {
      toast.classList.add('hiding');
      setTimeout(() => {
        toast.classList.add('hidden');
        toast.classList.remove('hiding');
        index++;
        if (index < unlocked.length) {
          setTimeout(showNext, 200);
        }
      }, 300);
    }, 3000);
  }

  // Delay to not overlap with achievement toasts
  setTimeout(showNext, 1200);
}
