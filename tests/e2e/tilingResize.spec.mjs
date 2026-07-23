// REGRESSION (2026-07-22): a tiling board never re-laid itself on viewport
// resize or phone rotation. Tiling cells are absolutely positioned with INLINE
// pixel left/top/width/height computed from the unit-pitch geometry at render
// time (_renderTilingBoard), so unlike the rectangular board — whose cells read
// var(--cell-size) through the CSS grid and reflow for free — a new pitch meant
// nothing until the cells were rebuilt. resizeCells() recomputed and set the
// pitch, then returned without touching them.
//
// Measured before the fix on ?coastline=hex at 390x844 -> 320x700: the pitch
// dropped 45 -> 36 while the board stayed frozen at 342x368 and ended up WIDER
// than its 284px container. The fix extracts layoutTilingCells() and calls it
// from resizeCells, so every path that changes the pitch re-lays the cells.
//
// Both shipped tilings are covered: the hexagonal 6.6.6 and the 4.8.8, since
// the frozen-geometry bug was in the shared tiling layout path.

import { test, expect } from '@playwright/test';
import { prepareInteractionSpec, settleAnimations } from './helpers.mjs';

test.use({ viewport: { width: 390, height: 844 } });

// The board's own box, its container, and how far the painted cells spill past
// the board. A frozen layout shows up as a board whose size does not track the
// pitch — and, once the viewport is small enough, one wider than its container.
async function boardFit(page) {
  // Cells run their reveal/cascade choreography; a rect read mid-flight is not
  // where the layout settles (see settleAnimations).
  await settleAnimations(page);
  return page.evaluate(() => {
    const board = document.getElementById('board');
    const container = document.getElementById('board-container');
    const br = board.getBoundingClientRect();
    const cr = container.getBoundingClientRect();
    const cells = [...board.children].filter(c => c.classList && c.classList.contains('cell'));
    const rects = cells.map(c => c.getBoundingClientRect());
    return {
      pitch: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell-size')),
      boardW: br.width,
      boardH: br.height,
      containerW: cr.width,
      spillRight: Math.max(...rects.map(r => r.right)) - br.right,
      spillBottom: Math.max(...rects.map(r => r.bottom)) - br.bottom,
      docScrollsX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

for (const [label, param] of [['6.6.6 hexagonal', 'hex'], ['4.8.8', '1']]) {
  test(`REGRESSION: a ${label} tiling board re-lays itself on resize and rotation`, async ({ page }) => {
    await prepareInteractionSpec(page);
    await page.goto(`/?isTest=1&coastline=${param}`);
    await page.waitForFunction(() => {
      const b = document.getElementById('board');
      return b && [...b.children].filter(c => c.classList && c.classList.contains('cell')).length > 5;
    }, { timeout: 30000 });

    const portrait = await boardFit(page);
    expect(portrait.pitch).toBeGreaterThan(0);
    expect(portrait.boardW).toBeLessThanOrEqual(portrait.containerW + 1);

    // Rotate to landscape. The height budget collapses, so the pitch must
    // shrink AND the board must shrink with it.
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(300);
    const landscape = await boardFit(page);
    expect(landscape.pitch).toBeLessThan(portrait.pitch);
    expect(landscape.boardW).toBeLessThan(portrait.boardW);
    expect(landscape.boardH).toBeLessThan(portrait.boardH);

    // Narrow portrait: the container is narrower than the original board, so a
    // frozen board would now overflow it. This is the case that actually broke.
    await page.setViewportSize({ width: 320, height: 700 });
    await page.waitForTimeout(300);
    const narrow = await boardFit(page);
    expect(narrow.boardW).toBeLessThanOrEqual(narrow.containerW + 1);
    expect(narrow.docScrollsX).toBe(false);

    // Cells always stay within the board box they were laid into.
    for (const state of [portrait, landscape, narrow]) {
      expect(state.spillRight).toBeLessThanOrEqual(1);
      expect(state.spillBottom).toBeLessThanOrEqual(1);
    }

    // Growing back restores a larger pitch — the relayout is not one-way.
    await page.setViewportSize({ width: 900, height: 950 });
    await page.waitForTimeout(300);
    const grown = await boardFit(page);
    expect(grown.pitch).toBeGreaterThan(narrow.pitch);
    expect(grown.boardW).toBeGreaterThan(narrow.boardW);
    expect(grown.boardW).toBeLessThanOrEqual(grown.containerW + 1);
  });
}
