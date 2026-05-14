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
};

export function preloadSprites() {
  for (const s of Object.values(SPRITES)) {
    const img = new Image();
    img.src = s.url;
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
  return `<img class="${cls}" src="${s.url}"${altAttr} draggable="false">`;
}
