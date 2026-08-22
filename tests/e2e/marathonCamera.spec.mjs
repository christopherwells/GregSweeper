// The marathon camera, driven through the REAL input path (the #363 lesson:
// a pure-tested helper crashed every real deal because no test crossed the
// wiring). These journeys boot a stored oversized-on-purpose board via the
// ?matchboard= practice lane with the cell-size preference set to Large, then
// drive the touch handlers with synthetic TouchEvents (deterministic timing;
// two Playwright taps under CI load can straddle the 350ms double-tap
// window, which is the flake class) and the mouse handlers with dblclick.
//
// Expected camera targets are computed IN PAGE by importing the shipped
// boardCamera module, never by re-deriving the formula here: the spec then
// pins "the driver agrees with the math", while the clamp semantics
// themselves (the top-edge ruling) are pinned in test/boardCamera.test.mjs.
//
// Every geometry read settles animations first (tests/e2e/helpers.mjs).

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { prepareInteractionSpec, settleAnimations } from './helpers.mjs';
import { prefMinPx } from '../../src/logic/boardCamera.js';

// The first live PLAIN rect board at least 12x9 in the match library, found
// at run time (the library re-shards nightly; a hardcoded pin would rot).
// At the Large preference (40px) a >= 12x9 rect overflows both axes of a
// 360x630 phone and the width of a 390x844 one.
function bigRectPin() {
  for (let p = 0; p < 5000; p++) {
    let page;
    try {
      page = JSON.parse(readFileSync(new URL(
        `../../scripts/data/match-library/match-${String(p).padStart(3, '0')}.json`,
        import.meta.url), 'utf8'));
    } catch {
      break;
    }
    for (let i = 0; i < page.boards.length; i++) {
      const b = page.boards[i];
      if (b && !b.evicted && b.spec && b.spec.shape === 'rect'
        && b.spec.rows >= 12 && b.spec.cols >= 9
        && (b.spec.gimmicks || []).length === 0) {
        return { page: p, idx: i, board: b };
      }
    }
  }
  throw new Error('no live plain rect >= 12x9 in the match library; pick a new pin strategy');
}
const PIN = bigRectPin();

async function bootOversized(page, viewport) {
  await page.setViewportSize(viewport);
  await prepareInteractionSpec(page);
  await page.addInitScript(() => {
    try { localStorage.setItem('minesweeper_cell_size_pref', 'large'); } catch {}
  });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`/?isTest=1&matchboard=${PIN.page}:${PIN.idx}`);
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 30_000 });
  await page.waitForSelector('#board .cell', { timeout: 30_000 });
  await settleAnimations(page);
  return errors;
}

// One synthetic double-tap on the cell at (row, col): the app's touchstart
// hit-tests with elementFromPoint(clientX, clientY), so the touch aims at the
// cell's on-screen center; touchend reads the coords stored at touchstart.
async function doubleTapCell(page, row, col) {
  await page.evaluate(({ row, col }) => {
    const board = document.getElementById('board');
    const el = [...board.querySelectorAll('.cell')]
      .find((c) => +c.dataset.row === row && +c.dataset.col === col);
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const tapOnce = () => {
      const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
      board.dispatchEvent(new TouchEvent('touchstart', {
        bubbles: true, cancelable: true, touches: [t], changedTouches: [t],
      }));
      board.dispatchEvent(new TouchEvent('touchend', {
        bubbles: true, cancelable: true, touches: [], changedTouches: [t],
      }));
    };
    tapOnce();
    tapOnce();
  }, { row, col });
}

// The camera's live geometry plus the module-computed expected target for
// centering the given cell at the given scale.
function cameraExpectation(page, row, col, scale) {
  return page.evaluate(async ({ row, col, scale }) => {
    const { clampedScroll } = await import('/src/logic/boardCamera.js');
    const board = document.getElementById('board');
    const wrap = document.getElementById('board-scroll-wrapper');
    const el = [...board.querySelectorAll('.cell')]
      .find((c) => +c.dataset.row === row && +c.dataset.col === col);
    return clampedScroll({
      cx: board.clientLeft + el.offsetLeft + el.offsetWidth / 2,
      cy: board.clientTop + el.offsetTop + el.offsetHeight / 2,
      scale,
      boardW: board.offsetWidth, boardH: board.offsetHeight,
      viewW: wrap.clientWidth, viewH: wrap.clientHeight,
      originX: board.offsetLeft, originY: board.offsetTop,
    });
  }, { row, col, scale });
}

function liveView(page) {
  return page.evaluate(() => {
    const board = document.getElementById('board');
    const wrap = document.getElementById('board-scroll-wrapper');
    const m = new DOMMatrixReadOnly(getComputedStyle(board).transform);
    return {
      scrollLeft: wrap.scrollLeft, scrollTop: wrap.scrollTop,
      scale: m.a,
      boardW: board.offsetWidth, boardH: board.offsetHeight,
      viewW: wrap.clientWidth, viewH: wrap.clientHeight,
      revealed: board.querySelectorAll('.cell.revealed').length,
    };
  });
}

// A revealed numbered cell (a live navigation target: with no flags down, an
// unsatisfied number is "not yet chordable" and therefore navigable).
function revealedNumberCell(page, pick = 'any') {
  return page.evaluate((pick) => {
    const cells = [...document.querySelectorAll('#board .cell.revealed')]
      .filter((c) => /^\d+$/.test(c.textContent))
      .map((c) => ({ row: +c.dataset.row, col: +c.dataset.col, top: c.offsetTop }));
    if (!cells.length) return null;
    if (pick === 'topmost') cells.sort((a, b) => a.top - b.top);
    return cells[0];
  }, pick);
}

test.describe('the camera engages behind the preference', () => {
  for (const viewport of [{ width: 360, height: 630 }, { width: 390, height: 844 }]) {
    test(`Large preference makes the pinned board overflow and shows the controls at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      const errors = await bootOversized(page, viewport);

      // Vacuity guard first: if the board does not actually overflow, every
      // assertion after this one is measuring nothing.
      const v = await liveView(page);
      expect(v.boardW, 'the preference must make the board wider than the wrapper').toBeGreaterThan(v.viewW + 1);
      // DERIVED, never a literal: this pinned 40 until the ladder was
      // re-anchored to the tap floor (2026-08-21) and then failed for saying
      // nothing about the camera. What matters is that the preference the
      // boot set is the size the board got, whatever that ladder says today.
      const cell = await page.evaluate(() => parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--cell-size')));
      expect(cell).toBe(prefMinPx('large'));

      await expect(page.locator('#zoom-controls')).toBeVisible();

      // HIS RULING: the opening view is the WHOLE board ("I want people to
      // see that the board extends somehow"), so every cell is on screen,
      // including the marked opener, at a scale below 1.
      const opening = await page.evaluate(() => {
        const wrap = document.getElementById('board-scroll-wrapper');
        const w = wrap.getBoundingClientRect();
        const cells = [...document.querySelectorAll('#board .cell')];
        const inside = (el) => {
          const r = el.getBoundingClientRect();
          return r.top >= w.top - 2 && r.bottom <= w.bottom + 2
            && r.left >= w.left - 2 && r.right <= w.right + 2;
        };
        return {
          allVisible: cells.every(inside),
          openerVisible: inside(document.querySelector('#board .cell.suggested-start')),
          scale: new DOMMatrixReadOnly(getComputedStyle(document.getElementById('board')).transform).a,
        };
      });
      expect(opening.scale, 'the survey view must be zoomed out').toBeLessThan(1);
      expect(opening.allVisible, 'every cell must be on screen at the opening survey').toBe(true);
      expect(opening.openerVisible).toBe(true);

      expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
    });
  }

  test('the first click dives out of the survey to the played cell size', async ({ page }) => {
    const errors = await bootOversized(page, { width: 360, height: 630 });
    const before = await liveView(page);
    expect(before.scale, 'boots surveying').toBeLessThan(1);

    await page.locator('#board .cell.suggested-start').first().click();
    await page.waitForTimeout(600);
    await settleAnimations(page);

    const after = await liveView(page);
    expect(after.scale, 'the dive lands at the played cell size').toBeCloseTo(1, 1);
    expect(after.revealed, 'the click still revealed').toBeGreaterThan(0);
    // And the cell they opened is on screen after the dive.
    const openedVisible = await page.evaluate(() => {
      const el = document.querySelector('#board .cell.revealed');
      const wrap = document.getElementById('board-scroll-wrapper');
      const r = el.getBoundingClientRect();
      const w = wrap.getBoundingClientRect();
      return r.top >= w.top - 2 && r.bottom <= w.bottom + 2;
    });
    expect(openedVisible).toBe(true);
    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });

  test('a first click NEAR the marked opener is the marked opener (his snap ruling)', async ({ page }) => {
    const errors = await bootOversized(page, { width: 360, height: 630 });
    // Aim a few pixels off the opener's center, at a neighbouring cell: at
    // survey scale a cell is a few px across, so this lands on a DIFFERENT
    // cell, and the snap must still open the marked one.
    const aim = await page.evaluate(() => {
      const start = document.querySelector('#board .cell.suggested-start');
      const r = start.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      // One full cell to the right: far enough to land on a DIFFERENT cell
      // at whatever the survey scale turned out to be, and still inside the
      // 44px snap radius, which is the case the ruling is about.
      const x = cx + r.width * 1.1;
      const y = cy;
      const hit = document.elementFromPoint(x, y);
      const cell = hit && hit.closest ? hit.closest('.cell') : null;
      return {
        x, y, offset: r.width * 1.1,
        startRow: +start.dataset.row, startCol: +start.dataset.col,
        aimedRow: cell ? +cell.dataset.row : null,
        aimedCol: cell ? +cell.dataset.col : null,
        cellW: r.width,
      };
    });
    expect(aim.offset, 'the aim must stay inside the 44px snap radius to test the snap')
      .toBeLessThanOrEqual(44);
    expect(aim.aimedRow !== null, 'the aim must land on some cell').toBe(true);
    const aimedElsewhere = aim.aimedRow !== aim.startRow || aim.aimedCol !== aim.startCol;
    expect(aimedElsewhere, 'the aim must land on a DIFFERENT cell for the snap to matter').toBe(true);

    await page.mouse.click(aim.x, aim.y);
    await page.waitForTimeout(600);
    await settleAnimations(page);

    const opened = await page.evaluate(({ startRow, startCol }) => {
      const el = [...document.querySelectorAll('#board .cell')]
        .find((c) => +c.dataset.row === startRow && +c.dataset.col === startCol);
      return el.classList.contains('revealed');
    }, aim);
    expect(opened, 'the marked opener must be what opened').toBe(true);
    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });

  test('the default preference changes nothing: no overflow, no controls', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await prepareInteractionSpec(page);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`/?isTest=1&matchboard=${PIN.page}:${PIN.idx}`);
    await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 30_000 });
    await page.waitForSelector('#board .cell', { timeout: 30_000 });
    await settleAnimations(page);

    const v = await liveView(page);
    expect(v.boardW).toBeLessThanOrEqual(v.viewW + 1);
    await expect(page.locator('#zoom-controls')).toBeHidden();
    expect(errors, `page errors: ${errors.join(' | ')}`).toHaveLength(0);
  });
});

test('double-tap on a finished number glides the camera to the module-computed target', async ({ page }) => {
  const errors = await bootOversized(page, { width: 360, height: 630 });

  // Open the board at its marked opener (the certified entry), then settle.
  await page.locator('#board .cell.suggested-start').first().click();
  await settleAnimations(page);

  const target = await revealedNumberCell(page, 'topmost');
  expect(target, 'the opener must have revealed at least one number').not.toBeNull();

  const before = await liveView(page);
  await doubleTapCell(page, target.row, target.col);
  // The glide runs 380ms; settle it plus the trailing updateZoom.
  await page.waitForTimeout(600);
  await settleAnimations(page);

  const after = await liveView(page);
  expect(after.scale, 'centering a cell zooms to play scale').toBeCloseTo(1, 1);
  const expected = await cameraExpectation(page, target.row, target.col, after.scale);
  expect(Math.abs(after.scrollLeft - expected.left), 'horizontal target').toBeLessThanOrEqual(2);
  expect(Math.abs(after.scrollTop - expected.top), 'vertical target').toBeLessThanOrEqual(2);
  // No game action happened: the double-tap revealed nothing new.
  expect(after.revealed).toBe(before.revealed);

  expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
});

test('double-tapping the centered cell again toggles out to the survey view', async ({ page }) => {
  const errors = await bootOversized(page, { width: 360, height: 630 });
  await page.locator('#board .cell.suggested-start').first().click();
  await settleAnimations(page);

  const target = await revealedNumberCell(page);
  await doubleTapCell(page, target.row, target.col);
  await page.waitForTimeout(600);
  await doubleTapCell(page, target.row, target.col);
  await page.waitForTimeout(600);
  await settleAnimations(page);

  const v = await liveView(page);
  const fit = await page.evaluate(async () => {
    const { cameraFitScale } = await import('/src/logic/boardCamera.js');
    const board = document.getElementById('board');
    const wrap = document.getElementById('board-scroll-wrapper');
    return cameraFitScale(board.offsetWidth, board.offsetHeight, wrap.clientWidth, wrap.clientHeight);
  });
  expect(fit, 'this board must need a sub-1 survey scale').toBeLessThan(1);
  // zoomLevel is whole percent, so the applied scale rounds; allow that.
  expect(Math.abs(v.scale - fit) * 100).toBeLessThanOrEqual(1);
  // The whole board is on screen in survey.
  expect(v.boardW * v.scale).toBeLessThanOrEqual(v.viewW + 2);
  expect(v.boardH * v.scale).toBeLessThanOrEqual(v.viewH + 2);

  expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
});

test('a chord with work keeps chord semantics: it fires and the camera stays put', async ({ page }) => {
  const errors = await bootOversized(page, { width: 390, height: 844 });
  await page.locator('#board .cell.suggested-start').first().click();
  await settleAnimations(page);

  // Manufacture a chordable cell: find a revealed "1" with at least two
  // hidden neighbors, flag one of them (right-click, the contextmenu path),
  // and the "1" is satisfied with work remaining.
  const setup = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('#board .cell.revealed')];
    for (const el of cells) {
      if (el.textContent !== '1') continue;
      const row = +el.dataset.row;
      const col = +el.dataset.col;
      const hidden = [];
      for (const n of document.querySelectorAll('#board .cell.unrevealed')) {
        const nr = +n.dataset.row;
        const nc = +n.dataset.col;
        if (Math.abs(nr - row) <= 1 && Math.abs(nc - col) <= 1 && !(nr === row && nc === col)) {
          hidden.push({ row: nr, col: nc });
        }
      }
      if (hidden.length >= 2) return { one: { row, col }, flag: hidden[0] };
    }
    return null;
  });
  expect(setup, 'the opened board must offer a "1" with hidden neighbors').not.toBeNull();

  const flagCell = page.locator(
    `#board .cell[data-row="${setup.flag.row}"][data-col="${setup.flag.col}"]`);
  await flagCell.click({ button: 'right' });
  await settleAnimations(page);

  const before = await liveView(page);
  const oneCell = page.locator(
    `#board .cell[data-row="${setup.one.row}"][data-col="${setup.one.col}"]`);
  await oneCell.dblclick();
  await page.waitForTimeout(600);
  await settleAnimations(page);

  const after = await liveView(page);
  expect(after.revealed, 'the chord must have revealed the unflagged neighbors').toBeGreaterThan(before.revealed);
  expect(after.scrollLeft).toBe(before.scrollLeft);
  expect(after.scrollTop).toBe(before.scrollTop);
  expect(after.scale).toBeCloseTo(before.scale, 2);

  expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
});

test('wall overlays ride the camera transform: on their edges at a non-1 scale, in screen pixels', async ({ page }) => {
  // The re-parent's whole point: walls (and worms, same parent and math)
  // used to sit OUTSIDE #board and stayed unscaled while the cells scaled,
  // the desync the old zoomed match boards shipped with. This measures the
  // painted result in VIEWPORT space at a non-1 scale, so a regression to
  // sibling parentage cannot pass. Venue: the biggest walled rectangle in
  // the Climb library (the wallResize spec's own derivation), oversized via
  // the Large preference.
  const { readdirSync } = await import('node:fs');
  const wallLevel = (() => {
    const dir = new URL('../../scripts/data/climb-library/', import.meta.url);
    let best = null;
    for (const f of readdirSync(dir).filter((x) => /^level-\d+\.json$/.test(x))) {
      const j = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
      j.boards.forEach((b, i) => {
        if (b.spec.shape !== 'rect' || !b.spec.gimmicks.includes('walls')) return;
        if (!best || b.spec.cells > best.cells) best = { lv: j.level, board: i, cells: b.spec.cells };
      });
    }
    return best;
  })();
  expect(wallLevel, 'the library carries no rectangular walls board').not.toBeNull();

  await page.setViewportSize({ width: 360, height: 630 });
  await prepareInteractionSpec(page);
  await page.addInitScript(() => {
    try {
      localStorage.setItem('minesweeper_cell_size_pref', 'large');
      localStorage.setItem('minesweeper_modifier_popup_disabled', 'true');
    } catch {}
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`/?isTest=1&level=${wallLevel.lv}&board=${wallLevel.board}`);
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 20_000 });
  await page.waitForSelector('#board .cell', { timeout: 20_000 });
  let ready = false;
  for (let attempt = 0; attempt < 6 && !ready; attempt++) {
    if (attempt > 0) await page.click('#reset-btn');
    ready = await page.waitForSelector('.wall-line', { timeout: 4_000 })
      .then(() => true, () => false);
  }
  expect(ready, 'a walls board with painted wall lines within 6 attempts').toBe(true);

  // Vacuity guards: the camera must be engaged, and the scale must leave 1.
  await expect(page.locator('#zoom-controls')).toBeVisible();
  await page.click('#zoom-out');
  await settleAnimations(page);
  const measured = await page.evaluate(async () => {
    const { state } = await import('/src/state/gameState.js');
    const boardEl = document.getElementById('board');
    const scale = new DOMMatrixReadOnly(getComputedStyle(boardEl).transform).a;
    const cols = state.cols;
    const rectOf = (r, c) => boardEl.children[r * cols + c].getBoundingClientRect();
    let maxDev = 0;
    const lines = [...document.querySelectorAll('.wall-line')];
    const edges = [...(state.board?._wallEdges ?? [])];
    edges.forEach((key, i) => {
      const el = lines[i];
      if (!el) { maxDev = Infinity; return; }
      const lr = el.getBoundingClientRect();
      const [from, to] = key.split('-');
      const [r1, c1] = from.split(',').map(Number);
      const [r2, c2] = to.split(',').map(Number);
      const p1 = rectOf(r1, c1);
      const p2 = rectOf(r2, c2);
      if (r1 === r2) {
        // Vertical bar on the shared vertical edge: its center x sits at the
        // midpoint between the two cells, its vertical span on the cells'.
        const midX = c1 < c2 ? (p1.right + p2.left) / 2 : (p2.right + p1.left) / 2;
        maxDev = Math.max(maxDev,
          Math.abs((lr.left + lr.right) / 2 - midX),
          Math.abs(lr.top - p1.top));
      } else {
        const midY = r1 < r2 ? (p1.bottom + p2.top) / 2 : (p2.bottom + p1.top) / 2;
        maxDev = Math.max(maxDev,
          Math.abs((lr.top + lr.bottom) / 2 - midY),
          Math.abs(lr.left - p1.left));
      }
    });
    return { scale, maxDev, lineCount: lines.length, edgeCount: edges.length };
  });
  expect(measured.scale, 'the zoom-out must have left scale 1').toBeLessThan(1);
  expect(measured.lineCount).toBe(measured.edgeCount);
  expect(measured.maxDev, 'wall lines on their edges in screen px at this scale').toBeLessThan(1.5);

  expect(errors, `page errors: ${errors.join(' | ')}`).toHaveLength(0);
});

test('desktop double-click navigates too, and a long-press still flags', async ({ page }) => {
  const errors = await bootOversized(page, { width: 360, height: 630 });
  await page.locator('#board .cell.suggested-start').first().click();
  await settleAnimations(page);

  // Long-press (touchstart, 400ms hold, touchend) flags a hidden cell: the
  // touch path's other job, untouched by the double-tap detector.
  const hidden = await page.evaluate(() => {
    const el = document.querySelector('#board .cell.unrevealed:not(.flagged)');
    return { row: +el.dataset.row, col: +el.dataset.col };
  });
  await page.evaluate(({ row, col }) => {
    const board = document.getElementById('board');
    const el = [...board.querySelectorAll('.cell')]
      .find((c) => +c.dataset.row === row && +c.dataset.col === col);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const t = new Touch({ identifier: 9, target: el, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
    board.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true, cancelable: true, touches: [t], changedTouches: [t],
    }));
    return new Promise((resolve) => setTimeout(() => {
      board.dispatchEvent(new TouchEvent('touchend', {
        bubbles: true, cancelable: true, touches: [], changedTouches: [t],
      }));
      resolve();
    }, 400));
  }, hidden);
  await expect(page.locator(
    `#board .cell[data-row="${hidden.row}"][data-col="${hidden.col}"]`))
    .toHaveClass(/flagged/);

  // Desktop path: dblclick on a revealed number centers it (mousedown ghost
  // guard swallows synthetic-mouse within 500ms of a touch, so wait it out).
  await page.waitForTimeout(600);
  const target = await revealedNumberCell(page, 'topmost');
  await page.locator(
    `#board .cell[data-row="${target.row}"][data-col="${target.col}"]`).dblclick();
  await page.waitForTimeout(600);
  await settleAnimations(page);

  const after = await liveView(page);
  const expected = await cameraExpectation(page, target.row, target.col, after.scale);
  expect(Math.abs(after.scrollLeft - expected.left)).toBeLessThanOrEqual(2);
  expect(Math.abs(after.scrollTop - expected.top)).toBeLessThanOrEqual(2);

  expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
});
