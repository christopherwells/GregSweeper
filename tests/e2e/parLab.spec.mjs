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

test('REGRESSION: a struck win records the DAILY-convention time (penalty folded in) and ?parlabRedo= voids it', async ({ page }) => {
  // His report: strike penalties were not counting against the recorded
  // time (rows carried pure wall clock). The row must now carry the same
  // number a daily submits — preciseTime with the penalties folded in —
  // plus penaltySec so the fit can subtract back to pure play time. The
  // spec solves lab board 1 outright (the layout is deterministic, so the
  // safe set is computable in node), with one deliberate strike first.
  const spec = PAR_LAB_BATTERY[0];
  const built = buildParLabBoard(spec, 0);
  const mines = [];
  const safes = [];
  for (let r = 0; r < built.rows; r++) {
    for (let c = 0; c < built.cols; c++) {
      (built.board[r][c].isMine ? mines : safes).push({ r, c });
    }
  }

  const errors = attachErrorCapture(page);
  await page.goto('?isTest=1&parlab=1');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 20_000 });

  await page.click(`#board .cell[data-row="${mines[0].r}"][data-col="${mines[0].c}"]`);
  await expect(page.locator('#bombhit-explainer')).toBeVisible();
  await page.click('#bombhit-explainer-ok');
  // The modal closes asynchronously, and finishBombHit (which resumes the
  // paused timer) hangs off that close — wait it out, or the scripted solve
  // wins against a paused clock, something no human hand can do.
  await expect(page.locator('#bombhit-explainer')).toBeHidden();

  // Reveal every safe cell programmatically — the board's input handler
  // lives on mousedown, so dispatch that, and do it in one evaluate so the
  // wall clock stays far below the >=3s strike penalty (which is what makes
  // the inclusive-time assertion discriminating).
  await page.evaluate((cells) => {
    for (const { r, c } of cells) {
      document.querySelector(`#board .cell[data-row="${r}"][data-col="${c}"]`)
        ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    }
  }, safes);

  // The win row lands via the handleWin hook; poll storage for it.
  const row = await page.waitForFunction(() => {
    try {
      const rows = JSON.parse(localStorage.getItem('gregsweeper_parlab_v1'))?.rows || [];
      return rows.find((x) => x.result === 'win') || null;
    } catch { return null; }
  }, undefined, { timeout: 15_000 }).then((h) => h.jsonValue());

  expect(row.id).toBe(spec.id);
  expect(row.bombHits).toBe(1);
  expect(row.penaltySec).toBeGreaterThanOrEqual(3); // ramped base floor
  // Penalty folded INTO the time (the daily convention). The scripted solve
  // takes well under a second, so pre-fix this was the bare wall clock — 0 —
  // while post-fix it is wall + penalty >= the penalty itself.
  expect(row.timeSec).toBeGreaterThanOrEqual(row.penaltySec);
  expect(row.bombHitEvents.length).toBe(1);

  // The redo door: voiding board 1 re-issues it unresolved with the voiding
  // tombstoned for the sync flush.
  await page.goto('?isTest=1&parlab=1&parlabRedo=1');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 20_000 });
  await expect(page.locator('#parlab-hud #parlab-line')).toContainText(/board 1\/\d+/);
  const voided = await page.evaluate(() => {
    const rows = JSON.parse(localStorage.getItem('gregsweeper_parlab_v1'))?.rows || [];
    return {
      invalids: rows.filter((x) => x.result === 'invalid').length,
      wins: rows.filter((x) => x.result === 'win').length,
    };
  });
  expect(voided.wins).toBe(0);
  expect(voided.invalids).toBeGreaterThanOrEqual(2); // the flipped row + its tombstone

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('plain boots stay lab-free — no HUD outside ?parlab=', async ({ page }) => {
  const errors = attachErrorCapture(page);
  await page.goto('?isTest=1');
  await page.waitForSelector('#title-screen:not(.hidden)', { timeout: 20_000 });
  await expect(page.locator('#parlab-hud')).toHaveCount(0);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
