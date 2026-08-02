import { test, expect } from '@playwright/test';
import { prepareInteractionSpec } from './helpers.mjs';

// Par Lab journey (test-only ?parlab= surface): the battery mounts its first
// board through the coastline-practice machinery, the HUD drives the
// session, results log to namespaced localStorage, and progress survives a
// reload. Board 1 is the hex warm-up (63 cells), so the spec doubles as a
// boot gate for the lab's board pipeline.

test.beforeEach(async ({ page }) => {
  await prepareInteractionSpec(page);
});

function attachErrorCapture(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  return errors;
}

test('the lab mounts board 1, a skip records and advances, and progress survives reload', async ({ page }) => {
  const errors = attachErrorCapture(page);
  await page.goto('?isTest=1&parlab=1');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 20_000 });

  const hud = page.locator('#parlab-hud');
  await expect(hud).toBeVisible();
  await expect(hud.locator('#parlab-line')).toContainText(/board 1\/\d+/);
  await expect(hud.locator('#parlab-line')).toContainText('warm-up');

  // Board 1 is the hex warm-up: a real tiling board, not a stub.
  await expect(page.locator('#board.tiling-board')).toBeVisible();
  const cells = await page.locator('#board .cell').count();
  expect(cells).toBeGreaterThan(40);

  // Skip records a row and advances the battery.
  await hud.locator('#parlab-skip').click();
  await expect(hud.locator('#parlab-line')).toContainText(/board 2\/\d+/);
  const stored = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('gregsweeper_parlab_v1')); } catch { return null; }
  });
  expect(stored?.rows?.length).toBe(1);
  expect(stored.rows[0].result).toBe('skip');
  expect(stored.rows[0].id).toBe('w-hex-1');

  // Progress is durable: a fresh load resumes at the first unresolved board.
  await page.goto('?isTest=1&parlab=1');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 20_000 });
  await expect(page.locator('#parlab-hud #parlab-line')).toContainText(/board 2\/\d+/);

  expect(errors, `console/page errors during the lab journey:\n${errors.join('\n')}`).toEqual([]);
});

test('plain boots stay lab-free — no HUD outside ?parlab=', async ({ page }) => {
  const errors = attachErrorCapture(page);
  await page.goto('?isTest=1');
  await page.waitForSelector('#title-screen:not(.hidden)', { timeout: 20_000 });
  await expect(page.locator('#parlab-hud')).toHaveCount(0);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
