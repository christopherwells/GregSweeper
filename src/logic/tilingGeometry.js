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
// A regular octagon inscribed in its unit box has side s = 1/(1+√2); the box
// corners are cut at a = (1 - s)/2 from each corner. OCT_CUT is that fraction.
export const OCT_CUT = (1 - 1 / (1 + Math.SQRT2)) / 2; // ≈ 0.29289

// The interstitial square is a diamond whose four corners reach the octagon
// vertices around it. Its axis-aligned bounding box is 2·OCT_CUT of the pitch.
export const SQ_BOX_FRAC = 2 * OCT_CUT; // ≈ 0.58579

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

  return { total, nOct, nSq, adj, octIndex, sqIndex, cellPos, width: N, height: M };
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
