// The "Start here" label must TRACK its cell through scroll (2026-07-12).
//
// The label is the certified no-guess entry marker for the daily. It used
// to be position:fixed with viewport coordinates captured once at render —
// a phone player who scrolled before their first click saw it hovering
// over the WRONG square, actively misdirecting them toward an uncertified
// opener. It now anchors inside #board with board-relative coordinates, so
// scrolling moves label and cell together. This spec scrolls the page and
// asserts the label's offset from its cell is unchanged.

import { test, expect } from '@playwright/test';
import { prepareInteractionSpec, settleAnimations } from './helpers.mjs';

test.use({ viewport: { width: 390, height: 600 } }); // phone-sized

test('REGRESSION: the Start-here label rides its cell when the page scrolls', async ({ page }) => {
  await prepareInteractionSpec(page);
  // Practice daily (?mode=daily&seed=) runs the full daily pipeline
  // locally — no canonical fetch — and renders the certified start
  // marker + label. The seed param is only consumed by the daily deep link.
  await page.goto('/?mode=daily&seed=fitF&isTest=1');

  const cell = page.locator('#board .cell.suggested-start');
  const label = page.locator('#start-here-label');
  await expect(cell).toBeVisible({ timeout: 30_000 }); // local board gen + solver
  await expect(label).toBeVisible();

  // The label enters on a 0.5s `fade-in-start` that translates it from
  // -80% to -100% of its own height, so a rect read mid-animation is a
  // position the layout never settles at. Both samples must be taken at
  // rest or they disagree by however far the animation happened to have
  // travelled between them.
  const offsetOf = async () => {
    await settleAnimations(page);
    const c = await cell.boundingBox();
    const l = await label.boundingBox();
    return { dx: l.x - c.x, dy: l.y - c.y, cellY: c.y };
  };

  // The board fit deliberately keeps the whole page on screen, so make the
  // page scrollable synthetically: what's under test is the MECHANISM
  // (scroll moves the cell on screen; the label must ride along), not how
  // the overflow arises — a real phone gets it from the URL bar collapse,
  // zoomed boards, and short landscape viewports. body is a centered ROW
  // flexbox pinned to 100% height with overflow-y:auto, so vertical
  // overflow needs a flex item TALLER than the viewport; body is then the
  // element that scrolls.
  await page.evaluate(() => {
    const spacer = document.createElement('div');
    spacer.style.minHeight = '150vh';
    spacer.style.width = '1px';
    spacer.style.flexShrink = '0';
    document.body.appendChild(spacer);
  });
  const before = await offsetOf();
  await page.evaluate(() => {
    window.scrollBy(0, 150);
    document.body.scrollTop += 150;
  });

  const after = await offsetOf();
  // The cell moving on screen IS the proof the scroll happened.
  expect(Math.abs(after.cellY - before.cellY)).toBeGreaterThan(50);
  // At rest the offset is EXACT, so this pins to a tenth of a pixel rather
  // than the half-pixel the animation noise used to force. A fixed-position
  // label fails by ~150px here: the cell moves, the label does not.
  expect(after.dx).toBeCloseTo(before.dx, 1);
  expect(after.dy).toBeCloseTo(before.dy, 1);
});
