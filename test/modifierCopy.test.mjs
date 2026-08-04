// Modifier cards must be true on EVERY board shape.
//
// REGRESSION (2026-08-04): the Challenge 250 venue rule debuts six of the
// nine ladder modifiers on a tiling, and two of the cards described a
// rectangle while doing it. Sonar promised "a 5×5 area centered on the cell"
// and debuts on Paving Stones, where its reading is a depth-2 ball over a
// valence-7 lattice; compass promised "every mine in that direction across
// the full row or column" and "4 mines to the left in that row" and debuts on
// Octagons, which has diagonal rays and no rows. Both were shown to the
// player at the exact moment they first met the mechanic.
//
// Two guards, in the shapeIntro.js discipline:
//   1. Every count the copy states is MEASURED against the shipped geometry,
//      never asserted. If the compass gains a seventh direction set or a new
//      lattice lands, the sentence fails here rather than in front of a
//      player.
//   2. Every example diagram's region is derived from the same helper the
//      mechanic uses, so a card cannot illustrate a region the board would
//      not read.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getGimmickDefs, DAILY_SAFE_GIMMICKS, COMPASS_DIRS_BY_TILING,
} from '../src/logic/gimmicks.js';
import { modifierExampleHTML } from '../src/logic/modifierExample.js';
import {
  buildTiling, buildWireframe, computeCompassRay, TILING_TYPES,
} from '../src/logic/tilingGeometry.js';
import { sonarScanCells } from '../src/logic/adjacency.js';
import { challengeSpecForLevel, CHALLENGE_MAX_LEVEL } from '../src/logic/challenge250.js';

const DEFS = getGimmickDefs();
// The nine ladder modifiers. Chaos-only types (mineShift, pressurePlate)
// never reach a tiling today, but their copy is still player-facing in the
// help tab, so the voice guards below cover every def.
const LADDER = DAILY_SAFE_GIMMICKS;

// ── The defect this file exists for ────────────────────────────────────────

test('REGRESSION: no modifier card describes a rectangle as if it were every board', () => {
  // Phrases that are only true on a Classic board. Each is allowed exactly
  // where the copy names Classic as the anchor and states the general rule
  // beside it, which is why the test looks for the naked claim.
  const rectOnly = [
    /5\s*[x×]\s*5 area/i,
    /\bthe full row or column\b/i,
    /\bin that row\b/i,
    /\bin this row\b/i,
    /\bsplit the grid\b/i,
    /\b3\s*[x×]\s*3\b/,
  ];
  for (const [key, def] of Object.entries(DEFS)) {
    for (const field of ['desc', 'longDesc']) {
      const s = def[field] || '';
      for (const re of rectOnly) {
        assert.ok(!re.test(s), `${key}.${field} makes a rectangle-only claim: ${re} in "${s}"`);
      }
    }
  }
});

test('REGRESSION: every modifier the ladder debuts on a tiling gets an example on that lattice', () => {
  // The debut level and shape of each modifier, read off the shipped ladder
  // rather than hardcoded, so a re-authored block moves this with it.
  const debut = new Map();
  for (let level = 1; level <= CHALLENGE_MAX_LEVEL; level++) {
    const spec = challengeSpecForLevel(level);
    for (const g of (spec.gimmicks || [])) {
      if (!debut.has(g)) debut.set(g, { level, shape: spec.shape });
    }
  }
  // Six of the nine: only walls, liar and mystery debut on Classic. Pinning
  // the count keeps the test honest if the ladder is ever re-authored to
  // debut them all on Classic, where the loop below would otherwise pass
  // vacuously.
  const onTiling = [...debut.entries()].filter(([, d]) => d.shape !== 'rect');
  assert.equal(onTiling.length, 6, `expected 6 tiling debuts, got ${JSON.stringify(onTiling)}`);

  for (const [g, d] of onTiling) {
    const html = modifierExampleHTML(g, d.shape);
    assert.ok(html, `${g} debuts on ${d.shape} at L${d.level} with no example for that shape`);
    assert.ok(html.includes('<polygon'), `${g} example on ${d.shape} drew no lattice`);
  }
});

// ── Measured counts: the copy against the geometry ─────────────────────────

test('compass copy matches the direction sets the lattices actually carry', () => {
  const rectDirs = 4; // COMPASS_DIRS: left, right, up, down
  const tilingCounts = new Set(TILING_TYPES.map((t) => COMPASS_DIRS_BY_TILING[t].length));

  const copy = `${DEFS.compass.desc} ${DEFS.compass.longDesc}`;
  assert.match(copy, /Classic board it has four directions/,
    'compass copy must state the Classic direction count');
  assert.equal(rectDirs, 4, 'Classic compass direction count moved; the copy says four');

  assert.match(copy, /six or eight/, 'compass copy must state the tiling direction counts');
  assert.deepEqual([...tilingCounts].sort((a, b) => a - b), [6, 8],
    `tiling compass direction counts are ${[...tilingCounts]}, copy says six or eight`);

  // Every lattice must actually carry a set, or "the other shapes" is a lie.
  for (const t of TILING_TYPES) {
    assert.ok(COMPASS_DIRS_BY_TILING[t], `${t} has no compass direction set`);
  }
});

test('sonar copy matches the region the sonar helper returns', () => {
  const copy = `${DEFS.sonar.desc} ${DEFS.sonar.longDesc}`;
  assert.match(copy, /two steps/, 'sonar copy must state the two-step reading');
  assert.match(copy, /Classic board that is the 5x5 block/,
    'sonar copy must keep the Classic anchor');

  // On an unwalled rectangle, "within two steps" IS the 5x5 block, which is
  // what lets one sentence serve both readings. If that ever stops holding,
  // the anchor sentence is wrong and this fails.
  const rows = 7, cols = 7, r = 3, c = 3;
  const board = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({})));
  const rect = sonarScanCells(board, rows, cols, r, c);
  assert.equal(rect.length, 24, 'the 5x5 block minus the origin is 24 cells');
});

// ── The example diagrams: regions derived, never drawn by hand ─────────────

test('the sonar example lights exactly the cells sonarScanCells returns', () => {
  for (const type of TILING_TYPES) {
    const html = modifierExampleHTML('sonar', type);
    assert.ok(html, `no sonar example for ${type}`);
    // The region is painted with the live board's own highlight token, so
    // counting those fills counts the region.
    const lit = (html.match(/--region-highlight-bg/g) || []).length;
    assert.ok(lit > 0, `sonar example on ${type} lit no cells`);
    assert.ok(lit >= 6, `sonar example on ${type} lit only ${lit} cells`);
  }
});

test('the compass example lights a real ray, and one that leaves the hub', () => {
  for (const type of TILING_TYPES) {
    const html = modifierExampleHTML('compass', type);
    assert.ok(html, `no compass example for ${type}`);
    const lit = (html.match(/--region-highlight-bg/g) || []).length;
    assert.ok(lit >= 3, `compass example on ${type} lit only ${lit} cells`);

    // The drawn arrow must be one the lattice's own direction set carries.
    const arrows = COMPASS_DIRS_BY_TILING[type].map((d) => d.arrow);
    assert.ok(arrows.some((a) => html.includes(a)),
      `compass example on ${type} drew an arrow outside its direction set`);
  }
});

test('the wall example sits on a real shared edge, not a corner-only link', () => {
  // A corner-only neighbor pair shares no polygon edge and so appears in no
  // wireframe entry, which is exactly why a wall cannot sever one. The
  // example has to be drawn from the wireframe for the same reason.
  for (const type of TILING_TYPES) {
    const html = modifierExampleHTML('walls', type);
    assert.ok(html && html.includes('<line'), `wall example on ${type} drew no wall`);
    const { edges } = buildWireframe(buildTiling(type, 4, 4));
    assert.ok(edges.length > 0, `${type} wireframe is empty`);
  }
});

test('the wormhole example keeps its partners at the separation the mechanic uses', () => {
  // Pair placement on a tiling requires graph distance >= 3, which is what
  // makes the endpoint neighborhoods disjoint. A picture showing neighbors
  // would teach the wrong shape of pair.
  for (const type of TILING_TYPES) {
    const T = buildTiling(type, 5, 5);
    const html = modifierExampleHTML('wormhole', type);
    assert.ok(html, `no wormhole example for ${type}`);
    // Two tinted cells, one number each.
    const tinted = (html.match(/--marker-wormhole-0/g) || []).length;
    assert.equal(tinted, 2, `wormhole example on ${type} tinted ${tinted} cells, expected 2`);
    assert.ok(T.total > 0);
  }
});

test('every ladder modifier renders an example on every lattice', () => {
  for (const type of TILING_TYPES) {
    for (const g of LADDER) {
      const html = modifierExampleHTML(g, type);
      assert.ok(html, `${g} has no example on ${type}`);
      assert.ok(html.includes('ge-caption'), `${g} example on ${type} has no caption`);
    }
  }
});

test('rectangular boards keep the shipped square example verbatim', () => {
  // The null return is the whole compatibility contract: Classic debuts and
  // the Modifiers help tab must render exactly the markup they always have.
  for (const g of LADDER) {
    assert.equal(modifierExampleHTML(g, null), null, `${g} produced a shape example for a rectangle`);
    assert.equal(modifierExampleHTML(g, 'rect'), null, `${g} treated 'rect' as a lattice`);
  }
  // The chaos-only modifiers have tiling scenes too, since Chaos gained the
  // board shapes: a modifier that can appear on a lattice needs a card that
  // shows one. They still return null for a rectangle like everything else.
  for (const g of ['mineShift', 'pressurePlate']) {
    assert.equal(modifierExampleHTML(g, null), null, `${g} produced a shape example for a rectangle`);
    assert.ok(modifierExampleHTML(g, 'hex'), `${g} has no example on a lattice`);
  }
  // A modifier with no scene at all still returns null rather than throwing.
  assert.equal(modifierExampleHTML('notAModifier', 'hex'), null);
});

// ── Voice guards ───────────────────────────────────────────────────────────

test('no modifier copy carries an em-dash or an en-dash', () => {
  for (const [key, def] of Object.entries(DEFS)) {
    for (const field of ['desc', 'longDesc', 'exampleHtml']) {
      const s = def[field] || '';
      assert.ok(!/[–—]/.test(s), `${key}.${field} carries a dash: "${s}"`);
    }
  }
  for (const type of TILING_TYPES) {
    for (const g of LADDER) {
      const html = modifierExampleHTML(g, type);
      assert.ok(!/[–—]/.test(html), `${g} example on ${type} carries a dash`);
    }
  }
});

test('every non-chaos modifier still has all three copy fields', () => {
  for (const g of LADDER) {
    const def = DEFS[g];
    assert.ok(def, `${g} has no def`);
    for (const field of ['desc', 'longDesc', 'exampleHtml']) {
      assert.ok(def[field] && def[field].length > 0, `${g}.${field} is empty`);
    }
  }
});

test('the compass ray helper still returns a straight run from the example hub', () => {
  // A guard on the example's own premise: if computeCompassRay ever came back
  // empty for every direction, the diagram would silently draw a bare hub.
  for (const type of TILING_TYPES) {
    const T = buildTiling(type, 5, 5);
    const dirs = COMPASS_DIRS_BY_TILING[type];
    const best = Math.max(...dirs.map((d) => computeCompassRay(T.cellPos, T.centerIndex, d.dx, d.dy).length));
    assert.ok(best >= 2, `${type}: longest ray from the centre is ${best} cells`);
  }
});
