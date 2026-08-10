// Challenge 250 expected-time cue (his ruling: displayed, handicap-
// adjusted, "go go go, but no real punishment"). The pure fill math is
// node-tested in test/expectedTime.test.mjs; this pins that the surface
// actually RENDERS on a ladder board and stays absent everywhere else —
// a CSS/DOM claim the pure test cannot make.

import { test, expect } from '@playwright/test';
import { prepareInteractionSpec, settleAnimations } from './helpers.mjs';

// Waiting for `#board .cell` is not enough: it matches the DEFAULT level's
// board too, and under parallel load this spec measured a Level 1 board and
// then won it on the opening click ("You Win! Time: 0.0s"), so the clock
// never ran and the bar never filled. `#level-display` is written from
// state.currentLevel, so it is the signal that the requested level actually
// landed — and asserting it also closes a vacuity hole, since the test's
// whole premise is that level 26 is a specific kind of board.
async function enterChallengeLevel(page, level) {
  await page.goto(`/?isTest=1&level=${level}`);
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 20_000 });
  await page.waitForSelector('#board .cell', { timeout: 20_000 });
  await expect(page.locator('#level-display')).toHaveText(`Level ${level}`, { timeout: 20_000 });
}

// The first reveal on a debut board raises the intro cards, and BOTH of them
// stop the clock while they are read — a card is not play. So the pace bar
// legitimately does not move until they are dismissed, and a spec that
// measures the fill has to clear them the way a player does. The modifier
// card is a deck (primer, one per unseen modifier, recap), so this advances
// until nothing is left up.
async function dismissIntroCards(page) {
  const shape = page.locator('#shape-intro-overlay');
  const gimmick = page.locator('#gimmick-intro-overlay');
  for (let i = 0; i < 8; i++) {
    if (await shape.isVisible().catch(() => false)) {
      await page.locator('#shape-intro-ok').click();
      // hideModal adds .modal-closing and only adds .hidden 250ms later, so
      // the overlay is still visible right after the click; re-checking
      // immediately would click a card that is already on its way out.
      await expect(shape).toBeHidden({ timeout: 5_000 });
      continue;
    }
    if (await gimmick.isVisible().catch(() => false)) {
      // The modifier deck advances IN PLACE, so this one does not go hidden
      // between cards. The loop bound is what terminates it.
      await page.locator('#gimmick-intro-ok').click();
      await page.waitForTimeout(350);
      continue;
    }
    return;
  }
  throw new Error('intro cards never cleared');
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

  // Play the certified opener to start the clock, clear the debut cards,
  // then let it run.
  await page.click('#board .cell.suggested-start');
  await dismissIntroCards(page);
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
