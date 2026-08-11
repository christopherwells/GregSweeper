// Modifier example diagrams drawn on the lattice the player is actually
// looking at.
//
// Every modifier card in GIMMICK_DEFS ships an `exampleHtml` built out of a
// 3x3 CSS grid of squares. That is honest on a classic board and only on a
// classic board, and the Challenge 250 venue rule debuts five of the nine
// modifiers ON A TILING: locked on the Honeycomb, wormhole and compass on
// Octagons, mirror on 3D Cubes, sonar on Paving Stones. A player meeting
// sonar for the first time was shown a square grid while a board of pentagons
// sat behind the card.
//
// So the example follows shapeIntro.js's rule: THE PICTURE IS REAL GEOMETRY.
// The patch comes from the same `buildTiling` the board itself uses, the
// sonar region comes from `sonarScanCells`, the compass ray from
// `computeCompassRay`, the wall from a real `buildWireframe` edge, and the
// worm's step from `buildWormCrawlTopology`. Nothing here is drawn by hand,
// so nothing here can drift from the mechanic it illustrates.
//
// Chaos-only modifiers (mineShift, pressure plates) are here too, since Chaos
// gained the shapes: a modifier that can appear on a lattice needs a
// card that shows one.
//
// RECTANGULAR BOARDS ARE UNTOUCHED. `modifierExampleHTML` returns null for a
// board with no tiling, and the caller falls back to the shipped
// `exampleHtml` verbatim, so the Classic debuts (walls, liar, mystery) and
// the Modifiers help tab render exactly the markup they always have.
//
// Pure: builds markup strings, reads no DOM. The geometry is therefore
// node-testable, which is the whole point (test/modifierExample.test.mjs
// measures every region against the lattice rather than trusting the copy).

import { buildTiling, buildWireframe, computeCompassRay, TILING_TYPES } from './tilingGeometry.js';
import { sonarScanCells } from './adjacency.js';
import { buildWormCrawlTopology } from './worms.js';
import { COMPASS_DIRS_BY_TILING } from './gimmicks.js';

// A patch big enough that the hub's two-step ball is complete on every
// lattice, before the drawn set is cut back to the cells nearest the hub.
// (Cell counts: 61 / 64 / 60 / 96 / 75 / 96.)
const PATCH_DIMS = {
  '4.8.8': { M: 6, N: 6 },
  hex: { M: 8, N: 8 },
  cairo: { M: 6, N: 6 },
  floret: { M: 4, N: 4 },
  rhombille: { M: 5, N: 5 },
  deltoidal: { M: 4, N: 4 },
};

// How many cells of context the picture carries. A modifier whose mechanic IS
// a region (sonar, compass) needs room for the region plus a ring of board
// around it; the rest only need enough lattice to read as a board.
const DRAW_LIMIT = 22;
const DRAW_LIMIT_REGION = 34;

/** The lattice's dominant cell nearest the patch center. */
function pickHub(T) {
  const maxValence = Math.max(...T.adj.map((a) => a.length));
  const c = T.cellPos[T.centerIndex];
  let hub = T.centerIndex;
  let bestD = Infinity;
  for (let i = 0; i < T.adj.length; i++) {
    if (T.adj[i].length !== maxValence) continue;
    const p = T.cellPos[i];
    const d = (p.cx - c.cx) ** 2 + (p.cy - c.cy) ** 2;
    if (d < bestD) { bestD = d; hub = i; }
  }
  return hub;
}

/** Graph distance from `from` to every cell, as a Map. */
function distancesFrom(adj, from) {
  const dist = new Map([[from, 0]]);
  let frontier = [from];
  while (frontier.length) {
    const next = [];
    for (const i of frontier) {
      for (const j of adj[i]) {
        if (dist.has(j)) continue;
        dist.set(j, dist.get(i) + 1);
        next.push(j);
      }
    }
    frontier = next;
  }
  return dist;
}

/** The `limit` cells physically nearest the hub, hub first. */
function nearestCells(T, hub, limit) {
  const o = T.cellPos[hub];
  return T.cellPos
    .map((p, i) => ({ i, d: (p.cx - o.cx) ** 2 + (p.cy - o.cy) ** 2 }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((e) => e.i);
}

/**
 * A board-shaped stand-in carrying just the three properties the shared
 * geometry helpers read. Building one (rather than reimplementing a depth-2
 * walk or a side-sharing filter here) is what keeps the example and the
 * mechanic single-sourced: a change to either helper moves the picture too.
 *
 * The container is 1 x total, so a cell's flat index IS its column.
 *
 * `M`/`N` are load-bearing rather than decorative: the worm's crawl topology
 * rebuilds the lattice through `buildTiling` from exactly these, the way the
 * renderer and `applyWallsTiling` do.
 */
function stubBoard(T, dims) {
  const board = [T.cellPos.map((_, i) => ({ row: 0, col: i }))];
  board._cellNeighbors = T.adj;
  board._cellPos = T.cellPos;
  board._tiling = { type: T.type, M: dims.M, N: dims.N, total: T.total };
  return board;
}

/**
 * The scene for one modifier: which cells are lit, what each carries, and the
 * caption. Every index in here is derived from the lattice.
 *
 * @returns {{focus:number[], region:number[], wall:?object, marks:object[], caption:string}}
 */
function buildScene(gimmick, T, hub, dims) {
  const board = stubBoard(T, dims);
  const dist = distancesFrom(T.adj, hub);

  switch (gimmick) {
    case 'sonar': {
      const region = sonarScanCells(board, 1, T.total, 0, hub);
      return {
        focus: [hub], region,
        marks: [{ cell: hub, text: `${SPRITE.sonar}5`, kind: 'sonar' }],
        caption: 'Sonar counts the mines anywhere in the shaded area, every cell within two steps.',
      };
    }
    case 'compass': {
      const dirs = COMPASS_DIRS_BY_TILING[T.type] || [];
      // The longest ray from this hub, so the picture shows the reach rather
      // than a stub. Ties break on the earlier direction for determinism.
      let best = null;
      for (const d of dirs) {
        const ray = computeCompassRay(T.cellPos, hub, d.dx, d.dy);
        if (!best || ray.length > best.ray.length) best = { dir: d, ray };
      }
      const ray = best ? best.ray : [];
      return {
        focus: [hub], region: ray,
        marks: [{ cell: hub, text: `3${best ? best.dir.arrow : ''}`, kind: 'compass' }],
        caption: 'The arrow counts every mine along the shaded line, out to the edge of the board.',
      };
    }
    case 'walls': {
      // A real boundary edge of the hub. Corner-only neighbors share no edge
      // and so appear in no wireframe entry, which is exactly why the wall is
      // taken from the wireframe rather than from the neighbor list.
      const { edges } = buildWireframe(T);
      const edge = edges.find((e) => e.cellA === hub || e.cellB === hub);
      const other = edge ? (edge.cellA === hub ? edge.cellB : edge.cellA) : hub;
      return {
        focus: [hub, other], region: [], wall: edge,
        marks: [{ cell: hub, text: '1' }, { cell: other, text: '2' }],
        caption: 'A wall runs along a shared edge. Neither number counts mines across it.',
      };
    }
    case 'wormhole': {
      // Partners are placed at graph distance 3 or more, which is what makes
      // their neighborhoods disjoint. The picture keeps exactly that minimum,
      // and among the cells at it takes the physically nearest so the pair
      // reads as a pair rather than as two unrelated cells.
      const o = T.cellPos[hub];
      const partner = [...dist.entries()]
        .filter(([, d]) => d === 3)
        .map(([i]) => i)
        .sort((a, b) => {
          const pa = T.cellPos[a], pb = T.cellPos[b];
          const da = (pa.cx - o.cx) ** 2 + (pa.cy - o.cy) ** 2;
          const db = (pb.cx - o.cx) ** 2 + (pb.cy - o.cy) ** 2;
          return da - db || a - b;
        })[0] ?? hub;
      return {
        focus: [hub, partner], region: [],
        marks: [{ cell: hub, text: '3', kind: 'wormhole' }, { cell: partner, text: '3', kind: 'wormhole' }],
        caption: 'Both linked cells show one number: the two counts added together.',
      };
    }
    case 'mirror': {
      const partner = T.adj[hub][0];
      return {
        focus: [hub, partner], region: [],
        marks: [{ cell: hub, text: '3', kind: 'mirror' }, { cell: partner, text: '1', kind: 'mirror' }],
        caption: 'These two swapped numbers. The one showing 3 really has 1.',
      };
    }
    case 'worm': {
      // The worm's own step graph, so the body is drawn along cells it could
      // actually crawl between (side-sharing only on a tiling).
      const topo = buildWormCrawlTopology(board, 1, T.total);
      const sides = topo ? topo.neighborsOf(0, hub).map((p) => p.c) : T.adj[hub];
      const tail = sides.length ? sides[0] : hub;
      return {
        focus: [hub, tail], region: [],
        marks: [
          { cell: hub, text: '2<span class="ge-worm-seg ge-worm-head"></span>', kind: 'worm' },
          { cell: tail, text: '1<span class="ge-worm-seg"></span>', kind: 'worm' },
        ],
        caption: 'The worm hides the numbers it sits on. They come back when it moves along.',
      };
    }
    case 'liar':
      return {
        focus: [hub], region: [],
        marks: [{ cell: hub, text: '3', kind: 'liar' }],
        caption: 'The pink cell is off by one. That 3 is really a 2 or a 4.',
      };
    case 'mystery':
      return {
        focus: [hub], region: [],
        marks: [{ cell: hub, text: '?', kind: 'mystery' }],
        caption: 'The "?" hides a real number. Work it out from its neighbors.',
      };
    case 'locked':
      return {
        focus: [hub], region: [],
        marks: [{ cell: hub, text: SPRITE.locked, kind: 'locked' }],
        caption: 'The locked cell opens once every safe cell around it is revealed.',
      };
    case 'mineShift': {
      // Chaos-only, and reachable on a lattice since Chaos gained the shapes.
      // The arrow points along a SIDE-SHARING step, because that is the only
      // step a mine may take (the worm's crawl graph).
      const board = stubBoard(T, dims);
      const topo = buildWormCrawlTopology(board, 1, T.total);
      const sides = topo ? topo.neighborsOf(0, hub).map((p) => p.c) : T.adj[hub];
      const to = sides.length ? sides[0] : hub;
      return {
        focus: [hub, to], region: [],
        marks: [{ cell: hub, text: '➤', kind: 'mineshift' }],
        caption: 'An unflagged mine creeps one cell at a time. Flag it to pin it down.',
      };
    }
    case 'pressurePlate': {
      // The plate demands its own neighbors, so the picture is the plate and
      // the ring it is asking for.
      return {
        focus: [hub], region: T.adj[hub],
        marks: [{ cell: hub, text: `${SPRITE.plate}2`, kind: 'plate' }],
        caption: 'Reveal every safe cell in the shaded ring before the timer runs out.',
      };
    }
    default:
      return null;
  }
}

// The same sprite files the real board draws these modifiers with, and the
// same `ge-piece` class the square examples already use.
const SPRITE = {
  sonar: '<img class="ge-piece" src="assets/sprites/mod-sonar.svg" alt="">',
  locked: '<img class="ge-piece" src="assets/sprites/mod-locked.svg" alt="">',
  plate: '<img class="ge-piece" src="assets/sprites/mod-pressure.svg" alt="">',
};

const MARK_FILL = {
  sonar: 'var(--marker-sonar-tint, rgba(0, 200, 220, 0.15))',
  compass: 'var(--marker-compass-tint, rgba(230, 180, 0, 0.16))',
  wormhole: 'var(--marker-wormhole-0, rgba(255, 140, 0, 0.18))',
  liar: 'rgba(231, 76, 60, 0.22)',
};

/**
 * The example diagram for a modifier on a tiling board.
 *
 * @param {string} gimmick a GIMMICK_DEFS key
 * @param {string} type    a TILING_TYPES entry
 * @param {number} size    rendered px (square frame)
 * @returns {?string} HTML markup, or null when there is no tiling variant
 *                    (rectangular boards, chaos-only modifiers)
 */
export function modifierExampleHTML(gimmick, type, size = 165) {
  if (!type || !TILING_TYPES.includes(type)) return null;
  const dims = PATCH_DIMS[type];
  if (!dims) return null;

  const T = buildTiling(type, dims.M, dims.N);
  const hub = pickHub(T);
  const scene = buildScene(gimmick, T, hub, dims);
  if (!scene) return null;

  const regionSet = new Set(scene.region);
  const focusSet = new Set(scene.focus);
  const limit = scene.region.length ? DRAW_LIMIT_REGION : DRAW_LIMIT;
  // Everything the scene needs is drawn whether or not it made the nearest
  // cut, so a compass ray never renders truncated.
  const drawn = [...new Set([...nearestCells(T, hub, limit), ...scene.region, ...scene.focus])];

  // Crop to the drawn cells, then fit that box into a square frame preserving
  // aspect. Same normalization as the shape-intro patch, and it is what lets
  // the HTML marker overlay address cells in plain percentages.
  const pts = drawn.map((ci) => T.cellVerts[ci].map((vi) => T.verts[vi]));
  const flat = pts.flat();
  const minX = Math.min(...flat.map((v) => v.x));
  const maxX = Math.max(...flat.map((v) => v.x));
  const minY = Math.min(...flat.map((v) => v.y));
  const maxY = Math.max(...flat.map((v) => v.y));
  const w = maxX - minX, h = maxY - minY;
  const pad = 0.04;
  const span = Math.max(w, h) || 1;
  const scale = (1 - 2 * pad) / span;
  const offX = pad + (span - w) * scale / 2;
  const offY = pad + (span - h) * scale / 2;
  const nx = (x) => offX + (x - minX) * scale;
  const ny = (y) => offY + (y - minY) * scale;

  const markOf = new Map(scene.marks.map((m) => [m.cell, m]));

  const polys = drawn.map((ci, k) => {
    const mark = markOf.get(ci);
    let fill = 'var(--color-cell-hidden, #bdbdbd)';
    if (regionSet.has(ci)) fill = 'var(--region-highlight-bg, rgba(38, 180, 222, 0.42))';
    else if (focusSet.has(ci)) fill = 'var(--color-cell-revealed, #efefef)';
    const dash = mark && mark.kind === 'mirror'
      ? ' stroke="var(--marker-mirror-0, rgba(52,152,219,0.85))" stroke-width="0.02" stroke-dasharray="0.035 0.025"'
      : '';
    const s = pts[k].map((v) => `${nx(v.x).toFixed(4)},${ny(v.y).toFixed(4)}`).join(' ');
    return `<polygon points="${s}" fill="${fill}"${dash}/>`;
  }).join('');

  // A second pass for the tinted overlays, so a tint composites over the
  // revealed body exactly as it does on the real board.
  const tints = scene.marks
    .filter((m) => MARK_FILL[m.kind])
    .map((m) => {
      const k = drawn.indexOf(m.cell);
      if (k < 0) return '';
      const s = pts[k].map((v) => `${nx(v.x).toFixed(4)},${ny(v.y).toFixed(4)}`).join(' ');
      return `<polygon points="${s}" fill="${MARK_FILL[m.kind]}"/>`;
    }).join('');

  const wall = scene.wall
    ? `<line x1="${nx(T.verts[scene.wall.v1].x).toFixed(4)}" y1="${ny(T.verts[scene.wall.v1].y).toFixed(4)}"`
      + ` x2="${nx(T.verts[scene.wall.v2].x).toFixed(4)}" y2="${ny(T.verts[scene.wall.v2].y).toFixed(4)}"`
      + ' stroke="var(--color-wall, #8B7355)" stroke-width="0.035" stroke-linecap="round"/>'
    : '';

  const svg = `<svg viewBox="0 0 1 1" width="${size}" height="${size}" aria-hidden="true" focusable="false">`
    + `<g stroke="var(--color-border, #7a7a7a)" stroke-width="0.008" stroke-linejoin="round">${polys}</g>`
    + `<g stroke="none">${tints}</g>${wall}</svg>`;

  const overlay = scene.marks.map((m) => {
    const p = T.cellPos[m.cell];
    const x = (nx(p.cx) * 100).toFixed(2);
    const y = (ny(p.cy) * 100).toFixed(2);
    const cls = m.kind ? ` ge-shape-${m.kind}` : '';
    return `<span class="ge-shape-mark${cls}" style="left:${x}%;top:${y}%">${m.text}</span>`;
  }).join('');

  return `<div class="gimmick-example-shape" style="width:${size}px;height:${size}px">`
    + `${svg}<div class="ge-shape-overlay">${overlay}</div></div>`
    + `<div class="ge-caption">${scene.caption}</div>`;
}
