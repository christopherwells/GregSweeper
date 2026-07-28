// ── Project Coastline: the compass direction sets are MEASURED, not chosen ──
//
// A compass points along a straight line of cell centers, and which lines exist
// is a property of the lattice. Every set in COMPASS_DIRS_BY_TILING was picked
// by measuring how much of the drawn line lies inside cells the number actually
// counts: the shipped 4.8.8 diagonals keep 100% of it, its axes 90.4%, and the
// hex verticals that were REJECTED keep 66.3%. This file re-derives that
// measurement from the builders' real output, because two things can silently
// invalidate a set and NEITHER produces an error or an empty ray:
//
//   1. ROTATIONAL PHASE. Each Laves set is fixed by the phase its builder emits.
//      Re-derive a builder 30 degrees around and the clean set swaps (30/90/150
//      becomes 0/60/120), and the now-wrong set still returns rays of mean
//      length 1.3 to 2.8 that wander across cells the number does not count. It
//      reads as plausible on review. `direction sets beat their rotated
//      alternative` is the guard.
//
//   2. ANCHOR NOISE. cellPos must carry closed-form points. A numerical
//      pattern-search incircle carries around 1.5e-9 of error, above
//      computeCompassRay's 1e-9 tolerance, and measuring deltoidal that way
//      destroyed 4 of its 6 direction families — again with short plausible rays
//      rather than none. `ray length collapses under anchor noise` is the guard,
//      and it doubles as the proof that the mean-ray bar is not vacuous.
//
// The bars: every shipped set scores at least 89.8% on the worst patch measured
// and every rejected alternative at most 67.0%, so the accept bar sits at 88%
// and the reject bar at 75%. Clean mean ray length bottoms out at 2.43 (the
// deltoidal fixture patch, the smallest); under 1.5e-9 of anchor noise the
// highest any tiling reaches is 2.06, so the bar sits at 2.2.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTiling, computeCompassRay, TILING_TYPES, HEX_ROW_H } from '../src/logic/tilingGeometry.js';
import { COMPASS_DIRS_BY_TILING } from '../src/logic/gimmicks.js';

// The gate-fixture patch of each tiling, so this file measures the same boards
// the certification gates certify.
const PATCH = {
  '4.8.8': [6, 7],
  hex: [7, 7],
  cairo: [7, 7],
  floret: [3, 4],
  rhombille: [5, 6],
  deltoidal: [3, 4],
};

const MIN_LINE_COUNTED = 0.88;
const MAX_ALTERNATIVE_LINE_COUNTED = 0.75;
const MIN_MEAN_RAY = 2.2;
const SAMPLES_PER_PITCH = 24;

// Ray casting; the tilings' cells are simple polygons in their own vertex order.
function pointInPolygon(px, py, verts, cellVertIndices) {
  let inside = false;
  for (let i = 0, j = cellVertIndices.length - 1; i < cellVertIndices.length; j = i++) {
    const a = verts[cellVertIndices[i]], b = verts[cellVertIndices[j]];
    if ((a.y > py) !== (b.y > py) &&
        px < (b.x - a.x) * (py - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// lineCOUNTED + ray statistics for one direction set over one tiling. The line
// traced is the RAY'S OWN line — anchor to anchor, the points computeCompassRay
// reasons about — since what this measures is whether a direction is a real
// lattice axis. Where a tiling draws its number somewhere else (cairo,
// deltoidal), a player following the numbers cell to cell keeps 94.2% / 91.7%,
// so the split does not cost the reading.
function measure(tiling, dirs) {
  const { cellPos, cellVerts, verts, total } = tiling;
  const anchorOf = (p) => ({ x: p.ax ?? p.cx, y: p.ay ?? p.cy });
  let counted = 0, sampled = 0, raySum = 0, cellsWithUsableRay = 0;

  for (let i = 0; i < total; i++) {
    let best = 0;
    for (const d of dirs) {
      const ray = computeCompassRay(cellPos, i, d.dx, d.dy);
      raySum += ray.length;
      if (ray.length > best) best = ray.length;
      if (ray.length === 0) continue;

      const a = anchorOf(cellPos[i]), b = anchorOf(cellPos[ray[ray.length - 1]]);
      const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * SAMPLES_PER_PITCH));
      const inSet = [i, ...ray];
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
        sampled++;
        for (const ci of inSet) {
          if (pointInPolygon(px, py, verts, cellVerts[ci])) { counted++; break; }
        }
      }
    }
    if (best >= 2) cellsWithUsableRay++;
  }

  return {
    lineCounted: sampled ? counted / sampled : 0,
    meanRay: raySum / (total * dirs.length),
    fracCellsWithUsableRay: cellsWithUsableRay / total,
    anyRay: sampled > 0,
  };
}

// The candidate set 30 degrees away — the one a re-derived builder would need.
function rotated30(dirs) {
  const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
  return dirs.map(d => ({ arrow: d.arrow, dx: d.dx * c - d.dy * s, dy: d.dx * s + d.dy * c }));
}

test('every tiling declares a compass direction set', () => {
  for (const type of TILING_TYPES) {
    assert.ok(COMPASS_DIRS_BY_TILING[type],
      `${type} has no entry in COMPASS_DIRS_BY_TILING — it would silently fall back to the 8-direction square-lattice set`);
    assert.ok(COMPASS_DIRS_BY_TILING[type].length >= 4, `${type}: too few directions`);
  }
});

test('every arrow points the way its direction vector does', () => {
  // A flipped sign is invisible in play except that the number counts mines
  // OPPOSITE the arrow the player is reading.
  const SIGNS = {
    '←': [-1, 0], '→': [1, 0], '↑': [0, -1], '↓': [0, 1],
    '↖': [-1, -1], '↗': [1, -1], '↙': [-1, 1], '↘': [1, 1],
  };
  for (const type of TILING_TYPES) {
    for (const d of COMPASS_DIRS_BY_TILING[type]) {
      const want = SIGNS[d.arrow];
      assert.ok(want, `${type}: unknown arrow ${d.arrow}`);
      assert.equal(Math.sign(d.dx), want[0], `${type} ${d.arrow}: dx sign`);
      assert.equal(Math.sign(d.dy), want[1], `${type} ${d.arrow}: dy sign`);
    }
  }
});

test('the two shipped tilings keep their exact direction sets', () => {
  // 4.8.8 and hex have been in players' hands; a refactor of this table must
  // not retune them, so both are pinned to their literal shipped values.
  assert.deepEqual(COMPASS_DIRS_BY_TILING['4.8.8'], [
    { arrow: '←', dx: -1, dy: 0 }, { arrow: '→', dx: 1, dy: 0 },
    { arrow: '↑', dx: 0, dy: -1 }, { arrow: '↓', dx: 0, dy: 1 },
    { arrow: '↖', dx: -1, dy: -1 }, { arrow: '↗', dx: 1, dy: -1 },
    { arrow: '↙', dx: -1, dy: 1 }, { arrow: '↘', dx: 1, dy: 1 },
  ]);
  assert.deepEqual(COMPASS_DIRS_BY_TILING.hex, [
    { arrow: '←', dx: -1, dy: 0 }, { arrow: '→', dx: 1, dy: 0 },
    { arrow: '↖', dx: -0.5, dy: -HEX_ROW_H }, { arrow: '↗', dx: 0.5, dy: -HEX_ROW_H },
    { arrow: '↙', dx: -0.5, dy: HEX_ROW_H }, { arrow: '↘', dx: 0.5, dy: HEX_ROW_H },
  ]);
});

test('every direction set keeps its ray inside the cells the number counts', () => {
  for (const type of TILING_TYPES) {
    const [M, N] = PATCH[type];
    const m = measure(buildTiling(type, M, N), COMPASS_DIRS_BY_TILING[type]);
    assert.ok(m.lineCounted >= MIN_LINE_COUNTED,
      `${type}: only ${(m.lineCounted * 100).toFixed(1)}% of the compass line lies inside counted cells (bar ${MIN_LINE_COUNTED * 100}%)`);
    assert.ok(m.meanRay >= MIN_MEAN_RAY,
      `${type}: mean ray ${m.meanRay.toFixed(2)} is under the bar of ${MIN_MEAN_RAY}`);
    assert.equal(m.fracCellsWithUsableRay, 1,
      `${type}: some cell has no direction reaching 2 cells, so applyCompass would ship a 0- or 1-cell compass there`);
  }
});

test('direction sets beat their rotated alternative', () => {
  // The phase guard. A builder re-derived 30 degrees around swaps which of the
  // two candidate sets is the clean one, and the wrong one still returns rays.
  for (const type of TILING_TYPES) {
    const [M, N] = PATCH[type];
    const tiling = buildTiling(type, M, N);
    const shipped = measure(tiling, COMPASS_DIRS_BY_TILING[type]);
    const alt = measure(tiling, rotated30(COMPASS_DIRS_BY_TILING[type]));
    if (!alt.anyRay) continue; // square-lattice sets (4.8.8, cairo): 30 degrees off hits nothing at all
    assert.ok(alt.lineCounted <= MAX_ALTERNATIVE_LINE_COUNTED,
      `${type}: the 30-degree-rotated set scores ${(alt.lineCounted * 100).toFixed(1)}%, close enough to the shipped ${(shipped.lineCounted * 100).toFixed(1)}% that this guard no longer separates them`);
    assert.ok(shipped.meanRay > alt.meanRay, `${type}: the rotated set reaches further than the shipped one`);
  }
});

test('REGRESSION: ray length collapses under anchor noise', () => {
  // The incident: measuring deltoidal's centers with a numerical pattern-search
  // incircle (error around 1.5e-9, above computeCompassRay's 1e-9) destroyed 4
  // of its 6 direction families, and the surviving rays were merely SHORT, not
  // absent. This reproduces that noise on every tiling and asserts the mean-ray
  // bar above would have caught it, which is also what stops that bar from
  // passing vacuously.
  const NOISE = 1.5e-9;
  for (const type of TILING_TYPES) {
    const [M, N] = PATCH[type];
    const tiling = buildTiling(type, M, N);
    let seed = 12345;
    const jitter = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff * 2 - 1) * NOISE; };
    const noisy = tiling.cellPos.map(p => (p.ax !== undefined
      ? { cx: p.cx, cy: p.cy, ax: p.ax + jitter(), ay: p.ay + jitter() }
      : { cx: p.cx + jitter(), cy: p.cy + jitter() }));
    const m = measure({ ...tiling, cellPos: noisy }, COMPASS_DIRS_BY_TILING[type]);
    assert.ok(m.meanRay < MIN_MEAN_RAY,
      `${type}: mean ray still ${m.meanRay.toFixed(2)} with searched-incircle noise on the anchors, so the mean-ray bar would not have caught it`);
  }
});
