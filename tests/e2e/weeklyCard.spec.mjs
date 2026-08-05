import { test, expect } from '@playwright/test';
import { prepareInteractionSpec, settleAnimations } from './helpers.mjs';

// The Weekly card's furniture (2026-08-05): a week streak, a par, and a Past
// weeklies chip, mirroring the Daily card.
//
// Three things need a browser to be worth pinning. (1) The corner stats are
// ABSOLUTELY positioned inside a card that reserves a bottom band for them, so
// whether they overlap the centre line is a layout question — the same one
// that sent the daily's shape label out of the par corner. (2) The Past chip
// lives INSIDE a <button>, so its tap has to be caught by a capture-phase
// handler before the card's own launch handler; if that ordering breaks, the
// chip silently starts this week's weekly instead of opening the list, which
// no unit test can see. (3) The list must not offer the CURRENT week, which is
// the live Weekly's job.

test.beforeEach(async ({ page }) => {
  await prepareInteractionSpec(page);
});

/** Seed a week streak so the corner has something to render. */
async function seedWeekStreak(page, { streak, best, lastWeek }) {
  await page.addInitScript((rec) => {
    try {
      const s = JSON.parse(localStorage.getItem('minesweeper_stats') || '{}');
      s.weekStreak = rec;
      localStorage.setItem('minesweeper_stats', JSON.stringify(s));
    } catch {}
  }, { streak, best, lastWeek });
}

/** This week's Monday in ET, computed the way the app does. */
async function currentWeekStart(page) {
  return page.evaluate(() => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    const d = new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  });
}

test('the week streak renders in the card corner without covering the centre line', async ({ page }) => {
  await seedWeekStreak(page, { streak: 6, best: 6, lastWeek: '1970-01-05' });
  await page.goto('?isTest=1');
  await page.waitForSelector('.mode-card[data-mode="weekly"]');
  // A 1970 lastWeek is long lapsed, so nothing should render — the streak is
  // over and the card must not keep advertising it.
  await expect(page.locator('.mode-card[data-mode="weekly"] .daily-corner-streak')).toHaveCount(0);
});

test('a live week streak shows, and its corners clear the centre line at phone width', async ({ page }) => {
  const thisWeek = await (async () => {
    await page.goto('?isTest=1');
    return currentWeekStart(page);
  })();
  await seedWeekStreak(page, { streak: 12, best: 12, lastWeek: thisWeek });
  await page.setViewportSize({ width: 390, height: 844 }); // iPhone-ish
  await page.goto('?isTest=1');

  const streak = page.locator('.mode-card[data-mode="weekly"] .daily-corner-streak');
  await expect(streak).toHaveCount(1);
  await expect(streak).toHaveText('12 weeks');

  await settleAnimations(page);
  // The corner must sit clear of the descriptor line, the failure the Daily
  // card's par corner already produced once.
  const overlap = await page.evaluate(() => {
    const card = document.querySelector('.mode-card[data-mode="weekly"]');
    const corner = card.querySelector('.daily-corner-streak').getBoundingClientRect();
    const note = card.querySelector('.mode-card-fieldnote').getBoundingClientRect();
    const chip = card.querySelector('.card-archive-btn').getBoundingClientRect();
    const hit = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
    return {
      noteOverlap: hit(corner, note),
      chipOverlap: hit(chip, note),
      cornerInsideCard: corner.bottom <= card.getBoundingClientRect().bottom + 0.5,
    };
  });
  expect(overlap.noteOverlap).toBe(false);
  expect(overlap.chipOverlap).toBe(false);
  expect(overlap.cornerInsideCard).toBe(true);
});

test('the Past chip opens the weekly list instead of starting this week\'s board', async ({ page }) => {
  await page.goto('?isTest=1');
  await page.waitForSelector('.mode-card[data-mode="weekly"] .card-archive-btn');
  await page.click('.mode-card[data-mode="weekly"] .card-archive-btn');

  // The list opened...
  await expect(page.locator('#weekly-archive-modal')).not.toHaveClass(/hidden/);
  // ...and the game did NOT start behind it (the capture-phase ordering).
  await expect(page.locator('#app')).toHaveClass(/hidden/);
});

test('the list offers past weeks only, never the current one', async ({ page }) => {
  await page.goto('?isTest=1');
  const thisWeek = await currentWeekStart(page);
  await page.click('.mode-card[data-mode="weekly"] .card-archive-btn');
  await page.waitForSelector('#weekly-archive-modal:not(.hidden)');

  const weeks = await page.$$eval('.weekly-archive-row', (rows) => rows.map((r) => r.dataset.week || ''));
  expect(weeks.length).toBeGreaterThan(0);
  expect(weeks).not.toContain(thisWeek);
  // Strictly descending, newest first.
  const playable = weeks.filter(Boolean);
  expect([...playable].sort().reverse()).toEqual(playable);
  for (const w of playable) expect(w < thisWeek).toBe(true);
});
