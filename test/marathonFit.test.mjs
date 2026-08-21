// The marathon lane's size ceiling and provisional pricing
// (src/logic/marathonFit.js). His ruling 2026-08-17, verbatim: "We've
// already figured out widths and lengths that work. Doubling that is all
// you need." So the region is derived from boardFit's own verdicts, never
// from a fresh pixel calculation, and this file pins that derivation
// against his own worked example (Classic 17x11 legal, so 34x22, storage-
// clipped to 30x22 = 660 cells).

import test from 'node:test';
import assert from 'node:assert';
import {
  marathonFits, marathonDims, marathonDimsSpread, marathonShapes,
  fitLegalFrontier, fitCeilingCells, inSupportCells,
  marathonProvisionalPar, MARATHON_TRAVERSAL_FLOOR_PPC, CANONICAL_MAX_DIM,
  MARATHON_MIN_SHORT_SIDE,
} from '../src/logic/marathonFit.js';
import { boardFitsPhone, rectFitsPhone } from '../src/logic/boardFit.js';
import { BOARD_WIDTH_CAP } from '../src/logic/difficulty.js';
import { buildTiling, containerIsStorable, TILING_TYPES } from '../src/logic/tilingGeometry.js';

test('his worked example, re-derived: Classic doubles its fit ceiling and clips to the container', () => {
  // He worked this out as 17x11 doubling to 34x22 and clipping to 30x22 = 660
  // cells. The ARITHMETIC is unchanged; its inputs moved. On 2026-08-20 he
  // ruled the width cap must be DERIVED from the tap floor rather than
  // remembered, which took it from 11 to 12 (12 columns delivers exactly the
  // 24px floor he had just set). Doubling 12 gives 24, so the widest rect the
  // lane may hold is now 30x24 = 720 cells. Both numbers are read from the
  // rules here rather than typed, so the next time the floor moves this test
  // follows instead of arguing.
  let tallest = 0;
  for (let r = 1; r <= 40; r++) if (rectFitsPhone(r, BOARD_WIDTH_CAP)) tallest = r;
  assert.ok(tallest >= 15, 'the fit-legal ceiling he doubled must be a real board');
  assert.ok(!rectFitsPhone(tallest + 1, BOARD_WIDTH_CAP), 'and one row more must not be');
  const dims = marathonDims('rect');
  const biggest = dims[0];
  assert.equal(biggest.cols, Math.min(CANONICAL_MAX_DIM, 2 * BOARD_WIDTH_CAP),
    'the widest rect is the doubled cap, clipped to the container');
  assert.equal(biggest.rows, 30);
  assert.equal(biggest.cells, biggest.rows * biggest.cols);
  // The clip is the canonical container's, not an invented number.
  assert.equal(CANONICAL_MAX_DIM, 30);
});

test('the region is the UNION of doubled legal pairs, never a box over axis maxima', () => {
  // Floret is why. Its fit-legal set includes thin strips (a 1x23 is legal),
  // so doubling the per-axis MAXIMA would admit 30x30 = 5400 cells of
  // nonsense. The union construction refuses that, because no single legal
  // pair reaches both extremes at once.
  const frontier = fitLegalFrontier('floret');
  assert.ok(frontier.length > 1, 'floret must have a real frontier to make this test bite');
  const maxM = Math.max(...frontier.map(([m]) => m));
  const maxN = Math.max(...frontier.map(([, n]) => n));
  assert.ok(!frontier.some(([m, n]) => m === maxM && n === maxN),
    'the axis maxima must NOT be reached by one pair, or the trap does not exist here');
  assert.equal(marathonFits('floret', Math.min(2 * maxM, 30), Math.min(2 * maxN, 30)), false,
    'the corner of the axis-maxima BOX must be refused');
});

test('the doubled bound really bounds: past 2x either axis is refused', () => {
  // Rect's fit-legal set has a single Pareto point, so its doubled region IS
  // one box, and these are its edges. The column bound is twice
  // BOARD_WIDTH_CAP, read rather than written down (it moved 11 -> 12 on
  // 2026-08-20 when he ruled the cap derives from the tap floor).
  const maxCols = 2 * BOARD_WIDTH_CAP;
  assert.ok(marathonFits('rect', 30, maxCols), 'the legal corner itself must pass');
  assert.equal(marathonFits('rect', 6, maxCols + 1), false, 'past 2x the column cap');
  assert.equal(marathonFits('rect', 30, maxCols + 1), false);
  // 35 rows would be past 2x17, and it is also past the container cap; both
  // refusals are real, and the container one is checked in its own test.
  assert.equal(marathonFits('rect', 35, 22), false);
});

test('THE DEGENERACY LINE: a short side under 3 is refused, 3 and up is not', () => {
  // Measured 2026-08-17, after his "I was musing about the merits of a 25x3
  // board myself". Thinness, not proportion, is what breaks a board: at one
  // column a cell has at most 2 neighbors, at two at most 5 and NO cell has
  // a full neighborhood, and at three the middle column carries all 8. The
  // generator agrees independently: a 25x3 certified 3 draws of 3 while a
  // 25x2 certified none. So the bound is the short side, and the aspect cap
  // that used to sit here (twice as long as wide) is gone with it, because
  // it was refusing exactly the boards the toggle exists to unlock.
  assert.equal(MARATHON_MIN_SHORT_SIDE, 3);
  assert.equal(marathonFits('rect', 25, 1), false, 'a path graph is not a board');
  assert.equal(marathonFits('rect', 25, 2), false, 'two columns have no interior cell');
  assert.equal(marathonFits('rect', 25, 3), true, 'his 25x3 is a real board');
  // Its wide twin is 3x22, not 3x25: the doubling ruling caps columns at
  // twice BOARD_WIDTH_CAP, so 22 is as wide as any rect may ever be, and a
  // board asking for 25 columns is out on the same rule that lets 25 rows in.
  assert.equal(marathonFits('rect', 3, 22), true, 'the wide twin, at the doubled cap');
  assert.equal(marathonFits('rect', 3, 25), false, 'past twice the column cap');
  for (const shape of marathonShapes()) {
    for (const d of marathonDims(shape)) {
      const M = shape === 'rect' ? d.rows : d.M;
      const N = shape === 'rect' ? d.cols : d.N;
      assert.ok(Math.min(M, N) >= MARATHON_MIN_SHORT_SIDE,
        `${shape} offered ${M}x${N}, under the short-side floor`);
    }
  }
});

test('PROPORTION qualifies, not only size: an ordinary-cell wide board is lane material', () => {
  // The half the first cut missed. A 6x20 is 120 cells, well inside rect's
  // 187-cell fit ceiling, and it is lane material purely because 20 columns
  // is past BOARD_WIDTH_CAP and no phone can hold it.
  assert.ok(marathonFits('rect', 6, 20), 'a wide board at an ordinary cell count');
  assert.ok(120 < fitCeilingCells('rect'), 'and it really is inside the fit ceiling');
  // Which means it is INSIDE the model's support and must not be priced
  // provisionally: that is the point of splitting the two.
  assert.equal(inSupportCells('rect', 120), true);
  assert.equal(inSupportCells('rect', 660), false, 'a giant is still out of support');
  assert.equal(inSupportCells('rect', fitCeilingCells('rect')), true, 'the ceiling itself is in');
  // The menu must actually OFFER such boards, or the rule would be theory.
  const dims = marathonDims('rect');
  assert.ok(dims.some((d) => d.cells <= fitCeilingCells('rect')),
    'the menu must offer at least one in-support size');
  assert.ok(dims.some((d) => d.cells > fitCeilingCells('rect')),
    'and at least one giant');
});

test('the menu SPREADS across the size range, so giants cannot crowd out the rest', () => {
  // The generator walks the menu until a cell is full, so taking the head
  // would build only giants and the proportion half would exist in the
  // rules and never on disk.
  const spread = marathonDimsSpread('rect', 4);
  assert.equal(spread.length, 4);
  assert.equal(spread[0].cells, marathonDims('rect')[0].cells, 'still biggest first');
  const cells = spread.map((d) => d.cells);
  assert.deepEqual(cells, [...cells].sort((a, b) => b - a), 'descending');
  assert.ok(new Set(cells).size === 4, 'four distinct sizes');
  assert.ok(cells[3] < cells[0] / 2, `the spread must reach small sizes, got ${cells.join(',')}`);
  // Degenerate asks answer sanely rather than throwing.
  assert.deepEqual(marathonDimsSpread('rect', 0), []);
  assert.equal(marathonDimsSpread('rect', 1).length, 1);
  assert.equal(marathonDimsSpread('rect', 9999).length, marathonDims('rect').length);
});

test('a fit-legal board is NOT marathon: the two lanes are disjoint by construction', () => {
  assert.ok(rectFitsPhone(17, 11));
  assert.equal(marathonFits('rect', 17, 11), false, 'a board the phone holds belongs to the base lane');
  for (const shape of TILING_TYPES) {
    for (const [M, N] of fitLegalFrontier(shape)) {
      assert.equal(marathonFits(shape, M, N), false,
        `${shape} ${M}x${N} is fit-legal and must not also be marathon`);
    }
  }
});

test('every marathon size is storable, in bounds, and really is oversized', () => {
  for (const shape of marathonShapes()) {
    const dims = marathonDims(shape);
    assert.ok(dims.length > 0, `${shape} must have a marathon range at all`);
    for (const d of dims) {
      const M = shape === 'rect' ? d.rows : d.M;
      const N = shape === 'rect' ? d.cols : d.N;
      assert.ok(M <= CANONICAL_MAX_DIM && N <= CANONICAL_MAX_DIM, `${shape} ${M}x${N} exceeds the container`);
      assert.ok(containerIsStorable(d.cells), `${shape} ${d.cells} cells cannot be stored`);
      const fitLegal = shape === 'rect'
        ? rectFitsPhone(M, N)
        : (() => { try { return boardFitsPhone(shape, M, N); } catch { return false; } })();
      assert.equal(fitLegal, false, `${shape} ${M}x${N} is fit-legal, so it is not lane material`);
      // The cell count must be the geometry's own, not an assumed product.
      const cells = shape === 'rect' ? M * N : buildTiling(shape, M, N).total;
      assert.equal(d.cells, cells);
    }
    // Distinct cell counts, biggest first: the generator's menu.
    const counts = dims.map((d) => d.cells);
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a), `${shape} dims must descend by size`);
    assert.equal(new Set(counts).size, counts.length, `${shape} must offer one entry per cell count`);
  }
});

test('every shape reaches past its fit ceiling, so the lane is non-vacuous everywhere', () => {
  for (const shape of marathonShapes()) {
    const biggestFit = Math.max(...fitLegalFrontier(shape).map(([M, N]) => (
      shape === 'rect' ? M * N : (() => { try { return buildTiling(shape, M, N).total; } catch { return 0; } })()
    )));
    const biggestLane = marathonDims(shape)[0].cells;
    assert.ok(biggestLane > biggestFit,
      `${shape}: lane ceiling ${biggestLane} must exceed the fit ceiling ${biggestFit}`);
  }
});

test('provisional pricing: anchored linear, floored, his approved arithmetic', () => {
  // The scheme: max(anchorPar * cells/anchorCells, FLOOR * cells).
  // His design-check example, verbatim: hex 600 cells at the floor is 240s.
  assert.equal(MARATHON_TRAVERSAL_FLOOR_PPC, 0.4);
  assert.equal(marathonProvisionalPar({ cells: 600, anchorPar: 19, anchorCells: 170 }), 240,
    'the floor catches hex, whose raw model collapses at size');
  // A shape whose anchor rate beats the floor prices from the model's edge.
  assert.equal(marathonProvisionalPar({ cells: 300, anchorPar: 200, anchorCells: 100 }), 600);
  // Linear in cells, by construction.
  const a = marathonProvisionalPar({ cells: 200, anchorPar: 200, anchorCells: 100 });
  const b = marathonProvisionalPar({ cells: 400, anchorPar: 200, anchorCells: 100 });
  assert.equal(b, 2 * a);
});

test('a degenerate anchor falls back to the floor, never to a fabricated rate', () => {
  for (const bad of [
    { cells: 500, anchorPar: 0, anchorCells: 100 },
    { cells: 500, anchorPar: 100, anchorCells: 0 },
    { cells: 500, anchorPar: NaN, anchorCells: 100 },
    { cells: 500 },
  ]) {
    assert.equal(marathonProvisionalPar(bad), 200, `${JSON.stringify(bad)} must price at the floor`);
  }
  // No cells is no board: zero, never NaN or Infinity, so a caller's
  // comparison against a ceiling cannot silently pass.
  assert.equal(marathonProvisionalPar({ cells: 0, anchorPar: 100, anchorCells: 100 }), 0);
  assert.equal(marathonProvisionalPar({}), 0);
});

// ── The anchor's own geometry (2026-08-18) ──────────────────────────────
//
// Found while filling the lane overnight: the anchor a provisional par is
// extrapolated from was chosen as the largest fit-legal pair by CELL COUNT
// alone, and on floret that is 1 x 23, a single row of rosettes. It is the
// degenerate path-graph shape this very module refuses for lane boards
// (MARATHON_MIN_SHORT_SIDE), it certifies in milliseconds because there is
// almost nothing to deduce, and every floret giant would have taken its
// seconds-per-cell from it. An anchor has to be a BOARD.

test('REGRESSION: no anchor geometry is a degenerate strip', async () => {
  const { fitCeilingSpecs } = await import('../scripts/topup-marathon-lane.mjs');
  for (const shape of marathonShapes()) {
    const specs = fitCeilingSpecs(shape);
    assert.ok(specs.length > 0, `${shape} must offer at least one anchor geometry`);
    for (const s of specs) {
      const M = shape === 'rect' ? s.rows : s.M;
      const N = shape === 'rect' ? s.cols : s.N;
      assert.ok(Math.min(M, N) >= MARATHON_MIN_SHORT_SIDE,
        `${shape} offers a ${M}x${N} anchor, under the thinness floor the lane itself enforces`);
    }
    // Ranked biggest first: an anchor should sit as close to the
    // extrapolation region as the model's own support allows.
    const cells = specs.map((s) => s.cells);
    assert.deepEqual(cells, [...cells].sort((a, b) => b - a), `${shape} anchors must be ranked by size`);
    // And every anchor must be inside support, or it is not the model
    // speaking from data.
    for (const s of specs) {
      assert.ok(inSupportCells(shape, s.cells),
        `${shape}: a ${s.cells}-cell anchor is outside the model's support`);
    }
  }
});

test('the anchor search has somewhere to fall back to', async () => {
  const { fitCeilingSpecs } = await import('../scripts/topup-marathon-lane.mjs');
  // Deltoidal certified 0 of 2 at its 90-cell ceiling at ~21% mines and
  // rhombille 0 of 2 at its 135-cell one, which left every denser cell of
  // those shapes permanently empty for want of an anchor. The fix is to walk
  // DOWN the legal geometries, so those shapes must offer more than one.
  for (const shape of ['deltoidal', 'rhombille', 'floret']) {
    assert.ok(fitCeilingSpecs(shape).length >= 2,
      `${shape} offers only one anchor geometry, so a failed certification has nowhere to fall back to`);
  }
});
