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

test('REGRESSION: sonar debuts on Paving Stones and its card draws that lattice', async ({ page }) => {
  await openModifierCard(page, 76, 'Sonar');

  const example = page.locator('#gimmick-intro-example');
  // The lattice diagram, not the square grid.
  await expect(example.locator('.gimmick-example-shape svg polygon').first()).toBeAttached();
  await expect(example.locator('.gimmick-example-grid')).toHaveCount(0);

  // The pentagons are really pentagons: five vertices apiece. A square grid
  // rendered as polygons would give four, so this cannot pass on the old
  // markup or on a rectangle drawn through the new path.
  const sides = await example.locator('svg polygon').first()
    .evaluate((el) => el.getAttribute('points').trim().split(/\s+/).length);
  expect(sides).toBe(5);

  // The region is lit, and the copy no longer promises a 5x5 area outright.
  const lit = await example.locator('svg polygon[fill*="region-highlight"]').count();
  expect(lit).toBeGreaterThan(5);
  await expect(page.locator('#gimmick-intro-desc')).not.toHaveText(/5×5 area centered/);
});

test('REGRESSION: compass debuts on Octagons and its card draws a real ray', async ({ page }) => {
  await openModifierCard(page, 91, 'Compass');

  const example = page.locator('#gimmick-intro-example');
  await expect(example.locator('.gimmick-example-shape svg polygon').first()).toBeAttached();

  // A ray of at least three cells, and an arrow from the 8-way set the
  // Octagons lattice carries (the old copy promised rows and columns only).
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
