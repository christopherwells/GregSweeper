// Sprite resolution chain:
//  - The canonical Greg PNGs (idle/win/loss.png) render ONLY on
//    Classic/Dark, where the smiley resolves to 😊/😎/😵.
//  - Every other (themed) world renders its OWN themed Greg SVG in the
//    three smiley slots (assets/sprites/greg/themed-<world>-<pose>.svg),
//    wired for all 24 worlds 2026-06-13.
//  - A theme's own object sprite (mine/flag/strike) still wins over the
//    Tier 1 set.
//  - Avatar surfaces (field note, win modal, ghost row) use spriteImgHTML
//    and ALWAYS show the canonical Greg PNG regardless of theme.
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

test('every themed world renders its own themed Greg in all three smiley slots', () => {
  const poseFor = { smiley: 'idle', smileyWin: 'win', smileyLoss: 'loss' };
  for (const [theme, info] of Object.entries(THEME_UNLOCKS)) {
    if (theme === 'classic' || theme === 'dark') continue;
    currentTheme = theme;
    for (const key of ['smiley', 'smileyWin', 'smileyLoss']) {
      const resolved = info[key];
      assert.ok(resolved, `${theme} must define ${key}`);
      const url = getSpriteUrl(key, resolved);
      const expected = `assets/sprites/greg/themed-${theme}-${poseFor[key]}.svg`;
      assert.equal(url, expected,
        `${theme}'s ${key} (${resolved}) must resolve to its themed Greg, got ${url}`);
      // The canonical Greg PNGs must never leak into a theme.
      for (const canon of ['idle', 'win', 'loss']) {
        assert.notEqual(url, `assets/sprites/${canon}.png`,
          `${theme}'s ${key} leaked the canonical Greg`);
      }
      // ...and the themed file must exist on disk.
      assert.ok(existsSync(join(repoRoot, url)), `missing ${url}`);
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
  // a7b is the shipped SVG master (the a7 blend with the open smile that
  // matches idle.png); export-greg-sprites.ps1 -Direction a7b rasterizes
  // these to the PNGs above. Superseded first-round candidates (a/b/c and
  // the a-a7g drill-down) live in greg/_exploration/, not greg/.
  for (const p of ['idle', 'win', 'loss']) {
    assert.ok(existsSync(join(repoRoot, 'assets', 'sprites', 'greg', `a7b-${p}.svg`)),
      `missing greg master a7b-${p}.svg`);
  }
  assert.ok(existsSync(join(repoRoot, 'assets', 'og-card.png')), 'missing og-card.png');
});

test('every THEME_SPRITES path in spriteLoader source exists on disk', () => {
  const src = readFileSync(join(repoRoot, 'src', 'ui', 'spriteLoader.js'), 'utf8');
  const paths = [...src.matchAll(/T \+ '([^']+\.svg)'/g)].map(m => 'assets/sprites/themes/' + m[1]);
  assert.ok(paths.length >= 30, `expected the theme sprite registry, found ${paths.length} paths`);
  for (const p of paths) {
    assert.ok(existsSync(join(repoRoot, p)), `missing ${p}`);
  }
});

test('the title mascot SVG carries its animation hooks and the unclipped viewBox', async () => {
  // The animated front-door Greg (src/ui/gregMascot.js) finds the eyes and
  // smile by class to blink and flip; a rename would silently kill the
  // animation. Pin the hooks and the 2026-06-25 re-framed (unclipped) viewBox.
  const { GREG_MASCOT_SVG } = await import('../src/ui/gregMascot.js');
  for (const cls of ['greg-smile', 'greg-eyes-open', 'greg-eyes-closed']) {
    assert.ok(GREG_MASCOT_SVG.includes(cls), `mascot SVG missing .${cls} — the idle animation would break`);
  }
  assert.match(GREG_MASCOT_SVG, /viewBox="-8\.18 -4\.71 140\.52 140\.52"/,
    'mascot must use the re-framed unclipped viewBox so the clipboard is not cut');
});
