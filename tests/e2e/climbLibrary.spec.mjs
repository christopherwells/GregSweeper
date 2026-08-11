// The Climb deals from the pre-generated library (the wiring that retires
// issue #286's draw-exhaustion class). What the pure layer cannot claim is
// that the SERVED level file reaches the page, deals, renders and certifies
// end to end; that is this file. Venues load from the committed library so
// the assertions move with it instead of going stale.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { prepareInteractionSpec } from './helpers.mjs';

const LEVEL = 30;
const bin = JSON.parse(readFileSync(new URL(
  `../../scripts/data/climb-library/level-0${LEVEL}.json`, import.meta.url), 'utf8'));

test('a Climb level deals a board from its library bin', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await prepareInteractionSpec(page);
  await page.goto(`/?isTest=1&level=${LEVEL}`);
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 30_000 });
  await page.waitForSelector('#board .cell', { timeout: 30_000 });

  // The board on screen is ONE OF the bin's boards: cell count and mine
  // counter both match some stored entry (the deal is a random unseen pick,
  // so the assertion is membership, not identity).
  const cells = await page.locator('#board .cell').count();
  const mineText = await page.locator('#mine-counter').textContent();
  const mines = Math.abs(parseInt(mineText, 10));
  const match = bin.boards.some((b) => b.spec.cells === cells && b.spec.mines === mines);
  expect(match, `a ${cells}-cell ${mines}-mine board is in the L${LEVEL} bin`).toBe(true);

  // Dealt boards keep the whole frozen-mode contract: the marked opener and
  // the Certified chip (the deal re-certified from the stored opener).
  await expect(page.locator('#board .cell.suggested-start')).toHaveCount(1);
  await expect(page.locator('#cert-chip')).toBeVisible();

  expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
});

test('the board= practice override deals the exact bin index', async ({ page }) => {
  await prepareInteractionSpec(page);
  await page.goto(`/?isTest=1&level=${LEVEL}&board=1`);
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 30_000 });
  await page.waitForSelector('#board .cell', { timeout: 30_000 });

  const wanted = bin.boards[1].spec;
  await expect(page.locator('#board .cell')).toHaveCount(wanted.cells);
  const mineText = await page.locator('#mine-counter').textContent();
  expect(Math.abs(parseInt(mineText, 10))).toBe(wanted.mines);
});

// ── The endless library (levels past the crown, 2026-08-11) ─────────────

const endlessIndex = JSON.parse(readFileSync(new URL(
  '../../scripts/data/climb-library/endless-index.json', import.meta.url), 'utf8'));

test('an endless level deals a pre-generated board end to end', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await prepareInteractionSpec(page);
  await page.goto('/?isTest=1&level=251');
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 30_000 });
  await page.waitForSelector('#board .cell', { timeout: 30_000 });

  // A random unseen deal, so the assertion is the frozen-mode contract, not
  // identity: the marked opener and the Certified chip (the deal
  // re-certified from the stored opener at the point of play).
  await expect(page.locator('#board .cell.suggested-start')).toHaveCount(1);
  await expect(page.locator('#cert-chip')).toBeVisible();
  expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
});

test('the endless board= override resolves a deterministic global index', async ({ page }) => {
  // Global index 5 through the committed index's counts: the page that
  // holds it plus the offset inside it, the same resolution the deal runs.
  const GLOBAL = 5;
  let k = GLOBAL, pageNo = 0;
  while (k >= endlessIndex.counts[pageNo]) { k -= endlessIndex.counts[pageNo]; pageNo++; }
  const pageJson = JSON.parse(readFileSync(new URL(
    `../../scripts/data/climb-library/endless-${String(pageNo).padStart(3, '0')}.json`,
    import.meta.url), 'utf8'));
  const wanted = pageJson.boards[k].spec;

  await prepareInteractionSpec(page);
  await page.goto(`/?isTest=1&level=300&board=${GLOBAL}`);
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 30_000 });
  await page.waitForSelector('#board .cell', { timeout: 30_000 });

  await expect(page.locator('#board .cell')).toHaveCount(wanted.cells);
  const mineText = await page.locator('#mine-counter').textContent();
  expect(Math.abs(parseInt(mineText, 10))).toBe(wanted.mines);
});
