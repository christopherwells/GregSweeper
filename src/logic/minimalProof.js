// ── Minimal-proof extraction ─────────────────────────────────
// For each cell the solver can deduce, find the SMALLEST set of
// clue-constraints that forces it. The proof is read off the constraint
// system the board solver already builds (buildBoardConstraints) — NOT a
// board-template scan. Two properties hold by construction:
//
//   • SOUND   — if a subset S forces cell C (C is invariant across every
//     assignment satisfying S), then C is genuinely forced on the full
//     board. Monotonicity: adding the rest of the board's constraints only
//     REMOVES satisfying assignments, so an invariant over S's solutions is
//     invariant over the (smaller) full solution set.
//   • COMPLETE — every cell findDeducibleFrontier proves has SOME minimal
//     proof; when no subset of ≤ MAX_NAMED_CLUES clues forces it, that is an
//     honest 'region' (a genuine enumeration deduction), never a guess.
//
// Nothing here assigns a human NAME — the proof's size and shape are what
// the pattern classifier consumes. This module only answers "what is the
// smallest set of clues that proves this square, and what are they?"

import { buildBoardConstraints, findDeducibleFrontier } from './boardSolver.js';

// 1-2-2-1 is the widest named shape (4 clues); a minimal proof larger than
// this is an enumeration deduction → 'region'.
export const MAX_NAMED_CLUES = 4;
// 2^n enumeration ceiling for a single subset's own cells. Named proofs
// union to far fewer cells than this; the cap only guards a pathological
// wide subset (which would be 'region' anyway).
const MAX_PROOF_CELLS = 22;

function popcount(x) {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  return ((x + (x >> 4)) & 0x0f0f0f0f) * 0x01010101 >>> 24;
}

// Does this subset of constraints force `cellIdx` to `kind` ('safe' | 'mine')
// across EVERY assignment that satisfies the subset? Enumerates the subset's
// OWN cells only and checks the target bit is invariant. Returns false when
// the subset doesn't even mention the cell, when it admits no satisfying
// assignment, or when the target varies.
export function subsetForces(subset, cellIdx, kind) {
  const cellSet = new Set();
  for (const c of subset) for (const u of c.unknowns) cellSet.add(u);
  if (!cellSet.has(cellIdx)) return false;
  const cells = [...cellSet];
  const n = cells.length;
  if (n > MAX_PROOF_CELLS) return false;
  const pos = new Map();
  cells.forEach((u, i) => pos.set(u, i));
  const target = pos.get(cellIdx);

  const masks = subset.map(c => {
    let m = 0;
    for (const u of c.unknowns) m |= (1 << pos.get(u));
    return m;
  });
  const allowed = subset.map(c => c.allowedMines);

  let valid = 0;
  let alwaysMine = true;
  let alwaysSafe = true;
  const limit = 1 << n;
  for (let a = 0; a < limit; a++) {
    let ok = true;
    for (let i = 0; i < masks.length; i++) {
      const cnt = popcount(a & masks[i]);
      const allow = allowed[i];
      let hit = false;
      for (let j = 0; j < allow.length; j++) if (allow[j] === cnt) { hit = true; break; }
      if (!hit) { ok = false; break; }
    }
    if (!ok) continue;
    valid++;
    if ((a >> target) & 1) alwaysSafe = false;
    else alwaysMine = false;
    if (!alwaysMine && !alwaysSafe) return false; // target varies → not forced
  }
  if (valid === 0) return false;
  return kind === 'safe' ? alwaysSafe : alwaysMine;
}

// Lexicographic k-combinations of an index array.
function* combinations(pool, k) {
  const n = pool.length;
  if (k <= 0 || k > n) return;
  const c = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    yield c.map(i => pool[i]);
    let i = k - 1;
    while (i >= 0 && c[i] === i + n - k) i--;
    if (i < 0) break;
    c[i]++;
    for (let j = i + 1; j < k; j++) c[j] = c[j - 1] + 1;
  }
}

// Constraints connected to cellIdx through shared cells, gathered up to
// `hops` hops. A size-s forcing subset is connected through the cell and
// spans ≤ s-1 hops, so MAX_NAMED_CLUES-1 hops contains every named proof —
// this keeps the subset search local and bounded even when the live
// component is the whole frontier.
function candidatePool(universe, cellIdx, hops) {
  const touching = [];
  for (let i = 0; i < universe.length; i++) {
    if (universe[i].unknowns.includes(cellIdx)) touching.push(i);
  }
  if (touching.length === 0) return { touching: [], pool: [] };

  const inPool = new Set(touching);
  let frontier = new Set(touching);
  for (let h = 0; h < hops; h++) {
    const next = new Set();
    for (const ci of frontier) {
      const cellsOf = new Set(universe[ci].unknowns);
      for (let j = 0; j < universe.length; j++) {
        if (inPool.has(j)) continue;
        if (universe[j].unknowns.some(u => cellsOf.has(u))) { next.add(j); inPool.add(j); }
      }
    }
    frontier = next;
    if (next.size === 0) break;
  }
  return { touching, pool: [...inPool] };
}

// The smallest forcing subset(s) for one deduced cell. Searches subsets by
// increasing size; at the first size that forces the cell it returns ALL
// minimal-size forcing subsets (so a caller picking "most specific" has the
// full minimal set, not whichever was found first). Returns { region:true }
// when no subset of ≤ maxClues forces it.
//
// `universe` is the clue list (each { unknowns, allowedMines, origin }) from
// clueUniverse(); `kind` is 'safe' | 'mine'.
export function minimalProofForCell(universe, cellIdx, kind, maxClues = MAX_NAMED_CLUES) {
  const { touching, pool } = candidatePool(universe, cellIdx, maxClues - 1);
  if (touching.length === 0) return null;
  const mustSet = new Set(touching);

  for (let size = 1; size <= maxClues; size++) {
    const found = [];
    for (const combo of combinations(pool, size)) {
      let hasMust = false;
      for (const ui of combo) if (mustSet.has(ui)) { hasMust = true; break; }
      if (!hasMust) continue;
      const subset = combo.map(ui => universe[ui]);
      if (subsetForces(subset, cellIdx, kind)) found.push(subset);
    }
    if (found.length) return { size, candidates: found, region: false };
  }
  return { size: Infinity, candidates: [], region: true };
}

// The universe of clue-constraints for the current board state — numbered
// cells, liar disjunctions, and visible gimmick constraints — each carrying
// its `origin` cell. This is exactly the constraint set the solver's joint
// pass consumes, so a minimal proof can only ever cite clues the solver
// itself used.
export function clueUniverse(board, opts = {}) {
  const { constraints, liarCs, gimmickCs } = buildBoardConstraints(board, opts);
  return [...constraints, ...liarCs, ...gimmickCs].filter(c => c.origin != null);
}

function summarize(mp, cols) {
  const rc = (i) => ({ row: Math.floor(i / cols), col: i % cols });
  if (!mp) return { size: 0, region: false, clues: [], candidates: [] };
  if (mp.region) return { size: Infinity, region: true, clues: [], candidates: [] };
  const describe = (subset) => subset.map(c => ({
    ...(c.origin != null ? rc(c.origin) : { row: -1, col: -1 }),
    allowedMines: c.allowedMines.slice(),
    cells: c.unknowns.map(rc),
  }));
  return {
    size: mp.size,
    region: false,
    clues: describe(mp.candidates[0]),
    candidates: mp.candidates.map(describe),
  };
}

// For every cell findDeducibleFrontier proves on the current board state,
// its minimal proof (size + the citing clues, in board coordinates). The
// `tier` from the frontier rides along so a caller can cross-check
// (tier 0 ⇒ size 1, tier 1 ⇒ size 2, on plain boards).
export function minimalProofs(board, opts = {}) {
  const universe = clueUniverse(board, opts);
  const fr = findDeducibleFrontier(board, opts);
  const cols = board[0].length;
  const idx = (r, c) => r * cols + c;
  const out = [];
  for (const s of fr.safe) {
    const mp = minimalProofForCell(universe, idx(s.row, s.col), 'safe');
    out.push({ row: s.row, col: s.col, kind: 'safe', tier: s.tier, ...summarize(mp, cols) });
  }
  for (const m of fr.mines) {
    const mp = minimalProofForCell(universe, idx(m.row, m.col), 'mine');
    out.push({ row: m.row, col: m.col, kind: 'mine', tier: m.tier, ...summarize(mp, cols) });
  }
  return out;
}
