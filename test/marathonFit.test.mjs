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
  marathonFits, marathonDims, marathonShapes, fitLegalFrontier, fitCeilingCells,
  marathonProvisionalPar, MARATHON_TRAVERSAL_FLOOR_PPC, CANONICAL_MAX_DIM,
} from '../src/logic/marathonFit.js';
import { boardFitsPhone, rectFitsPhone } from '../src/logic/boardFit.js';
import { buildTiling, containerIsStorable, TILING_TYPES } from '../src/logic/tilingGeometry.js';

test('his worked example: Classic doubles 17x11 to 34x22, clipped to 30x22 = 660 cells', () => {
  // The premise of his arithmetic, checked rather than assumed.
  assert.ok(rectFitsPhone(17, 11), '17x11 must be the fit-legal ceiling he doubled');
  assert.ok(!rectFitsPhone(18, 11), 'and 18 rows must not be');
  const dims = marathonDims('rect');
  const biggest = dims[0];
  assert.equal(biggest.cells, 660);
  assert.equal(biggest.rows, 30);
  assert.equal(biggest.cols, 22);
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
  // Rect's fit-legal set has a single Pareto point (17x11), so its doubled
  // region IS one box, and these are its edges. BOARD_WIDTH_CAP caps
  // columns at 11, so 22 is the most any doubling can allow.
  assert.ok(marathonFits('rect', 30, 22), 'the legal corner itself must pass');
  assert.equal(marathonFits('rect', 6, 24), false, 'past 2x the column cap');
  assert.equal(marathonFits('rect', 30, 23), false);
  // 35 rows would be past 2x17, and it is also past the container cap; both
  // refusals are real, and the container one is checked in its own test.
  assert.equal(marathonFits('rect', 35, 22), false);
});

test('REGRESSION: marathon means BIGGER, so a tall thin board is not one', () => {
  // Found by this file, 2026-08-17: the doubled-dims bound alone admitted a
  // 25x1 at twenty-five cells as a "marathon" board, because rectFitsPhone
  // tolerates thin boards (a 17x1 passes it) and failing it by HEIGHT says
  // nothing about size. Every shape's lane now has to exceed that shape's
  // own fit ceiling in cells, which is the doubling ruling read in the
  // currency a player actually feels.
  assert.equal(marathonFits('rect', 25, 1), false, 'twenty-five cells is not a marathon');
  assert.equal(marathonFits('rect', 27, 3), false, 'eighty-one cells is not either');
  assert.equal(marathonFits('rect', 24, 3), false);
  for (const shape of marathonShapes()) {
    const ceiling = fitCeilingCells(shape);
    assert.ok(ceiling > 0, `${shape} must have a fit ceiling`);
    for (const d of marathonDims(shape)) {
      assert.ok(d.cells > ceiling,
        `${shape} offered ${d.cells} cells against a fit ceiling of ${ceiling}`);
    }
  }
  // And the menu stays PROPORTIONED: one entry per cell count, the squarest
  // dims that produce it, because the camera scrolls both axes and a
  // balanced board keeps every point nearer the middle of a glide.
  for (const d of marathonDims('rect')) {
    const ratio = Math.max(d.rows, d.cols) / Math.min(d.rows, d.cols);
    assert.ok(ratio <= 3, `the menu offered ${d.rows}x${d.cols} (ratio ${ratio.toFixed(1)})`);
  }
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
