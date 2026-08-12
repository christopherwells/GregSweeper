import { test, expect } from '@playwright/test';
import { prepareInteractionSpec } from './helpers.mjs';

// REGRESSION (2026-07-10 audit): flags placed BEFORE the first click sit on
// the placeholder board (a first-click generator builds the real layout on
// that click, and generateBoard returns fresh cell objects), so the flags
// silently vanish, but state.flagCount was never reset, leaving the mine
// counter reading totalMines - N for the whole game, and stale flag icons
// painted on cells whose state said unflagged. The fix zeroes flagCount and
// re-renders every cell when the real board lands.
//
// The case was originally pinned in Quick Play. That mode was absorbed into
// the dealt Challenge match (whose boards are FROZEN, so it belongs with
// the ladder below), leaving CHAOS as the one first-click generator in the
// game and therefore the only place this defect can still occur.
//
// CHALLENGE flipped contracts with the Challenge 250 engine: the ladder
// board is FROZEN at newGame (drawn certified from the level's spec, like
// daily), so there is no placeholder and pre-first-click flags sit on REAL
// cells. The challenge case now pins the frozen semantics — flags SURVIVE
// the first click and the counter stays consistent — which would fail
// loudly if the placeholder wipe ever came back to a frozen board and ate
// a player's real flags.
//
// The assertions read the counter relative to its own initial value, so the
// spec doesn't hardcode per-level mine counts.

test.beforeEach(async ({ page }) => {
  await prepareInteractionSpec(page);
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

test('challenge (C250 frozen board) — pre-first-click flags are real flags and survive the first click', async ({ page }) => {
  await page.goto('?isTest=1');
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 20_000 });
  await page.waitForSelector('#title-screen:not(.hidden)', { timeout: 20_000 });
  await page.click('.mode-card[data-mode="normal"]');
  // Challenge routes through the checkpoint selector; Level 1 is always unlocked.
  await page.waitForSelector('#checkpoint-list .checkpoint-btn', { timeout: 10_000 });
  await page.click('#checkpoint-list .checkpoint-btn');

  // The frozen board mounts with its certified opener marked — the ladder
  // generates at newGame now, never on the first click.
  await page.waitForSelector('#board .cell[data-row="0"][data-col="0"]', { timeout: 20_000 });
  await page.waitForSelector('#start-here-label', { timeout: 20_000 });
  const initial = await counterValue(page);
  expect(initial).toBeGreaterThan(0);

  // Two flags before any reveal — these sit on the REAL board.
  await page.click('#board .cell[data-row="0"][data-col="0"]', { button: 'right' });
  await page.click('#board .cell[data-row="0"][data-col="1"]', { button: 'right' });
  expect(await counterValue(page)).toBe(initial - 2);
  await expect(page.locator('#board .cell.flagged')).toHaveCount(2);

  // First click = an ordinary reveal on the frozen layout (take the marked
  // certified opener). The flags and the counter must survive untouched.
  await page.click('#board .cell.suggested-start');
  expect(await counterValue(page)).toBe(initial - 2);
  await expect(page.locator('#board .cell.flagged')).toHaveCount(2);
  await expect(page.locator('#board .cell.revealed')).not.toHaveCount(0);
});

test('REGRESSION: chaos, pre-first-click flags leave no stale flag icons after generation', async ({ page }) => {
  // Chaos unlocks at Climb L100, so the card is hidden until the stats say
  // so; seeding progression is what makes the one surviving first-click
  // generator reachable from the front door.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('minesweeper_stats', JSON.stringify({
        totalGames: 100, wins: 100, losses: 0, currentStreak: 0, bestStreak: 0,
        maxLevelReached: 100, bestTimes: {}, recentGames: [],
        challengeEpoch: 1, challengeSeenEpoch: 1, challengeArtifactEpoch: 1,
        modeStats: {
          challenge: {
            totalGames: 100, wins: 100, losses: 0, currentStreak: 0, bestStreak: 0,
            maxLevelReached: 100, bestTimes: {}, recentGames: [],
          },
        },
      }));
    } catch {}
  });
  await page.goto('?isTest=1');
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 20_000 });
  await page.waitForSelector('#title-screen:not(.hidden)', { timeout: 20_000 });
  await page.click('.mode-card[data-mode="chaos"]');
  await flagTwoThenFirstClick(page);
});
