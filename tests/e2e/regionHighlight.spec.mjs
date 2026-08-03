// REGRESSION (2026-08-01, Christopher's report): flagging a cell inside a
// pinned sonar/compass region stripped the highlight from exactly that cell.
// The highlight classes live on cell elements and updateCell rebuilds
// className wholesale, so every targeted re-render (flag, unflag, reveal) wiped
// them from the cell it repainted. The point of pinning a region is counting
// flags inside it, so the wipe hit the one cell the player was reasoning about.
//
// On desktop the bug HID ITSELF half the time: the next mouse movement fires a
// hover fallback that re-shows the pinned region, repainting the class before
// anyone looks. Touch has no hover, so on a phone the highlight just vanished.
// The assertions below therefore run IMMEDIATELY after the flag toggle, before
// any pointer movement — move the mouse first and the spec goes vacuous.
//
// The board is deterministic: a frozen practice seed plus a frozen click
// policy (opener, then always the FIRST hidden cell in flat order) reaches a
// revealed sonar cell without ever hitting a mine. If this spec dies on a
// game-over overlay, the seed's board changed — regenerate the seed with
// scratch sweep sonar-seed-sweep2 rather than loosening the policy.
//
// The first-encounter modifier popup is disabled up front (the wallResize
// precedent): a fresh context has never seen sonar, so the intro modal would
// open the moment the cascade reveals a sonar cell and swallow every click
// after it — which reads as an actionability timeout, not as a modal.

import { test, expect } from '@playwright/test';
import { prepareInteractionSpec, settleAnimations } from './helpers.mjs';

// Frozen by the sweep: the deterministic policy reveals a sonar cell on this
// seed with no mine hit, and its region holds at least two hidden cells.
// Re-frozen 2026-08-03 (region4 -> region1): the gimmick re-roll generator
// legitimately re-drew this seed's board (region4's old layout came from a
// discarded-base search path), and the frozen policy walked onto a mine on
// the new layout. region1 passes the policy with wide margin under the
// re-roll generator (12-cell region, 12 hidden at pin).
const SEED = 'region1';

async function counts(page) {
  return page.evaluate(() => ({
    highlight: document.querySelectorAll('#board .cell.region-highlight').length,
    hidden: document.querySelectorAll('#board .cell.region-highlight:not(.revealed)').length,
    source: document.querySelectorAll('#board .cell.region-source').length,
  }));
}

test('REGRESSION: a pinned sonar region survives flagging inside it', async ({ page }) => {
  await prepareInteractionSpec(page);
  await page.addInitScript(() => {
    try {
      localStorage.setItem('minesweeper_modifier_popup_disabled', 'true');
      // Without this, main.js's one-time v1.4.1 migration ('re-enable popups
      // for all users') sees a fresh profile and OVERWRITES the line above at
      // boot. Ordinary boots hide this: the service worker's install reload
      // gives a second boot where the migration is already done, but
      // prepareInteractionSpec neutralizes the SW, so this spec boots once.
      localStorage.setItem('minesweeper_popup_reset_v141', 'done');
    } catch {}
  });
  await page.goto(`/?isTest=1&coastline=sonar&seed=${SEED}`);
  await page.waitForFunction(() => {
    const b = document.getElementById('board');
    return b && [...b.children].filter(c => c.classList && c.classList.contains('cell')).length > 5;
  }, { timeout: 30000 });

  // Opener, then the frozen policy until the sonar cell is on screen.
  const cells = await page.$$('#board .cell');
  await cells[Math.floor(cells.length / 2)].click();
  for (let k = 0; k < 30; k++) {
    if (await page.$('#board .cell.revealed.sonar-cell')) break;
    expect(await page.$('#gameover-overlay:not(.hidden)'),
      'the frozen seed must never hit a mine under the frozen policy').toBeNull();
    const target = await page.$('#board .cell:not(.revealed):not(.flagged)');
    expect(target, 'ran out of hidden cells before revealing a sonar').not.toBeNull();
    await target.click();
    await page.waitForTimeout(160);
  }

  // Every reveal runs the per-theme choreography (num-pop scales the box), and
  // Playwright refuses to click an element whose box is mid-animation — the
  // settleAnimations contract every interacting tiling spec follows.
  await settleAnimations(page);

  // Pin the region.
  await page.click('#board .cell.revealed.sonar-cell');
  const pinned = await counts(page);
  expect(pinned.source).toBe(1);
  expect(pinned.highlight).toBeGreaterThanOrEqual(3);
  expect(pinned.hidden).toBeGreaterThanOrEqual(2);

  // The pin survives the cursor leaving: park the mouse off-board. This is what
  // separates a PIN from the hover preview.
  await page.mouse.move(2, 2);
  await page.waitForTimeout(80);
  expect((await counts(page)).highlight).toBe(pinned.highlight);

  // THE regression: flag a hidden cell inside the region. The highlight on that
  // cell must survive the flag re-render. Assert with the mouse UNMOVED —
  // hovering afterward would repaint the region and mask the wipe.
  const victim = page.locator('#board .cell.region-highlight:not(.revealed)').first();
  await victim.click({ button: 'right' });
  await settleAnimations(page); // flag-pop moves the box; settle before re-click
  await expect(victim, 'flag landed').toHaveClass(/flagged/);
  await expect(victim,
    'the highlight must outlive the flag re-render — it dies only by unpinning',
  ).toHaveClass(/region-highlight/);
  expect((await counts(page)).highlight).toBe(pinned.highlight);

  // Unflagging is the same re-render path; same contract.
  await victim.click({ button: 'right' });
  await expect(victim).not.toHaveClass(/flagged/);
  await expect(victim).toHaveClass(/region-highlight/);
  expect((await counts(page)).highlight).toBe(pinned.highlight);

  // Unpin: tap the source again, park the mouse, everything clears.
  await page.click('#board .cell.region-source');
  await page.mouse.move(2, 2);
  await page.waitForTimeout(80);
  const cleared = await counts(page);
  expect(cleared.highlight).toBe(0);
  expect(cleared.source).toBe(0);
});
