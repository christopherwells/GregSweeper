// Sprite loader for the Tier 1 default-look icons AND the per-theme
// object sets.
//
// Tier 1 sprites render only when the resolved emoji equals the
// canonical default for that key (Classic/Dark themes). Emoji packs —
// the old per-player override layer — were cut with the 2026-06-12
// Collection declutter, so the theme is the only source of object
// emoji now; the equality checks below remain as the identity
// contract between getThemeEmoji and THEME_UNLOCKS.
//
// THEME_SPRITES (below) are each world's objects drawn in its material
// language — the editorial ink blot, the sumi-e hanko stroke, the
// blueprint drafted bomb. A theme sprite renders only when the resolved
// emoji equals THAT THEME's own object emoji; undrawn themes fall back
// to their emoji untouched. Ship world by world.

import { THEME_UNLOCKS } from './themeManager.js';

const SPRITES = {
  mine:       { defaultEmoji: '💣', url: 'assets/sprites/mine.png' },
  flag:       { defaultEmoji: '🚩', url: 'assets/sprites/flag.png' },
  smiley:     { defaultEmoji: '😊', url: 'assets/sprites/idle.png' },
  smileyWin:  { defaultEmoji: '😎', url: 'assets/sprites/win.png' },
  smileyLoss: { defaultEmoji: '😵', url: 'assets/sprites/loss.png' },
  strike:     { defaultEmoji: '💥', url: 'assets/sprites/strike.png' },
  // The "bomb you actually hit." Triggered by the same canonical mine emoji
  // as the regular mine sprite — on Classic/Default we swap to strike.png so
  // the exploded bomb stands out from the other revealed mines. On themed
  // alternates (e.g. Ocean 🐡), the themed mine emoji renders verbatim.
  strikeCell: { defaultEmoji: '💣', url: 'assets/sprites/strike.png' },

  // ── Tiers 3-5 of the sprite inventory (drawn SVG, 2026-06-10) ──
  // Mode cards and power-ups render these directly from index.html
  // markup (static surfaces, emoji as onerror fallback). The medal set
  // is registered here for the inline-text call sites (winLossHandler
  // ratings, achievement tiers, leaderboard headers) to adopt via
  // applyIcon/spriteImgHTML once the art is approved.
  medalDiamond: { defaultEmoji: '💎', url: 'assets/sprites/medal-diamond.svg' },
  medalGold:    { defaultEmoji: '🥇', url: 'assets/sprites/medal-gold.svg' },
  medalSilver:  { defaultEmoji: '🥈', url: 'assets/sprites/medal-silver.svg' },
  medalBronze:  { defaultEmoji: '🥉', url: 'assets/sprites/medal-bronze.svg' },
};

// Retain Image refs until each one fires onload/onerror so the browser
// can't GC-cancel a pending fetch (rare, but defensive — and pinning
// during the early load is cheap, the array clears as fetches resolve).
const _preloadCache = [];

export function preloadSprites() {
  for (const s of Object.values(SPRITES)) {
    if (_preloadCache.some(i => i.src.endsWith(s.url))) continue;
    const img = new Image();
    img.decoding = 'async';
    img.src = s.url;
    _preloadCache.push(img);
    const drop = () => {
      const idx = _preloadCache.indexOf(img);
      if (idx >= 0) _preloadCache.splice(idx, 1);
    };
    img.onload = drop;
    img.onerror = drop;
  }
}

// Per-theme object sets: theme -> { mine, flag, strikeCell } -> svg.
// Batch 1 (2026-06-11): the eight concept worlds + chalkboard's chalk
// set + noir's chalk-outline strike.
const T = 'assets/sprites/themes/';
const THEME_SPRITES = {
  editorial:    { mine: T + 'editorial-mine.svg',    flag: T + 'editorial-flag.svg',    strikeCell: T + 'editorial-strike.svg' },
  sumie:        { mine: T + 'sumie-mine.svg',        flag: T + 'sumie-flag.svg',        strikeCell: T + 'sumie-strike.svg' },
  blueprint:    { mine: T + 'blueprint-mine.svg',    flag: T + 'blueprint-flag.svg',    strikeCell: T + 'blueprint-strike.svg' },
  cartography:  { mine: T + 'cartography-mine.svg',  flag: T + 'cartography-flag.svg',  strikeCell: T + 'cartography-strike.svg' },
  chalkboard:   { mine: T + 'chalkboard-mine.svg',   flag: T + 'chalkboard-flag.svg',   strikeCell: T + 'chalkboard-strike.svg' },
  noir:         { strikeCell: T + 'noir-strike.svg' },
  sakura:       { mine: T + 'sakura-mine.svg',       flag: T + 'sakura-flag.svg',       strikeCell: T + 'sakura-strike.svg' },
  apothecary:   { mine: T + 'apothecary-mine.svg',   strikeCell: T + 'apothecary-strike.svg' },
  aurora:       { mine: T + 'aurora-mine.svg',       flag: T + 'aurora-flag.svg',       strikeCell: T + 'aurora-strike.svg' },
  splitflap:    { mine: T + 'splitflap-mine.svg',    flag: T + 'splitflap-flag.svg',    strikeCell: T + 'splitflap-strike.svg' },
  galaxy:       { mine: T + 'galaxy-mine.svg',       flag: T + 'galaxy-flag.svg',       strikeCell: T + 'galaxy-strike.svg' },
  circuitboard: { mine: T + 'circuitboard-mine.svg', flag: T + 'circuitboard-flag.svg', strikeCell: T + 'circuitboard-strike.svg' },
  comic:        { mine: T + 'comic-mine.svg',        flag: T + 'comic-flag.svg',        strikeCell: T + 'comic-strike.svg' },
};

// The theme's OWN emoji for a key (strikeCell falls back to mine, the
// same chain getThemeEmoji uses). A theme sprite only replaces this.
function themeDefaultEmoji(themeInfo, key) {
  if (!themeInfo) return null;
  if (key === 'strikeCell') return themeInfo.strikeCell || themeInfo.mine;
  return themeInfo[key];
}

export function getThemeSpriteUrl(key, resolvedEmoji) {
  const theme = document.documentElement.getAttribute('data-theme') || 'classic';
  const set = THEME_SPRITES[theme];
  if (!set || !set[key]) return null;
  // Defensive identity check: the sprite only replaces the theme's own
  // object emoji (always true since emoji packs were cut, but keeps
  // getThemeEmoji and THEME_UNLOCKS honest with each other).
  return resolvedEmoji === themeDefaultEmoji(THEME_UNLOCKS[theme], key) ? set[key] : null;
}

export function getSpriteUrl(key, resolvedEmoji) {
  const themed = getThemeSpriteUrl(key, resolvedEmoji);
  if (themed) return themed;
  const s = SPRITES[key];
  if (!s || resolvedEmoji !== s.defaultEmoji) return null;
  return s.url;
}

export function applyIcon(el, key, resolvedEmoji, { extraClass = '', sizeClass = '' } = {}) {
  if (!el) return;
  const url = getSpriteUrl(key, resolvedEmoji);
  if (url) {
    el.textContent = '';
    const img = document.createElement('img');
    img.className = `game-sprite ${sizeClass} ${extraClass}`.trim();
    img.src = url;
    img.alt = '';
    img.draggable = false;
    // Async decode so a cascade reveal (50+ mines flipping to strike.png
    // in rapid succession) doesn't block the render thread on the
    // synchronous decode path. Cached bitmaps decode in microseconds
    // either way; this matters mostly during the first uncached burst.
    img.decoding = 'async';
    el.appendChild(img);
  } else {
    el.textContent = resolvedEmoji;
  }
}

// Medal emoji -> drawn medal sprite (the four ranks the medal set
// covers). Returns null for non-medal emoji (platinum/emerald keep
// their emoji until drawn). TEXT surfaces (share strings) must stay
// emoji - callers choose by simply not using this.
const MEDAL_BY_EMOJI = { '🥉': 'medalBronze', '🥈': 'medalSilver', '🥇': 'medalGold', '💎': 'medalDiamond' };
export function medalImgForEmoji(emoji, sizeClass = 'sprite-rank', alt = '') {
  const key = MEDAL_BY_EMOJI[emoji];
  return key ? spriteImgHTML(key, sizeClass, alt) : null;
}

// Theme-agnostic HTML snippet for surfaces that always show the sprite
// (leaderboard column header, daily/weekly bomb-hit popup).
export function spriteImgHTML(key, sizeClass = '', alt = '') {
  const s = SPRITES[key];
  if (!s) return '';
  const cls = `game-sprite ${sizeClass}`.trim();
  const altAttr = alt ? ` alt="${alt}"` : ' alt=""';
  return `<img class="${cls}" src="${s.url}"${altAttr} decoding="async" draggable="false">`;
}
