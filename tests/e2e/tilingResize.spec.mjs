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
// Every tiling is covered, because the frozen-geometry bug was in the shared
// tiling layout path. The four Laves tilings (2026-07-27) matter here beyond
// repeating the original bug: their cells occur in several ORIENTATIONS, so each
// one carries a per-cell clip-path and a per-cell box rather than the single
// per-shape constant the first two tilings could share. A re-lay that recomputed
// the box but reused a stale clip-path would leave the polygon and its box
// disagreeing, which is exactly the class this spec is here to catch.

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
      // Clip-paths are expressed in percentages of each cell's OWN box, so they
      // are scale-free and must be identical at every pitch. The count of
      // DISTINCT ones is the tiling's orientation count, which is the thing a
      // per-cell derivation can get wrong by collapsing every cell onto one
      // orientation — a fault no rect measurement can see, because clip-path is
      // paint and getBoundingClientRect reports the unclipped box.
      clips: [...new Set(cells.map(c => c.style.clipPath).filter(Boolean))].sort().join('|'),
      spillRight: Math.max(...rects.map(r => r.right)) - br.right,
      spillBottom: Math.max(...rects.map(r => r.bottom)) - br.bottom,
      docScrollsX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

// Orientation counts, measured from the shipped builders. A cell's shape is one
// polygon per ORIENTATION, and only the two Archimedean tilings have a single
// orientation per shape — which is why the per-shape clip-path constants they
// shipped with had to become a per-cell derivation.
const ORIENTATIONS = { hex: 1, 1: 2, cairo: 4, floret: 6, rhombille: 3, deltoidal: 6 };

for (const [label, param] of [
  ['6.6.6 hexagonal', 'hex'],
  ['4.8.8', '1'],
  ['Cairo pentagonal', 'cairo'],
  ['floret pentagonal', 'floret'],
  ['rhombille', 'rhombille'],
  ['deltoidal trihexagonal', 'deltoidal'],
]) {
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

    // Every orientation this lattice has is actually drawn. Collapsing the
    // per-cell derivation onto one orientation leaves boxes and rects untouched,
    // so without this the spec's own claim to guard the clip-path was empty.
    expect(portrait.clips.split('|').length).toBe(ORIENTATIONS[param]);

    // The board's box IS the tiling's extent times the pitch, so the ratio
    // boardW/pitch is a constant of the tiling and must survive every re-lay.
    // That is the invariant the frozen-layout bug actually broke, and unlike a
    // directional claim it holds for every board shape: rhombille and deltoidal
    // are WIDE AND SHORT, so rotating to landscape hands them more room and
    // their pitch GROWS (measured 26 -> 35 and 27 -> 33) where the hexagon's
    // shrinks. Asserting "the pitch went down on rotation" passed only because
    // both shipped tilings happen to be tall.
    const ratio = portrait.boardW / portrait.pitch;

    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(300);
    const landscape = await boardFit(page);
    expect(landscape.pitch).not.toBeCloseTo(portrait.pitch, 1);
    expect(landscape.boardW / landscape.pitch).toBeCloseTo(ratio, 1);
    expect(landscape.boardW).toBeLessThanOrEqual(landscape.containerW + 1);

    // Narrow portrait: the container is narrower than the original board, so a
    // frozen board would now overflow it. This is the case that actually broke.
    await page.setViewportSize({ width: 320, height: 700 });
    await page.waitForTimeout(300);
    const narrow = await boardFit(page);
    expect(narrow.boardW).toBeLessThanOrEqual(narrow.containerW + 1);
    expect(narrow.docScrollsX).toBe(false);
    expect(narrow.boardW / narrow.pitch).toBeCloseTo(ratio, 1);
    // Percentage clip-paths are scale-free, so a re-lay must reproduce them
    // exactly. A re-lay that recomputed the box but reused a stale clip-path
    // would leave the polygon and its box disagreeing.
    expect(narrow.clips).toBe(portrait.clips);
    expect(landscape.clips).toBe(portrait.clips);

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
