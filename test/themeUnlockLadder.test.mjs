// Theme unlock ladder: classic + dark free at level 0; the other 24
// themes unlock one per checkpoint — every 5 challenge levels, L5
// through L120, no gaps, no doubles — ordered by visual intensity
// (quiet worlds early, loud worlds late). Parsed from themeManager.js
// source because the module pulls in browser-only UI imports.
//
// Run: node --test test/themeUnlockLadder.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '..', 'src', 'ui', 'themeManager.js'), 'utf8');

// Extract { theme, level } pairs in source order from the THEME_UNLOCKS block.
const block = src.slice(src.indexOf('export const THEME_UNLOCKS'), src.indexOf('};', src.indexOf('export const THEME_UNLOCKS')));
const entries = [...block.matchAll(/^\s{2}(\w+):\s*\{\s*levelRequired:\s*(\d+)/gm)]
  .map(m => ({ theme: m[1], level: Number(m[2]) }));

const MAX_CHALLENGE_LEVEL = 120;
const STEP = 5;

test('classic and dark are free at level 0, and nothing else is', () => {
  const free = entries.filter(e => e.level === 0).map(e => e.theme).sort();
  assert.deepEqual(free, ['classic', 'dark']);
});

test('the 24 unlockable themes sit at exactly every 5th level, 5 through 120', () => {
  const levels = entries.filter(e => e.level > 0).map(e => e.level).sort((a, b) => a - b);
  const expected = [];
  for (let l = STEP; l <= MAX_CHALLENGE_LEVEL; l += STEP) expected.push(l);
  assert.deepEqual(levels, expected,
    'unlock levels must be the multiples of 5 from 5 to 120 with no gaps or doubles');
});

test('registry entries are listed in unlock order (drives the Collection grid)', () => {
  for (let i = 1; i < entries.length; i++) {
    assert.ok(entries[i].level >= entries[i - 1].level,
      `${entries[i].theme} (L${entries[i].level}) is listed before ${entries[i - 1].theme} (L${entries[i - 1].level})`);
  }
});
