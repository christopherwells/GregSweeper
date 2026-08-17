// Theme switching must re-fit the board (2026-07-12, Christopher's report:
// "switching between themes where cells are a different size makes the
// cells spill off the side — start on neon, scroll left to candy").
//
// Mechanism: themes may override --grid-gap (candy 3px, matrix 1px vs the
// 2px default), #board is width:fit-content, and applyThemeLive never
// re-ran the cell fit — so the cells stayed sized for the OLD gap and the
// wider gap pushed the board past its container. The fix refits after the
// lazy theme stylesheet actually loads. This spec plays the real journey:
// a width-bound board, cycle themes to candy via the in-game arrows, then
// assert the board still fits its container.

import { test, expect } from '@playwright/test';
import { prepareInteractionSpec } from './helpers.mjs';

test.use({ viewport: { width: 390, height: 844 } }); // width-bound fit on a 12-wide board

test('REGRESSION: cycling to candy (wider --grid-gap) keeps the board inside its container', async ({ page }) => {
  await prepareInteractionSpec(page);
  await page.addInitScript(() => {
    // Unlock every theme so the carousel can reach candy. The seed must be
    // DEFAULT_STATS-shaped: loadStats' legacy migration spreads bestTimes
    // and iterates recentGames, so a bare {maxLevelReached} throws and
    // bricks init.
    try {
      localStorage.setItem('minesweeper_stats', JSON.stringify({
        totalGames: 0, wins: 0, losses: 0, currentStreak: 0, bestStreak: 0,
        bestTimes: {}, recentGames: [], maxLevelReached: 250,
        // Post-reset profile (see CHALLENGE_250_EPOCH): unstamped stats
        // are wiped to L1 by the ladder reset at init, which would relock
        // every theme this spec needs to cycle through.
        challengeEpoch: 1,
      }));
    } catch {}
  });
  // fitF → deterministic 12x12 practice daily: at 390px the fit is
  // width-bound, so a 1px-per-gap widening (11px total) must be absorbed
  // by a refit or it spills. (The seed param only works with mode=daily.)
  //
  // previewthemes=1: candy is SHELVED (the 2026-08-16 five-theme shelf),
  // and the carousel honors the shelf, so the production cycle can no
  // longer reach it. The refit-after-css-load machinery this spec pins is
  // theme-agnostic and still ships; the preview door is the sanctioned
  // way a test build reaches a shelved theme, and candy stays the subject
  // because its 3px gap is the widest override in the catalog.
  await page.goto('/?mode=daily&seed=fitF&isTest=1&previewthemes=1');
  await expect(page.locator('#board .cell').first()).toBeVisible({ timeout: 30_000 });

  // Cycle LEFT with the in-game arrow until candy is active (the reported
  // repro path). Cap generously; the unlocked ladder is 26 themes.
  const prevBtn = page.locator('#btn-theme-prev');
  await expect(prevBtn).toBeVisible();
  let reached = false;
  for (let i = 0; i < 30 && !reached; i++) {
    await prevBtn.click();
    reached = (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'candy';
  }
  expect(reached).toBe(true);

  // Let the lazy candy stylesheet load and the post-load refit settle.
  await expect
    .poll(async () => page.evaluate(() => getComputedStyle(document.getElementById('board')).gap), { timeout: 5_000 })
    .toBe('3px');
  await page.waitForTimeout(250);

  const { boardW, containerW, docOverflow } = await page.evaluate(() => ({
    boardW: document.getElementById('board').getBoundingClientRect().width,
    containerW: document.getElementById('board-container').clientWidth,
    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  expect(boardW, `board ${boardW}px must fit its ${containerW}px container under candy's 3px gap`)
    .toBeLessThanOrEqual(containerW + 1);
  expect(docOverflow, 'no horizontal page overflow').toBeLessThanOrEqual(1);
});
