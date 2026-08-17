// ── Tiling geometry + topology (Project Coastline) ─────────────────────────
//
// Six tilings live here: the two Archimedean ones this module shipped with
// (4.8.8 and the 6.6.6 honeycomb) and the four Laves tilings below (cairo,
// floret, rhombille, deltoidal). Adding one is a builder plus a dispatcher
// entry; nothing downstream learns a tiling's name.
//
// A LEAF module: it imports nothing, so the renderer (a UI module), the board
// generator (which also pulls the solver), and the Phase 1 test fixture can all
// depend on it without dragging each other's dependencies along, the same
// reason adjacency.js is a leaf. Promoted from test/fixtures/tiling488.mjs.
//
// It answers two separable questions about a tiling, kept apart on purpose (see
// adjacency.js's topology contract):
//   - TOPOLOGY: `buildTiling488(...).adj`, the certifier's geometry-free
//     adjacency, byte-identical to the Phase 1 fixture so the gate stays green.
//   - GEOMETRY: `.cellPos` + the shape constants, per-cell center and outline,
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
// this is tuned UP for legibility, the octagons and squares read as closer in
// size (Christopher's call: "the octagons need to be smaller and the squares
// bigger", and again on 2026-07-28: "make the squares and octagons more even").
//
// Raised 0.37 -> 0.42 on 2026-07-28, then LOWERED 0.42 -> 0.38 on 2026-08-17.
// The 2026-07-28 call evened the two classes out; at 0.42 the octagon's flat
// sides had shrunk to ~7px on the reference phone (0.16 of the pitch) and he
// reversed course: "I think we need to increase the size difference of the
// octagons and squares. The small sides are too small", then ".38 works" from
// the measured table. At 0.38 the flats are ~10.8px and the diamond delivers
// 24.1px on the daily boards' 44.9px pitch, right at his 24px minority tap
// floor (MIN_TAP_MINORITY), which is the whole spare the change spends. He
// accepted the difficulty cost in the same breath ("this is going to hurt
// octagons difficulty"): a bigger relative diamond means the fit rules admit
// nothing wider, and the shape was already the endless zone's thinnest.
//
//   cut    diamond number circle    area ratio    flat/diagonal side
//   0.293  41% of the octagon's     4.82x         1.00  (a regular octagon)
//   0.37   59%                      2.65x         0.50
//   0.38   ~61%                     2.46x         0.45   <- current
//   0.42   67% -> 72%               1.83x         0.27
//   0.44   79%                      1.58x         0.19
//
// The cut can go to 0.5, but the straight sides shorten as it rises and at
// 0.44 they are a fifth of the diagonals: the octagon has become a rounded
// diamond and the board reads as a diamond lattice rather than a 4.8.8. At 0.5
// the interstitial square collapses to a point, diagonal octagons finally
// touch, and the tiling degenerates into a rotated square grid, which is also
// the one value that would break the corner-inclusive adjacency no-op the two
// Archimedean tilings rely on.
//
// Nothing downstream hardcodes this. Adjacency is cut-INDEPENDENT (measured: the
// valence histogram and the zero vertex-only-pair count hold across 0.05 to
// 0.499), so no certificate, fixture or par value moves; SQ_BOX_FRAC, the
// clip-paths and both font sizes all derive. Cell CENTERS sit on the lattice
// points and never move with the cut, which is why stored cellPos and the
// stored compass rays survive a retune untouched. Tune this one number to
// rebalance.
export const OCT_CUT = 0.38;

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

// ── Hexagon geometry (6.6.6 regular hexagonal, Coastline tiling #2) ─────────
//
// Pointy-top hexagons in offset rows (a vertex points up). The pitch P (the
// renderer's --cell-size) is the hex WIDTH (flat-to-flat horizontally), so a
// hexagon reads as "one P wide" exactly like a 4.8.8 octagon is one P wide,
// keeping number/sprite legibility comparable across tilings. Given hex width
// = sqrt(3)*R = 1 pitch unit, the circumradius R = 1/sqrt(3) and the row-to-row
// vertical spacing is 1.5*R.
export const HEX_R = 1 / Math.sqrt(3);        // circumradius, pitch units (~0.5774)
export const HEX_ROW_H = 1.5 * HEX_R;         // row vertical spacing (~0.8660)
export const HEX_BOX_H = 2 * HEX_R;           // hex box height as a multiple of pitch (~1.1547)

// Pointy-top hexagon clip-path over its own box (width = P, height = HEX_BOX_H*P).
// The two side vertices sit at 25% / 75% of the box height (y = R/2 and 3R/2 of
// the 2R-tall box); the top and bottom vertices are centered.
export const HEXAGON_CLIP_PATH = 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)';

/**
 * Build the 4.8.8 topology + geometry over an M×N lattice of octagons.
 *
 * 4.8.8 is the truncated square tiling: regular octagons on a square lattice
 * with a small square filling each interstice. Vertex configuration 4.8.8, one
 * square and two octagons meet at every vertex, which is why two diagonally
 * placed octagons do NOT touch (a square sits between them). Valence is not even
 * constant: it runs 3, 4, 5 and 8.
 *
 * Cell indices are octagons-first, then squares:
 *   octagon (i, j) -> i * N + j                 for 0 <= i < M, 0 <= j < N
 *   square  (i, j) -> M*N + i * (N-1) + j        for 0 <= i < M-1, 0 <= j < N-1
 * where square (i, j) is bounded by octagons (i,j), (i,j+1), (i+1,j), (i+1,j+1).
 *
 * The adjacency construction is IDENTICAL to the Phase 1 fixture, do not change
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

  // Per-cell POLYGON vertices, over one deduped global vertex list, so two
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

  // centerIndex / wUnits / hUnits / type are the tiling-agnostic descriptor the
  // generator and renderer consume (so neither has to know it is a 4.8.8). For
  // this tiling the pitch-unit extent is exactly N x M (octagon pitch = 1) and
  // the opener is the middle octagon.
  const centerIndex = octIndex(Math.floor((M - 1) / 2), Math.floor((N - 1) / 2));
  return {
    total, nOct, nSq, adj, octIndex, sqIndex, cellPos, cellVerts, verts,
    width: N, height: M, wUnits: N, hUnits: M, centerIndex, type: '4.8.8',
  };
}

/**
 * Build the 6.6.6 regular-hexagonal topology + geometry over an M x N grid of
 * pointy-top hexagons in offset rows (odd rows shifted right by half a hex).
 *
 * Every cell is one shape and one size, and valence is a constant 6 in the
 * interior (fewer than the square grid's 8, and with NO diagonals: a hexagon's
 * six neighbors are all edge-neighbors, so the corner-touch ambiguity of square
 * minesweeper is just absent). The board array stays pure STORAGE exactly as
 * for 4.8.8 (see containerFor / the Board Topology contract): adjacency is the
 * returned `adj`, geometry is `cellPos`, and only the flat index i*N+j matters.
 *
 * @returns the same shape as buildTiling488 (adj + cellPos + cellVerts + verts +
 *   wUnits/hUnits/centerIndex/type), so buildTiling can return either
 *   interchangeably.
 */
export function buildHexTiling(M, N) {
  const total = M * N;
  const idx = (i, j) => i * N + j;
  const inb = (i, j) => i >= 0 && i < M && j >= 0 && j < N;

  const adj = Array.from({ length: total }, () => []);
  const link = (a, b) => { adj[a].push(b); adj[b].push(a); };

  // Odd-r offset, pointy-top. Link each undirected edge once, from its upper /
  // left cell: the right neighbor plus the two LOWER-diagonal neighbors (whose
  // parity-dependent columns are the standard offset-grid formula). Every edge
  // is then counted exactly once and adj comes out symmetric.
  for (let i = 0; i < M; i++) {
    for (let j = 0; j < N; j++) {
      if (inb(i, j + 1)) link(idx(i, j), idx(i, j + 1));           // right
      const lowCols = (i % 2 === 0) ? [j - 1, j] : [j, j + 1];      // two below
      for (const jc of lowCols) if (inb(i + 1, jc)) link(idx(i, j), idx(i + 1, jc));
    }
  }

  // Geometry, pitch units (P = hex width = 1). Hex (i,j) center; odd rows are
  // shifted right by half a hex. Even rows span x in [0, N]; odd rows in
  // [0.5, N+0.5]; y runs [0, 2R + (M-1)*rowH].
  const R = HEX_R, rowH = HEX_ROW_H, half = 0.5;
  const cellPos = new Array(total);
  for (let i = 0; i < M; i++) {
    for (let j = 0; j < N; j++) {
      cellPos[idx(i, j)] = { cx: 0.5 + j + (i % 2) * 0.5, cy: R + i * rowH, shape: 'hex' };
    }
  }

  // Per-cell polygon vertices over one deduped global vertex list, so two
  // adjacent hexes share the exact two vertex indices of the edge between them
  // (what buildWireframe / continuous walls rely on). Adjacent hexes compute the
  // shared vertices from R and integers, so they coincide to the dedup rounding.
  const verts = [];
  const vertKey = new Map();
  const vIdx = (x, y) => {
    const k = `${Math.round(x * 1e6)},${Math.round(y * 1e6)}`;
    let v = vertKey.get(k);
    if (v === undefined) { v = verts.length; verts.push({ x, y }); vertKey.set(k, v); }
    return v;
  };
  const cellVerts = new Array(total);
  for (let i = 0; i < M; i++) {
    for (let j = 0; j < N; j++) {
      const { cx, cy } = cellPos[idx(i, j)];
      cellVerts[idx(i, j)] = [
        vIdx(cx, cy - R),          // top
        vIdx(cx + half, cy - R / 2), // upper-right
        vIdx(cx + half, cy + R / 2), // lower-right
        vIdx(cx, cy + R),          // bottom
        vIdx(cx - half, cy + R / 2), // lower-left
        vIdx(cx - half, cy - R / 2), // upper-left
      ];
    }
  }

  const centerIndex = idx(Math.floor((M - 1) / 2), Math.floor((N - 1) / 2));
  const wUnits = N + (M > 1 ? 0.5 : 0);       // odd rows stick out half a hex
  const hUnits = 2 * R + (M - 1) * rowH;
  return {
    total, adj, cellPos, cellVerts, verts,
    width: wUnits, height: hUnits, wUnits, hUnits, centerIndex, type: 'hex',
    M, N, cellIndex: idx,
  };
}

// ── Laves tilings (Coastline #3-#6) ────────────────────────────────────────
//
// cairo [3².4.3.4], floret [3⁴.6], rhombille [3.6.3.6] and deltoidal
// trihexagonal [3.4.6.4]. Each is isohedral, ONE cell shape at one size, so
// every interior cell reasons about an identical neighborhood, and unlike the
// two Archimedean tilings above there are no diagonals to disambiguate and no
// second cell size to keep legible.
//
// They share three things the first two tilings did not need, so the machinery
// below is written once and called four times.
//
// 1. CORNER-INCLUSIVE ADJACENCY. Cells touching at a single VERTEX are
//    neighbors, exactly as diagonal cells are on a square grid (Christopher's
//    rule, 2026-07-27: "corners are adjacent in mine counts"). On 4.8.8 and on
//    the honeycomb this rule is a strict NO-OP, both are trivalent, so at every
//    vertex the incident cells already share edges and there is nothing for it
//    to add (measured: zero vertex-only pairs on either, at every patch size and
//    every value of OCT_CUT short of the degenerate 0.5). On these four it is
//    the whole point: interior valence goes 5 → 7 (cairo), 5 → 8 (floret),
//    4 → 10 (rhombille) and 4 → 9 (deltoidal), which is Σ_v (deg(v) − 1) minus
//    the side count for each Laves face. Rhombille and deltoidal are therefore
//    the first tilings to carry a clue ABOVE 8.
// 2. EXACT VERTEX KEYS. See latticeVertices.
// 3. A NORMALIZATION to pitch units. See assembleTiling.
//
// A consequence worth stating because it looks like an omission: buildWireframe
// only ever emits an edge for a pair that shares exactly TWO vertices, so a
// corner-only link has no wireframe edge and no wall can sever it. That is
// right, a wall is a line drawn along a shared boundary, and two cells meeting
// at a point have none, but it does mean walls cut a strict subset of the
// adjacency graph here, where on the shipped two the two graphs coincide.

/**
 * A deduped vertex list addressed by the EXACT integer coordinates of the
 * lattice rather than by a rounded float.
 *
 * The 4.8.8 and hex builders key `vIdx` on `Math.round(x * 1e6)`, and a rounded
 * key is a bet that no coordinate ever lands near a half-step. Losing that bet
 * does not throw: it splits one corner into two vertices, which DROPS the
 * adjacency the cells had through it, so the board certifies against a
 * neighborhood the player is never shown, the one failure the no-guess contract
 * cannot absorb.
 *
 * The bet is not lost today, but the margin narrows exactly where it matters.
 * Measured over these four lattices built with float coordinates: the closest
 * any vertex comes to a 1e-6 rounding boundary is 5.8e-8 at M=N=6 and 2.1e-8 at
 * M=N=12, while the spread between independent computations of one shared corner
 * grows from 8.9e-16 to 3.6e-15 over the same range (floret is tightest, 1.6e-9
 * against 2.1e-14). Those two numbers converge with patch size, and nothing here
 * bounds the gap.
 *
 * So each builder picks integer coordinates for its own lattice, keys on those,
 * and derives the float exactly once per vertex. Then there is no rounding
 * decision to get right and no size at which it starts being wrong.
 *
 * @param {(...key:number[]) => {x:number,y:number}} toXY integer key -> position
 */
function latticeVertices(toXY) {
  const verts = [];
  const seen = new Map();
  return {
    verts,
    /** @param {...number} key */
    at(...key) {
      const k = key.join(',');
      let i = seen.get(k);
      if (i === undefined) { i = verts.length; verts.push(toXY(...key)); seen.set(k, i); }
      return i;
    },
  };
}

/**
 * Turn a raw Laves patch into the descriptor every consumer reads: reading
 * order, corner-inclusive adjacency, the opener, and the normalization to pitch
 * units.
 *
 * @param {string} type
 * @param {number} M
 * @param {number} N
 * @param {{verts:Array<{x:number,y:number}>, cellVerts:Array<number[]>,
 *          cellPos:Array<{cx:number,cy:number,ax?:number,ay?:number}>}} raw
 *        native lattice units; cellPos holds each cell's incircle center and,
 *        where the two differ, its compass ray anchor
 * @param {number} scale native units -> pitch units
 */
function assembleTiling(type, M, N, raw, scale) {
  const total = raw.cellVerts.length;

  // READING ORDER: ascending centroid y, ties by centroid x. Taken in the
  // builder's own lattice units and BEFORE normalization, so the order is a
  // property of the lattice and cannot move if `scale` is ever retuned. This is
  // load-bearing rather than cosmetic, a frozen certification fixture's mine
  // list is a list of INDICES, and it means nothing except against this order.
  const centroid = raw.cellVerts.map(cv => {
    let x = 0, y = 0;
    for (const vi of cv) { x += raw.verts[vi].x; y += raw.verts[vi].y; }
    return { cx: x / cv.length, cy: y / cv.length };
  });
  const order = centroid
    .map((p, i) => ({ i, ky: Math.round(p.cy * 1e4), kx: Math.round(p.cx * 1e4) }))
    .sort((a, b) => a.ky - b.ky || a.kx - b.kx)
    .map(o => o.i);

  const cellVerts = new Array(total);
  const cellPos = new Array(total);
  const mid = new Array(total);
  order.forEach((from, to) => {
    cellVerts[to] = raw.cellVerts[from];
    cellPos[to] = raw.cellPos[from];
    mid[to] = centroid[from];
  });

  // Corner-inclusive adjacency: every pair of cells sharing at least one vertex.
  // Derived from an unordered pair map, so symmetry is structural and
  // defineCellNeighbors cannot be handed an asymmetric list; sorted ascending so
  // neighbor ORDER is deterministic (applyMirrorPairs takes the first eligible
  // neighbor in list order, so a reshuffle would move mirror boards).
  const vertCells = new Map();
  cellVerts.forEach((cv, ci) => {
    for (const v of cv) {
      let users = vertCells.get(v);
      if (!users) { users = []; vertCells.set(v, users); }
      users.push(ci);
    }
  });
  const nbrs = Array.from({ length: total }, () => new Set());
  for (const users of vertCells.values()) {
    for (let a = 0; a < users.length; a++) {
      for (let b = a + 1; b < users.length; b++) {
        nbrs[users[a]].add(users[b]);
        nbrs[users[b]].add(users[a]);
      }
    }
  }
  const adj = nbrs.map(s => [...s].sort((x, y) => x - y));

  // The opener: the cell nearest the patch's own center of mass. A patch with a
  // mirror symmetry can tie two cells EXACTLY (deltoidal at M=3,N=4 ties cells
  // 31 and 39 across its center), and because the centroids come from exact
  // lattice integers the tie is bitwise rather than float noise, so it has to
  // be broken here instead of being handed to whichever distance happens to
  // round a hair smaller. The later cell in reading order wins, which is what
  // the frozen gate fixtures were found against.
  let mx = 0, my = 0;
  for (const p of mid) { mx += p.cx; my += p.cy; }
  mx /= total; my /= total;
  let centerIndex = 0, bestD = Infinity;
  for (let i = 0; i < total; i++) {
    const d = (mid[i].cx - mx) ** 2 + (mid[i].cy - my) ** 2;
    if (d <= bestD) { bestD = d; centerIndex = i; }
  }

  // NORMALIZE to pitch units: translate the patch's bounding box to the origin
  // (the renderer places every cell at unit × pitch from the board's own origin,
  // exactly as the 4.8.8 spans [0,N] × [0,M]), then scale so the cell's
  // INSCRIBED DIAMETER is one pitch unit. That is already the hexagon's rule,
  // HEX_R = 1/√3 makes a hex one pitch flat-to-flat and one pitch inscribed, so
  // a number sized at half the pitch reads the same on every one of these
  // tilings, and their cell areas land within 25% of the hexagon's. The 4.8.8
  // deliberately keeps its own tuning: OCT_CUT 0.37 cuts the octagon's inscribed
  // diameter to 0.891 pitch, and retrofitting this rule there would shrink the
  // octagon's font 11% and the interstitial diamond's 29%.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const v of raw.verts) {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  const px = x => (x - minX) * scale;
  const py = y => (y - minY) * scale;
  const verts = raw.verts.map(v => ({ x: px(v.x), y: py(v.y) }));
  for (const p of cellPos) {
    p.cx = px(p.cx);
    p.cy = py(p.cy);
    if (p.ax !== undefined) { p.ax = px(p.ax); p.ay = py(p.ay); }
    // Each of these four is isohedral, so the cell's shape name IS the tiling's.
    p.shape = type;
  }
  const wUnits = (maxX - minX) * scale;
  const hUnits = (maxY - minY) * scale;

  return {
    total, adj, cellPos, cellVerts, verts,
    width: wUnits, height: hUnits, wUnits, hUnits, centerIndex, type, M, N,
  };
}

// The Cairo pentagon is TANGENTIAL: four sides of length 1 and one of length
// √3 − 1, all five touching a circle of radius (3 − √3)/2. Its center sits on
// the pentagon's mirror axis, √3 − 3/2 off the lattice edge the pentagon spans,
// on the side away from the apex.
const CAIRO_INSET = Math.sqrt(3) - 1.5;                 // ~0.2321, lattice units
const CAIRO_SCALE = (3 + Math.sqrt(3)) / 6;             // 1 / (3 − √3), inscribed diameter -> 1

/**
 * Build the Cairo pentagonal tiling, Laves [3².4.3.4], over an M×N lattice.
 *
 * The degree-4 vertices sit on a square lattice of spacing √3, and exactly ONE
 * pentagon spans each lattice EDGE, M(N−1) horizontal plus (M−1)N vertical, so
 * 2MN − M − N cells. The pinwheel handedness alternates with site parity (the
 * p4g symmetry); getting that alternation wrong looks fine cell by cell and
 * makes the pentagons overlap.
 *
 * Every vertex is (a + b√3)/2 with a and b integers, which is the exact key.
 *
 * @returns the same descriptor shape as buildTiling488 / buildHexTiling.
 */
export function buildCairoTiling(M, N) {
  const S3 = Math.sqrt(3);
  const V = latticeVertices((a, b, c, d) => ({ x: (a + b * S3) / 2, y: (c + d * S3) / 2 }));
  const cellVerts = [];
  const cellPos = [];

  // RAY ANCHOR. A compass asks "which way", which only a straight line of cell
  // centers can answer, and the Cairo pentagons' incircle centers do not lie on
  // usable ones: measured from them, every direction keeps less of its drawn ray
  // inside the cells it counts (53.9% on the diagonals, 64.1% on the axes) than
  // the hex directions that were REJECTED at 66.3%. The pentagon's two
  // LATTICE-SITE vertices do fall on a clean 45°-rotated square lattice, so the
  // ray is taken from the midpoint of its long diagonal instead: 100.0% on the
  // diagonals and 87.9% on the axes, against the shipped 4.8.8 axes' 90.4%.
  // Splitting anchor from drawn center costs nothing, measured with the ray taken
  // from the anchor and the LINE traced between incircle centers. And it is a
  // midpoint of two exact lattice points, which matters as much as where it
  // lands (computeCompassRay says why a searched center is not allowed).
  for (let i = 0; i < M; i++) {
    for (let j = 0; j < N; j++) {
      const even = ((i + j) % 2) === 0;
      const sx = S3 * j, sy = S3 * i;

      if (j + 1 < N) {                       // pentagon on the horizontal lattice edge
        const sg = even ? -1 : 1;            // which side of the edge the wide end sits on
        cellVerts.push([
          V.at(0, 2 * j, 0, 2 * i),
          V.at(1, 2 * j, 0, 2 * i + sg),
          V.at(-1, 2 * j + 2, 0, 2 * i + sg),
          V.at(0, 2 * j + 2, 0, 2 * i),
          V.at(0, 2 * j + 1, -sg, 2 * i),
        ]);
        cellPos.push({
          cx: sx + S3 / 2, cy: sy + sg * CAIRO_INSET,
          ax: sx + S3 / 2, ay: sy,
        });
      }
      if (i + 1 < M) {                       // pentagon on the vertical lattice edge
        const tg = even ? 1 : -1;
        cellVerts.push([
          V.at(0, 2 * j, 0, 2 * i),
          V.at(0, 2 * j + tg, 1, 2 * i),
          V.at(0, 2 * j + tg, -1, 2 * i + 2),
          V.at(0, 2 * j, 0, 2 * i + 2),
          V.at(-tg, 2 * j, 0, 2 * i + 1),
        ]);
        cellPos.push({
          cx: sx + tg * CAIRO_INSET, cy: sy + S3 / 2,
          ax: sx, ay: sy + S3 / 2,
        });
      }
    }
  }

  return assembleTiling('cairo', M, N, { verts: V.verts, cellVerts, cellPos }, CAIRO_SCALE);
}

// The floret pentagon is TANGENTIAL too: sides 2:1:1:1:2 around a circle of
// radius √3/2 whose center is the vertex centroid, at (1, 1) on the triangular
// basis below.
// Rosette rings built beyond the requested M×N so the rectangular crop below
// always has cells to draw from on every side. Two rings would leave the crop
// short at extreme aspect ratios; three is measured to be enough for every
// (M, N) the practice boards and the gate fixture use.
const FLORET_PAD = 3;
const FLORET_BASE = [[0, 0], [2, 0], [2, 1], [1, 2], [0, 2]];
const FLORET_INCENTER = [1, 1];
const FLORET_SCALE = 1 / Math.sqrt(3);                  // inscribed diameter -> 1

// A 60° rotation on the triangular basis e1 = (1, 0), e2 = (1/2, √3/2) is
// e1 -> e2 and e2 -> e2 − e1, so it maps integers to integers exactly.
const rotate60 = ([p, q]) => [-q, p + q];

/**
 * Build the floret pentagonal tiling, Laves [3⁴.6], over an M×N lattice of
 * rosettes: six congruent pentagons pinwheeled around each center, 6MN cells.
 *
 * It is the dual of the snub hexagonal tiling, which is what pins the
 * pentagon's sides at 2:1:1:1:2 and the rosette lattice at L1 = 4e1 + e2,
 * L2 = −e1 + 5e2. Working on that triangular basis makes every vertex a PAIR OF
 * INTEGERS, because the pinwheel's 60° rotation is exact there; rotating with
 * cos/sin instead would put float noise on every shared corner and hand the
 * dedupe a rounding decision it must not have to make.
 *
 * The tiling is chiral, and its rosette phase decides which direction set the
 * compass can use (here 30/90/150 and their opposites), a 30° re-derivation
 * would swap the clean set for 0/60/120 and the wrong choice reads as plausible
 * rather than empty, so the direction set must be derived from what this builder
 * actually emits.
 *
 * ROWS ARE RE-SEATED so the patch is a RECTANGLE. L1 and L2 sit at 60° to each
 * other, so laying rosettes at plain m·L1 + n·L2 gives a sheared PARALLELOGRAM:
 * measured on a 3×4 patch it left roughly a third of the board box empty as two
 * opposite triangular wedges, which no other tiling here does and which reads as
 * a broken board rather than a lattice. L2 drifts x by exactly L1/3 per row, so
 * subtracting round(n/3)·L1 pulls every row back into column and bounds the
 * remaining stagger at ±L1/3, the same shape of fix as the honeycomb's half-hex
 * row offset, and like it a change of WHICH lattice points are used, not of the
 * lattice. The cells stay congruent, the adjacency rule is untouched, and the
 * compass phase is unaffected because whole-L1 translations are lattice
 * symmetries.
 *
 * @returns the same descriptor shape as buildTiling488 / buildHexTiling.
 */
export function buildFloretTiling(M, N) {
  const S3 = Math.sqrt(3);
  const xy = (p, q) => ({ x: p + q / 2, y: q * S3 / 2 });

  // Enumerate a GENEROUS patch as integer lattice data only. Nothing is
  // registered in the vertex list yet, because the crop below decides which
  // cells exist and assembleTiling normalizes against the whole vertex list,
  // registering first would leave orphan vertices inflating wUnits/hUnits.
  const rosettes = [];
  for (let m = -FLORET_PAD; m < M + FLORET_PAD; m++) {
    for (let n = -FLORET_PAD; n < N + FLORET_PAD; n++) {
      const k = Math.round(n / 3);                      // whole-L1 row re-seat
      const op = 4 * (m - k) - n, oq = (m - k) + 5 * n; // rosette center, (m−k)·L1 + n·L2
      let poly = FLORET_BASE, center = FLORET_INCENTER;
      for (let r = 0; r < 6; r++) {
        const c = xy(op + center[0], oq + center[1]);
        const pts = poly.map(([p, q]) => [op + p, oq + q]);
        // The cell's own extent, so the crop below can score a selection by the
        // box its POLYGONS occupy rather than by where its centers land.
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [p, q] of pts) {
          const v = xy(p, q);
          if (v.x < x0) x0 = v.x;
          if (v.x > x1) x1 = v.x;
          if (v.y < y0) y0 = v.y;
          if (v.y > y1) y1 = v.y;
        }
        rosettes.push({
          pts, cx: c.x, cy: c.y, x0, y0, x1, y1,
          core: m >= 0 && m < M && n >= 0 && n < N,
        });
        poly = poly.map(rotate60);
        center = rotate60(center);
      }
    }
  }

  // CROP TO A RECTANGLE, AT CELL GRANULARITY. The rosette lattice is a
  // triangular lattice whose L1 sits 10.89° off the horizontal, and no choice of
  // basis squares that up, so a patch counted in whole ROSETTES is a sheared
  // parallelogram no matter how its rows are seated, and it leaves the board box
  // badly under-filled (measured 67.4% against 80-94% for the other five, with
  // two large empty wedges before the rows were re-seated at all).
  //
  // Selecting CELLS rather than rosettes is what fixes it: the boundary then
  // steps by one pentagon instead of by a six-cell rosette, so it can follow a
  // rectangle closely. A rosette on the edge just contributes the petals that
  // fall inside. This is a change of WHICH lattice cells are used, never of the
  // lattice, so every cell stays congruent, adjacency is still read off shared
  // vertices, and above all the lattice's ORIENTATION is untouched, which is
  // what keeps the measured compass direction set (30/90/150 and opposites)
  // valid. Rotating the tiling to square it up would have invalidated that.
  const core = rosettes.filter(r => r.core);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of core) {
    if (r.cx < minX) minX = r.cx;
    if (r.cx > maxX) maxX = r.cx;
    if (r.cy < minY) minY = r.cy;
    if (r.cy > maxY) maxY = r.cy;
  }
  const cx0 = (minX + maxX) / 2, cy0 = (minY + maxY) / 2;
  const want = 6 * M * N;

  // WHICH rectangle? Every cell has the same area, so the selection that fills
  // its board box best is exactly the one whose polygons land in the SMALLEST
  // box, no sampling needed, just the bounding area. Sweeping the aspect and
  // keeping the tightest is what makes this adapt to any (M, N) instead of
  // baking in a ratio that happened to suit one board (measured on the 3×4
  // practice patch: the patch's own aspect fills 76.4%, a square crop 73.5%,
  // and the tightest 82.6%).
  const select = (aspect) => rosettes
    .map(r => ({ r, d: Math.max(Math.abs(r.cx - cx0) / aspect, Math.abs(r.cy - cy0)) }))
    // Ties are possible and must not depend on enumeration order, so break them
    // in reading order the way assembleTiling does.
    .sort((a, b) => a.d - b.d
      || Math.round(a.r.cy * 1e4) - Math.round(b.r.cy * 1e4)
      || Math.round(a.r.cx * 1e4) - Math.round(b.r.cx * 1e4))
    .slice(0, want)
    .map(e => e.r);

  let kept = null, bestArea = Infinity;
  for (let step = 0; step <= 24; step++) {
    const aspect = 0.6 + step * 0.05;                 // 0.60 .. 1.80, deterministic
    const sel = select(aspect);
    if (sel.length < want) continue;                  // ran out of padding
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of sel) {
      if (r.x0 < x0) x0 = r.x0;
      if (r.x1 > x1) x1 = r.x1;
      if (r.y0 < y0) y0 = r.y0;
      if (r.y1 > y1) y1 = r.y1;
    }
    const area = (x1 - x0) * (y1 - y0);
    // Strictly less, so the lowest aspect wins a tie and the choice is stable.
    if (area < bestArea - 1e-9) { bestArea = area; kept = sel; }
  }
  if (!kept) throw new Error(`floret ${M}x${N}: crop could not gather ${want} cells`);

  const V = latticeVertices((p, q) => xy(p, q));
  const cellVerts = kept.map(r => r.pts.map(([p, q]) => V.at(p, q)));
  const cellPos = kept.map(r => ({ cx: r.cx, cy: r.cy }));

  return assembleTiling('floret', M, N, { verts: V.verts, cellVerts, cellPos }, FLORET_SCALE);
}

// Pointy-top hexagons of circumradius 1 in offset rows (odd rows shifted right
// by half a hex) are the substrate BOTH rhombille and deltoidal subdivide. Every
// point either builder needs, hex center, hex vertex, edge midpoint, has x a
// multiple of √3/4 and y a multiple of 1/4, so the integer pair (B, C) with
// x = B√3/4 and y = C/4 addresses it exactly.
const hexLavesSite = (i, j) => [4 * j + 2 * (i % 2), 6 * i];
const HEX_LAVES_VERT = [[0, 4], [-2, 2], [-2, -2], [0, -4], [2, -2], [2, 2]];
const HEX_LAVES_MID = [[-1, 3], [-2, 0], [-1, -3], [1, -3], [2, 0], [1, 3]];
const hexLavesXY = (B, C) => ({ x: B * Math.sqrt(3) / 4, y: C / 4 });

const RHOMBILLE_SCALE = 2 / Math.sqrt(3);               // inscribed diameter -> 1

/**
 * Build the rhombille tiling, Laves [3.6.3.6], over an M×N hexagon lattice:
 * each hexagon cut into three 60/120 rhombi, 3MN cells.
 *
 * The rhombus is centrally symmetric, so its incircle center, its centroid and
 * its bounding-box center are all the same point and there is no compass anchor
 * to split off, the six directions 0/60/120 and their opposites work straight
 * off the drawn center, at hex quality (100% of the drawn ray inside counted
 * cells, mean length 4.45 to 5.89).
 *
 * It is also the densest of these lattices to reason on: interior valence 10,
 * against the rectangle's 8. Two consequences that are properties of the
 * tiling rather than of this builder, a rhombille clue can read 9 or 10, and
 * Pass B is structurally almost dead here (its subset pairs rarely resolve, so
 * its ladder runs Pass A straight to Pass C).
 *
 * @returns the same descriptor shape as buildTiling488 / buildHexTiling.
 */
export function buildRhombilleTiling(M, N) {
  const V = latticeVertices(hexLavesXY);
  const cellVerts = [];
  const cellPos = [];

  for (let i = 0; i < M; i++) {
    for (let j = 0; j < N; j++) {
      const [B0, C0] = hexLavesSite(i, j);
      for (let k = 0; k < 6; k += 2) {
        const a = HEX_LAVES_VERT[k];
        const b = HEX_LAVES_VERT[(k + 1) % 6];
        const c = HEX_LAVES_VERT[(k + 2) % 6];
        cellVerts.push([
          V.at(B0, C0),
          V.at(B0 + a[0], C0 + a[1]),
          V.at(B0 + b[0], C0 + b[1]),
          V.at(B0 + c[0], C0 + c[1]),
        ]);
        // A rhombus's center is the midpoint of its long diagonal, which runs
        // from the hexagon's center to the vertex between a and c.
        const mid = hexLavesXY(B0 + b[0] / 2, C0 + b[1] / 2);
        cellPos.push({ cx: mid.x, cy: mid.y });
      }
    }
  }

  return assembleTiling('rhombille', M, N, { verts: V.verts, cellVerts, cellPos }, RHOMBILLE_SCALE);
}

// The kite is tangential (every kite is), inscribed radius (3 − √3)/4 with its
// center at (3 − √3)/2 along hexCenter -> hexVertex; the vertex centroid sits
// slightly short of that, at 5/8.
const DELTOIDAL_INCENTER_R = (3 - Math.sqrt(3)) / 2;    // ~0.6340 of the circumradius
const DELTOIDAL_ANCHOR_R = 0.5;                         // long-diagonal midpoint
const DELTOIDAL_SCALE = (3 + Math.sqrt(3)) / 3;         // 2 / (3 − √3), inscribed diameter -> 1

/**
 * Build the deltoidal trihexagonal tiling, Laves [3.4.6.4], over an M×N hexagon
 * lattice: each hexagon cut into six congruent kites (center, edge midpoint,
 * vertex, next edge midpoint), 6MN cells.
 *
 * Richest of the four to solve, 62% of constructively generated certified
 * boards reach techniqueLevel 2, against 6% on rhombille, and its interior
 * valence of 9 also carries clues above the classic ceiling of 8.
 *
 * @returns the same descriptor shape as buildTiling488 / buildHexTiling.
 */
export function buildDeltoidalTiling(M, N) {
  const V = latticeVertices(hexLavesXY);
  const cellVerts = [];
  const cellPos = [];

  // RAY ANCHOR, and the one number here that is a coincidence rather than a
  // choice. Sweeping the anchor radius from 0.30 to 0.866 puts EVERY value below
  // the shipped bar except exactly 1/2, including the vertex centroid (0.625)
  // and the incircle center (0.634), whose best direction keeps 67.2% of its
  // drawn ray inside counted cells, under the 66.3% that got hex's 30/90/150
  // rejected. At radius 1/2, the kite's long-diagonal midpoint, the same
  // directions reach 89.8-91.3%. So this is not a tunable to nudge for
  // legibility: it is where the kite centers happen to fall on straight lines,
  // and moving it in either direction breaks the compass rather than trading
  // against something.
  for (let i = 0; i < M; i++) {
    for (let j = 0; j < N; j++) {
      const [B0, C0] = hexLavesSite(i, j);
      const hub = hexLavesXY(B0, C0);
      for (let k = 0; k < 6; k++) {
        const m0 = HEX_LAVES_MID[(k + 5) % 6];
        const v = HEX_LAVES_VERT[k];
        const m1 = HEX_LAVES_MID[k];
        cellVerts.push([
          V.at(B0, C0),
          V.at(B0 + m0[0], C0 + m0[1]),
          V.at(B0 + v[0], C0 + v[1]),
          V.at(B0 + m1[0], C0 + m1[1]),
        ]);
        // The kite's long diagonal is hexCenter -> hexVertex, and the hexagon's
        // circumradius is 1, so this offset is already a unit vector.
        const u = hexLavesXY(v[0], v[1]);
        cellPos.push({
          cx: hub.x + DELTOIDAL_INCENTER_R * u.x, cy: hub.y + DELTOIDAL_INCENTER_R * u.y,
          ax: hub.x + DELTOIDAL_ANCHOR_R * u.x, ay: hub.y + DELTOIDAL_ANCHOR_R * u.y,
        });
      }
    }
  }

  return assembleTiling('deltoidal', M, N, { verts: V.verts, cellVerts, cellPos }, DELTOIDAL_SCALE);
}

/**
 * Every tiling the dispatcher builds, canonical names only, `'6.6.6'` is
 * accepted as an alias for `'hex'` but is not a separate tiling. Single-sourced
 * here so the deep-link parser and any per-type table can be checked against the
 * builders rather than against a hand-copied list.
 */
export const TILING_TYPES = ['4.8.8', 'hex', 'cairo', 'floret', 'rhombille', 'deltoidal'];

const TILING_BUILDERS = {
  '4.8.8': buildTiling488,
  hex: buildHexTiling,
  '6.6.6': buildHexTiling,
  cairo: buildCairoTiling,
  floret: buildFloretTiling,
  rhombille: buildRhombilleTiling,
  deltoidal: buildDeltoidalTiling,
};

/**
 * Tiling dispatcher: return the topology + geometry for a named tiling. Every
 * builder emits the same descriptor, so each consumer (generator, renderer, wall
 * wireframe) is tiling-agnostic and picks the tiling by `type` alone.
 *
 * An unrecognized type falls through to the shipped 4.8.8 rather than throwing,
 * which is the contract the generator's own `type = '4.8.8'` default relies on.
 * With six types that fallback is a real hazard, a typo produces a 4.8.8 with
 * no error anywhere, so callers that take a type from OUTSIDE the code (the
 * `?coastline=` token parser is the only one) must validate against
 * TILING_TYPES before they get here.
 */
export function buildTiling(type, M, N) {
  return (TILING_BUILDERS[type] || buildTiling488)(M, N);
}

/**
 * A cell's own box and clip-path, derived from that cell's polygon.
 *
 * The renderer picks a clip-path per SHAPE NAME today, which holds only while
 * every cell of a shape is identical up to TRANSLATION, true of the octagon,
 * the interstitial diamond and the hexagon, false of all four Laves tilings,
 * whose one cell shape appears in several rotations (cairo 4, floret 6,
 * rhombille 3, deltoidal 6). Box size does not identify the rotation either:
 * rhombille's 0° and 60° rhombi share a 1 × 1.732 box and need different
 * clip-paths, so anything keyed on box dimensions mis-shapes half the board
 * without erroring.
 *
 * So derive both from the vertices: the box is their tight axis-aligned bounding
 * box in PITCH units, and the clip-path is each vertex as a percentage of that
 * box in the polygon's own order. This is not a new rule for the shipped shapes,
 * it is the rule their three hand-inlined branches are cases of, SQ_BOX_FRAC IS
 * the diamond's bbox width and HEX_BOX_H IS the hexagon's bbox height, and it
 * reproduces all three to 0 percentage points across every cell of a full board,
 * and to 0 differing pixels over 711,000 in a headless-Chromium comparison.
 *
 * Percentages are trimmed of trailing zeros so the two shipped shapes that CAN
 * match do, byte for byte. The octagon still differs as a string, because
 * octagonClipPath() mixes toFixed(3) values with bare 0%/100% literals; Chromium
 * normalizes both spellings to the same computed value, so nothing that can read
 * a clip-path can tell them apart.
 *
 * @param {Array<{x:number,y:number}>} verts the tiling's deduped vertex list
 * @param {number[]} cellVertIndices one cell's entry of the tiling's `cellVerts`
 * @returns {{left:number, top:number, width:number, height:number, clipPath:string}}
 *   left/top/width/height in PITCH units, multiply by the live pitch for px.
 */
export function cellOutline(verts, cellVertIndices) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const vi of cellVertIndices) {
    const v = verts[vi];
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  const width = maxX - minX, height = maxY - minY;
  const points = cellVertIndices.map(vi => {
    const v = verts[vi];
    return `${trimPct((v.x - minX) / width)}% ${trimPct((v.y - minY) / height)}%`;
  });
  return { left: minX, top: minY, width, height, clipPath: `polygon(${points.join(', ')})` };
}

function trimPct(fraction) {
  const s = (fraction * 100).toFixed(3);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
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
 * A rows×cols container that EXACTLY holds `total` cells, every slot is a real
 * cell, so `cellCount = rows*cols` stays an honest feature, as near-square as
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

// Dimension bounds the canonical-board rules enforce on `rows` and `cols`
// (`firebase-rules.json`, the dailyBoard and weeklyBoard blocks). Mirrored here
// so a board that could never be STORED is refused where it is built rather
// than by a silent write rejection; `test/tilingCanonicalRoundTrip.test.mjs`
// reads the rules file and asserts these two still match it.
export const CANONICAL_MIN_DIM = 5;
export const CANONICAL_MAX_DIM = 30;

/**
 * Can a tiling of `total` cells be stored as a canonical board?
 *
 * The container is an arbitrary exact factorization, so this is a question
 * about `total`'s FACTORS, not about the tiling: a PRIME cell count forces
 * `1 × total`, and the rules require every dimension in
 * [CANONICAL_MIN_DIM, CANONICAL_MAX_DIM]. A 4.8.8 at M=8, N=8 is
 * 2·8·8−8−8+1 = 113 cells, prime, so it ships as 1×113 and the write is
 * rejected wholesale. Nothing about the board is wrong; it just cannot be a
 * daily, and without this check the only symptom is a canonical that never
 * appears.
 *
 * Cell counts per tiling, so a size choice can be checked before it is made:
 * 4.8.8 `2MN − M − N + 1`, hex `MN`, cairo `2MN − M − N`, floret `6MN`,
 * rhombille `3MN`, deltoidal `6MN`. The three multiples of 3 and 6 are storable
 * across the whole useful band; 4.8.8 and cairo are the two that can land on a
 * prime, so they are the two worth checking (cairo M=4,N=7 is 41, prime).
 *
 * @param {number} total cell count
 * @returns {boolean}
 */
export function containerIsStorable(total) {
  const { rows, cols } = containerFor(total);
  return rows >= CANONICAL_MIN_DIM && rows <= CANONICAL_MAX_DIM
    && cols >= CANONICAL_MIN_DIM && cols <= CANONICAL_MAX_DIM;
}

/**
 * The cells a compass ray crosses on a tiling: every cell whose CENTER lies on
 * the straight line out of the origin in direction (dx, dy), ordered outward.
 *
 * A compass is a geometry question ("which way"), which a neighbor graph can't
 * answer, so the ray is computed HERE, from cell positions, once at generation,
 * and stored on the cell. The certifier and the display then both read the
 * stored ray (compassRayCells returns it on an explicit topology) and can never
 * disagree. Positions are exact half/integer lattice values, so the colinearity
 * cross-product is exact, no float slop.
 *
 * On the 4.8.8 lattice positions are exact half/integer values so the colinearity
 * cross-product is exactly zero; on a hexagonal lattice the row spacing is
 * sqrt(3)/2, so a colinear cell's cross-product is only zero to floating point.
 * The tolerance bridges that: the nearest OFF-axis lattice cell has a
 * cross-product of order ~0.4 (the lattice's minimal off-line distance), orders
 * of magnitude above any float error, so this can never misclassify. Both the
 * display and the certifier read the SAME stored ray, so whatever this returns
 * is self-consistent regardless.
 *
 * A cell may nominate a RAY ANCHOR (`cellPos[i].ax/ay`) distinct from the point
 * its number is drawn at, and where one is present it is used for the origin and
 * for every candidate. Cairo and deltoidal need this: the point a player reads
 * the number at is the cell's incircle center, and on those two lattices the
 * incircle centers do not lie on usable straight lines while another exactly
 * computable point of the same cell does (see each builder's anchor note for the
 * measurements). The two Archimedean tilings, floret and rhombille emit no
 * anchor and are byte-identical either way.
 *
 * The anchor must be CLOSED FORM, never a numerical search. A pattern-search
 * incircle carries around 1.5e-9 of error, which is larger than the EPS below,
 * and measuring deltoidal that way silently destroyed 4 of its 6 direction
 * families, the rays came back short and plausible rather than empty, which is
 * exactly the failure a review does not catch.
 *
 * @param {Array<{cx:number,cy:number,ax?:number,ay?:number}>} cellPos
 * @param {number} originIdx
 * @param {number} dx  direction x-component
 * @param {number} dy  direction y-component
 * @returns {number[]} flat indices, nearest first
 */
export function computeCompassRay(cellPos, originIdx, dx, dy) {
  const o = cellPos[originIdx];
  const ox = o.ax ?? o.cx, oy = o.ay ?? o.cy;
  const hits = [];
  const EPS = 1e-9;
  const norm = Math.hypot(dx, dy) || 1;
  for (let i = 0; i < cellPos.length; i++) {
    if (i === originIdx) continue;
    const p = cellPos[i];
    const rx = (p.ax ?? p.cx) - ox, ry = (p.ay ?? p.cy) - oy;
    if (Math.abs(rx * dy - ry * dx) / norm > EPS) continue;  // off the line
    const t = rx * dx + ry * dy;                             // signed distance along the ray
    if (t <= EPS) continue;                                  // behind / at the origin
    hits.push({ i, t });
  }
  hits.sort((a, b) => a.t - b.t);
  return hits.map(h => h.i);
}
