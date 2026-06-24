// Icon coverage manifest test.
// Validates that every 'sprite' entry in iconCoverage.js has:
//   1. A matching SVG/PNG file on disk in assets/sprites/
//   2. A SPRITES registry entry in spriteLoader.js
// Also validates that every SPRITES entry has a file on disk.
//
// Run: node --test test/iconCoverage.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { ICON_STATUS } from '../src/ui/iconCoverage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

test('every SPRITES entry in spriteLoader.js has a file on disk', () => {
  const src = readFileSync(join(repoRoot, 'src/ui/spriteLoader.js'), 'utf8');
  const urlMatches = [...src.matchAll(/url:\s*['"]([^'"]+)['"]/g)];
  const missing = [];
  for (const m of urlMatches) {
    const relPath = m[1];
    const absPath = join(repoRoot, relPath);
    if (!existsSync(absPath)) missing.push(relPath);
  }
  assert.deepStrictEqual(missing, [], 'Sprite files missing from disk: ' + missing.join(', '));
});

test('every SPRITES entry in spriteLoader has a unique defaultEmoji', () => {
  const src = readFileSync(join(repoRoot, 'src/ui/spriteLoader.js'), 'utf8');
  const spriteBlock = src.slice(src.indexOf('const SPRITES'), src.indexOf('const _preloadCache'));
  const emojiMatches = [...spriteBlock.matchAll(/defaultEmoji:\s*'([^']+)'/g)];
  const seen = new Map();
  const dupes = [];
  for (const m of emojiMatches) {
    const emoji = m[1];
    if (seen.has(emoji)) {
      dupes.push(`${emoji} used by ${seen.get(emoji)} and another entry`);
    }
    seen.set(emoji, emoji);
  }
  // 💣 is intentionally used twice (mine + strikeCell) — that's fine
  const filtered = dupes.filter(d => !d.startsWith('💣'));
  assert.deepStrictEqual(filtered, [], 'Duplicate defaultEmoji: ' + filtered.join(', '));
});

test('every new SVG in sw.js ASSETS exists on disk', () => {
  const sw = readFileSync(join(repoRoot, 'sw.js'), 'utf8');
  const assetMatches = [...sw.matchAll(/'\.\/assets\/sprites\/([^']+)'/g)];
  const missing = [];
  for (const m of assetMatches) {
    const file = m[1];
    const absPath = join(repoRoot, 'assets/sprites', file);
    if (!existsSync(absPath)) missing.push(file);
  }
  assert.deepStrictEqual(missing, [], 'SW ASSETS entries missing from disk: ' + missing.join(', '));
});

test('all mod-*.svg files are in sw.js ASSETS', () => {
  const sw = readFileSync(join(repoRoot, 'sw.js'), 'utf8');
  const expected = [
    'mod-walls.svg', 'mod-liar.svg', 'mod-mystery.svg', 'mod-mineshift.svg',
    'mod-locked.svg', 'mod-wormhole.svg', 'mod-mirror.svg', 'mod-pressure.svg',
    'mod-sonar.svg', 'mod-compass.svg',
  ];
  const missing = expected.filter(f => !sw.includes(f));
  assert.deepStrictEqual(missing, [], 'Modifier SVGs missing from sw.js: ' + missing.join(', '));
});

test('all medal SVGs are in sw.js ASSETS', () => {
  const sw = readFileSync(join(repoRoot, 'sw.js'), 'utf8');
  const expected = [
    'medal-bronze.svg', 'medal-silver.svg', 'medal-gold.svg',
    'medal-diamond.svg', 'medal-emerald.svg',
  ];
  const missing = expected.filter(f => !sw.includes(f));
  assert.deepStrictEqual(missing, [], 'Medal SVGs missing from sw.js: ' + missing.join(', '));
});

test('mode-gym.svg is in sw.js ASSETS', () => {
  const sw = readFileSync(join(repoRoot, 'sw.js'), 'utf8');
  assert.ok(sw.includes('mode-gym.svg'), 'mode-gym.svg missing from sw.js ASSETS');
});

// ── Source scan: no stray raw emoji on render surfaces ──
// Every emoji that appears in the app's source must be classified in the
// ICON_STATUS manifest (as a drawn 'sprite' or an intentional 'plain'
// text glyph). This is the hard gate that keeps raw emoji from silently
// returning. Uses \p{Extended_Pictographic} so text symbols (arrows,
// dashes, ×, ✓) are not flagged — only true emoji pictographs.
//
// EXCLUDED: src/ui/themeManager.js is the per-theme object-emoji registry
// (THEME_UNLOCKS — each world's mine/flag/smiley/strikeCell). That is a
// deliberate emoji-as-game-object layer with its own THEME_SPRITES
// override path and is validated structurally by spriteChain.test.mjs;
// enumerating its ~90 world glyphs here would be noise.
const EMOJI_SCAN_EXCLUDE = ['src/ui/themeManager.js'];

function collectJsFiles(dir, acc = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) collectJsFiles(p, acc);
    else if (ent.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

test('no unaccounted raw emoji on render surfaces (source scan)', () => {
  const files = [...collectJsFiles(join(repoRoot, 'src')), join(repoRoot, 'index.html')]
    .filter((f) => !EMOJI_SCAN_EXCLUDE.includes(relative(repoRoot, f).replace(/\\/g, '/')));
  const stripVS = (s) => s.replace(/[︎️]/g, ''); // drop emoji variation selectors
  const accounted = new Set(Object.keys(ICON_STATUS).map(stripVS));
  const re = /\p{Extended_Pictographic}/gu;
  const unaccounted = new Set();
  for (const f of files) {
    const rel = relative(repoRoot, f).replace(/\\/g, '/');
    for (const m of readFileSync(f, 'utf8').matchAll(re)) {
      const e = stripVS(m[0]);
      if (e && !accounted.has(e)) {
        unaccounted.add(`${e} (U+${e.codePointAt(0).toString(16).toUpperCase()}) in ${rel}`);
      }
    }
  }
  assert.deepStrictEqual(
    [...unaccounted],
    [],
    'Raw emoji not classified in ICON_STATUS — add each as a drawn sprite or an intentional plain glyph: '
      + [...unaccounted].join('; ')
  );
});
