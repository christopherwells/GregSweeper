// A wall blocks the cells whose sight line it crosses.
//
// INCIDENT (Christopher, 2026-08-07, playing 3D Cubes at L87): a cell in the
// bottom right read 5 and should not have, and another read 3 where it should
// have read 2, with a wall drawn between them and the mines they were counting.
//
// THE RULE IS HIS, and it is stated as a sight line rather than as a topology
// patch: "If a line drawn from the center of one cell to another is bisected by
// a wall, those two cells aren't connected." Whether two cells see past a
// corner depends on the ANGLE between them. Two facing each other across an
// open corner still see one another; two that would have to curve around the
// wall do not.
//
// What it replaced. Corner-inclusive adjacency makes cells meeting at a single
// VERTEX neighbours, but buildWireframe emits an edge only for a pair sharing
// TWO vertices, so severing wireframe edges left every corner contact intact.
// Measured over 12 walled boards per shape beforehand: EVERY board on all four
// Laves tilings was affected, 464 see-through corner links, 165 of them feeding
// a wrong clue (rhombille worst at 77).
//
// Why it is worse than a wrong number. The certifier reads the same adjacency,
// so those boards certified as no-guess and were internally consistent, while
// being unsolvable for a person reasoning from the wall in front of them.
// Nothing in the engine could notice, which is why the test is written against
// the GEOMETRY a player sees rather than against the graph.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTiling, buildWireframe, TILING_TYPES } from '../src/logic/tilingGeometry.js';
import { generateTilingBoard } from '../src/logic/tilingGenerator.js';
import { sightLineCuts } from '../src/logic/gimmicks.js';

const LAVES = ['cairo', 'floret', 'rhombille', 'deltoidal'];
const TRIVALENT = ['4.8.8', 'hex'];
const EPS = 1e-9;

// An INDEPENDENT crossing test, deliberately not the shipped one. A test that
// imports the predicate it is checking proves only that the code agrees with
// itself.
const cr = (ox, oy, ax, ay, bx, by) => (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
function crosses(p1, p2, q1, q2) {
  const d = [
    cr(q1.x, q1.y, q2.x, q2.y, p1.x, p1.y), cr(q1.x, q1.y, q2.x, q2.y, p2.x, p2.y),
    cr(p1.x, p1.y, p2.x, p2.y, q1.x, q1.y), cr(p1.x, p1.y, p2.x, p2.y, q2.x, q2.y),
  ].map(v => (Math.abs(v) < EPS ? 0 : Math.sign(v)));
  if (d[0] * d[1] > 0 || d[2] * d[3] > 0) return false;
  if (d.some(Boolean)) return true;
  const on = (a, b, c) => Math.min(a.x, b.x) - EPS <= c.x && c.x <= Math.max(a.x, b.x) + EPS
    && Math.min(a.y, b.y) - EPS <= c.y && c.y <= Math.max(a.y, b.y) + EPS;
  return on(p1, p2, q1) || on(p1, p2, q2) || on(q1, q2, p1) || on(q1, q2, p2);
}

function walledBoards(type, seeds = 8) {
  const T = buildTiling(type, 4, 5);
  const out = [];
  for (let seed = 0; seed < seeds; seed++) {
    const res = generateTilingBoard({
      type, M: 4, N: 5, mines: Math.round(T.total * 0.25),
      seed: `wallsight-${type}-${seed}`, gimmicks: ['walls'], gimmickLevel: 115,
    });
    if (res && res.board._tilingWalls && res.board._tilingWalls.length) out.push(res.board);
  }
  return out;
}

const centres = (t, a, b) => [
  { x: t.cellPos[a].cx, y: t.cellPos[a].cy },
  { x: t.cellPos[b].cx, y: t.cellPos[b].cy },
];

for (const type of TILING_TYPES) {
  test(`REGRESSION: no surviving link has a wall across its sight line (${type})`, () => {
    const boards = walledBoards(type);
    assert.ok(boards.length >= 4, `expected walled boards to generate, got ${boards.length}`);

    let links = 0;
    let cornerLinksSevered = 0;
    for (const b of boards) {
      const t = buildTiling(b._tiling.type, b._tiling.M, b._tiling.N);
      const walls = b._tilingWalls.map(w => [{ x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 }]);
      for (let a = 0; a < b._cellNeighbors.length; a++) {
        for (const c of b._cellNeighbors[a]) {
          if (c <= a) continue;
          links++;
          const [p1, p2] = centres(t, a, c);
          const hit = walls.find(([q1, q2]) => crosses(p1, p2, q1, q2));
          assert.ok(!hit, `${type}: cells ${a} and ${c} still see each other through a wall`);
        }
      }
      // Count what the rule actually took away, split by kind of contact.
      for (let a = 0; a < t.adj.length; a++) {
        for (const c of t.adj[a]) {
          if (c <= a || b._cellNeighbors[a].includes(c)) continue;
          let shared = 0;
          for (const x of t.cellVerts[a]) if (t.cellVerts[c].includes(x)) shared++;
          if (shared === 1) cornerLinksSevered++;
        }
      }
    }
    assert.ok(links > 0, `${type}: no links were examined, so nothing was tested`);
    // NON-VACUITY where it can bite. On the Laves tilings the rule must be seen
    // to remove corner contacts; on the trivalent pair there are none to remove
    // and that is the point of the separate test below.
    if (LAVES.includes(type)) {
      assert.ok(cornerLinksSevered > 0,
        `${type}: no corner contact was severed, so the fix was never exercised`);
    }
  });
}

test('the trivalent tilings have no corner contacts for the rule to reach', () => {
  // 4.8.8 and the honeycomb have degree-3 interior vertices, and at a degree-3
  // vertex all three incident faces already share edges pairwise. That is the
  // structural reason the sight-line rule cannot change what they count, rather
  // than a lucky one. Measured, not argued from the geometry.
  for (const type of TRIVALENT) {
    const t = buildTiling(type, 4, 5);
    let cornerOnly = 0;
    for (let a = 0; a < t.cellVerts.length; a++) {
      for (let b = a + 1; b < t.cellVerts.length; b++) {
        let shared = 0;
        for (const x of t.cellVerts[a]) if (t.cellVerts[b].includes(x)) shared++;
        if (shared === 1) cornerOnly++;
      }
    }
    assert.equal(cornerOnly, 0, `${type} was expected to have no vertex-only pairs`);
  }
  // And the four Laves tilings must have plenty, or the assertion above is a
  // statement about nothing.
  for (const type of LAVES) {
    const t = buildTiling(type, 4, 5);
    let cornerOnly = 0;
    for (let a = 0; a < t.cellVerts.length; a++) {
      for (let b = a + 1; b < t.cellVerts.length; b++) {
        let shared = 0;
        for (const x of t.cellVerts[a]) if (t.cellVerts[b].includes(x)) shared++;
        if (shared === 1) cornerOnly++;
      }
    }
    assert.ok(cornerOnly > 0, `${type} was expected to have vertex-only pairs`);
  }
});

test('an OPEN corner is still seen across: the rule is about angle, not proximity', () => {
  // The half of his rule that is easy to lose. A wall near a corner does not
  // sever every contact at it, only the ones whose sight line it actually
  // crosses. A version that cut everything touching a walled vertex would pass
  // every assertion above while quietly taking away contacts a player can see.
  const t = buildTiling('rhombille', 4, 5);
  const { edges } = buildWireframe(t);
  let sawSurvivor = false;
  for (let ei = 0; ei < edges.length && !sawSurvivor; ei++) {
    const cuts = sightLineCuts(t, edges, t.adj, [ei]);
    const cutSet = new Set(cuts.map(([a, b]) => `${a}-${b}`));
    const e = edges[ei];
    // Cells at this wall's own vertices, other than the pair it divides.
    for (const v of [e.v1, e.v2]) {
      const at = [];
      t.cellVerts.forEach((vs, i) => { if (vs.includes(v)) at.push(i); });
      for (const a of at) {
        for (const b of at) {
          if (b <= a) continue;
          if (a === e.cellA && b === e.cellB) continue;
          if (b === e.cellA && a === e.cellB) continue;
          if (!t.adj[a].includes(b)) continue;
          if (!cutSet.has(`${a}-${b}`)) sawSurvivor = true;
        }
      }
    }
  }
  assert.ok(sawSurvivor,
    'expected some contact at a walled vertex to SURVIVE — otherwise the rule is cutting on proximity');
});

test('a wall cuts the pair it divides, or it is not a wall at all', () => {
  // The other direction, so the survivor test above cannot pass by the
  // predicate simply never cutting anything.
  const t = buildTiling('rhombille', 4, 5);
  const { edges } = buildWireframe(t);
  for (let ei = 0; ei < Math.min(edges.length, 40); ei++) {
    const e = edges[ei];
    const cuts = sightLineCuts(t, edges, t.adj, [ei]);
    const cutSet = new Set(cuts.map(([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`));
    assert.ok(cutSet.has(`${Math.min(e.cellA, e.cellB)}-${Math.max(e.cellA, e.cellB)}`),
      `a wall on edge ${ei} must sever the two cells it lies between`);
  }
});

test('severing keeps the topology symmetric and the board connected', () => {
  // An ASYMMETRIC edge list does not crash: it quietly certifies a board nobody
  // can solve, because one cell's clue counts a mine the mine's own
  // neighbourhood does not count back. defineCellNeighbors validates at stamp
  // time, so this asserts the thing that validation protects rather than
  // trusting it. Connectivity matters for the same reason it always did, and
  // more now: a wall removes more links than its own edge, so a chain that
  // would strand a cell is trimmed back until it does not.
  for (const type of TILING_TYPES) {
    for (const b of walledBoards(type, 4)) {
      const adj = b._cellNeighbors;
      for (let i = 0; i < adj.length; i++) {
        for (const j of adj[i]) {
          assert.ok(adj[j].includes(i), `${type}: adjacency asymmetric between ${i} and ${j}`);
        }
      }
      const seen = new Uint8Array(adj.length);
      const stack = [0]; seen[0] = 1; let n = 1;
      while (stack.length) {
        const u = stack.pop();
        for (const v of adj[u]) if (!seen[v]) { seen[v] = 1; n++; stack.push(v); }
      }
      assert.equal(n, adj.length, `${type}: walls disconnected the board`);
    }
  }
});
