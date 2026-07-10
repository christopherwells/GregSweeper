import { test, expect } from '@playwright/test';

// REGRESSION (2026-07-10 audit): flags placed BEFORE the first click sit on
// the placeholder board (challenge/timed generate the real layout on the
// first click, and generateBoard returns fresh cell objects), so the flags
// silently vanish — but state.flagCount was never reset, leaving the mine
// counter reading totalMines - N for the whole game, and (in timed, which
// had no post-generation full re-render) stale flag icons painted on cells
// whose state said unflagged. The fix zeroes flagCount and re-renders every
// cell when the real board lands.
//
// The assertions read the counter relative to its own initial value, so the
// spec doesn't hardcode per-level mine counts.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('minesweeper_onboarded', 'true'); } catch {}
    // No service worker in gameplay journeys: the app reloads itself when a
    // fresh SW claims the page (by design on real boots), and under parallel
    // e2e load that first-install reload lands MID-JOURNEY, detaching the DOM
    // between clicks. The SW lifecycle is the boot smoke's concern.
    if (navigator.serviceWorker) {
      navigator.serviceWorker.register = () => new Promise(() => {});
    }
  });
});

async function counterValue(page) {
  const text = await page.locator('#mine-counter').textContent();
  return parseInt(text, 10);
}

async function flagTwoThenFirstClick(page) {
  await page.waitForSelector('#board .cell[data-row="0"][data-col="0"]', { timeout: 20_000 });
  const initial = await counterValue(page);
  expect(initial).toBeGreaterThan(0);

  // Two pre-first-click flags (right-click) on the placeholder fog.
  await page.click('#board .cell[data-row="0"][data-col="0"]', { button: 'right' });
  await page.click('#board .cell[data-row="0"][data-col="1"]', { button: 'right' });
  expect(await counterValue(page)).toBe(initial - 2);
  await expect(page.locator('#board .cell.flagged')).toHaveCount(2);

  // First click generates the real board; the placeholder flags die with
  // the placeholder cells, so the counter must return to its full value
  // and no stale flag icon may remain painted.
  await page.click('#board .cell[data-row="2"][data-col="2"]');
  expect(await counterValue(page)).toBe(initial);
  await expect(page.locator('#board .cell.flagged')).toHaveCount(0);
}

test('REGRESSION: challenge — pre-first-click flags reset the mine counter when the board generates', async ({ page }) => {
  await page.goto('?isTest=1');
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 20_000 });
  await page.waitForSelector('#title-screen:not(.hidden)', { timeout: 20_000 });
  await page.click('.mode-card[data-mode="normal"]');
  // Challenge routes through the checkpoint selector; Level 1 is always unlocked.
  await page.waitForSelector('#checkpoint-list .checkpoint-btn', { timeout: 10_000 });
  await page.click('#checkpoint-list .checkpoint-btn');
  await flagTwoThenFirstClick(page);
});

test('REGRESSION: timed — pre-first-click flags leave no stale flag icons after generation', async ({ page }) => {
  await page.goto('?isTest=1');
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 20_000 });
  await page.waitForSelector('#title-screen:not(.hidden)', { timeout: 20_000 });
  await page.click('.mode-card[data-mode="timed"]');
  await flagTwoThenFirstClick(page);
});
