import { test, expect } from '@playwright/test';
import { prepareInteractionSpec } from './helpers.mjs';

// REGRESSION (2026-07-10 audit): the #gameover-overlay is one shared surface,
// and its optional sections used to persist between renders — a loss after a
// daily/weekly win showed the previous win's par line (the weekly variant
// carries a whole leaderboard in there) and history dots, and a timed loss
// after a daily win had NO Play Again button. The fix applies a complete
// visibility plan (src/logic/gameoverPlan.js) at the top of every render.
//
// This spec drives it end-to-end: pre-pollute the modal with exactly the
// leftovers a previous win render produces (par + dots visible, retry
// hidden), then finish a REAL challenge game (clicking a 5x5 with 2 mines
// until it ends — win or loss, both are valid ends) and assert the render
// cleared the stale sections and settled the action buttons.

test.beforeEach(async ({ page }) => {
  await prepareInteractionSpec(page);
});

test('REGRESSION: a game-over render clears stale sections and always offers its action button', async ({ page }) => {
  await page.goto('?isTest=1');
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 20_000 });
  await page.waitForSelector('#title-screen:not(.hidden)', { timeout: 20_000 });
  await page.click('.mode-card[data-mode="normal"]');
  await page.waitForSelector('#checkpoint-list .checkpoint-btn', { timeout: 10_000 });
  await page.click('#checkpoint-list .checkpoint-btn');
  await page.waitForSelector('#board .cell[data-row="0"][data-col="0"]', { timeout: 20_000 });

  // Simulate the leftovers of a previous daily/weekly win render.
  await page.evaluate(() => {
    const par = document.getElementById('gameover-par');
    par.classList.remove('hidden');
    par.innerHTML = '<span id="stale-par-sentinel">Your par 110.5s</span>';
    document.getElementById('gameover-history-dots').classList.remove('hidden');
    document.getElementById('gameover-retry').classList.add('hidden');
    document.getElementById('gameover-done').classList.remove('hidden');
  });

  // Play the 5x5 L1 board to ANY end: click unrevealed cells until the
  // overlay appears (a mine ends it as a loss; clearing every safe cell
  // ends it as a win — the modal follows the victory animation by ~2s).
  const overlayVisible = () =>
    page.evaluate(() => {
      const el = document.getElementById('gameover-overlay');
      return !!el && !el.classList.contains('hidden');
    });
  for (let i = 0; i < 40 && !(await overlayVisible()); i++) {
    const cell = page.locator('#board .cell.unrevealed').first();
    if ((await cell.count()) === 0) break;
    await cell.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(150);
  }
  await page.waitForFunction(() => {
    const el = document.getElementById('gameover-overlay');
    return !!el && !el.classList.contains('hidden');
  }, undefined, { timeout: 15_000 });

  // Outcome-independent pins: the stale win furniture is gone (a challenge
  // end never shows par or dots) and the mode's action buttons are settled.
  await expect(page.locator('#gameover-par')).toBeHidden();
  await expect(page.locator('#gameover-history-dots')).toBeHidden();
  await expect(page.locator('#gameover-retry')).toBeVisible();
  await expect(page.locator('#gameover-done')).toBeHidden();

  // Outcome-specific action button.
  const title = await page.locator('#gameover-title').textContent();
  if (title === 'You Win!') {
    await expect(page.locator('#gameover-share')).toBeVisible();
  } else {
    await expect(page.locator('#gameover-explore')).toBeVisible();
    await expect(page.locator('#gameover-share')).toBeHidden();
  }
});
