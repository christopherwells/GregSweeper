// Shape intro cards (his ruling 2026-08-04: "I want a card for them and
// the symbol can be one repeated pattern of that version… make the
// minimum repeated unit-ish"). The symbol is REAL geometry from the same
// buildTiling the board uses, so these pins are about that contract
// holding, not about a drawing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shapePatchSVG, shapeIntroCard, SHAPE_INTRO_TYPES } from '../src/logic/shapeIntro.js';
import { TILING_TYPES, buildTiling } from '../src/logic/tilingGeometry.js';
import { tilingLabel } from '../src/logic/coastlineLink.js';

test('every shipped tiling has a card, and its title is the player-facing name', () => {
  assert.deepEqual([...SHAPE_INTRO_TYPES].sort(), [...TILING_TYPES].sort(),
    'a new tiling must arrive with its card or a player meets it unannounced');
  for (const type of TILING_TYPES) {
    const card = shapeIntroCard(type);
    assert.ok(card, `${type} has no card`);
    assert.equal(card.title, tilingLabel(type));
    assert.ok(card.neighbors.length > 20, `${type} description is too thin to be useful`);
    assert.equal(card.note, undefined, 'the card carries ONE description, no flavor line');
  }
  assert.equal(shapeIntroCard('nonsense'), null, 'an unknown shape yields nothing, never a broken card');
});

test('card copy takes no em-dashes (his standing player-copy rule)', () => {
  for (const type of TILING_TYPES) {
    const { title, neighbors } = shapeIntroCard(type);
    for (const [field, text] of [['title', title], ['neighbors', neighbors]]) {
      assert.ok(!text.includes('—'), `${type}.${field} carries an em-dash`);
      assert.ok(!text.includes('–'), `${type}.${field} carries an en-dash`);
    }
  }
});

test('every number in the copy matches the lattice it describes', () => {
  // Both errors in the first draft were factual, not stylistic (his
  // catches): the honeycomb card denied corner CONTACT when what is
  // absent is corner-ONLY neighbors, and the Octagons card said two
  // octagons never meet at a corner when every octagon pair that touches
  // at all shares a full edge. So the counts are measured here rather
  // than trusted, against the same geometry the board is built from.
  const WORD = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  for (const type of TILING_TYPES) {
    const T = buildTiling(type, 6, 6);
    const maxValence = Math.max(...T.adj.map((a) => a.length));
    const c = T.cellPos[T.centerIndex];
    let hub = T.centerIndex, best = Infinity;
    for (let i = 0; i < T.adj.length; i++) {
      if (T.adj[i].length !== maxValence) continue;
      const p = T.cellPos[i];
      const d = (p.cx - c.cx) ** 2 + (p.cy - c.cy) ** 2;
      if (d < best) { best = d; hub = i; }
    }
    const hubVerts = new Set(T.cellVerts[hub]);
    let edge = 0, cornerOnly = 0;
    for (const n of T.adj[hub]) {
      (T.cellVerts[n].filter((v) => hubVerts.has(v)).length >= 2 ? edge++ : cornerOnly++);
    }
    const text = shapeIntroCard(type).neighbors;
    const said = [...text.matchAll(/\b(two|three|four|five|six|seven|eight|nine|ten)\b/gi)]
      .map((m) => WORD[m[1].toLowerCase()]);
    assert.ok(said.includes(edge + cornerOnly),
      `${type}: copy never states the total neighbor count ${edge + cornerOnly}`);
    if (cornerOnly > 0) {
      assert.ok(said.includes(edge) && said.includes(cornerOnly),
        `${type}: copy must state the ${edge} edge and ${cornerOnly} corner-only neighbors`);
      assert.match(text, /corner/, `${type}: copy must mention corners, which it has`);
    } else {
      // No corner-only neighbors: the copy may say so, but must never
      // claim the cells do not TOUCH at corners (they do).
      assert.ok(!/(never|not|nothing)\s+\w*\s*(meet|touch)\w*\s+at a corner/i.test(text),
        `${type}: copy denies corner contact, which is false — it is corner-ONLY neighbors that are absent`);
    }
  }
});

test('the symbol is the MINIMUM REPEATED UNIT: one cell plus everything it touches', () => {
  for (const type of TILING_TYPES) {
    const svg = shapePatchSVG(type);
    const polys = (svg.match(/<polygon/g) || []).length;
    // The count must equal some cell's valence + 1 on that lattice — that
    // is what "one cell plus its neighbors" means, and it is checkable
    // against the builder rather than against a remembered number.
    const T = buildTiling(type, 5, 5);
    const valences = new Set(T.adj.map((a) => a.length));
    assert.ok(valences.has(polys - 1),
      `${type}: drew ${polys} cells, which is not any cell's neighborhood here`);
    // A motif, not a swatch: bounded well below a full patch.
    assert.ok(polys >= 5 && polys <= 12, `${type}: ${polys} cells is not a minimum unit`);
  }
});

test('REGRESSION: the 4.8.8 symbol hubs on an OCTAGON, not an interstitial square', () => {
  // The first cut took the patch's centre cell outright. On the 4.8.8
  // that happens to be a small square, so the motif drew a four-petal
  // diamond showing none of the octagon-and-square interlock the card
  // describes. The hub is the highest-valence cell now.
  const svg = shapePatchSVG('4.8.8');
  const polys = (svg.match(/<polygon/g) || []).length;
  assert.equal(polys, 9, 'octagon hub + 4 octagons + 4 squares');
  // Eight-vertex polygons are octagons; the square-hub motif had only 4.
  const octagons = (svg.match(/<polygon points="(?:[^"]*?\s){7}[^"]*?"/g) || []).length;
  assert.ok(octagons >= 5, `expected at least 5 octagons in the motif, found ${octagons}`);
});

test('the symbol is self-contained, themed, and scale-free', () => {
  const svg = shapePatchSVG('hex');
  assert.match(svg, /viewBox="0 0 1 1"/, 'unit viewBox so the motif scales with the frame');
  assert.match(svg, /var\(--color-cell-hidden/, 'fills from the board tokens, so it themes itself');
  assert.match(svg, /var\(--color-border/);
  assert.match(svg, /aria-hidden="true"/, 'decorative: the copy carries the meaning');
  assert.ok(!svg.includes('<script'), 'markup is inserted as innerHTML — nothing executable');
  // Every coordinate lands inside the unit box (the crop must actually fit).
  for (const m of svg.matchAll(/points="([^"]+)"/g)) {
    for (const pair of m[1].split(' ')) {
      const [x, y] = pair.split(',').map(Number);
      assert.ok(x >= 0 && x <= 1 && y >= 0 && y <= 1, `point ${pair} outside the frame`);
    }
  }
});

test('a size argument scales the frame without touching the geometry', () => {
  const a = shapePatchSVG('cairo', 40);
  const b = shapePatchSVG('cairo', 200);
  assert.match(a, /width="40"/);
  assert.match(b, /width="200"/);
  const pointsOf = (s) => (s.match(/points="[^"]+"/g) || []).join('|');
  assert.equal(pointsOf(a), pointsOf(b), 'the motif is identical at any size');
});
