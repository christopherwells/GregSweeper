// REGRESSION: one scrollbar in the stats modal, never two (his report,
// 2026-08-18: "a little bug in the challenge stats page where there's a
// second scroll bar").
//
// .stats-body used to carry its own max-height: min(80vh, 900px) +
// overflow-y: auto INSIDE .modal-content's 85vh scroller, the only
// modal-body in the app with a cap of its own. The two caps sit close
// enough that any tab taller than the window scrolled both containers at
// once: a second scrollbar inside the first, and the inner one ate the
// right padding so the rivalry margins clipped under it. The contract this
// pins is the one every other modal keeps: .modal-content is the ONE
// scroller, and the body wrapper never scrolls independently.
//
// Measured at a deliberately short desktop window so the modal is
// guaranteed to overflow, and on the reference phone (his 360x630) where
// overlay scrollbars hide but a nested scroll container still traps touch
// scrolling. Geometry is measured, so every measurement follows
// settleAnimations (the flake rule).

import { test, expect } from '@playwright/test';
import { prepareInteractionSpec, settleAnimations } from './helpers.mjs';

async function openStats(page, tab) {
  await prepareInteractionSpec(page);
  await page.goto('?isTest=1');
  await page.waitForSelector('#title-progress-btn');
  await page.locator('#title-progress-btn').click();
  await page.locator('#sheet-stats-btn').click();
  await expect(page.locator('#stats-modal')).toBeVisible();
  if (tab) {
    await page.locator(`.stats-tab[data-tab="${tab}"]`).click();
  }
  await settleAnimations(page);
}

async function scrollState(page) {
  return page.evaluate(() => {
    const content = document.querySelector('#stats-modal .modal-content');
    const body = document.querySelector('#stats-modal .stats-body');
    const scrolls = (el) => el.scrollHeight > el.clientHeight + 1;
    return {
      contentScrolls: scrolls(content),
      bodyScrolls: scrolls(body),
      bodyOverflow: getComputedStyle(body).overflowY,
    };
  });
}

for (const [name, viewport] of [
  ['short desktop window', { width: 900, height: 520 }],
  ['reference phone', { width: 360, height: 630 }],
  ['iOS viewport', { width: 390, height: 844 }],
]) {
  test(`the stats modal has ONE scroller on a ${name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    // The daily tab (default) always renders enough content to overflow a
    // 520px window, so the non-vacuity half of the pin holds with no
    // seeded history; the challenge tab is the reported surface.
    for (const tab of [null, 'match']) {
      await openStats(page, tab);
      const s = await scrollState(page);
      // The modal's own scroller is allowed, and on the SHORT DESKTOP
      // window the default tab genuinely uses it, which is the
      // non-vacuity half of this pin (a modal that never overflowed could
      // not demonstrate the second scroller). On the phone a signed-out
      // daily panel fits inside the modal, so only the never-scrolls half
      // applies there.
      if (!tab && viewport.height === 520) expect(s.contentScrolls).toBe(true);
      // The body wrapper must never scroll independently: that second
      // scroller is the reported bug.
      expect(s.bodyScrolls).toBe(false);
      expect(s.bodyOverflow).toBe('visible');
      await page.keyboard.press('Escape');
    }
  });
}
