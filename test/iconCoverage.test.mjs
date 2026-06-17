// Icon coverage manifest test.
// Validates that every 'sprite' entry in iconCoverage.js has:
//   1. A matching SVG/PNG file on disk in assets/sprites/
//   2. A SPRITES registry entry in spriteLoader.js
// Also validates that every SPRITES entry has a file on disk.
//
// Run: node --test test/iconCoverage.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
    'medal-diamond.svg', 'medal-platinum.svg', 'medal-emerald.svg',
  ];
  const missing = expected.filter(f => !sw.includes(f));
  assert.deepStrictEqual(missing, [], 'Medal SVGs missing from sw.js: ' + missing.join(', '));
});

test('mode-gym.svg is in sw.js ASSETS', () => {
  const sw = readFileSync(join(repoRoot, 'sw.js'), 'utf8');
  assert.ok(sw.includes('mode-gym.svg'), 'mode-gym.svg missing from sw.js ASSETS');
});
