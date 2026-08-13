// The Challenge sheet's two tabs and his three places (2026-08-13).
//
// What a pure test cannot reach: that the tabs actually swap panels, that the
// places actually swap lists, and above all that the sheet still FITS the
// reference phone. The front door's height budget is measured, not assumed
// (his 360x630 rule), and a tab row plus a place row is new vertical space.

import { test, expect } from '@playwright/test';
import { prepareInteractionSpec, settleAnimations } from './helpers.mjs';

async function openSheet(page) {
  await prepareInteractionSpec(page);
  await page.goto('?isTest=1');
  await page.waitForSelector('.mode-card[data-mode="match"]');
  await page.locator('.mode-card[data-mode="match"]').click();
  await expect(page.locator('#match-setup-modal')).toBeVisible();
  await settleAnimations(page);
}

test('the sheet opens on Your runs, and New run holds the config', async ({ page }) => {
  await openSheet(page);
  // His ruling: a player with an invite waiting should not have to find it
  // behind a config sheet, so the runs tab leads.
  await expect(page.locator('#match-tab-runs')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#match-panel-runs')).toBeVisible();
  await expect(page.locator('#match-panel-new')).toBeHidden();
  await expect(page.locator('#match-start')).toBeHidden();

  await page.locator('#match-tab-new').click();
  await expect(page.locator('#match-panel-new')).toBeVisible();
  await expect(page.locator('#match-panel-runs')).toBeHidden();
  // The config sheet is all still there and still works.
  await expect(page.locator('#match-start')).toBeVisible();
  await expect(page.locator('#match-shapes .match-chip').first()).toBeVisible();
});

test('the three places each show their own list', async ({ page }) => {
  await openSheet(page);
  const review = page.locator('#match-review');
  // Signed out with no invites, every place is empty, and each says its OWN
  // empty line rather than a shared one, which is what makes them browsable.
  const seen = new Set();
  for (const place of ['active', 'finished', 'declined']) {
    await page.locator(`.match-place[data-place="${place}"]`).click();
    await expect(page.locator(`.match-place[data-place="${place}"]`)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.match-place.active')).toHaveCount(1);
    const text = (await review.innerText()).trim();
    expect(text.length).toBeGreaterThan(0);
    seen.add(text);
  }
  expect(seen.size).toBe(3);
});

test('the sheet fits the reference phone with the tabs added', async ({ page }) => {
  // 360x630 is the reference phone WITH browser chrome showing, the number the
  // hero-card work was measured against. The sheet may scroll internally; what
  // must not happen is the tabs or the place row going off the top, since they
  // are the only way to reach the other places.
  await page.setViewportSize({ width: 360, height: 630 });
  await openSheet(page);

  // Measure the MODAL against the viewport, not the body against its own
  // content: the body sizes itself to what it holds, so comparing the two
  // always reports a perfect fit and proves nothing (the harness-measures-
  // the-harness trap). Measured 2026-08-13: the tab row and place row cost
  // 68px together, the runs tab leaves 370px spare and the config tab 94px.
  const fits = async (label) => {
    await settleAnimations(page);
    const m = await page.evaluate(() => {
      const c = document.querySelector('#match-setup-modal .modal-content').getBoundingClientRect();
      const t = document.querySelector('.match-tabs').getBoundingClientRect();
      return {
        vh: window.innerHeight,
        top: c.top, bottom: c.bottom,
        tabsTop: t.top, tabsBottom: t.bottom, tabsHeight: t.height,
      };
    });
    expect(m.bottom, `${label}: the sheet runs off the bottom`).toBeLessThanOrEqual(m.vh + 1);
    expect(m.top, `${label}: the sheet runs off the top`).toBeGreaterThanOrEqual(-1);
    // The tabs are the only way to the other places, so losing them off
    // either edge strands the player on whichever one is showing.
    expect(m.tabsTop, `${label}: the tab row is above the viewport`).toBeGreaterThanOrEqual(0);
    expect(m.tabsBottom, `${label}: the tab row is below the viewport`).toBeLessThanOrEqual(m.vh);
    // Non-vacuity: a zero-height tab row would satisfy every bound above.
    expect(m.tabsHeight).toBeGreaterThan(20);
  };

  await fits('runs tab');
  await page.locator('#match-tab-new').click();
  await fits('new run tab');
  await expect(page.locator('#match-start')).toBeVisible();
});
