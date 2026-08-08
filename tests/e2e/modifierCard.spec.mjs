// The first-encounter modifier card, on the board shape it debuts on.
//
// REGRESSION (2026-08-04): six of the nine ladder modifiers debut on a
// tiling, and every card's diagram was a 3x3 grid of squares. The copy half
// of that defect is pinned in test/modifierCopy.test.mjs, which is the
// cheaper layer; what a pure test cannot claim is that the card the player
// actually sees carries the lattice diagram rather than the square one, and
// that a Classic debut still carries the square one. That is this file.

import { test, expect } from '@playwright/test';
import { prepareInteractionSpec } from './helpers.mjs';
import { challengeSpecForLevel, MOD_INTRO_BLOCKS, CHALLENGE_BLOCK_SIZE } from '../../src/logic/challenge250.js';
import { buildTiling } from '../../src/logic/tilingGeometry.js';

/**
 * WHERE a modifier debuts is DERIVED from the pool now, not authored, so this
 * file reads it rather than writing it down. Hardcoding the level is what
 * broke these two specs when the ladder moved to a pool: sonar had been pinned
 * to L76 on Paving Stones and compass to L91, and both levels now carry
 * something else entirely.
 */
function debutOf(modifier) {
  const block = Number(Object.entries(MOD_INTRO_BLOCKS).find(([, g]) => g === modifier)[0]);
  const level = (block - 1) * CHALLENGE_BLOCK_SIZE + 1;
  return { level, spec: challengeSpecForLevel(level) };
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
async function openModifierCard(page, level, modifierName) {
  await prepareInteractionSpec(page);
  await page.goto(`/?isTest=1&level=${level}`);
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

test('REGRESSION: sonar debuts on a lattice and its card draws THAT lattice', async ({ page }) => {
  const { level, spec } = debutOf('sonar');
  test.skip(spec.shape === 'rect', 'sonar debuts on Classic in this pool — the square markup is correct there');
  await openModifierCard(page, level, 'Sonar');

  const example = page.locator('#gimmick-intro-example');
  // The lattice diagram, not the square grid.
  await expect(example.locator('.gimmick-example-shape svg polygon').first()).toBeAttached();
  await expect(example.locator('.gimmick-example-grid')).toHaveCount(0);

  // The cells are really that lattice's cells. Vertex counts come from the
  // geometry, so this stays exact wherever sonar debuts and still cannot pass
  // on the square markup (which draws no polygon) or on a rectangle.
  const sides = await example.locator('svg polygon').first()
    .evaluate((el) => el.getAttribute('points').trim().split(/\s+/).length);
  expect(vertexCounts(spec.shape)).toContain(sides);

  // The region is lit, and the copy no longer promises a 5x5 area outright.
  const lit = await example.locator('svg polygon[fill*="region-highlight"]').count();
  expect(lit).toBeGreaterThan(5);
  await expect(page.locator('#gimmick-intro-desc')).not.toHaveText(/5×5 area centered/);
});

test('REGRESSION: compass debuts on a lattice and its card draws a real ray', async ({ page }) => {
  const { level, spec } = debutOf('compass');
  test.skip(spec.shape === 'rect', 'compass debuts on Classic in this pool — the square markup is correct there');
  await openModifierCard(page, level, 'Compass');

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
