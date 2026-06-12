// Sprite resolution chain: the Greg Tier 1 sprites (idle/win/loss.png)
// render ONLY when the resolved emoji equals the canonical default
// (😊/😎/😵 — i.e. the Classic/Dark themes), and a theme's own object
// sprite always wins over the Tier 1 set. Greg must never override a
// theme's smiley identity; themes that override the smiley emoji keep
// their emoji (or their own drawn sprite) verbatim.
//
// Run: node --test test/spriteChain.test.mjs

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// spriteLoader imports themeManager (browser-only UI module), so stub
// the DOM surface its import chain touches at module evaluation. The
// active theme is routed through a mutable variable so each test can
// flip it.
let currentTheme = 'classic';
globalThis.document = {
  documentElement: { getAttribute: () => currentTheme },
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {} }),
  head: { appendChild: () => {} },
  body: { appendChild: () => {} },
  addEventListener: () => {},
};
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

let getSpriteUrl, spriteImgHTML, THEME_UNLOCKS;
before(async () => {
  ({ getSpriteUrl, spriteImgHTML } = await import('../src/ui/spriteLoader.js'));
  ({ THEME_UNLOCKS } = await import('../src/ui/themeManager.js'));
});

test('classic theme resolves the three Greg smiley slots to the PNG files', () => {
  currentTheme = 'classic';
  assert.equal(getSpriteUrl('smiley', '😊'), 'assets/sprites/idle.png');
  assert.equal(getSpriteUrl('smileyWin', '😎'), 'assets/sprites/win.png');
  assert.equal(getSpriteUrl('smileyLoss', '😵'), 'assets/sprites/loss.png');
});

test('a theme that overrides the smiley emoji keeps it: Greg never renders there', () => {
  for (const [theme, info] of Object.entries(THEME_UNLOCKS)) {
    if (theme === 'classic' || theme === 'dark') continue;
    currentTheme = theme;
    for (const key of ['smiley', 'smileyWin', 'smileyLoss']) {
      const resolved = info[key];
      assert.ok(resolved, `${theme} must define ${key}`);
      assert.notEqual(
        getSpriteUrl(key, resolved), `assets/sprites/idle.png`,
        `${theme}'s ${key} (${resolved}) must not resolve to Greg's idle sprite`);
      // Theme smiley emoji are never the canonical defaults, so the
      // Tier 1 sprites must not fire at all on these themes.
      const url = getSpriteUrl(key, resolved);
      assert.ok(url === null || !url.startsWith('assets/sprites/idle')
        && !String(url).startsWith('assets/sprites/win')
        && !String(url).startsWith('assets/sprites/loss'),
        `${theme}'s ${key} resolved to a Greg slot: ${url}`);
    }
  }
});

test('a theme object sprite wins over the Tier 1 set (comic mine over mine.png)', () => {
  // Comic's mine emoji IS the canonical 💣, so this proves the theme
  // sprite is consulted BEFORE the Tier 1 fallback would match.
  currentTheme = 'comic';
  assert.equal(getSpriteUrl('mine', '💣'), 'assets/sprites/themes/comic-mine.svg');
  currentTheme = 'classic';
  assert.equal(getSpriteUrl('mine', '💣'), 'assets/sprites/mine.png');
});

test('spriteImgHTML always emits the Tier 1 sprite (theme-agnostic avatar surfaces)', () => {
  currentTheme = 'comic';
  const html = spriteImgHTML('smiley', 'sprite-greg-par', 'Greg');
  assert.match(html, /assets\/sprites\/idle\.png/,
    'avatar surfaces (field note, win modal, ghost row) must show Greg regardless of theme');
});

test('the exported Greg PNGs and SVG masters exist on disk', () => {
  for (const f of ['idle.png', 'win.png', 'loss.png']) {
    assert.ok(existsSync(join(repoRoot, 'assets', 'sprites', f)), `missing assets/sprites/${f}`);
  }
  for (const d of ['a', 'b', 'c']) {
    for (const p of ['idle', 'win', 'loss']) {
      assert.ok(existsSync(join(repoRoot, 'assets', 'sprites', 'greg', `${d}-${p}.svg`)),
        `missing greg master ${d}-${p}.svg`);
    }
  }
  assert.ok(existsSync(join(repoRoot, 'assets', 'og-card.svg')), 'missing og-card.svg master');
  assert.ok(existsSync(join(repoRoot, 'assets', 'og-card.png')), 'missing og-card.png export');
});

test('every THEME_SPRITES path in spriteLoader source exists on disk', () => {
  const src = readFileSync(join(repoRoot, 'src', 'ui', 'spriteLoader.js'), 'utf8');
  const paths = [...src.matchAll(/T \+ '([^']+\.svg)'/g)].map(m => 'assets/sprites/themes/' + m[1]);
  assert.ok(paths.length >= 30, `expected the theme sprite registry, found ${paths.length} paths`);
  for (const p of paths) {
    assert.ok(existsSync(join(repoRoot, p)), `missing ${p}`);
  }
});
