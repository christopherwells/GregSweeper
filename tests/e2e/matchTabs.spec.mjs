// The Challenge sheet's two tabs and his three places (2026-08-13).
//
// What a pure test cannot reach: that the tabs actually swap panels, that the
// places actually swap lists, and above all that the sheet still FITS the
// reference phone. The front door's height budget is measured, not assumed
// (his 360x630 rule), and a tab row plus a place row is new vertical space.

import { test, expect } from '@playwright/test';
import { prepareInteractionSpec, settleAnimations } from './helpers.mjs';
import { CELL_SIZE_PREFS, prefMinPx } from '../../src/logic/boardCamera.js';

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

// ── Settings re-skin (2026-08-18, his "frustratingly bad and doesn't look
// good") ─────────────────────────────────────────────────────────────────
//
// The modal was built from native OS widgets inside a heavily themed game.
// The re-skin restyles the SAME elements rather than replacing them, so what
// a test can usefully hold is that the native dropdown is gone, the chip row
// really drives the stored preference, and the preview shows real cells.

test('Settings: cell size is a chip row that drives the preference and previews itself', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await prepareInteractionSpec(page);
  await page.goto('/?isTest=1');
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 30_000 });
  await page.locator('#title-more-btn').click();
  await page.locator('#sheet-settings-btn').click();
  await expect(page.locator('#settings-modal')).toBeVisible();

  // The native dropdown is gone, replaced by the app's own chip vocabulary.
  await expect(page.locator('#cell-size-select')).toHaveCount(0);
  const chips = page.locator('#cell-size-chips .match-chip');
  // COUNT AND SIZES ARE DERIVED. Both were literals (3 chips, 40px, 32px) and
  // all three went stale together when the ladder was re-anchored to the tap
  // floor. The chip row renders from CELL_SIZE_PREFS, so that is what it owes.
  await expect(chips).toHaveCount(CELL_SIZE_PREFS.length);
  await expect(chips.filter({ hasText: 'Fit to screen' })).toHaveAttribute('aria-pressed', 'true');

  // Labels are matched EXACTLY: 'Large' is a substring of 'Largest', so a
  // hasText filter resolves to two chips and the click fails strict mode.
  const chip = (label) => chips.filter({ hasText: new RegExp(`^${label}$`) });

  // The preview shows REAL cells, and follows the choice.
  const swatch = page.locator('#cell-size-preview .cell-size-swatch').first();
  await chip('Large').click();
  await expect(chip('Large')).toHaveAttribute('aria-pressed', 'true');
  await expect(swatch).toHaveCSS('width', `${prefMinPx('large')}px`);
  await expect(page.locator('#cell-size-preview .cell-size-caption'))
    .toHaveText(`${prefMinPx('large')}px`);

  await chip('Comfortable').click();
  await expect(swatch).toHaveCSS('width', `${prefMinPx('comfortable')}px`);

  // And the choice is what the board will actually be held to.
  const stored = await page.evaluate(() => localStorage.getItem('minesweeper_cell_size_pref'));
  expect(stored).toBe('comfortable');
  const token = await page.evaluate(() => getComputedStyle(document.documentElement)
    .getPropertyValue('--cell-pref-min-size').trim());
  expect(token).toBe(`${prefMinPx('comfortable')}px`);

  // NON-VACUITY: the two sizes compared above must differ, or every assertion
  // in this block would hold with the preference wired to nothing.
  expect(prefMinPx('large')).not.toBe(prefMinPx('comfortable'));

  // The default writes NO render floor (issue #421). It briefly wrote the tap
  // floor for everyone, which on any viewport under 360px pushed the board off
  // the screen and made dailies scroll for players who had chosen nothing.
  // An explicit preset is a request and may scroll; the default is not.
  await chip('Fit to screen').click();
  const fitToken = await page.evaluate(() => getComputedStyle(document.documentElement)
    .getPropertyValue('--cell-pref-min-size').trim());
  expect(fitToken, 'the default must contribute no floor').toBe('');
  // NON-VACUITY: the token is really the thing that carries a floor, so an
  // explicit preset must still set it.
  await chip('Large').click();
  const largeToken = await page.evaluate(() => getComputedStyle(document.documentElement)
    .getPropertyValue('--cell-pref-min-size').trim());
  expect(largeToken).toBe(`${prefMinPx('large')}px`);

  // The toggles are switches now, not raw checkboxes: still inputs (so every
  // handler and label association is untouched) but with the native
  // appearance gone.
  const box = page.locator('#colorblind-toggle');
  await expect(box).toHaveCSS('appearance', 'none');

  expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
});

test('What\'s New opens on the current version, with the back catalogue collapsed', async ({ page }) => {
  await prepareInteractionSpec(page);
  await page.goto('/?isTest=1');
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 30_000 });
  await page.locator('#title-more-btn').click();
  await page.locator('#sheet-whatsnew-btn').click();
  await expect(page.locator('#whatsnew-modal')).toBeVisible();

  // The newest entry is open; every older one sits behind one disclosure, so
  // the modal opens on what changed rather than on eight versions of history.
  const older = page.locator('.whatsnew-older');
  await expect(older).toHaveCount(1);
  const hidden = page.locator('.whatsnew-older .whatsnew-entry').first();
  await expect(hidden).not.toBeVisible();
  await older.locator('summary').click();
  await expect(hidden).toBeVisible();
});
