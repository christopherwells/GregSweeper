// The first-encounter modifier card, on the board shape it debuts on.
//
// REGRESSION (2026-08-04): six of the nine ladder modifiers debut on a
// tiling, and every card's diagram was a 3x3 grid of squares. The copy half
// of that defect is pinned in test/modifierCopy.test.mjs, which is the
// cheaper layer; what a pure test cannot claim is that the card the player
// actually sees carries the lattice diagram rather than the square one, and
// that a Classic debut still carries the square one. That is this file.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { prepareInteractionSpec } from './helpers.mjs';
import { CHALLENGE_BLOCK_SIZE } from '../../src/logic/challenge250.js';
import { LIB_MOD_INTROS } from '../../src/logic/climbLibrary.js';
import { buildTiling } from '../../src/logic/tilingGeometry.js';

/**
 * WHERE a modifier debuts follows the LIBRARY's schedule now: ?level= deals
 * from the level's pre-generated bin, so the braid's spec for that slot says
 * nothing about the board on screen. The venue is read from the committed
 * level file itself, and the &board= practice override pins the exact bin
 * index so the dealt lattice is deterministic per run. Hardcoding a level
 * is what broke this spec twice (the pool move, then the library move).
 */
function debutOf(modifier) {
  const block = Number(Object.entries(LIB_MOD_INTROS).find(([, g]) => g === modifier)[0]);
  const level = (block - 1) * CHALLENGE_BLOCK_SIZE + 1;
  // Blocks 2-4 debut inside the authored openers (L1-25), which have no
  // bin file and stay drawn; only library levels can pin a bin index.
  if (level < 26) return { level, board: -1, spec: null };
  const bin = JSON.parse(readFileSync(new URL(
    `../../scripts/data/climb-library/level-${String(level).padStart(3, '0')}.json`,
    import.meta.url), 'utf8'));
  // A modifier-debut bin carries the debut mod on every board; take the
  // first LATTICE board for the diagram tests, if the bin holds one.
  const board = bin.boards.findIndex((b) => b.spec.shape !== 'rect');
  return { level, board, spec: board >= 0 ? bin.boards[board].spec : bin.boards[0].spec };
}

/**
 * The first modifier (in schedule order) whose debut bin holds a lattice
 * board: sonar now debuts at L26, where only Classic is introduced, so the
 * lattice-diagram regression keys off whichever debut genuinely lands on a
 * lattice rather than skipping itself vacuously.
 */
function firstLatticeDebut() {
  const blocks = Object.keys(LIB_MOD_INTROS).map(Number).sort((a, b) => a - b);
  for (const b of blocks) {
    const mod = LIB_MOD_INTROS[b];
    const d = debutOf(mod);
    if (d.board >= 0) return { mod, ...d };
  }
  return null;
}

/**
 * How many vertices the debut lattice's own cells have, taken from the
 * geometry rather than written down. This is the non-vacuity guard: the square
 * markup path renders no polygon at all, and a rectangle drawn through the new
 * path would give four, so matching the real cell's vertex count proves the
 * card drew THIS lattice and not merely some lattice.
 */
function vertexCounts(shape) {
  const t = buildTiling(shape, 4, 4);
  return [...new Set(t.cellVerts.map((v) => v.length))];
}

/** Open a ladder level and click through to the named modifier's own card. */
async function openModifierCard(page, level, modifierName, board = null) {
  await prepareInteractionSpec(page);
  const boardParam = board != null && board >= 0 ? `&board=${board}` : '';
  await page.goto(`/?isTest=1&level=${level}${boardParam}`);
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 30_000 });
  await page.waitForSelector('#board .cell', { timeout: 30_000 });
  await page.click('#board .cell.suggested-start');

  // On a lattice the shape card comes first, and a player who has never met
  // a modifier gets the one-time primer before the modifier's own card.
  if (await page.locator('#shape-intro-overlay:not(.hidden)').count()) {
    await page.click('#shape-intro-ok');
  }
  await page.waitForSelector('#gimmick-intro-overlay:not(.hidden)', { timeout: 15_000 });
  for (let i = 0; i < 4; i++) {
    const heading = await page.locator('#gimmick-intro-name').textContent();
    if (heading === `Modifier: ${modifierName}`) return;
    await page.click('#gimmick-intro-ok');
    await page.waitForTimeout(100);
  }
  throw new Error(`never reached the ${modifierName} card at L${level}`);
}

test('REGRESSION: a lattice debut draws THAT lattice on its card', async ({ page }) => {
  const d = firstLatticeDebut();
  test.skip(!d, 'no modifier-debut bin holds a lattice board in this library');
  const { getGimmickDefs } = await import('../../src/logic/gimmicks.js');
  const modifierName = getGimmickDefs()[d.mod].name;
  await openModifierCard(page, d.level, modifierName, d.board);

  const example = page.locator('#gimmick-intro-example');
  // The lattice diagram, not the square grid.
  await expect(example.locator('.gimmick-example-shape svg polygon').first()).toBeAttached();
  await expect(example.locator('.gimmick-example-grid')).toHaveCount(0);

  // The cells are really that lattice's cells. Vertex counts come from the
  // geometry, so this stays exact wherever the debut lands and still cannot
  // pass on the square markup (which draws no polygon) or on a rectangle.
  const sides = await example.locator('svg polygon').first()
    .evaluate((el) => el.getAttribute('points').trim().split(/\s+/).length);
  expect(vertexCounts(d.spec.shape)).toContain(sides);
});

test('REGRESSION: compass on a lattice draws a real ray on its card', async ({ page }) => {
  const { level, board, spec } = debutOf('compass');
  test.skip(board < 0, 'the compass debut bin holds no lattice board in this library');
  await openModifierCard(page, level, 'Compass', board);

  const example = page.locator('#gimmick-intro-example');
  await expect(example.locator('.gimmick-example-shape svg polygon').first()).toBeAttached();

  // A ray of at least three cells, and an arrow from one of the direction
  // sets a lattice can carry (the old copy promised rows and columns only).
  const lit = await example.locator('svg polygon[fill*="region-highlight"]').count();
  expect(lit).toBeGreaterThanOrEqual(3);
  await expect(example.locator('.ge-shape-compass')).toHaveText(/[←→↑↓↖↗↙↘]/);
  await expect(page.locator('#gimmick-intro-desc')).not.toHaveText(/full row or column/);
});

test('a Classic debut still shows the shipped square example', async ({ page }) => {
  // The compatibility half: walls debuts at L6 on a rectangle, where the
  // authored markup is the honest picture and must render untouched.
  await openModifierCard(page, 6, 'Walls');

  const example = page.locator('#gimmick-intro-example');
  await expect(example.locator('.gimmick-example-grid')).toHaveCount(1);
  await expect(example.locator('.gimmick-example-shape')).toHaveCount(0);
});
