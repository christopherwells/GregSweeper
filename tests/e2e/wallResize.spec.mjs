// REGRESSION (2026-07-17): wall overlays are absolutely-positioned pixel
// divs built from live cell rects (renderWallOverlays), but the window
// resize handler only refit the cells — it never re-rendered the walls, so
// any viewport resize (window drag, phone rotation) left the wall lines at
// their old pixel positions, visually detached from the edges they mark
// (measured: 62px off after a 900px→420px shrink — two cells away from the
// real edge, and sized for the old cells). The theme-switch refit in
// applyThemeLive had the same staleness: it repositioned worm overlays but
// not walls. The fix re-renders wall overlays from both paths, matching the
// worm overlay's treatment.
//
// The spec plays the real journey: a challenge L36 practice board (the
// Challenge 250 walls remix block — the ladder's specs author their
// modifiers). Under the C250 engine the board is FROZEN at newGame, so
// the wall lines paint before any click (the daily contract); the
// viewport then shrinks and every .wall-line must still sit exactly
// where the live cell rects say its edge is — the same midpoint math
// renderWallOverlays uses.
//
// The LEVEL CHOICE is load-bearing: the assertion only has power if the
// cells actually move, so the board must be big enough that a 900→420px
// shrink re-fits it. The walls INTRO block (L6-10) was used until the
// L1-10 ramp shrank those boards to 6×6-8×8, which fit at both widths
// and left the spec asserting nothing; block 8's 11×11 is comfortably
// constrained at 420px.

import { test, expect } from '@playwright/test';
import { challengeSpecForLevel, CHALLENGE_MAX_LEVEL } from '../../src/logic/challenge250.js';
import { prepareInteractionSpec, settleAnimations } from './helpers.mjs';

test.use({ viewport: { width: 900, height: 950 } });

// Measure how far each painted .wall-line sits from where the CURRENT cell
// rects put its edge (recomputing renderWallOverlays' own geometry). A
// stale overlay shows up as a large maxDev; an aligned one is sub-pixel.
async function wallAlignment(page) {
  // Revealed cells run their per-theme reveal choreography, and a cell rect
  // read mid-animation is not where the layout puts it — which is what the
  // wall lines are measured against. Settle first (see settleAnimations).
  await settleAnimations(page);
  return page.evaluate(async () => {
    const { state } = await import('/src/state/gameState.js');
    const boardEl = document.getElementById('board');
    const cols = state.cols;
    const boardRect = boardEl.getBoundingClientRect();
    const bx = boardEl.offsetLeft, by = boardEl.offsetTop;
    const pos = (r, c) => {
      const rect = boardEl.children[r * cols + c].getBoundingClientRect();
      return { left: rect.left - boardRect.left + bx, top: rect.top - boardRect.top + by,
               right: rect.right - boardRect.left + bx, bottom: rect.bottom - boardRect.top + by,
               width: rect.width, height: rect.height };
    };
    const lines = [...document.querySelectorAll('.wall-line')];
    const edges = [...(state.board?._wallEdges ?? [])];
    let maxDev = 0;
    edges.forEach((key, i) => {
      const el = lines[i];
      if (!el) { maxDev = Infinity; return; }
      const [from, to] = key.split('-');
      const [r1, c1] = from.split(',').map(Number);
      const [r2, c2] = to.split(',').map(Number);
      const p1 = pos(r1, c1), p2 = pos(r2, c2);
      let exp;
      if (r1 === r2) {
        const L = c1 < c2 ? p1 : p2, R = c1 < c2 ? p2 : p1;
        exp = { left: (L.right + R.left) / 2, top: p1.top, span: p1.height };
      } else {
        const T = r1 < r2 ? p1 : p2, B = r1 < r2 ? p2 : p1;
        exp = { left: p1.left, top: (T.bottom + B.top) / 2, span: p1.width };
      }
      const dev = Math.max(
        Math.abs(exp.left - parseFloat(el.style.left)),
        Math.abs(exp.top - parseFloat(el.style.top)),
        Math.abs(exp.span - parseFloat(el.style.height || el.style.width)),
      );
      maxDev = Math.max(maxDev, dev);
    });
    return {
      edgeCount: edges.length,
      lineCount: lines.length,
      maxDev,
      cellSize: getComputedStyle(document.documentElement).getPropertyValue('--cell-size'),
    };
  });
}

test('REGRESSION: wall overlays track their cells through a viewport resize', async ({ page }) => {
  await prepareInteractionSpec(page);
  await page.addInitScript(() => {
    // No first-encounter modifier popup over the board mid-spec.
    try { localStorage.setItem('minesweeper_modifier_popup_disabled', 'true'); } catch {}
  });
  // DERIVED, not hardcoded. This spec was pinned to L36 because the authored
  // table put walls there; the ladder draws from a pool now, so the level is
  // found by asking which one is a rectangle carrying walls. The biggest such
  // board is preferred — a resize has more to get wrong on a wide one.
  const wallLevel = (() => {
    let best = null;
    for (let lv = 1; lv <= CHALLENGE_MAX_LEVEL; lv++) {
      const s = challengeSpecForLevel(lv);
      if (s.shape !== 'rect' || !s.gimmicks.includes('walls')) continue;
      if (!best || s.cells > best.cells) best = { lv, cells: s.cells };
    }
    return best;
  })();
  expect(wallLevel, 'the ladder carries no rectangular walls board').not.toBeNull();
  await page.goto(`/?isTest=1&level=${wallLevel.lv}`);
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 20_000 });
  await page.waitForSelector('#board .cell', { timeout: 20_000 });

  // The frozen draw carries walls from newGame — no click needed. A
  // rare layout can still lose its edges to applyWalls' isolation check,
  // so redraw (reset = a fresh certified layout of the same spec) until
  // the lines are painted.
  let ready = false;
  for (let attempt = 0; attempt < 6 && !ready; attempt++) {
    if (attempt > 0) await page.click('#reset-btn');
    ready = await page.waitForSelector('.wall-line', { timeout: 4_000 })
      .then(() => true, () => false);
  }
  expect(ready, 'a walls board with painted wall lines within 6 attempts').toBe(true);

  const before = await wallAlignment(page);
  expect(before.edgeCount).toBeGreaterThan(0);
  expect(before.lineCount).toBe(before.edgeCount);
  expect(before.maxDev, 'walls aligned at the starting viewport').toBeLessThan(1);

  // Shrink the viewport (the phone-rotation / window-drag shape). The cells
  // must actually move for the assertion to have power.
  await page.setViewportSize({ width: 420, height: 900 });
  await expect
    .poll(async () => (await wallAlignment(page)).cellSize, { timeout: 5_000 })
    .not.toBe(before.cellSize);

  const after = await wallAlignment(page);
  expect(after.lineCount, 'wall lines survive the resize').toBe(after.edgeCount);
  expect(after.maxDev, `wall lines must be re-laid against the ${after.cellSize} cells (stale overlays measured 62px off)`)
    .toBeLessThan(1);
});
