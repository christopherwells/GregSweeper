// Challenge 250 expected-time cue (his ruling: displayed, handicap-
// adjusted, "go go go, but no real punishment"). The pure fill math is
// node-tested in test/expectedTime.test.mjs; this pins that the surface
// actually RENDERS on a ladder board and stays absent everywhere else —
// a CSS/DOM claim the pure test cannot make.

import { test, expect } from '@playwright/test';
import { prepareInteractionSpec, settleAnimations } from './helpers.mjs';

async function enterChallengeLevel(page, level) {
  await page.goto(`/?isTest=1&level=${level}`);
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 20_000 });
  await page.waitForSelector('#board .cell', { timeout: 20_000 });
}

test('the pace bar shows the expected time on a ladder board and fills as the clock runs', async ({ page }) => {
  await prepareInteractionSpec(page);
  await enterChallengeLevel(page, 26); // block 6: the Honeycomb shape intro

  const bar = page.locator('#pace-bar');
  await expect(bar).toBeVisible();

  // The label is the expected-time line, hedged (personalPar is an
  // estimate for a board nobody has played).
  const label = page.locator('#pace-bar-label');
  await expect(label).toHaveText(/^About \d+(s|:\d\d)$/);

  // Fresh board: the timer has not started (challenge boards are frozen —
  // the clock starts on the first reveal), so the bar reads empty.
  await settleAnimations(page);
  const before = await page.locator('#pace-bar-fill').evaluate((el) => el.getBoundingClientRect().width);
  expect(before).toBeLessThan(2);

  // Play the certified opener to start the clock, then let it run.
  await page.click('#board .cell.suggested-start');
  await expect.poll(
    async () => page.locator('#pace-bar-fill').evaluate((el) => el.getBoundingClientRect().width),
    { timeout: 8_000, message: 'the bar must fill as the timer runs' },
  ).toBeGreaterThan(before);

  // The fill never overflows its track — the clamp is the no-punishment
  // rule made visible — and the LABEL is never clipped by the row (the
  // first cut positioned it absolutely and a phone cut the text off).
  const geom = await page.evaluate(() => {
    const row = document.getElementById('pace-bar');
    const track = row.querySelector('.pace-bar-track');
    const fill = document.getElementById('pace-bar-fill');
    const label = document.getElementById('pace-bar-label');
    const r = row.getBoundingClientRect(), l = label.getBoundingClientRect();
    return {
      overflow: fill.getBoundingClientRect().width - track.getBoundingClientRect().width,
      labelWidth: l.width,
      clippedRight: l.right - r.right,
      clippedBottom: l.bottom - r.bottom,
    };
  });
  expect(geom.overflow).toBeLessThanOrEqual(0.5);
  expect(geom.labelWidth, 'the label must occupy real width').toBeGreaterThan(20);
  expect(geom.clippedRight, 'the label must fit inside the row').toBeLessThanOrEqual(0.5);
  expect(geom.clippedBottom, 'the label must not spill below the row').toBeLessThanOrEqual(0.5);
});

test('the pace bar stays absent outside the challenge ladder', async ({ page }) => {
  await prepareInteractionSpec(page);

  // Quick Play: has its own end-of-run par line; no pace cue mid-board.
  await page.goto('?isTest=1');
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 20_000 });
  await page.waitForSelector('#title-screen:not(.hidden)', { timeout: 20_000 });
  await page.click('.mode-card[data-mode="timed"]');
  await page.waitForSelector('#board .cell', { timeout: 20_000 });
  await expect(page.locator('#pace-bar')).toBeHidden();

  // Daily: likewise reports against par at the END, where the comparison
  // belongs — and its par is the shared daily par, not a ladder cue.
  await page.goto('/?isTest=1&mode=daily&seed=pacebar1');
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 20_000 });
  await page.waitForSelector('#board .cell', { timeout: 20_000 });
  await expect(page.locator('#pace-bar')).toBeHidden();
});
