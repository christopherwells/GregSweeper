// Sprite loader for the Tier 1 default-look icons.
//
// Sprites render only when the resolved emoji (after theme + emoji-pack
// overrides) equals the canonical default for that key — Classic/Dark theme
// plus the Default pack. Themed alternates (Ocean fish, Pirate skull, etc.)
// and pack overrides stay as text emoji so themes keep their personality.

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

export function getSpriteUrl(key, resolvedEmoji) {
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

// Theme-agnostic HTML snippet for surfaces that always show the sprite
// (leaderboard column header, daily/weekly bomb-hit popup).
export function spriteImgHTML(key, sizeClass = '', alt = '') {
  const s = SPRITES[key];
  if (!s) return '';
  const cls = `game-sprite ${sizeClass}`.trim();
  const altAttr = alt ? ` alt="${alt}"` : ' alt=""';
  return `<img class="${cls}" src="${s.url}"${altAttr} decoding="async" draggable="false">`;
}
