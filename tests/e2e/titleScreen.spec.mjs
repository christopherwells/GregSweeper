import { test, expect } from '@playwright/test';

// Title-screen integrity for the 2026-06-25 front-door rebuild. The boot smoke
// proves the title renders without a console error; these prove the two design
// decisions survive: (1) the animated Greg mascot actually mounts in the header
// (a regression that drops the startGregMascot call would still boot clean, so
// the smoke can't see it), and (2) the "one Greg" call — the Daily card rides
// its calendar icon, never re-growing a note-Greg sprite.

test.beforeEach(async ({ page }) => {
  // Onboarded user lands straight on the title (skips the tutorial overlay).
  await page.addInitScript(() => { try { localStorage.setItem('minesweeper_onboarded', 'true'); } catch {} });
});

test('the title header mounts the animated Greg mascot', async ({ page }) => {
  await page.goto('?isTest=1');
  // The mascot is injected by startGregMascot in init; its smile + eye hooks
  // appearing means the SVG mounted. A dropped call would never satisfy this.
  // The smile is a two-path open/closed toggle (theme-aware rig, 2026-06-27).
  await page.waitForSelector('#title-greg-mascot svg .greg-smile-open', { timeout: 20_000 });
  const ok = await page.evaluate(() => {
    const el = document.getElementById('title-greg-mascot');
    return !!(el && el.querySelector('.greg-eyes-open') && el.querySelector('.greg-eyes-closed')
      && el.querySelector('.greg-smile-open') && el.querySelector('.greg-smile-closed'));
  });
  expect(ok, 'the header Greg must carry its eyes + smile (open + closed) for the blink/smile rig').toBe(true);
});

test('the Daily card keeps its calendar icon and grows no note-Greg', async ({ page }) => {
  await page.goto('?isTest=1');
  await page.waitForSelector('#title-screen:not(.hidden)', { timeout: 20_000 });
  await page.waitForTimeout(300); // let updateTitleProgress fill the card
  const calendarIcon = await page.evaluate(() => !!document.querySelector('.mode-card[data-mode="daily"] .mode-card-icon img, .mode-card[data-mode="daily"] .mode-card-icon svg'));
  const noteGreg = await page.evaluate(() => !!document.querySelector('#title-daily-progress .sprite-greg-note'));
  expect(calendarIcon, 'the Daily card keeps its calendar mode icon').toBe(true);
  expect(noteGreg, 'the Daily card note-Greg was dropped (one Greg lives in the header)').toBe(false);
});
