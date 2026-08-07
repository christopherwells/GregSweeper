// REGRESSION (2026-08-06): tiling boards were authored without any cap on how
// wide they could get, and several shipped as letterbox strips that crushed the
// pitch on a phone. Christopher's report named Paving Stones; measured, its
// widest daily was 4 rows x 10 columns, a 345 x 141px board with 25px cells and
// 440px of vertical budget going unused.
//
// The cap lives in src/logic/boardFit.js. This file is what holds every
// AUTHORED table to it — the band configs, the challenge ladder, the endless
// pool, the practice boards — so those tables keep hand-picked dimensions and
// challenge250.js stays the leaf it is documented to be. Chaos is the one
// surface that consults boardFit at runtime, because it derives its dimensions
// from a target cell count rather than authoring them; it is covered here too,
// over every round it can reach.
//
// The Par Lab battery is DELIBERATELY EXEMPT and asserted to be so below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  boardFitsPhone, maxExtentUnits, tapRatios, tapSizeAt, fittingDims,
  widthBudget, heightBudget, comfortHeightBudget, FIT_REFERENCE, MIN_TAP_MAJORITY, MIN_TAP_MINORITY,
} from '../src/logic/boardFit.js';
import { buildTiling, TILING_TYPES } from '../src/logic/tilingGeometry.js';
import { TILING_BAND_CONFIGS } from '../src/logic/tilingBandConfigs.js';
import { COASTLINE_BOARDS } from '../src/logic/coastlineLink.js';
import { challengeSpecForLevel, ENDLESS_SPECS, CHALLENGE_MAX_LEVEL } from '../src/logic/challenge250.js';
import { CHAOS_SHAPES, chaosTilingPlan, chaosTilingDims } from '../src/logic/chaosShape.js';
import { getChaosDifficulty } from '../src/logic/difficulty.js';
import { PAR_LAB_BATTERY } from '../src/logic/parLab.js';

function describe(type, M, N) {
  const t = tapSizeAt(type, M, N);
  const g = buildTiling(type, M, N);
  const cap = maxExtentUnits(type);
  return `${type} ${M}x${N} (${g.total} cells): ${g.wUnits.toFixed(2)}w x ${g.hUnits.toFixed(2)}h units `
    + `(cap ${cap.wUnits.toFixed(2)} x ${cap.hUnits.toFixed(2)}), pitch ${t.pitch.toFixed(1)}px `
    + `-> majority ${t.majority.toFixed(1)}px / minority ${t.minority.toFixed(1)}px`;
}

// ── the rule itself ────────────────────────────────────────────────

test('the tap ratios are DERIVED from the shipped geometry, not hardcoded', () => {
  // The five isohedral tilings are normalized to inscribed diameter == 1 pitch
  // by assembleTiling, so both ratios must come back exactly 1. If one does
  // not, a builder stopped normalizing and every cap derived from it is wrong.
  for (const type of TILING_TYPES.filter((t) => t !== '4.8.8')) {
    const { median, min } = tapRatios(type);
    assert.ok(Math.abs(median - 1) < 1e-9, `${type} median inscribed diameter is ${median}, expected 1 pitch`);
    assert.ok(Math.abs(min - 1) < 1e-9, `${type} min inscribed diameter is ${min}, expected 1 pitch`);
  }
  // The 4.8.8 keeps its own tuning and is the only shape with two cell classes.
  // These follow OCT_CUT (0.42), so they move when it is retuned — which is
  // exactly why they are derived. Loose bounds: the point is that the octagon
  // is clearly the majority and the diamond clearly smaller, not the digits.
  const oct = tapRatios('4.8.8');
  assert.ok(oct.median > 0.75 && oct.median < 0.95, `4.8.8 octagon ratio ${oct.median} out of expected band`);
  assert.ok(oct.min > 0.50 && oct.min < 0.70, `4.8.8 diamond ratio ${oct.min} out of expected band`);
  assert.ok(oct.min < oct.median, '4.8.8 diamond must be the smaller class');
});

test('the width and height budgets match the measured browser layout', () => {
  // MEASURED in headless Chromium at four viewports. If a layout change moves
  // #app's width or padding, or the board's border, this is the alarm.
  assert.equal(Math.round(widthBudget(320)), 276);
  assert.equal(Math.round(widthBudget(360)), 314);
  assert.equal(Math.round(widthBudget(390)), 343);
  assert.equal(Math.round(widthBudget(430)), 381);
  assert.equal(Math.round(heightBudget(844)), 583);
});

test('the height budget still tracks #board-scroll-wrapper max-height in the CSS', () => {
  // boardFit holds 0.70 as a number. A stylesheet edit that changes the scroll
  // wrapper's max-height without updating it would make every cap wrong on the
  // height axis, silently.
  const css = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('#board-scroll-wrapper'));
  const match = block.match(/max-height:\s*([\d.]+)vh/);
  assert.ok(match, '#board-scroll-wrapper no longer declares a vh max-height');
  assert.equal(Number(match[1]) / 100, 0.70, 'board height budget drifted from boardFit');
});

test('width is the binding axis on a phone for every shape', () => {
  // The finding this whole cap rests on. If a builder ever changes so that
  // height binds first, the caps still hold but the "transpose it" remedy stops
  // being right, and whoever hits this should re-derive rather than relax it.
  for (const type of TILING_TYPES) {
    const cap = maxExtentUnits(type);
    assert.ok(cap.hUnits > cap.wUnits,
      `${type}: height cap ${cap.hUnits.toFixed(2)} is not looser than width cap ${cap.wUnits.toFixed(2)}`);
  }
});

test('a board sitting exactly on the cap passes, and one past it fails', () => {
  // Guards the epsilon, and proves the predicate can say no at all.
  const cap = maxExtentUnits('hex');
  // hex wUnits = N + 0.5; find the largest N that fits and check N+1 does not.
  let maxN = 0;
  for (let N = 1; N <= 30; N++) if (buildTiling('hex', 3, N).wUnits <= cap.wUnits) maxN = N;
  assert.ok(maxN > 0);
  assert.ok(boardFitsPhone('hex', 3, maxN), `hex 3x${maxN} should fit`);
  assert.ok(!boardFitsPhone('hex', 3, maxN + 1), `hex 3x${maxN + 1} should NOT fit`);
});

// ── the authored tables ────────────────────────────────────────────

test('every daily/weekly band config fits a phone', () => {
  const bad = [];
  for (const [type, entries] of Object.entries(TILING_BAND_CONFIGS)) {
    for (const e of entries) {
      if (!boardFitsPhone(type, e.M, e.N)) bad.push(`${e.id}: ${describe(type, e.M, e.N)}`);
    }
  }
  assert.deepEqual(bad, [], `band configs too wide for a phone:\n  ${bad.join('\n  ')}`);
});

test('every practice (?coastline=) board fits a phone', () => {
  const bad = [];
  for (const [type, b] of Object.entries(COASTLINE_BOARDS)) {
    if (!boardFitsPhone(type, b.M, b.N)) bad.push(describe(type, b.M, b.N));
  }
  assert.deepEqual(bad, [], `practice boards too wide for a phone:\n  ${bad.join('\n  ')}`);
});

test('every authored challenge level fits a phone', () => {
  const bad = new Map();
  for (let lv = 1; lv <= CHALLENGE_MAX_LEVEL; lv++) {
    const s = challengeSpecForLevel(lv);
    if (!s || !s.shape || s.shape === 'rect' || s.M == null) continue;
    if (boardFitsPhone(s.shape, s.M, s.N)) continue;
    const key = `${s.shape} ${s.M}x${s.N}`;
    if (!bad.has(key)) bad.set(key, []);
    bad.get(key).push(lv);
  }
  const lines = [...bad.entries()].map(([k, lvls]) => `${k} on ${lvls.length} levels (L${lvls[0]}..L${lvls[lvls.length - 1]})`);
  assert.deepEqual(lines, [], `ladder levels too wide for a phone:\n  ${lines.join('\n  ')}`);
});

test('every endless pool entry fits a phone', () => {
  const bad = [];
  ENDLESS_SPECS.forEach((s, i) => {
    if (!s.shape || s.shape === 'rect' || s.M == null) return;
    if (!boardFitsPhone(s.shape, s.M, s.N)) bad.push(`entry ${i}: ${describe(s.shape, s.M, s.N)}`);
  });
  assert.deepEqual(bad, [], `endless entries too wide for a phone:\n  ${bad.join('\n  ')}`);
});

// ── chaos, which derives rather than authors ───────────────────────

test('every reachable chaos round fits a phone', () => {
  const bad = new Set();
  for (let round = 1; round <= 60; round++) {
    let diff;
    try { diff = getChaosDifficulty(round); } catch { continue; }
    if (!diff) continue;
    for (const shape of CHAOS_SHAPES) {
      const plan = chaosTilingPlan(diff, shape);
      if (!plan) continue;
      if (!boardFitsPhone(plan.type, plan.M, plan.N)) {
        bad.add(`round ${round}: ${describe(plan.type, plan.M, plan.N)}`);
      }
    }
  }
  assert.deepEqual([...bad], [], `chaos rounds too wide for a phone:\n  ${[...bad].join('\n  ')}`);
});

test('chaos still reaches a real board size on every shape it offers', () => {
  // The cap must not quietly turn chaos into a game of tiny boards. Its ramp
  // asks for up to CHAOS_MAX_TILING_CELLS; each shape should still get within
  // reach of that rather than collapsing to its minimum.
  for (const shape of CHAOS_SHAPES) {
    const dims = chaosTilingDims(shape, 150);
    assert.ok(dims, `${shape} produced no chaos dims at all`);
    assert.ok(boardFitsPhone(shape, dims.M, dims.N), `chaos ${shape} largest board does not fit: ${describe(shape, dims.M, dims.N)}`);
    assert.ok(dims.cells >= 60, `chaos ${shape} tops out at only ${dims.cells} cells`);
  }
});

// ── the chooser ────────────────────────────────────────────────────

test('fittingDims never returns a board that fails the cap', () => {
  for (const type of TILING_TYPES) {
    for (const target of [30, 60, 90, 120, 150, 200]) {
      const d = fittingDims(type, target);
      if (!d) continue;
      assert.ok(boardFitsPhone(type, d.M, d.N),
        `fittingDims(${type}, ${target}) returned an unfitting ${d.M}x${d.N}`);
    }
  }
});

test('a board must be PROPORTIONED, not merely under the caps', () => {
  // This test used to assert that fittingDims prefers a PORTRAIT board, which
  // was the first pass at the cap and was wrong in the other direction
  // (2026-08-07). Christopher, on the Paving Stones ladder blocks: "too long
  // for the screen but definitely could've been wider." Turning the 4x10
  // letterbox into a 10x4 ribbon fixed the tap size and broke the shape, and
  // a cap on MAXIMUM extents could not see it — 10x4 renders 204 x 510px,
  // using 65% of the width and overflowing the comfortable height.
  //
  // Both orientations of that board are now refused, and neither direction of
  // ribbon is reachable.
  assert.ok(!boardFitsPhone('cairo', 4, 10), 'the wide 4x10 letterbox must fail');
  assert.ok(!boardFitsPhone('cairo', 10, 4), 'the tall 10x4 ribbon must fail too');

  // What survives is squarer. Ask for that cell count and the search declines
  // rather than returning a ribbon.
  const exact = fittingDims('cairo', 66, { maxCells: 66, minCells: 66 });
  assert.equal(exact, null, 'cairo has 66 cells only at 4x10 / 10x4 — both ribbons');

  // And a free search near that size returns something well-shaped.
  const d = fittingDims('cairo', 66);
  assert.ok(d, 'no legal Paving Stones board near 66 cells');
  const g = buildTiling('cairo', d.M, d.N);
  const { pitch, majority } = tapSizeAt('cairo', d.M, d.N);
  assert.ok(majority >= MIN_TAP_MAJORITY, 'cells must still clear the tap floor');
  assert.ok(g.wUnits * pitch >= widthBudget() * 0.75, 'must use the width it is given');
  assert.ok(g.hUnits * pitch <= comfortHeightBudget() + 12, 'must fit the comfortable height');
});

// ── the deliberate exemption ───────────────────────────────────────

test('the Par Lab battery is EXEMPT, and that is deliberate', () => {
  // The battery is complete (86/86 played) and its rows are the frozen source
  // of the per-shape par priors in scripts/data/parlab-prior-centers.json.
  // Re-dimensioning a played spec would silently re-describe boards that have
  // already been played and fit, so the battery keeps its historical
  // dimensions. It is test-env-only (?parlab=1) and reaches no player.
  //
  // This test asserts the exemption is REAL rather than forgotten: some lab
  // board must still violate the cap, so that if someone later "fixes" the
  // battery to satisfy boardFit they get a failure telling them why not to.
  const violating = PAR_LAB_BATTERY.filter(
    (b) => b.M != null && b.shape && !boardFitsPhone(b.shape, b.M, b.N)
  );
  assert.ok(violating.length > 0,
    'the Par Lab battery no longer violates the cap — if it was re-dimensioned on purpose, '
    + 'the frozen prior centers in scripts/data/parlab-prior-centers.json no longer describe '
    + 'the boards that were played');
});
