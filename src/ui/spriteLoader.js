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
  // alternates (e.g. Ocean's blowfish), the themed mine emoji renders verbatim.
  strikeCell: { defaultEmoji: '💣', url: 'assets/sprites/strike.png' },

  // ── Tiers 3-5 of the sprite inventory (drawn SVG, 2026-06-10) ──
  // Mode cards and power-ups render these directly from index.html
  // markup (static surfaces, emoji as onerror fallback). The medal set
  // is registered here for the inline-text call sites (winLossHandler
  // ratings, achievement tiers, leaderboard headers) to adopt via
  // applyIcon/spriteImgHTML once the art is approved.
  medalDiamond:  { defaultEmoji: '💎', url: 'assets/sprites/medal-diamond.svg' },
  medalGold:     { defaultEmoji: '🥇', url: 'assets/sprites/medal-gold.svg' },
  medalSilver:   { defaultEmoji: '🥈', url: 'assets/sprites/medal-silver.svg' },
  medalBronze:   { defaultEmoji: '🥉', url: 'assets/sprites/medal-bronze.svg' },
  medalEmerald:  { defaultEmoji: '💚', url: 'assets/sprites/medal-emerald.svg' },

  // ── Wave A modifier icons (2026-06-16) ──
  modWalls:     { defaultEmoji: '🧱', url: 'assets/sprites/mod-walls.svg' },
  modLiar:      { defaultEmoji: '🤥', url: 'assets/sprites/mod-liar.svg' },
  modMystery:   { defaultEmoji: '❓', url: 'assets/sprites/mod-mystery.svg' },
  modMineShift: { defaultEmoji: '💨', url: 'assets/sprites/mod-mineshift.svg' },
  modLocked:    { defaultEmoji: '🔒', url: 'assets/sprites/mod-locked.svg' },
  modWormhole:  { defaultEmoji: '🌀', url: 'assets/sprites/mod-wormhole.svg' },
  modMirror:    { defaultEmoji: '🪞', url: 'assets/sprites/mod-mirror.svg' },
  modPressure:  { defaultEmoji: '🔴', url: 'assets/sprites/mod-pressure.svg' },
  modSonar:     { defaultEmoji: '📡', url: 'assets/sprites/mod-sonar.svg' },
  modCompass:   { defaultEmoji: '🧭', url: 'assets/sprites/mod-compass.svg' },

  // ── Wave B achievement category icons (2026-06-23) ──
  // Each achievement has its own drawn identity. Several share a glyph
  // with a mode card (📅 daily, ⛏️ challenge, ⏱️ timed), so these render
  // by category id (achievementSpriteImgHTML), never by emoji — the
  // defaultEmoji here is the registry fallback, not the lookup key.
  achWins:             { defaultEmoji: '🏆', url: 'assets/sprites/ach-wins.svg' },
  achStreak:           { defaultEmoji: '🔥', url: 'assets/sprites/ach-streak.svg' },
  achSpeed:            { defaultEmoji: '⚡', url: 'assets/sprites/ach-speed.svg' },
  achDaily:            { defaultEmoji: '📅', url: 'assets/sprites/ach-daily.svg' },
  achFlagless:         { defaultEmoji: '🏳️', url: 'assets/sprites/ach-flagless.svg' },
  achEfficient:        { defaultEmoji: '🎯', url: 'assets/sprites/ach-efficient.svg' },
  achTankCommander:    { defaultEmoji: '🧮', url: 'assets/sprites/ach-tankCommander.svg' },
  achLieDetector:      { defaultEmoji: '🕵️', url: 'assets/sprites/ach-lieDetector.svg' },
  achPurist:           { defaultEmoji: '💪', url: 'assets/sprites/ach-purist.svg' },
  achChallengeClimber: { defaultEmoji: '⛏️', url: 'assets/sprites/ach-challengeClimber.svg' },
  achTimedSpeed:       { defaultEmoji: '⏱️', url: 'assets/sprites/ach-timedSpeed.svg' },
  achGimmickMaster:    { defaultEmoji: '🎪', url: 'assets/sprites/ach-gimmickMaster.svg' },
  achDailyStreak:      { defaultEmoji: '📆', url: 'assets/sprites/ach-dailyStreak.svg' },

  // ── Wave C chrome icons (2026-06-24) ──
  // Theme-agnostic UI affordances, rendered BY KEY (uiSpriteImgHTML /
  // uiSpriteUrl), never by emoji — several share a glyph with content
  // icons (🏆 leaderboard vs Victory, ❓ help vs mystery), so no
  // defaultEmoji here. Drawn in one house style; see ICON-STYLE-GUIDE.md.
  uiHome:        { url: 'assets/sprites/ui-home.svg' },
  uiStats:       { url: 'assets/sprites/ui-stats.svg' },
  uiSettings:    { url: 'assets/sprites/ui-settings.svg' },
  uiHelp:        { url: 'assets/sprites/ui-help.svg' },
  uiLeaderboard: { url: 'assets/sprites/ui-leaderboard.svg' },
  uiCollection:  { url: 'assets/sprites/ui-collection.svg' },
  uiMuteOn:      { url: 'assets/sprites/ui-mute-on.svg' },
  uiMuteOff:     { url: 'assets/sprites/ui-mute-off.svg' },
  uiClose:       { url: 'assets/sprites/ui-close.svg' },
  uiReplay:      { url: 'assets/sprites/ui-replay.svg' },
  uiUpdate:      { url: 'assets/sprites/ui-update.svg' },
  uiReset:       { url: 'assets/sprites/ui-reset.svg' },
  uiDelete:      { url: 'assets/sprites/ui-delete.svg' },
  uiReport:      { url: 'assets/sprites/ui-report.svg' },
  uiSponsor:     { url: 'assets/sprites/ui-sponsor.svg' },
  uiDiagnostics: { url: 'assets/sprites/ui-diagnostics.svg' },
  uiWhatsNew:    { url: 'assets/sprites/ui-whatsnew.svg' },
  uiMore:        { url: 'assets/sprites/ui-more.svg' },
  uiPause:       { url: 'assets/sprites/ui-pause.svg' },
  uiNotifyOn:    { url: 'assets/sprites/ui-notify-on.svg' },
  uiNotifyOff:   { url: 'assets/sprites/ui-notify-off.svg' },
  uiReveal:      { url: 'assets/sprites/ui-reveal.svg' },
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

// Per-theme object sets AND per-theme Greg: theme ->
// { mine, flag, strikeCell, smiley, smileyWin, smileyLoss } -> svg.
// Object sprites are drawn world by world (batch 1, 2026-06-11: the
// concept worlds + chalkboard's chalk set + noir's chalk-outline
// strike). The three Greg smiley slots are wired for ALL 24 themed
// worlds (2026-06-13): a themed player sees Greg redrawn in that world's
// material. Classic/Dark have no entry here and keep the canonical Greg
// PNGs; avatar surfaces always use spriteImgHTML (canonical) regardless
// of theme, so the field note / win modal / ghost row stay green-crab.
const T = 'assets/sprites/themes/';
const G = 'assets/sprites/greg/';
// The three themed-Greg smiley slots for a world (idle/win/loss).
const greg = (t) => ({
  smiley:     `${G}themed-${t}-idle.svg`,
  smileyWin:  `${G}themed-${t}-win.svg`,
  smileyLoss: `${G}themed-${t}-loss.svg`,
});
const THEME_SPRITES = {
  editorial:    { mine: T + 'editorial-mine.svg',    flag: T + 'editorial-flag.svg',    strikeCell: T + 'editorial-strike.svg',    ...greg('editorial') },
  sumie:        { mine: T + 'sumie-mine.svg',        flag: T + 'sumie-flag.svg',        strikeCell: T + 'sumie-strike.svg',        ...greg('sumie') },
  blueprint:    { mine: T + 'blueprint-mine.svg',    flag: T + 'blueprint-flag.svg',    strikeCell: T + 'blueprint-strike.svg',    ...greg('blueprint') },
  cartography:  { mine: T + 'cartography-mine.svg',  flag: T + 'cartography-flag.svg',  strikeCell: T + 'cartography-strike.svg',  ...greg('cartography') },
  origami:      { ...greg('origami') },
  chalkboard:   { mine: T + 'chalkboard-mine.svg',   flag: T + 'chalkboard-flag.svg',   strikeCell: T + 'chalkboard-strike.svg',   ...greg('chalkboard') },
  noir:         { strikeCell: T + 'noir-strike.svg', ...greg('noir') },
  ocean:        { ...greg('ocean') },
  forest:       { ...greg('forest') },
  sakura:       { mine: T + 'sakura-mine.svg',       flag: T + 'sakura-flag.svg',       strikeCell: T + 'sakura-strike.svg',       ...greg('sakura') },
  apothecary:   { mine: T + 'apothecary-mine.svg',   strikeCell: T + 'apothecary-strike.svg',                                      ...greg('apothecary') },
  splitflap:    { mine: T + 'splitflap-mine.svg',    flag: T + 'splitflap-flag.svg',    strikeCell: T + 'splitflap-strike.svg',    ...greg('splitflap') },
  stainedglass: { ...greg('stainedglass') },
  aurora:       { mine: T + 'aurora-mine.svg',       flag: T + 'aurora-flag.svg',       strikeCell: T + 'aurora-strike.svg',       ...greg('aurora') },
  galaxy:       { mine: T + 'galaxy-mine.svg',       flag: T + 'galaxy-flag.svg',       strikeCell: T + 'galaxy-strike.svg',       ...greg('galaxy') },
  candy:        { ...greg('candy') },
  comic:        { mine: T + 'comic-mine.svg',        flag: T + 'comic-flag.svg',        strikeCell: T + 'comic-strike.svg',        ...greg('comic') },
  circuitboard: { mine: T + 'circuitboard-mine.svg', flag: T + 'circuitboard-flag.svg', strikeCell: T + 'circuitboard-strike.svg', ...greg('circuitboard') },
  matrix:       { ...greg('matrix') },
  neon:         { ...greg('neon') },
  synthwave:    { ...greg('synthwave') },
  inferno:      { ...greg('inferno') },
  supernova:    { ...greg('supernova') },
  legendary:    { ...greg('legendary') },
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

// Medal emoji -> drawn medal sprite. The five ranks ARE the full tier
// ladder (platinum was dropped 2026-06-23), so every tier icon now
// resolves to a medal. Returns null for any non-tier emoji. TEXT
// surfaces (share strings) must stay emoji — callers choose by simply
// not using this.
const MEDAL_BY_EMOJI = { '🥉': 'medalBronze', '🥈': 'medalSilver', '🥇': 'medalGold', '💎': 'medalDiamond', '💚': 'medalEmerald' };
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

// Theme-MATCHED sprite HTML: renders the current world's sprite for a key
// (e.g. the active theme's Greg), falling back to the emoji when no sprite is
// drawn. The caller passes the resolved emoji (getThemeEmoji) so spriteLoader
// stays free of a boardRenderer import cycle.
export function themeSpriteImgHTML(key, resolvedEmoji, sizeClass = '', alt = '') {
  const url = getSpriteUrl(key, resolvedEmoji);
  const cls = `game-sprite ${sizeClass}`.trim();
  if (url) {
    const altAttr = alt ? ` alt="${alt}"` : ' alt=""';
    return `<img class="${cls}" src="${url}"${altAttr} decoding="async" draggable="false">`;
  }
  return `<span class="${sizeClass}" aria-hidden="true">${resolvedEmoji || ''}</span>`;
}

// ── Gimmick (modifier) icon sprites ──────────────────────
// Maps gimmick definition keys to their SPRITES registry keys.
const GIMMICK_SPRITE_KEYS = {
  walls: 'modWalls', liar: 'modLiar', mystery: 'modMystery',
  mineShift: 'modMineShift', locked: 'modLocked', wormhole: 'modWormhole',
  mirror: 'modMirror', pressurePlate: 'modPressure', sonar: 'modSonar',
  compass: 'modCompass',
};

export function gimmickSpriteImgHTML(gimmickKey, sizeClass = 'sprite-gimmick', alt = '') {
  const spriteKey = GIMMICK_SPRITE_KEYS[gimmickKey];
  return spriteKey ? spriteImgHTML(spriteKey, sizeClass, alt) : null;
}

// Raw sprite URL for a gimmick key — used by the canvas share-card
// renderer (drawImage needs a URL, not HTML).
export function gimmickSpriteUrl(gimmickKey) {
  const spriteKey = GIMMICK_SPRITE_KEYS[gimmickKey];
  return spriteKey && SPRITES[spriteKey] ? SPRITES[spriteKey].url : null;
}

export function applyGimmickIcon(el, gimmickKey, fallbackEmoji) {
  const spriteKey = GIMMICK_SPRITE_KEYS[gimmickKey];
  if (spriteKey) {
    applyIcon(el, spriteKey, SPRITES[spriteKey].defaultEmoji, { sizeClass: 'sprite-gimmick' });
  } else if (el) {
    el.textContent = fallbackEmoji || '';
  }
}

// ── Achievement category icon sprites (Wave B) ───────────
// Keyed by the achievement category id (achievements.js CATEGORIES),
// not by emoji — several categories share a glyph with a mode card, so
// the id is the only unambiguous handle. Theme-agnostic chrome.
const ACHIEVEMENT_SPRITE_KEYS = {
  wins: 'achWins', streak: 'achStreak', speed: 'achSpeed', daily: 'achDaily',
  flagless: 'achFlagless', efficient: 'achEfficient', tankCommander: 'achTankCommander',
  lieDetector: 'achLieDetector', purist: 'achPurist', challengeClimber: 'achChallengeClimber',
  timedSpeed: 'achTimedSpeed', gimmickMaster: 'achGimmickMaster', dailyStreak: 'achDailyStreak',
};

export function achievementSpriteImgHTML(catId, sizeClass = 'sprite-medal', alt = '') {
  const spriteKey = ACHIEVEMENT_SPRITE_KEYS[catId];
  return spriteKey ? spriteImgHTML(spriteKey, sizeClass, alt) : null;
}

// ── Chrome icon sprites (Wave C) ─────────────────────────
// Nav / settings / indicator affordances. uiSpriteImgHTML for HTML
// strings; uiSpriteUrl for toggle buttons whose src flips at runtime
// (mute, notifications). Theme-agnostic, keyed (see the SPRITES note).
export function uiSpriteImgHTML(key, sizeClass = 'ui-icon', alt = '') {
  return SPRITES[key] ? spriteImgHTML(key, sizeClass, alt) : '';
}

export function uiSpriteUrl(key) {
  return SPRITES[key] ? SPRITES[key].url : null;
}
