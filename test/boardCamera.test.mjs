// The marathon camera's pure geometry (src/logic/boardCamera.js). The
// clamping cases are his ruling verbatim (2026-08-17): "It wouldn't
// vertically center on a cell that's on the top or bottom edge, so the
// screen is still full of cells." A regression here is the camera dragging
// empty space on screen, or a scroll target the wrapper cannot reach.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CELL_SIZE_PREFS, CELL_SIZE_DEFAULT_KEY, normalizeCellPref,
  prefMinPx, cameraFitScale, clampedScroll,
  easeOutCubic, glideFrame, cameraTapPlan,
  withinViewMoveGrace, VIEW_MOVE_GRACE_MS,
} from '../src/logic/boardCamera.js';
import { readFileSync } from 'node:fs';
import { MIN_TAP_MAJORITY } from '../src/logic/tapFloor.js';

// A 1000x2000 board in a 320x480 view at scale 1: taller and wider than the
// view, so both axes have real clamp ranges.
const GEO = { scale: 1, boardW: 1000, boardH: 2000, viewW: 320, viewH: 480 };

test('an interior cell centers exactly', () => {
  const t = clampedScroll({ ...GEO, cx: 500, cy: 1000 });
  assert.equal(t.left, 500 - 160);
  assert.equal(t.top, 1000 - 240);
});

test('REGRESSION: a top-edge cell does not vertically center (his ruling verbatim)', () => {
  const t = clampedScroll({ ...GEO, cx: 500, cy: 10 });
  assert.equal(t.top, 0, 'the screen must stay full of cells, not center 10px into empty space');
  assert.equal(t.left, 340, 'the free axis still centers');
});

test('a bottom-edge cell parks flush against the bottom', () => {
  const t = clampedScroll({ ...GEO, cx: 500, cy: 1995 });
  assert.equal(t.top, 2000 - 480);
});

test('left and right edges clamp the same way', () => {
  assert.equal(clampedScroll({ ...GEO, cx: 5, cy: 1000 }).left, 0);
  assert.equal(clampedScroll({ ...GEO, cx: 998, cy: 1000 }).left, 1000 - 320);
});

test('content smaller than the view never scrolls negative', () => {
  const t = clampedScroll({ cx: 50, cy: 50, scale: 1, boardW: 100, boardH: 100, viewW: 320, viewH: 480 });
  assert.equal(t.left, 0);
  assert.equal(t.top, 0);
});

test('the scale multiplies the content, and the clamp follows it', () => {
  // At scale 0.5 the 1000px board is 500px wide in a 320px view.
  const t = clampedScroll({ ...GEO, scale: 0.5, cx: 900, cy: 100 });
  assert.equal(t.left, 500 - 320, 'right edge at half scale');
  assert.equal(t.top, 0, 'top clamp unaffected by scale');
});

test('the board origin (auto-centering margin) shifts targets and bounds together', () => {
  // Board 200 layout px wide sitting at originX 60 in a 320 view: fits, so 0.
  const fits = clampedScroll({ cx: 100, cy: 50, scale: 1, boardW: 200, boardH: 100, viewW: 320, viewH: 480, originX: 60, originY: 0 });
  assert.equal(fits.left, 0);
  // Board taller than the view with a vertical origin: the max includes it.
  const tall = clampedScroll({ cx: 100, cy: 590, scale: 1, boardW: 200, boardH: 600, viewW: 320, viewH: 480, originY: 20 });
  assert.equal(tall.top, 20 + 600 - 480);
});

test('cameraFitScale shows the whole board and never upscales', () => {
  assert.equal(cameraFitScale(640, 960, 320, 480), 0.5);
  assert.equal(cameraFitScale(100, 100, 320, 480), 1, 'a fitting board stays at natural size');
  const s = cameraFitScale(1000, 2000, 320, 480);
  assert.ok(1000 * s <= 320 && 2000 * s <= 480, 'both extents inside the view');
});

test('cameraFitScale answers 1 on degenerate input, never 0 or Infinity', () => {
  for (const args of [[0, 100, 320, 480], [100, 0, 320, 480], [100, 100, 0, 480], [NaN, 100, 320, 480]]) {
    assert.equal(cameraFitScale(...args), 1);
  }
});

test('the size ladder is DERIVED from the tap floor, not written down', () => {
  // HIS RULING 2026-08-21: "The tap floor is 24 px. No argument there. Beyond
  // that, the sizes should be 10% more, 25% more, and 50% more."
  //
  // Derived rather than listed, for the reason the width cap taught a day
  // earlier: a number beside the number it depends on goes stale the first
  // time either moves, and this ladder depends on the tap floor twice, as its
  // base and as its unit. Asserting the MULTIPLES rather than the pixels is
  // what makes that real; pinning 24/26/30/36 would just be the old table
  // with new digits.
  assert.deepEqual(CELL_SIZE_PREFS.map((p) => p.key),
    ['fit', 'comfortable', 'large', 'largest']);
  const px = (k) => prefMinPx(k);
  assert.equal(px('fit'), MIN_TAP_MAJORITY, 'fit IS the floor');
  assert.equal(px('comfortable'), Math.round(MIN_TAP_MAJORITY * 1.10));
  assert.equal(px('large'), Math.round(MIN_TAP_MAJORITY * 1.25));
  assert.equal(px('largest'), Math.round(MIN_TAP_MAJORITY * 1.50));

  // NON-VACUITY: the ladder must actually climb, or the multiples are inert.
  const ladder = CELL_SIZE_PREFS.map((p) => p.px);
  for (let i = 1; i < ladder.length; i++) {
    assert.ok(ladder[i] > ladder[i - 1],
      `the ladder must increase: ${ladder.join(' ')}`);
  }

  // NOTHING BELOW THE PRESSING SURFACE. "Fit to screen" used to mean px 0, no
  // preference floor, which let the renderer's 18px last-resort clamp take
  // over; 18 guards boards MEANT to exceed the screen and is not a tap target.
  for (const p of CELL_SIZE_PREFS) {
    assert.ok(p.px >= MIN_TAP_MAJORITY,
      `${p.key} at ${p.px}px is under the ${MIN_TAP_MAJORITY}px pressing surface`);
  }
  // An absent or unknown key reads as the FLOOR, never as zero.
  assert.equal(px(null), MIN_TAP_MAJORITY);
  assert.equal(px(undefined), MIN_TAP_MAJORITY);
  assert.equal(px('huge'), MIN_TAP_MAJORITY);
});

// REGRESSION (2026-08-21): the settings handler normalized a stored key with
// `prefMinPx(key) > 0 ? key : 'fit'`, which read as "is this a key I know"
// only because 'fit' happened to be the one preset priced at 0. The moment
// every preset carried a real floor, that test passed for EVERY string, so a
// garbage value in localStorage normalized to itself and was written straight
// back, permanently. Membership is the only sound question.
test('normalizeCellPref: membership decides, never the pixel value', () => {
  for (const p of CELL_SIZE_PREFS) {
    assert.equal(normalizeCellPref(p.key), p.key, `${p.key} is a real preset`);
  }
  for (const junk of ['huge', 'FIT', '', 'large ', '32', null, undefined, 0]) {
    assert.equal(normalizeCellPref(/** @type {any} */ (junk)), CELL_SIZE_DEFAULT_KEY,
      `${JSON.stringify(junk)} must fall back to the default`);
  }
  // NON-VACUITY: the fallback would be untestable if no preset were priced
  // above zero, which is precisely the condition that hid the bug.
  assert.ok(CELL_SIZE_PREFS.every((p) => p.px > 0),
    'every preset carries a real floor, so px truthiness cannot identify a key');
  // And the default it falls back to must itself be a real preset.
  assert.ok(CELL_SIZE_PREFS.some((p) => p.key === CELL_SIZE_DEFAULT_KEY));
});

test('easeOutCubic: endpoints exact, monotone, clamped', () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.equal(easeOutCubic(-1), 0);
  assert.equal(easeOutCubic(2), 1);
  let prev = 0;
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const v = easeOutCubic(t);
    assert.ok(v >= prev, `not monotone at t=${t}`);
    prev = v;
  }
});

test('glideFrame: endpoints exact, path between them', () => {
  const from = { cx: 0, cy: 100, scale: 0.5 };
  const to = { cx: 200, cy: 0, scale: 1 };
  assert.deepEqual(glideFrame(from, to, 0), from);
  assert.deepEqual(glideFrame(from, to, 1), to);
  const mid = glideFrame(from, to, 0.5);
  assert.ok(mid.cx > 0 && mid.cx < 200);
  assert.ok(mid.cy > 0 && mid.cy < 100);
  assert.ok(mid.scale > 0.5 && mid.scale < 1);
});

test('cameraTapPlan: dive, keep a deeper pinch, toggle out, dive back in', () => {
  // A new cell at survey scale: dive in to natural size.
  assert.deepEqual(cameraTapPlan({ sameCell: false, scale: 0.4, fitScale: 0.4 }), { scale: 1, survey: false });
  // A new cell while pinched past natural: keep the player's zoom.
  assert.deepEqual(cameraTapPlan({ sameCell: false, scale: 1.5, fitScale: 0.4 }), { scale: 1.5, survey: false });
  // The centered cell again at play scale: out to the survey view.
  assert.deepEqual(cameraTapPlan({ sameCell: true, scale: 1, fitScale: 0.4 }), { scale: 0.4, survey: true });
  // The centered cell while below natural size: dive back in on it.
  assert.deepEqual(cameraTapPlan({ sameCell: true, scale: 0.4, fitScale: 0.4 }), { scale: 1, survey: false });
});

test('REGRESSION: a reveal is refused while the view is still moving (his 2026-08-21 report)', () => {
  // "I've hit several mines because I tripled clicked by accident, revealing a
  // cell that was a mine. The first two clicks moved the view and the third
  // revealed." That is the double-tap centering gesture working as designed:
  // taps one and two pan, the cells slide under the finger, and tap three
  // lands somewhere the player never aimed at.
  assert.equal(VIEW_MOVE_GRACE_MS, 200, 'his number');
  assert.equal(withinViewMoveGrace(1000, 1000), true, 'the instant it moves');
  assert.equal(withinViewMoveGrace(1000, 1199), true, 'just inside');
  assert.equal(withinViewMoveGrace(1000, 1200), false, 'exactly at the boundary is settled');
  assert.equal(withinViewMoveGrace(1000, 5000), false, 'long settled');

  // A view that has never moved is NOT in a grace period, or the first tap of
  // every game would be swallowed.
  assert.equal(withinViewMoveGrace(null, 1000), false, 'never moved');
  assert.equal(withinViewMoveGrace(undefined, 1000), false, 'unset');
  assert.equal(withinViewMoveGrace(NaN, 1000), false, 'unreadable stamp');

  // A stamp in the FUTURE (a clock that jumped) reads as active rather than
  // being ignored: the safe direction is to make the player tap again.
  assert.equal(withinViewMoveGrace(2000, 1000), true, 'a future stamp errs toward refusing');
});

test('the grace period refuses ONLY the reveal, and every view move stamps it', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const rend = readFileSync(new URL('../src/ui/boardRenderer.js', import.meta.url), 'utf8');

  // The refusal sits on the reveal branch, not above the whole handler: a pan
  // that also flagged or chorded would be a worse bug than the one it fixes,
  // and neither of those can lose a run.
  assert.match(main, /viewMoveGraceActive\(\)/, 'the tap path must consult the grace');
  // Measured on the CODE, with comments stripped. This counted raw characters
  // until 2026-08-22, which measured how much prose sat between the guard and
  // the reveal rather than what ran between them, and it failed the moment the
  // mouse path took the same guard with a longer explanation (issue #422).
  // Adjacency is the real invariant, and asserting it on stripped code is
  // strictly stronger than a character budget.
  const code = main.replace(/^\s*\/\/.*$/gm, '');
  let searched = 0;
  for (let i = code.indexOf('viewMoveGraceActive()'); i !== -1;
       i = code.indexOf('viewMoveGraceActive()', i + 1)) {
    const reveal = code.indexOf('revealCell(row, col);', i);
    assert.ok(reveal > i, 'a grace guard must be followed by the reveal it guards');
    const between = code.slice(i + 'viewMoveGraceActive()'.length, reveal);
    // Only the branch scaffolding may sit between them: no other statement.
    assert.equal(between.replace(/[\s(){}]/g, ''), 'else',
      `a statement sits between the grace guard and the reveal it guards: ${between.trim().slice(0, 80)}`);
    searched++;
  }
  // NON-VACUITY: both pointer handlers take the guard, so this must have run
  // twice. One is the bug #422 fixed.
  assert.equal(searched, 2,
    `expected the guard on both pointer paths, found ${searched}`);
  assert.match(main, /toggleFlag\(row, col\)/, 'flagging must still be reachable');
  assert.match(main, /handleChordReveal\(row, col\)/, 'chording must still be reachable');

  // Every path that shifts what sits under the finger stamps the clock. If one
  // stops, the grace silently covers less than it claims.
  assert.ok((rend.match(/markViewMoved\(\)/g) || []).length >= 3,
    'scroll, wheel and the centering glide must each stamp a view move');
});

test('REGRESSION: the overflow verdict is cached, so a tap cannot force layout (#the shape lag)', () => {
  // The frame probe on his device caught it: revealing ONE cell cost 133ms on
  // an Octagons board, the same as revealing sixteen. A per-TAP cost, not a
  // per-cell one.
  //
  // needsZoom() reads boardEl.offsetWidth/offsetHeight, which forces a
  // synchronous reflow, and it was called from _navTap on every tap and from
  // the pinch branch of touchmove on every move event, both straight after the
  // reveal had written classes and inline styles to cells. Write-then-read is
  // the textbook layout thrash. Measured at 6x throttle on a settled board:
  // 1.09ms a tap on classic and 1.35ms on Octagons against 0.01ms without the
  // read, and Octagons is dearer with HALF the cells, which is the tiling
  // signal that only appears once something forces layout.
  const rend = readFileSync(new URL('../src/ui/boardRenderer.js', import.meta.url), 'utf8');

  // The cache is consulted BEFORE the layout read, or it is not a cache.
  const fn = rend.slice(rend.indexOf('function _boardOverflowsWrapper'),
    rend.indexOf('export function needsZoom'));
  assert.ok(fn.length > 50, '_boardOverflowsWrapper was not found');
  const idxCache = fn.indexOf('_overflowCache !== null');
  const idxRead = fn.indexOf('_boardLayoutSize()');
  assert.ok(idxCache > 0, 'the overflow verdict must be cached');
  assert.ok(idxRead > idxCache,
    'the cache must be consulted before the layout read, not after it');

  // And it is invalidated wherever the layout actually moves. A cache that is
  // never cleared is a correctness bug pretending to be a fix: the camera
  // controls would stop appearing on a board that grew.
  for (const site of ['renderBoard', 'resizeCells', 'layoutTilingCells']) {
    const at = rend.indexOf(`export function ${site}(`);
    assert.ok(at > 0, `${site} was not found`);
    const head = rend.slice(at, at + 260);
    assert.ok(head.includes('invalidateBoardOverflow()'),
      `${site} moves the layout and must invalidate the overflow cache`);
  }
});
