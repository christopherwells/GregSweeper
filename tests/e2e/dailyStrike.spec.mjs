// A daily strike marker must SURVIVE (2026-07-12). Clicking a mine on a
// daily marks the cell isRevealed + isStrike — the paid-for marker that
// counts as a flag for chording and anchors adjacent numbers. A legacy
// inline "fixDailyRevealed" script in index.html (a band-aid for the old
// solver-leak bug, whose root cause cleanSolverArtifacts fixed in the
// module code long ago) fired 100/500 ms after module load and force-
// un-revealed EVERY revealed daily cell, wiping strike markers, resumed
// progress, and resetting status to idle. Discovered when it erased the
// per-mine chord strikes during live verification; removed. This journey
// clicks a known mine as the first action (inside the old script's firing
// window on a fast load) and pins that the strike marker persists.

import { test, expect } from '@playwright/test';
import { prepareInteractionSpec } from './helpers.mjs';

test('REGRESSION: a daily bomb-hit strike marker persists past boot-time cleanup timers', async ({ page }) => {
  await prepareInteractionSpec(page);
  await page.addInitScript(() => {
    // Popup path, not the first-strike explainer modal.
    try { localStorage.setItem('minesweeper_seen_bombhit_explainer_v2', 'true'); } catch {}
  });
  // fitF practice daily: deterministic board, mine at (0,0) — and the
  // daily board is FROZEN, so a first-click mine is a bomb hit by design.
  await page.goto('/?mode=daily&seed=fitF&isTest=1');
  const firstCell = page.locator('#board .cell').first();
  await expect(firstCell).toBeVisible({ timeout: 30_000 });

  await firstCell.click(); // (0,0) is a mine on this seed
  await expect(firstCell).toHaveClass(/strike-cell/, { timeout: 5_000 });

  // Outlive the popup teardown (2s) AND the old cleanup timers.
  await page.waitForTimeout(2_600);
  await expect(firstCell).toHaveClass(/strike-cell/);
  const cellState = await page.evaluate(async () => {
    const { state } = await import('./src/state/gameState.js');
    const c = state.board[0][0];
    return { isRevealed: c.isRevealed, isStrike: c.isStrike, hits: state.dailyBombHits, status: state.status };
  });
  expect(cellState.isRevealed).toBe(true);
  expect(cellState.isStrike).toBe(true);
  expect(cellState.hits).toBe(1);
  expect(cellState.status).toBe('playing');
});
