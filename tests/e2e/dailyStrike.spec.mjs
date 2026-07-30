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
  // fitF practice daily: a deterministic FROZEN board, so a first-click
  // mine is a bomb hit by design. The mine is LOCATED at runtime rather
  // than hardcoded: which cell holds one depends on the candidate-seed
  // selection, and pinning a coordinate coupled this spec to the selector
  // (the 2026-07-30 mission-lottery change moved fitF's board and broke a
  // (0,0) assumption that had nothing to do with what this spec pins).
  await page.goto('/?mode=daily&seed=fitF&isTest=1');
  await expect(page.locator('#board .cell').first()).toBeVisible({ timeout: 30_000 });

  const mine = await page.evaluate(async () => {
    const { state } = await import('./src/state/gameState.js');
    for (let r = 0; r < state.rows; r++) {
      for (let c = 0; c < state.cols; c++) {
        if (state.board[r][c].isMine) return { r, c, idx: r * state.cols + c };
      }
    }
    return null;
  });
  expect(mine).not.toBeNull();
  const mineCell = page.locator('#board .cell').nth(mine.idx);

  await mineCell.click(); // first action, inside the old script's firing window
  await expect(mineCell).toHaveClass(/strike-cell/, { timeout: 5_000 });

  // Outlive the popup teardown (2s) AND the old cleanup timers.
  await page.waitForTimeout(2_600);
  await expect(mineCell).toHaveClass(/strike-cell/);
  const cellState = await page.evaluate(async ({ r, c }) => {
    const { state } = await import('./src/state/gameState.js');
    const cell = state.board[r][c];
    return { isRevealed: cell.isRevealed, isStrike: cell.isStrike, hits: state.dailyBombHits, status: state.status };
  }, { r: mine.r, c: mine.c });
  expect(cellState.isRevealed).toBe(true);
  expect(cellState.isStrike).toBe(true);
  expect(cellState.hits).toBe(1);
  expect(cellState.status).toBe('playing');
});
