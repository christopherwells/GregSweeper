// Theme unlock ladder: classic + dark free at level 0; the other 24
// themes re-spread across the Challenge 250 ladder — the first at the
// opener capstone L25 (clearing the openers, the door to the shapes),
// then one every 10 levels from L30 to L250, so Legendary lands on the
// crown. Ordered by visual intensity (quiet worlds early, loud worlds
// late). Parsed from themeManager.js source because the module pulls in
// browser-only UI imports.
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

const FIRST_UNLOCK = 25;   // the opener capstone checkpoint
const STEP = 10;           // one theme every two blocks thereafter

test('classic and dark are free at level 0, and nothing else is', () => {
  const free = entries.filter(e => e.level === 0).map(e => e.theme).sort();
  assert.deepEqual(free, ['classic', 'dark']);
});

test('the 24 unlockable themes sit at L25, then every 10th level to the L250 crown', async () => {
  const { CHALLENGE_MAX_LEVEL, CHALLENGE_BLOCK_SIZE } = await import('../src/logic/challenge250.js');
  const levels = entries.filter(e => e.level > 0).map(e => e.level).sort((a, b) => a - b);
  const expected = [FIRST_UNLOCK];
  for (let l = 30; l <= CHALLENGE_MAX_LEVEL; l += STEP) expected.push(l);
  assert.deepEqual(levels, expected,
    'unlock levels must be L25 then every 10th level to 250, with no gaps or doubles');
  // Every unlock must land ON a checkpoint (a block boundary), or a
  // player could pass it mid-block and never see the reward moment.
  for (const l of levels) {
    assert.equal(l % CHALLENGE_BLOCK_SIZE, 0, `L${l} is not a checkpoint level`);
  }
  assert.equal(levels[levels.length - 1], CHALLENGE_MAX_LEVEL, 'the last theme lands on the crown');
});

test('registry entries are listed in unlock order (drives the Collection grid)', () => {
  for (let i = 1; i < entries.length; i++) {
    assert.ok(entries[i].level >= entries[i - 1].level,
      `${entries[i].theme} (L${entries[i].level}) is listed before ${entries[i - 1].theme} (L${entries[i - 1].level})`);
  }
});
