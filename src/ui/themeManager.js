import { $, $$ } from './domHelpers.js?v=1.0';
import { loadStats } from '../storage/statsStorage.js?v=1.0';

// ── Lazy Theme CSS Loading ────────────────────────────
// classic + dark are eagerly loaded in index.html.
// All other themes are loaded on-demand here.
const EAGER_THEMES = new Set(['classic', 'dark']);
const _loadedThemes = new Set(['classic', 'dark']);

export function loadThemeCSS(themeName) {
  if (EAGER_THEMES.has(themeName) || _loadedThemes.has(themeName)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'src/styles/themes/' + themeName + '.css?v=1.0.4';
  document.head.appendChild(link);
  _loadedThemes.add(themeName);
}

// ── Theme Unlock Progression ──────────────────────────
// Themes unlock based on highest level ever beaten (permanent).
// Dying in normal mode resets current level to 1 but keeps unlocks.
export const THEME_UNLOCKS = {
  classic:          { levelRequired: 0,  displayName: 'Classic',        mine: '💣', flag: '🚩', smiley: '😊', smileyWin: '😎', smileyLoss: '😵' },
  dark:             { levelRequired: 0,  displayName: 'Dark',           mine: '💣', flag: '🚩', smiley: '😊', smileyWin: '😎', smileyLoss: '😵' },
  ocean:            { levelRequired: 3,  displayName: 'Ocean',          mine: '🐡', flag: '⚓', smiley: '🐟', smileyWin: '🐬', smileyLoss: '🫧' },
  sunset:           { levelRequired: 6,  displayName: 'Sunset',         mine: '☀️', flag: '🚩', smiley: '🌤️', smileyWin: '🌞', smileyLoss: '🌧️' },
  forest:           { levelRequired: 9,  displayName: 'Forest',         mine: '🍄', flag: '🌿', smiley: '🌲', smileyWin: '🦉', smileyLoss: '🪵' },
  candy:            { levelRequired: 12, displayName: 'Candy',          mine: '🍬', flag: '🍭', smiley: '🧁', smileyWin: '🎂', smileyLoss: '🍩' },
  midnight:         { levelRequired: 15, displayName: 'Midnight',       mine: '🌙', flag: '⭐', smiley: '🦇', smileyWin: '🌕', smileyLoss: '🌑' },
  stealth:          { levelRequired: 18, displayName: 'Stealth',        mine: '💣', flag: '🏴', smiley: '🥷', smileyWin: '🕵️', smileyLoss: '💀' },
  neon:             { levelRequired: 21, displayName: 'Neon',           mine: '⚡', flag: '🎯', smiley: '💡', smileyWin: '🔆', smileyLoss: '💤' },
  'cherry-blossom': { levelRequired: 24, displayName: 'Cherry Blossom', mine: '🌸', flag: '🎀', smiley: '🌷', smileyWin: '🦋', smileyLoss: '🥀' },
  aurora:           { levelRequired: 27, displayName: 'Aurora',         mine: '❄️', flag: '🌌', smiley: '🌀', smileyWin: '🌈', smileyLoss: '🌫️' },
  volcano:          { levelRequired: 30, displayName: 'Volcano',        mine: '🌋', flag: '🔥', smiley: '🪨', smileyWin: '🏔️', smileyLoss: '💨' },
  ice:              { levelRequired: 34, displayName: 'Ice',            mine: '🧊', flag: '❄️', smiley: '⛄', smileyWin: '🏔️', smileyLoss: '💧' },
  cyberpunk:        { levelRequired: 38, displayName: 'Cyberpunk',      mine: '🤖', flag: '🔌', smiley: '🖥️', smileyWin: '🦾', smileyLoss: '⚠️' },
  retro:            { levelRequired: 42, displayName: 'Retro',          mine: '👾', flag: '🕹️', smiley: '🎮', smileyWin: '🏆', smileyLoss: '👻' },
  holographic:      { levelRequired: 46, displayName: 'Holographic',    mine: '💠', flag: '🔮', smiley: '🔮', smileyWin: '🪩', smileyLoss: '🫥' },
  copper:           { levelRequired: 33, displayName: 'Copper',         mine: '🔩', flag: '🔧', smiley: '⚙️', smileyWin: '🏅', smileyLoss: '🪤' },
  sakura:           { levelRequired: 36, displayName: 'Sakura',         mine: '🎴', flag: '🏮', smiley: '🌸', smileyWin: '🎎', smileyLoss: '🍂' },
  galaxy:           { levelRequired: 40, displayName: 'Galaxy',         mine: '☄️', flag: '🛸', smiley: '🪐', smileyWin: '🌟', smileyLoss: '🌑' },
  lavender:         { levelRequired: 44, displayName: 'Lavender',       mine: '🦋', flag: '💜', smiley: '🪻', smileyWin: '🌸', smileyLoss: '🫧' },
  toxic:            { levelRequired: 48, displayName: 'Toxic',          mine: '☢️', flag: '🧪', smiley: '🧫', smileyWin: '🧬', smileyLoss: '💀' },
  autumn:           { levelRequired: 52, displayName: 'Autumn',         mine: '🌰', flag: '🍁', smiley: '🍂', smileyWin: '🎃', smileyLoss: '🥀' },
  royal:            { levelRequired: 55, displayName: 'Royal',          mine: '👑', flag: '⚔️', smiley: '🏰', smileyWin: '👑', smileyLoss: '⚰️' },
  coral:            { levelRequired: 58, displayName: 'Coral',          mine: '🐙', flag: '🐚', smiley: '🦀', smileyWin: '🐠', smileyLoss: '🫧' },
  emerald:          { levelRequired: 61, displayName: 'Emerald',        mine: '🐸', flag: '💚', smiley: '🌿', smileyWin: '💎', smileyLoss: '🪨' },
  prismatic:        { levelRequired: 64, displayName: 'Prismatic',      mine: '🌈', flag: '✨', smiley: '💎', smileyWin: '🦄', smileyLoss: '🫧' },
  slate:            { levelRequired: 67, displayName: 'Slate',          mine: '⬛', flag: '🏳️', smiley: '🪨', smileyWin: '💠', smileyLoss: '🌫️' },
  void:             { levelRequired: 70, displayName: 'Void',           mine: '🕳️', flag: '⚫', smiley: '👁️', smileyWin: '🌀', smileyLoss: '💫' },
  arctic:           { levelRequired: 73, displayName: 'Arctic',         mine: '🐻‍❄️', flag: '🏔️', smiley: '🦭', smileyWin: '🐧', smileyLoss: '🥶' },
  deepspace:        { levelRequired: 76, displayName: 'Deep Space',     mine: '🛸', flag: '🌀', smiley: '🔭', smileyWin: '🌌', smileyLoss: '☠️' },
  jungle:           { levelRequired: 78, displayName: 'Jungle',         mine: '🐍', flag: '🦜', smiley: '🐒', smileyWin: '🦁', smileyLoss: '🦴' },
  obsidian:         { levelRequired: 80, displayName: 'Obsidian',       mine: '🖤', flag: '⛓️', smiley: '🗿', smileyWin: '💎', smileyLoss: '🪦' },
  phantom:          { levelRequired: 83, displayName: 'Phantom',        mine: '👻', flag: '🩻', smiley: '💀', smileyWin: '🕊️', smileyLoss: '⚰️' },
  matrix:           { levelRequired: 86, displayName: 'Matrix',         mine: '🟢', flag: '🔴', smiley: '👁️', smileyWin: '🔓', smileyLoss: '🔒' },
  solar:            { levelRequired: 88, displayName: 'Solar',          mine: '☀️', flag: '🔆', smiley: '🌻', smileyWin: '🌞', smileyLoss: '🌘' },
  bloodmoon:        { levelRequired: 90, displayName: 'Blood Moon',     mine: '🩸', flag: '🌑', smiley: '🐺', smileyWin: '🦇', smileyLoss: '⚰️' },
  inferno:          { levelRequired: 92, displayName: 'Inferno',        mine: '🔥', flag: '💀', smiley: '😈', smileyWin: '👹', smileyLoss: '💀' },
  synthwave:        { levelRequired: 94, displayName: 'Synthwave',      mine: '🎹', flag: '🎧', smiley: '🎛️', smileyWin: '🎶', smileyLoss: '📴' },
  celestial:        { levelRequired: 96, displayName: 'Celestial',      mine: '🌟', flag: '🌠', smiley: '🌙', smileyWin: '☀️', smileyLoss: '🌑' },
  supernova:        { levelRequired: 98, displayName: 'Supernova',      mine: '💥', flag: '🚀', smiley: '🛰️', smileyWin: '⭐', smileyLoss: '🌑' },
  legendary:        { levelRequired: 100, displayName: 'Legendary',     mine: '🐉', flag: '🏰', smiley: '⚔️', smileyWin: '🐉', smileyLoss: '💀' },
};

export function getUnlockedThemes() {
  const stats = loadStats();
  const maxLevel = stats.maxLevelReached || 1;
  const unlocked = {};
  for (const [theme, info] of Object.entries(THEME_UNLOCKS)) {
    unlocked[theme] = maxLevel >= info.levelRequired;
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
