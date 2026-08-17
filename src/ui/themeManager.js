import { $, $$ } from './domHelpers.js';
import { loadStats } from '../storage/statsStorage.js';
import { applyThemeEffects } from './themeEffects.js';

// ── Lazy Theme CSS Loading ────────────────────────────
// classic + dark are eagerly loaded in index.html.
// All other themes are loaded on-demand here. Returns a Promise that
// resolves once the stylesheet has actually APPLIED (link.onload), a
// caller that needs to measure the new theme's live geometry (the
// board-refit in applyThemeLive reads --grid-gap) must wait on it, or it
// measures the OLD theme's values. Resolves immediately for eager /
// already-loaded themes, and on error too (a failed sheet must never
// hang a theme switch).
const EAGER_THEMES = new Set(['classic', 'dark']);
const _themeCSSLoads = new Map(); // theme -> Promise (pending or settled)

export function loadThemeCSS(themeName) {
  if (EAGER_THEMES.has(themeName)) return Promise.resolve();
  if (_themeCSSLoads.has(themeName)) return _themeCSSLoads.get(themeName);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  // In live theme-preview mode (localhost + ?previewthemes=1) the service worker
  // is bypassed and the goal is to always see the freshest CSS, so cache-bust
  // the href, otherwise the browser serves a stale cached theme file and new
  // token edits (e.g. a theme's --cell-gap-seal) silently don't apply. In
  // production the SW + CACHE_NAME handle versioning, so no buster is added.
  const preview = /[?&]previewthemes=1\b/.test(location.search) &&
    /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  link.href = 'src/styles/themes/' + themeName + '.css' + (preview ? '?v=' + Date.now() : '');
  const p = new Promise((resolve) => {
    link.onload = () => resolve();
    link.onerror = () => resolve();
  });
  document.head.appendChild(link);
  _themeCSSLoads.set(themeName, p);
  return p;
}

// ── The Theme Shelf (his ruling, 2026-08-16) ──────────
// FIVE themes ship, all unlocked from the start: classic, dark, forest,
// matrix, nest (the five that got the title-polish pass). The other 21
// are SHELVED, not cut: their CSS, sprites, sound palettes, effects and
// confetti entries all stay in the codebase (the 26-theme count doctrine
// is untouched), and none of them renders anywhere on a production
// build. They stay reachable on localhost and the /test/ deployment via
// ?previewthemes=1 (isThemePreview below), which is where they get
// worked on until they return. His words: "Maybe we ship with a few
// themes (classic, dark, forest, matrix, and nest) and then we do the
// rest later" and "I think I want them just unlocked for now. No need
// to earn that for now."
//
// The unlock LADDER is DORMANT, not deleted: shelved entries keep their
// old levelRequired values as the historical record, but nothing reads
// them as earnable: getUnlockedThemes reports every shelved theme
// locked (outside preview) and checkThemeUnlocks never fires a moment
// for one. Re-laddering when themes return is a fresh design decision,
// not a revert. Entries are listed live-first; the Collection grid
// renders in this order.
//
// (2026-06 catalog trim note: cut themes live in git history; restoring
// one means restoring its CSS file + entries here, in THEME_EFFECTS,
// and in the confetti palette, bringing it up to the objects+moments
// contract.)
export const LIVE_THEMES = ['classic', 'dark', 'forest', 'matrix', 'nest'];

export const THEME_UNLOCKS = {
  classic:          { levelRequired: 0,   displayName: 'Classic',        mine: '💣', flag: '🚩', smiley: '😊', smileyWin: '😎', smileyLoss: '😵' },
  dark:             { levelRequired: 0,   displayName: 'Dark',           mine: '💣', flag: '🚩', smiley: '😊', smileyWin: '😎', smileyLoss: '😵' },
  forest:           { levelRequired: 0,   displayName: 'Forest',         mine: '🌰', flag: '🐿️', strikeCell: '🌳', smiley: '🌲', smileyWin: '🦉', smileyLoss: '🪵' },
  matrix:           { levelRequired: 0,   displayName: 'Matrix',         mine: '🟢', flag: '🔴', strikeCell: '❌', smiley: '👁️', smileyWin: '🔓', smileyLoss: '🔒' },
  nest:             { levelRequired: 0,   displayName: 'Nest',           mine: '🥚', flag: '🪶', strikeCell: '🍳', smiley: '🪺', smileyWin: '🐥', smileyLoss: '🪹' },
  // ── Shelved below this line (old ladder values kept, dormant) ──
  editorial:        { levelRequired: 25,  displayName: 'Editorial',      mine: '⬛', flag: '✒️', strikeCell: '💢', smiley: '📰', smileyWin: '🎩', smileyLoss: '☕' },
  sumie:            { levelRequired: 30,  displayName: 'Sumi-e',         mine: '⚫', flag: '🖌️', strikeCell: '💢', smiley: '🎴', smileyWin: '🌸', smileyLoss: '🌑' },
  blueprint:        { levelRequired: 40,  displayName: 'Blueprint',      mine: '🔩', flag: '📍', strikeCell: '⚠️', smiley: '📐', smileyWin: '✏️', smileyLoss: '❌' },
  cartography:      { levelRequired: 50,  displayName: 'Cartography',    mine: '❌', flag: '⛵', strikeCell: '🐙', smiley: '🧭', smileyWin: '💰', smileyLoss: '🐙' },
  origami:          { levelRequired: 60,  displayName: 'Origami',        mine: '🕊️', flag: '🔖', strikeCell: '🗯️', smiley: '🦢', smileyWin: '🎏', smileyLoss: '🗯️' },
  chalkboard:       { levelRequired: 70,  displayName: 'Chalkboard',     mine: '☠️', flag: '⚑', strikeCell: '💨', smiley: '✏️', smileyWin: '💯', smileyLoss: '💨' },
  noir:             { levelRequired: 80,  displayName: 'Noir',           mine: '🎱', flag: '🔍', strikeCell: '🩸', smiley: '🕵️', smileyWin: '🥃', smileyLoss: '🚬' },
  ocean:            { levelRequired: 90,  displayName: 'Ocean',          mine: '🐡', flag: '⚓', strikeCell: '🌊', smiley: '🐟', smileyWin: '🐬', smileyLoss: '🫧' },
  sakura:           { levelRequired: 110, displayName: 'Sakura',         mine: '🎴', flag: '🏮', strikeCell: '🌸', smiley: '🌸', smileyWin: '🎎', smileyLoss: '🍂' },
  apothecary:       { levelRequired: 120, displayName: 'Apothecary',     mine: '🧪', flag: '🗝️', strikeCell: '☠️', smiley: '⚗️', smileyWin: '✨', smileyLoss: '💀' },
  splitflap:        { levelRequired: 130, displayName: 'Split-Flap',     mine: '🧳', flag: '🏷️', strikeCell: '💥', smiley: '🛫', smileyWin: '🛬', smileyLoss: '⛔' },
  stainedglass:     { levelRequired: 140, displayName: 'Stained Glass',  mine: '🕯️', flag: '⚜️', strikeCell: '🔥', smiley: '⛪', smileyWin: '😇', smileyLoss: '💀' },
  aurora:           { levelRequired: 150, displayName: 'Aurora',         mine: '❄️', flag: '🌌', strikeCell: '🌨️', smiley: '🌀', smileyWin: '🌈', smileyLoss: '🌫️' },
  galaxy:           { levelRequired: 160, displayName: 'Galaxy',         mine: '☄️', flag: '🛸', strikeCell: '💫', smiley: '🪐', smileyWin: '🌟', smileyLoss: '🌑' },
  candy:            { levelRequired: 170, displayName: 'Candy',          mine: '🍬', flag: '🍭', strikeCell: '💥', smiley: '🧁', smileyWin: '🎂', smileyLoss: '🍩' },
  circuitboard:     { levelRequired: 190, displayName: 'Circuit Board',  mine: '🐛', flag: '🔧', strikeCell: '⚡', smiley: '🤖', smileyWin: '💡', smileyLoss: '🔥' },
  neon:             { levelRequired: 210, displayName: 'Neon',           mine: '⚡', flag: '🎯', strikeCell: '💥', smiley: '💡', smileyWin: '🔆', smileyLoss: '💤' },
  synthwave:        { levelRequired: 220, displayName: 'Synthwave',      mine: '🎹', flag: '🎧', strikeCell: '📺', smiley: '🎛️', smileyWin: '🎶', smileyLoss: '📴' },
  inferno:          { levelRequired: 230, displayName: 'Inferno',        mine: '🔥', flag: '💀', strikeCell: '🌋', smiley: '😈', smileyWin: '👹', smileyLoss: '💀' },
  supernova:        { levelRequired: 240, displayName: 'Supernova',      mine: '💥', flag: '🚀', strikeCell: '🌟', smiley: '🛰️', smileyWin: '⭐', smileyLoss: '🌑' },
  legendary:        { levelRequired: 250, displayName: 'Legendary',      mine: '🐉', flag: '🏰', strikeCell: '🔥', smiley: '⚔️', smileyWin: '🐉', smileyLoss: '💀' },
};

// Dev-only theme preview: `?previewthemes=1` unlocks every theme in the
// Collection so designs can be reviewed live (with effects). Allowed on
// localhost AND on the /test/ deployment (theme evaluation happens
// there); inert on the production build.
function isThemePreview() {
  try {
    const h = location.hostname;
    const isLocal = h === 'localhost' || h === '127.0.0.1' || h === '';
    const isTestBuild = location.pathname.includes('/test/');
    return (isLocal || isTestBuild) && new URLSearchParams(location.search).has('previewthemes');
  } catch {
    return false;
  }
}

// A shelved theme is invisible on a production build and fully available
// under the dev preview door. Every selectable-theme surface (Collection,
// carousel, in-game cycle, the boot fallback) must consult this, because a
// surface that lists a shelved theme un-shelves it.
export function isThemeShelved(theme) {
  return !LIVE_THEMES.includes(theme) && !isThemePreview();
}

export function getUnlockedThemes() {
  const stats = loadStats();
  const maxLevel = stats.maxLevelReached || 1;
  const preview = isThemePreview();
  const unlocked = {};
  for (const [theme, info] of Object.entries(THEME_UNLOCKS)) {
    unlocked[theme] = preview
      || (LIVE_THEMES.includes(theme) && maxLevel >= info.levelRequired);
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
    // Shelved themes never fire an unlock moment: their levelRequired is
    // the dormant historical ladder, not an earnable threshold, and a
    // toast for a theme the Collection does not show would be a lie.
    // (With the five live themes all free at 0, this loop currently
    // yields nothing at all; it stays for the day themes re-ladder.)
    if (!LIVE_THEMES.includes(theme)) continue;
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

// ── Android nav-bar theme-color meta tag ──────────────
// Mirrors the active theme's app background into the <meta name="theme-color">
// tag so the mobile browser chrome matches.
export function updateThemeColor() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--color-app-bg').trim();
  if (bg) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', bg);
  }
}

// ── Chaos theme override ──────────────────────────────
// Chaos forces its own theme for the duration of a run. Entering stashes the
// player's current theme; leaving restores it. The stash + restore live HERE,
// not in main.js, so game modules (modeManager) can restore on exit without
// importing the entry orchestrator, importing main.js auto-runs init() at
// module load, which booted the whole app on any headless import.
let _previousChaosTheme = null;

export function enterChaosTheme(currentTheme) {
  _previousChaosTheme = currentTheme;
  document.documentElement.setAttribute('data-theme', 'chaos');
  loadThemeCSS('chaos');
  applyThemeEffects('chaos');
  updateThemeColor();
}

// Restores the pre-chaos theme if one was stashed. Conditional on the stash so
// it's idempotent and safe to call on any path that leaves chaos (title screen,
// checkpoint selector, direct switchMode).
export function restorePreChaosTheme() {
  if (!_previousChaosTheme) return;
  document.documentElement.setAttribute('data-theme', _previousChaosTheme);
  applyThemeEffects(_previousChaosTheme);
  updateThemeColor();
  _previousChaosTheme = null;
}
