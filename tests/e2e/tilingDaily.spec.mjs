import { test, expect } from '@playwright/test';
import { settleAnimations, prepareInteractionSpec } from './helpers.mjs';

// Tiling DAILY journey (Coastline shape rotation, shipped dark). The rotation
// is off in production (TILING_ROTATION_START = null), so this spec reaches
// the path through the test-env-only ?dailyShape= override — which rides the
// PRACTICE lane by design (/test/ shares localStorage with production, so an
// overridden board must never record as the real date). What the journey
// proves is everything the node tests cannot: the daily deep link routes into
// the shape branch, the shared builder's board mounts through the tiling
// renderer, the daily surfaces (start-here label, suggested start) land on a
// lattice, and the certified opener actually opens ground when clicked.
//
// ?seed=rotatest1 pins the practice seed so the hex board is the same on
// every run; assertions stay STRUCTURAL (lattice class, clip-path signature,
// reveal behavior) rather than pinning cells, because the mission spec
// (experimentTarget.json) legitimately changes nightly and moves the gimmick
// roll with it.

const ENTRY = '?isTest=1&mode=daily&seed=rotatest1&dailyShape=hex';

// Deep links route only for an ONBOARDED user (a fresh context lands in the
// tutorial branch and the mode param is ignored), and interaction specs
// neutralize the SW's first-install reload.
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

test('a forced-shape daily mounts as a hexagon lattice and plays from the marked start', async ({ page }) => {
  const errors = attachErrorCapture(page);
  await page.goto(ENTRY);
  await page.waitForSelector('#app:not(.hidden)', { timeout: 20_000 });

  // The board mounted through the tiling renderer, not the CSS grid.
  const board = page.locator('#board.tiling-board');
  await expect(board, 'the daily board must be a tiling board under ?dailyShape=hex').toBeVisible();
  const cellCount = await page.locator('#board .cell').count();
  expect(cellCount, 'the hex daily config is a real board, not a stub').toBeGreaterThan(40);

  // Hexagon signature: every cell shares ONE clip-path (the honeycomb is the
  // single-orientation tiling; a 4.8.8 would show two, a rect none).
  const clipPaths = await page.$$eval('#board .cell', (cells) =>
    [...new Set(cells.map((c) => c.style.clipPath || ''))].filter((s) => s.length > 0));
  expect(clipPaths.length, 'a honeycomb renders exactly one distinct clip-path').toBe(1);

  // The seam overlay draws every shared tile edge (the clip-paths tile
  // exactly, so without it neighboring cells have NO visible boundary —
  // the petals-board legibility report, 2026-08-02).
  await expect(page.locator('#board #tiling-seams path')).toHaveCount(1);

  // The practice lane announced itself — the recording gate the override
  // rides on (localStorage is shared with production on /test/).
  await expect(page.locator('.queued-toast')).toContainText(/Nothing records/i, { timeout: 5_000 });

  // Daily surfaces on a lattice: the certified start marker and its label.
  await settleAnimations(page);
  const startCell = page.locator('#board .cell.suggested-start');
  await expect(startCell, 'the daily start marker must land on a tiling cell').toHaveCount(1);
  await expect(page.locator('#start-here-label')).toBeVisible();

  // The certified opener opens ground: clicking the marked start reveals
  // cells (a daily board is frozen — a working reveal proves the board,
  // its topology, and the input routing agree).
  await startCell.click();
  await settleAnimations(page);
  const revealed = await page.locator('#board .cell.revealed').count();
  expect(revealed, 'clicking the certified start must reveal at least itself').toBeGreaterThan(0);

  expect(errors, `console/page errors during the journey:\n${errors.join('\n')}`).toEqual([]);
});

test('without the override the daily stays rectangular — the rotation ships dark', async ({ page }) => {
  const errors = attachErrorCapture(page);
  await page.goto('?isTest=1&mode=daily&seed=rotatest2');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 20_000 });
  await expect(page.locator('#board')).toBeVisible();
  await expect(page.locator('#board.tiling-board'), 'no override, no rotation start → no lattice').toHaveCount(0);
  await expect(page.locator('#tiling-seams'), 'rectangular boards draw no seam overlay').toHaveCount(0);
  expect(errors, `console/page errors during boot:\n${errors.join('\n')}`).toEqual([]);
});
