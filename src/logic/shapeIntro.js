// Shape intro cards — the first-encounter explainer for each board shape
// on the Challenge 250 ladder (his ruling 2026-08-04: "I want a card for
// them and the symbol can be one repeated pattern of that version").
//
// The modifier cards had a first-encounter explainer from the start; the
// shapes never did, so a player who reached L26 met a hexagonal board
// with no word about what had changed. This is that card.
//
// THE SYMBOL IS REAL GEOMETRY, not an illustration: the patch is drawn
// from the SAME buildTiling the board itself uses, so the icon is a
// literal tessellation of the lattice the player is about to play. A
// hand-drawn approximation would drift the moment a builder is tuned
// (OCT_CUT has already moved once), and this cannot.
//
// Pure: builds SVG markup strings and reads the copy table. No DOM, so
// the patch geometry and the copy are node-testable.

import { buildTiling, TILING_TYPES } from './tilingGeometry.js';
import { tilingLabel } from './coastlineLink.js';

// The patch is built from a lattice big enough that the cell we pick
// from it has a COMPLETE ring of neighbors (an edge cell would draw a
// lopsided motif). What gets drawn is a small selection out of it, not
// the whole thing — see shapePatchSVG.
const PATCH_DIMS = {
  hex: { M: 5, N: 5 },
  '4.8.8': { M: 4, N: 4 },
  rhombille: { M: 4, N: 4 },
  cairo: { M: 4, N: 4 },
  floret: { M: 3, N: 3 },
  deltoidal: { M: 3, N: 3 },
};

// Per-shape copy. Each card answers the one question a player actually
// has on arrival — "what counts as next to what?" — because that is the
// only rule the shape changes. Everything else about the game is
// identical, and saying so is what keeps the card calming rather than
// alarming.
// (No em-dashes anywhere in this table: player copy takes none, per his
// standing voice rule.)
const SHAPE_COPY = {
  hex: {
    neighbors: 'Every hexagon touches six others, and all six meet along a full edge. Nothing here touches at a corner.',
    note: 'Six neighbors is fewer than a classic board’s eight, so the numbers run a little lower than you are used to.',
  },
  '4.8.8': {
    neighbors: 'Octagons and small squares interlock. An octagon touches eight cells and a square touches four. Two octagons never meet at a corner, because a square always sits between them.',
    note: 'Numbers on the small squares see much less than the ones on the octagons, so they settle fastest.',
  },
  rhombille: {
    neighbors: 'The rhombi stack into what looks like a wall of cubes. A rhombus touches ten cells: four along its edges, six more at the shared corners.',
    note: 'That is a wider neighborhood than a classic square grid, so numbers here run higher than they look like they should.',
  },
  cairo: {
    neighbors: 'Each pentagon touches seven others: five along its edges, two more at corners.',
    note: 'The pentagons point in four different directions, so it pays to check which edges a number actually has before counting.',
  },
  floret: {
    neighbors: 'Six pentagons pinwheel around each hub. A pentagon touches eight others, edges and corners together.',
    note: 'The rosettes are the thing to see: once you spot where one flower ends and the next begins, the board reads much faster.',
  },
  deltoidal: {
    neighbors: 'Each kite touches nine others. Three kites meet at every wide corner and six at the narrow ones.',
    note: 'This is the richest board in the game to solve, so expect to lean on the harder patterns more often than anywhere else.',
  },
};

export const SHAPE_INTRO_TYPES = Object.freeze(TILING_TYPES.slice());

/**
 * The SVG symbol for a shape: the MINIMUM REPEATING UNIT of its lattice
 * (his ruling 2026-08-04), drawn from the shipped builder's own polygons.
 *
 * The unit is one cell plus everything it touches. That is the smallest
 * patch that still tessellates visibly, and it is also exactly what the
 * card is ABOUT — the card's one job is to answer "what counts as next to
 * what", so the symbol should be a picture of one cell's neighborhood
 * rather than a swatch of wallpaper. On the honeycomb it comes out as the
 * seven-cell flower; on the richer lattices it is correspondingly larger,
 * which is itself the honest signal.
 *
 * Cells are filled and stroked with the board's own tokens, so the symbol
 * reads as a piece of board rather than as a diagram, and it is cropped
 * to the drawn cells so the motif fills its frame on every lattice.
 *
 * @param {string} type a TILING_TYPES entry
 * @param {number} size rendered px (square frame)
 * @returns {string} SVG markup
 */
export function shapePatchSVG(type, size = 96) {
  const dims = PATCH_DIMS[type] || { M: 3, N: 3 };
  const T = buildTiling(type, dims.M, dims.N);

  // One cell plus its neighbors. The hub is the HIGHEST-VALENCE cell
  // nearest the patch centre, which matters only on a mixed-cell lattice
  // and matters a lot there: the 4.8.8's centre cell happens to be a
  // small interstitial square, so taking the centre outright drew a
  // four-petal diamond that showed none of the octagon-and-square
  // interlock the card describes. Highest valence picks the dominant
  // cell (the octagon), and on the five uniform lattices it changes
  // nothing. Max valence also implies a complete ring, so an edge cell
  // can never win.
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
  const cells = [hub, ...T.adj[hub]];

  // Crop to the drawn cells' own bounding box, then fit that box into a
  // square frame preserving aspect (a motif is not square in general).
  const pts = cells.map((ci) => T.cellVerts[ci].map((vi) => T.verts[vi]));
  const flat = pts.flat();
  const minX = Math.min(...flat.map((v) => v.x));
  const maxX = Math.max(...flat.map((v) => v.x));
  const minY = Math.min(...flat.map((v) => v.y));
  const maxY = Math.max(...flat.map((v) => v.y));
  const w = maxX - minX, h = maxY - minY;
  const pad = 0.05;
  const scale = (1 - 2 * pad) / Math.max(w, h);
  const offX = pad + (Math.max(w, h) - w) * scale / 2;
  const offY = pad + (Math.max(w, h) - h) * scale / 2;

  // cellVerts holds INDICES into the deduped vertex list, and a vertex is
  // {x, y}, not a coordinate pair. Both are worth stating: the shared
  // vertex list is what makes the tiling exact, and treating the indices
  // as coordinates fails at render time rather than at parse time.
  const polys = pts.map((verts) => {
    const s = verts
      .map((v) => `${(offX + (v.x - minX) * scale).toFixed(4)},${(offY + (v.y - minY) * scale).toFixed(4)}`)
      .join(' ');
    return `<polygon points="${s}"/>`;
  }).join('');

  return `<svg class="shape-intro-patch" viewBox="0 0 1 1" width="${size}" height="${size}" `
    + 'aria-hidden="true" focusable="false">'
    + `<g fill="var(--color-cell-hidden, #bdbdbd)" stroke="var(--color-border, #7a7a7a)" `
    + `stroke-width="0.012" stroke-linejoin="round" vector-effect="non-scaling-stroke">${polys}</g>`
    + '</svg>';
}

/**
 * The card's content for a shape: its player-facing name, the adjacency
 * sentence, and the closing note.
 * @param {string} type
 * @returns {{title: string, neighbors: string, note: string} | null}
 */
export function shapeIntroCard(type) {
  const copy = SHAPE_COPY[type];
  if (!copy) return null;
  return { title: tilingLabel(type), neighbors: copy.neighbors, note: copy.note };
}
