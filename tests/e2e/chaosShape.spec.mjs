// A Chaos round on a lattice, end to end.
//
// The pure logic (which shapes, what size, how fast) is in
// test/chaosShape.test.mjs. What a pure test cannot claim is the thing that
// makes Chaos different from every other tiling path: the board is a lattice
// BEFORE the first click, because Chaos generates its mines FROM that click.
// The player has to be looking at the polygons they are about to click, and
// the click has to open ground on them.

import { test, expect } from '@playwright/test';
import { prepareInteractionSpec, settleAnimations } from './helpers.mjs';

test('a chaos round renders its lattice BEFORE the first click, and the click opens ground', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await prepareInteractionSpec(page);
  await page.goto('/?isTest=1');
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 30_000 });

  // Unlock and enter chaos, replaying rounds until one rolls a lattice. The
  // roll is ~50%, so a handful of attempts is plenty; the loop is bounded and
  // reports honestly if none lands.
  await page.evaluate(() => {
    const raw = localStorage.getItem('minesweeper_stats');
    const s = raw ? JSON.parse(raw) : {};
    s.modeStats = s.modeStats || {};
    s.modeStats.challenge = { ...(s.modeStats.challenge || {}), maxLevelReached: 200 };
    localStorage.setItem('minesweeper_stats', JSON.stringify(s));
  });
  await page.reload();
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 30_000 });
  await page.click('.mode-card[data-mode="chaos"]');
  await page.waitForSelector('#board .cell', { timeout: 30_000 });

  let sawLattice = false;
  for (let attempt = 0; attempt < 14 && !sawLattice; attempt++) {
    const isTiling = await page.locator('#board.tiling-board').count();
    if (isTiling) { sawLattice = true; break; }
    // Restart the round to re-roll the shape.
    await page.keyboard.press('r');
    await page.waitForTimeout(150);
  }
  expect(sawLattice, 'no chaos round rolled a lattice in 14 tries (the roll is ~50%)').toBe(true);

  await settleAnimations(page);

  // The lattice is on screen with no click yet: cells are polygons, and the
  // seam overlay tiling boards carry is present.
  const board = page.locator('#board.tiling-board');
  await expect(board).toHaveCount(1);
  await expect(page.locator('#tiling-seams')).toHaveCount(1);
  const clipped = await page.locator('#board .cell').first()
    .evaluate((el) => getComputedStyle(el).clipPath);
  expect(clipped, 'a lattice cell must be clipped to its polygon').toContain('polygon');

  // Nothing is revealed yet — the mines do not exist until the first click.
  await expect(page.locator('#board .cell.revealed')).toHaveCount(0);

  // Click a cell and it must open GROUND, not a lone number and not a mine:
  // chaos generates around the actual click, keeping it and its neighbours
  // clear.
  const cells = page.locator('#board .cell');
  const target = Math.floor((await cells.count()) / 2);
  await cells.nth(target).click();
  await settleAnimations(page);

  await expect(page.locator('#board .cell.revealed').first()).toBeAttached();
  const revealed = await page.locator('#board .cell.revealed').count();
  expect(revealed, 'the first click must open a region, not a single cell').toBeGreaterThan(1);
  await expect(page.locator('#board .cell.mine-hit')).toHaveCount(0);

  // Still a lattice after generation replaced the board.
  await expect(page.locator('#board.tiling-board')).toHaveCount(1);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
