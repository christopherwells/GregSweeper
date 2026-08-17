// THE THEME SHELF (his ruling, 2026-08-16): five themes ship, all free
// from the start (classic, dark, forest, matrix, nest, the five that got
// the title-polish pass); the other 21 are SHELVED, invisible on a
// production build and reachable only through the preview door, until
// they return via the test track. The 26-theme count doctrine is
// untouched: nothing is deleted, the ladder is dormant, and re-laddering
// when themes return is a fresh design decision.
//
// Parsed from themeManager.js source because the module pulls in
// browser-only UI imports. index.html's pre-boot script carries its own
// copy of the live list (it runs before any module loads, to keep a
// shelved saved theme off the boot overlay), so the two are pinned in
// lockstep here: a drift ships a first-paint theme main.js then yanks.
//
// Run: node --test test/themeUnlockLadder.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '..', 'src', 'ui', 'themeManager.js'), 'utf8');
const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

// Extract { theme, level } pairs in source order from the THEME_UNLOCKS block.
const block = src.slice(src.indexOf('export const THEME_UNLOCKS'), src.indexOf('};', src.indexOf('export const THEME_UNLOCKS')));
const entries = [...block.matchAll(/^\s{2}(\w+):\s*\{\s*levelRequired:\s*(\d+)/gm)]
  .map(m => ({ theme: m[1], level: Number(m[2]) }));

// The declared live list, from its own export.
const liveMatch = src.match(/export const LIVE_THEMES = \[([^\]]+)\]/);
const LIVE = liveMatch ? [...liveMatch[1].matchAll(/'(\w+)'/g)].map(m => m[1]) : [];

const HIS_FIVE = ['classic', 'dark', 'forest', 'matrix', 'nest'];

test('the live shelf is exactly his five, free at level 0, listed first', () => {
  // "Drop legendary. I said 5." — the ruling is the list, verbatim.
  assert.deepEqual(LIVE, HIS_FIVE);
  assert.deepEqual(entries.slice(0, 5).map(e => e.theme), HIS_FIVE,
    'the five live themes must lead the registry (the Collection renders in this order)');
  for (const e of entries.slice(0, 5)) {
    assert.equal(e.level, 0, `${e.theme} must be free at level 0 ("just unlocked for now")`);
  }
});

test('the 26-theme count doctrine survives the shelf: 21 shelved, nothing deleted', () => {
  assert.equal(entries.length, 26, 'the catalog stays at 26 themes; the shelf hides, never cuts');
  const shelved = entries.slice(5).map(e => e.theme);
  assert.equal(shelved.length, 21);
  for (const t of shelved) {
    assert.ok(!LIVE.includes(t), `${t} is listed in the shelved half but also declared live`);
  }
  // Legendary is shelved WITH the rest ("Drop legendary. I said 5.").
  assert.ok(shelved.includes('legendary'));
});

test('shelved entries keep their dormant ladder values (the historical record)', () => {
  // The values are deliberately retained, not zeroed: zero would read as
  // "free", and the shelf means "not earnable at any level". The guards
  // that keep them dormant are pinned below.
  for (const e of entries.slice(5)) {
    assert.ok(e.level > 0, `${e.theme} is shelved and must not read as free (level 0)`);
  }
});

test('the shelf guards are wired: unlock reporting, unlock moments, the Collection render', () => {
  // getUnlockedThemes must gate on LIVE_THEMES (a shelved theme reporting
  // unlocked would surface in the carousel and the in-game cycle).
  const unlockFn = src.slice(src.indexOf('export function getUnlockedThemes'), src.indexOf('\n}', src.indexOf('export function getUnlockedThemes')));
  assert.match(unlockFn, /LIVE_THEMES\.includes\(theme\)/,
    'getUnlockedThemes must consult LIVE_THEMES');
  // checkThemeUnlocks must skip shelved themes (a toast for a theme the
  // Collection does not show would be a lie).
  const checkFn = src.slice(src.indexOf('export function checkThemeUnlocks'), src.indexOf('\n}', src.indexOf('export function checkThemeUnlocks')));
  assert.match(checkFn, /LIVE_THEMES\.includes\(theme\)/,
    'checkThemeUnlocks must skip shelved themes');
  // The Collection render skips shelved themes entirely rather than
  // rendering them locked.
  const mainSrc = readFileSync(join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(mainSrc, /if \(isThemeShelved\(theme\)\) continue;/,
    'renderCollectionModal must skip shelved themes');
});

test('LOCKSTEP: index.html\'s pre-boot live list matches LIVE_THEMES verbatim', () => {
  const m = html.match(/var LIVE = \[([^\]]+)\]/);
  assert.ok(m, 'index.html must carry the pre-boot live-theme list');
  const inline = [...m[1].matchAll(/'(\w+)'/g)].map(x => x[1]);
  assert.deepEqual(inline, LIVE,
    'the pre-boot list drifted from LIVE_THEMES; a saved theme on the wrong side flashes at first paint');
});
