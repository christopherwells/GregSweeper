import { test, expect } from '@playwright/test';
import { prepareInteractionSpec } from './helpers.mjs';
import { PAR_LAB_BATTERY, buildParLabBoard } from '../../src/logic/parLab.js';

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

test('REGRESSION: a lab mine is a DAILY-style strike, never a loss', async ({ page }) => {
  // The lab parameterizes the daily par model, so its mines must behave like
  // daily mines (Christopher's ruling): revealed strike marker, priced
  // penalty, play continues. Before the fix a lab mine routed to handleLoss
  // — a different response frame than the model the rows feed. The board is
  // deterministic, so the spec computes board 1's layout in node and clicks
  // a known mine.
  const spec = PAR_LAB_BATTERY[0];
  const built = buildParLabBoard(spec, 0);
  expect(built).toBeTruthy();
  let mine = null;
  for (let r = 0; r < built.rows && !mine; r++) {
    for (let c = 0; c < built.cols && !mine; c++) {
      if (built.board[r][c].isMine) mine = { r, c };
    }
  }
  expect(mine).toBeTruthy();

  const errors = attachErrorCapture(page);
  await page.goto('?isTest=1&parlab=1');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 20_000 });
  await expect(page.locator('#parlab-hud #parlab-line')).toContainText(/board 1\/\d+/);

  await page.click(`#board .cell[data-row="${mine.r}"][data-col="${mine.c}"]`);
  // The DAILY choreography, verbatim: the first-ever hit raises the
  // "Mine hit. The game continues." explainer (fresh context, notice unseen),
  // and the strike PAINT deliberately waits behind it (updateAllCells runs
  // in finishBombHit on dismissal).
  await expect(page.locator('#bombhit-explainer')).toBeVisible();
  await page.click('#bombhit-explainer-ok');
  // Strike, not death: the marker renders, no game-over surface appears.
  await expect(page.locator('#board .cell.strike-cell')).toHaveCount(1);
  await expect(page.locator('#gameover-overlay')).not.toBeVisible();
  await page.click('#board .cell.suggested-start');
  const revealed = await page.locator('#board .cell.revealed').count();
  expect(revealed, 'play continues after the strike').toBeGreaterThan(1);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('plain boots stay lab-free — no HUD outside ?parlab=', async ({ page }) => {
  const errors = attachErrorCapture(page);
  await page.goto('?isTest=1');
  await page.waitForSelector('#title-screen:not(.hidden)', { timeout: 20_000 });
  await expect(page.locator('#parlab-hud')).toHaveCount(0);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
