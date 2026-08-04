// The Daily card names today's board shape, and the card still fits.
//
// REGRESSION (2026-08-04, v1.10): the shape line was first written into the
// par corner as "Paving Stones · Par 240s". Measured on the shipped layout
// that corner is 174px wide at most, and the string OVERLAPPED the streak
// corner ("128 days") on every viewport. The four corners are already spoken
// for; the centre descriptor is the one place with room, and the shape is a
// descriptor of the board rather than a statistic, so that is where it went.
//
// The card's own content comes from the CANONICAL board and only resolves
// once Firebase answers, which an e2e context cannot depend on. So this
// measures the LAYOUT with the longest real content injected: the longest
// shape name, a three-digit streak, a three-digit par, and a full field
// note. If that fits, every real combination fits.

import { test, expect } from '@playwright/test';
import { prepareInteractionSpec } from './helpers.mjs';

// "Paving Stones" is the longest of the seven names; the note is a real
// fieldNoteFromBoard shape.
const LONGEST = {
  streak: '128 days',
  par: 'Par 240s',
  note: 'Paving Stones today. A wormhole day. I want the pair counts.',
};

const VIEWPORTS = [
  { width: 390, height: 844, name: 'iOS' },
  { width: 360, height: 800, name: 'Android' },
  { width: 1280, height: 800, name: 'desktop' },
];

for (const vp of VIEWPORTS) {
  test(`REGRESSION: the Daily card holds the longest shape line without overlap (${vp.name})`, async ({ page }) => {
    await prepareInteractionSpec(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/?isTest=1');
    await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 30_000 });
    await page.waitForSelector('.mode-card[data-mode="daily"]', { timeout: 20_000 });

    const geom = await page.evaluate((L) => {
      const el = document.getElementById('title-daily-progress');
      const card = el.closest('.mode-card');
      const sibling = document.querySelector('.mode-card[data-mode="weekly"]');
      el.innerHTML = `<span class="daily-corner-stat daily-corner-streak">${L.streak}</span>`
        + `<span class="daily-corner-stat daily-corner-par">${L.par}</span>`
        + `<span class="mode-card-fieldnote">${L.note}</span>`;
      const r = (sel) => el.querySelector(sel).getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const par = r('.daily-corner-par');
      const streak = r('.daily-corner-streak');
      const note = r('.mode-card-fieldnote');
      return {
        cardWidth: cardRect.width,
        cardHeight: cardRect.height,
        siblingHeight: sibling.getBoundingClientRect().height,
        cornersOverlap: par.left < streak.right,
        noteHitsCorners: note.bottom > streak.top + 1 || note.bottom > par.top + 1,
        noteOverflows: note.bottom > cardRect.bottom || note.right > cardRect.right + 1,
        parClipped: el.querySelector('.daily-corner-par').scrollWidth
          > el.querySelector('.daily-corner-par').clientWidth + 1,
      };
    }, LONGEST);

    expect(geom.cornersOverlap,
      `the bottom corners collide at ${geom.cardWidth.toFixed(0)}px wide`).toBe(false);
    expect(geom.noteHitsCorners, 'the note must clear the corner stats').toBe(false);
    expect(geom.noteOverflows, 'the note must stay inside the card').toBe(false);
    expect(geom.parClipped, 'the par corner must not be clipped').toBe(false);

    // The Daily card shares a grid row with Weekly, so a taller Daily must
    // take its neighbour with it rather than breaking the row's alignment.
    expect(Math.abs(geom.cardHeight - geom.siblingHeight)).toBeLessThan(1);
  });
}
