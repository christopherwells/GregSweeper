// ── Archimedean tiling geometry + topology (Project Coastline, Phase 2) ─────
//
// A LEAF module: it imports nothing, so the renderer (a UI module), the board
// generator (which also pulls the solver), and the Phase 1 test fixture can all
// depend on it without dragging each other's dependencies along — the same
// reason adjacency.js is a leaf. Promoted from test/fixtures/tiling488.mjs.
//
// It answers two separable questions about a tiling, kept apart on purpose (see
// adjacency.js's topology contract):
//   - TOPOLOGY: `buildTiling488(...).adj` — the certifier's geometry-free
//     adjacency, byte-identical to the Phase 1 fixture so the gate stays green.
//   - GEOMETRY: `.cellPos` + the shape constants — per-cell center and outline,
//     read ONLY by the renderer (and later the compass ray + worm momentum),
//     never by the certifier.

// ── Shape geometry (unit pitch) ────────────────────────────────────────────
//
// OCT_CUT is the fraction cut off each corner of an octagon's unit box. The
// tiling is valid for any value in (0, 0.5): a bigger cut gives ROUNDER octagons
// (shorter flat sides) and BIGGER interstitial squares, and the square always
// tiles the gap exactly because its corner reaches the octagon vertex for any
// cut (verified in the tests). A *regular* octagon is (1 - 1/(1+√2))/2 ≈ 0.293,
// but that leaves the squares too small to hold a number + a gimmick sprite, so
// this is tuned UP for legibility — the octagons and squares read as closer in
// size (Christopher's call: "the octagons need to be smaller and the squares
// bigger"). Tune this one number to rebalance.
export const OCT_CUT = 0.37;

// The interstitial square is a diamond whose four corners reach the surrounding
// octagon vertices. Its axis-aligned bounding box is 2·OCT_CUT of the pitch, so
// it grows with the cut.
export const SQ_BOX_FRAC = 2 * OCT_CUT; // 0.74 at OCT_CUT 0.37

// Octagon clip-path as a CSS polygon() over the cell's own box.
export function octagonClipPath() {
  const a = (OCT_CUT * 100).toFixed(3);
  const b = ((1 - OCT_CUT) * 100).toFixed(3);
  return `polygon(${a}% 0%, ${b}% 0%, 100% ${a}%, 100% ${b}%, ${b}% 100%, ${a}% 100%, 0% ${b}%, 0% ${a}%)`;
}

// The interstitial square is drawn as a diamond in its own (already shrunk) box.
export const DIAMOND_CLIP_PATH = 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)';

/**
 * Build the 4.8.8 topology + geometry over an M×N lattice of octagons.
 *
 * 4.8.8 is the truncated square tiling: regular octagons on a square lattice
 * with a small square filling each interstice. Vertex configuration 4.8.8 — one
 * square and two octagons meet at every vertex, which is why two diagonally
 * placed octagons do NOT touch (a square sits between them). Valence is not even
 * constant: it runs 3, 4, 5 and 8.
 *
 * Cell indices are octagons-first, then squares:
 *   octagon (i, j) -> i * N + j                 for 0 <= i < M, 0 <= j < N
 *   square  (i, j) -> M*N + i * (N-1) + j        for 0 <= i < M-1, 0 <= j < N-1
 * where square (i, j) is bounded by octagons (i,j), (i,j+1), (i+1,j), (i+1,j+1).
 *
 * The adjacency construction is IDENTICAL to the Phase 1 fixture — do not change
 * it, or test/tilingCertification.test.mjs (the arc's gate) will move.
 *
 * @returns {{total:number, nOct:number, nSq:number, adj:Array<number[]>,
 *            octIndex:(i:number,j:number)=>number,
 *            sqIndex:(i:number,j:number)=>number,
 *            cellPos:Array<{cx:number,cy:number,shape:'oct'|'sq'}>,
 *            width:number, height:number}}
 */
export function buildTiling488(M, N) {
  const nOct = M * N;
  const nSq = (M - 1) * (N - 1);
  const total = nOct + nSq;
  const octIndex = (i, j) => i * N + j;
  const sqIndex = (i, j) => nOct + i * (N - 1) + j;

  const adj = Array.from({ length: total }, () => []);
  const link = (a, b) => { adj[a].push(b); adj[b].push(a); };

  // Octagon to octagon: the four orthogonal sides.
  for (let i = 0; i < M; i++) {
    for (let j = 0; j < N; j++) {
      if (j + 1 < N) link(octIndex(i, j), octIndex(i, j + 1));
      if (i + 1 < M) link(octIndex(i, j), octIndex(i + 1, j));
    }
  }
  // Square to its four surrounding octagons.
  for (let i = 0; i < M - 1; i++) {
    for (let j = 0; j < N - 1; j++) {
      const s = sqIndex(i, j);
      link(s, octIndex(i, j));
      link(s, octIndex(i, j + 1));
      link(s, octIndex(i + 1, j));
      link(s, octIndex(i + 1, j + 1));
    }
  }

  // Geometry, UNIT pitch (octagon centers one unit apart; the renderer scales by
  // the live pixel pitch). Octagon (i,j) sits in box [j..j+1] × [i..i+1]; square
  // (i,j) is the diamond centered on the shared corner of its four octagons. The
  // whole tiling spans [0, N] × [0, M] in pitch units.
  const cellPos = new Array(total);
  for (let i = 0; i < M; i++) {
    for (let j = 0; j < N; j++) {
      cellPos[octIndex(i, j)] = { cx: j + 0.5, cy: i + 0.5, shape: 'oct' };
    }
  }
  for (let i = 0; i < M - 1; i++) {
    for (let j = 0; j < N - 1; j++) {
      cellPos[sqIndex(i, j)] = { cx: j + 1, cy: i + 1, shape: 'sq' };
    }
  }

  // Per-cell POLYGON vertices, over one deduped global vertex list — so two
  // adjacent cells share the exact two vertex indices of the edge between them.
  // This is what lets a wall sit on the TRUE shared boundary (including the 45°
  // octagon/square edges) and lets continuous walls be built by walking the
  // wireframe (buildWireframe). A vertex shared by several cells collapses to
  // one index.
  const a = OCT_CUT, f = 0.5 - a;
  const verts = [];
  const vertKey = new Map();
  const vIdx = (x, y) => {
    const k = `${Math.round(x * 1e6)},${Math.round(y * 1e6)}`;
    let idx = vertKey.get(k);
    if (idx === undefined) { idx = verts.length; verts.push({ x, y }); vertKey.set(k, idx); }
    return idx;
  };
  const cellVerts = new Array(total);
  for (let i = 0; i < M; i++) {
    for (let j = 0; j < N; j++) {
      const cx = j + 0.5, cy = i + 0.5;
      cellVerts[octIndex(i, j)] = [
        vIdx(cx - f, cy - 0.5), vIdx(cx + f, cy - 0.5), // top flat
        vIdx(cx + 0.5, cy - f), vIdx(cx + 0.5, cy + f), // right flat
        vIdx(cx + f, cy + 0.5), vIdx(cx - f, cy + 0.5), // bottom flat
        vIdx(cx - 0.5, cy + f), vIdx(cx - 0.5, cy - f), // left flat
      ];
    }
  }
  for (let i = 0; i < M - 1; i++) {
    for (let j = 0; j < N - 1; j++) {
      const sx = j + 1, sy = i + 1;
      cellVerts[sqIndex(i, j)] = [
        vIdx(sx, sy - a), vIdx(sx + a, sy), vIdx(sx, sy + a), vIdx(sx - a, sy),
      ];
    }
  }

  return { total, nOct, nSq, adj, octIndex, sqIndex, cellPos, cellVerts, verts, width: N, height: M };
}

/**
 * The two shared vertex indices of the edge between adjacent cells a and b, or
 * null if they don't share exactly an edge.
 */
export function sharedEdge(cellVerts, a, b) {
  const setB = new Set(cellVerts[b]);
  const shared = cellVerts[a].filter(v => setB.has(v));
  return shared.length === 2 ? shared : null;
}

/**
 * The tiling's WIREFRAME: every cell-boundary edge once, tagged with the two
 * cells it separates, plus a vertex -> incident-edge index. Walking connected
 * runs of these edges (edges sharing a vertex) is how a wall becomes a
 * continuous barrier rather than scattered severings.
 *
 * @returns {{edges: Array<{v1:number,v2:number,cellA:number,cellB:number}>,
 *            vertEdges: Map<number, number[]>}}
 */
export function buildWireframe(tiling) {
  const { adj, cellVerts, total } = tiling;
  const edges = [];
  const edgeKey = new Map();
  const vertEdges = new Map();
  for (let a = 0; a < total; a++) {
    for (const b of adj[a]) {
      if (b <= a) continue;
      const shared = sharedEdge(cellVerts, a, b);
      if (!shared) continue;
      const [v1, v2] = shared;
      const ek = v1 < v2 ? `${v1}-${v2}` : `${v2}-${v1}`;
      if (edgeKey.has(ek)) continue;
      const ei = edges.length;
      edges.push({ v1, v2, cellA: a, cellB: b });
      edgeKey.set(ek, ei);
      for (const v of [v1, v2]) {
        if (!vertEdges.has(v)) vertEdges.set(v, []);
        vertEdges.get(v).push(ei);
      }
    }
  }
  return { edges, vertEdges };
}

/**
 * A rows×cols container that EXACTLY holds `total` cells — every slot is a real
 * cell, so `cellCount = rows*cols` stays an honest feature — as near-square as
 * total's factors allow. The container is pure STORAGE: a cell's (row, col) says
 * nothing about what it touches (adjacency is _cellNeighbors) or where it is
 * drawn (geometry is _cellPos). Only the flat index r*cols+c matters, and that
 * is what boardEl.children, updateCell, and the solver all key on.
 *
 * @param {number} total
 * @returns {{rows:number, cols:number}} rows <= cols
 */
export function containerFor(total) {
  let best = { rows: 1, cols: total };
  for (let r = 1; r * r <= total; r++) {
    if (total % r === 0) best = { rows: r, cols: total / r };
  }
  return best;
}

/**
 * The cells a compass ray crosses on a tiling: every cell whose CENTER lies on
 * the straight line out of the origin in direction (dx, dy), ordered outward.
 *
 * A compass is a geometry question ("which way"), which a neighbor graph can't
 * answer — so the ray is computed HERE, from cell positions, once at generation,
 * and stored on the cell. The certifier and the display then both read the
 * stored ray (compassRayCells returns it on an explicit topology) and can never
 * disagree. Positions are exact half/integer lattice values, so the colinearity
 * cross-product is exact — no float slop.
 *
 * @param {Array<{cx:number,cy:number}>} cellPos
 * @param {number} originIdx
 * @param {number} dx  one of -1, 0, 1
 * @param {number} dy  one of -1, 0, 1
 * @returns {number[]} flat indices, nearest first
 */
export function computeCompassRay(cellPos, originIdx, dx, dy) {
  const o = cellPos[originIdx];
  const hits = [];
  for (let i = 0; i < cellPos.length; i++) {
    if (i === originIdx) continue;
    const p = cellPos[i];
    const rx = p.cx - o.cx, ry = p.cy - o.cy;
    if (rx * dy - ry * dx !== 0) continue;   // off the line
    const t = rx * dx + ry * dy;             // signed distance along the ray
    if (t <= 0) continue;                    // behind the origin
    hits.push({ i, t });
  }
  hits.sort((a, b) => a.t - b.t);
  return hits.map(h => h.i);
}
