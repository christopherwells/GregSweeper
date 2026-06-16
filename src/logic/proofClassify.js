// ── Soundness-gated pattern naming ───────────────────────────
// Names a deduced cell by the RICHEST shape whose clues PROVABLY force it.
// Two halves, deliberately separated:
//
//   • GEOMETRY (patternNames.js recognizers) describes a shape and reports
//     the exact clues it matched (the optional `out` capture param).
//   • THE GATE (minimalProof.subsetForces) proves those clues actually force
//     the square across every satisfying assignment.
//
// A name is returned only when BOTH pass, so a shape can never be claimed on
// incidental geometry that doesn't truly prove the cell — the soundness flaw
// the old board-scan recognizers had no defense against. "Most specific wins"
// (Christopher, 2026-06-15): when a square is provable by both a cheaper and
// a richer shape, the richer one is named, because the richer geometry is a
// valid proof of it (verified by the gate) and is the pattern the player
// recognizes — even though a cheaper proof also exists.
//
// This is the authoritative classifier for player-facing technique stats.
// patternNames.classifyPattern (ungated, geometry-only) stays as the Gym /
// receipts namer; the exhaustive validation harness cross-checks the two.

import { buildNeighborCache } from './boardSolver.js';
import { clueUniverse, subsetForces, minimalProofForCell } from './minimalProof.js';
import {
  isOneTwoOne, isOneTwoTwoOne, isOneThreeOneCorner, isTwoTwoTwoCorner,
  isHole, isTriangle, matchesOverlapPair,
} from './patternNames.js';

// Richest → cheapest. The order IS the "most specific wins" policy: the
// first shape that both matches AND gates wins. Line composites outrank the
// pocket overlaps, which outrank the bare pairs, which outrank counting.
const SHAPE_ORDER = [
  '1-2-2-1', '1-2-1', '1-3-1', '2-2-2', 'triangle', 'hole', '1-2', '1-1', 'pair',
];

// Classify one deduced cell by its richest gated shape.
//   board : live state, target cells still hidden, proven mines flagged
//   ded   : { row, col, kind:'safe'|'mine' }
//   opts  : { rows?, cols?, neighborCache?, universe?, respectFlags? }
// Returns { name, family, clues:[{row,col}] } where name is a SHAPE_ORDER
// entry, 'count' (single-clue), or 'region' (provable but unnamed).
export function classifyByProof(board, ded, opts = {}) {
  if (!ded || typeof ded.row !== 'number' || typeof ded.col !== 'number') {
    return { name: null, family: null, clues: [] };
  }
  const rows = opts.rows || board.length;
  const cols = opts.cols || board[0].length;
  const nc = opts.neighborCache || buildNeighborCache(board, rows, cols);
  const kind = ded.kind === 'mine' ? 'mine' : 'safe';
  const target = ded.row * cols + ded.col;
  const universe = opts.universe || clueUniverse(board, opts);

  // origin cell index → its constraint (one per plain clue; named shapes only
  // ever cite plain clues, so every captured clue resolves here).
  const byOrigin = new Map();
  for (const c of universe) if (c.origin != null && !byOrigin.has(c.origin)) byOrigin.set(c.origin, c);
  const rc = (i) => ({ row: Math.floor(i / cols), col: i % cols });

  // The gate: the captured clue origins must form a constraint subset that
  // forces the target. A captured clue missing from the universe (should not
  // happen for plain clues) fails the gate rather than naming unsoundly.
  const gate = (origins) => {
    if (!origins || !origins.length) return false;
    const subset = [];
    for (const o of origins) {
      const c = byOrigin.get(o);
      if (!c) return false;
      subset.push(c);
    }
    return subsetForces(subset, target, kind);
  };

  const out = {};
  const tryShape = (matched, name, family) => {
    if (!matched) return null;
    if (!gate(out.clues)) return null;
    return { name, family, clues: out.clues.map(rc) };
  };

  // Richest-first; each candidate is gated before it can win.
  let r;
  out.clues = null;
  if ((r = tryShape(isOneTwoTwoOne(board, rows, cols, nc, target, out), '1-2-2-1', '1-2'))) return r;
  out.clues = null;
  if ((r = tryShape(isOneTwoOne(board, rows, cols, nc, target, out), '1-2-1', '1-2'))) return r;
  out.clues = null;
  if ((r = tryShape(isOneThreeOneCorner(board, rows, cols, nc, target, kind, out), '1-3-1', '1-2'))) return r;
  out.clues = null;
  if (kind === 'safe' && (r = tryShape(isTwoTwoTwoCorner(board, rows, cols, nc, target, out), '2-2-2', 'enumeration'))) return r;
  out.clues = null;
  const tri = isTriangle(board, rows, cols, nc, target, out);
  if ((r = tryShape(tri, 'triangle', tri || '1-1'))) return r;
  out.clues = null;
  const hol = isHole(board, rows, cols, nc, target, out);
  if ((r = tryShape(hol, 'hole', hol || '1-1'))) return r;
  out.clues = null;
  const op = matchesOverlapPair(board, rows, cols, nc, target, kind, out);
  if (op && gate(out.clues)) {
    const [lo, hi] = op;
    const clues = out.clues.map(rc);
    if (lo === 1 && hi === 1) return { name: '1-1', family: '1-1', clues };
    if (lo === 1 && hi === 2) return { name: '1-2', family: '1-2', clues };
    return { name: 'pair', family: lo === hi ? '1-1' : '1-2', clues };
  }

  // No named shape gated. A single clue that forces it is plain counting;
  // anything else provable is an honest 'region' (enumeration, no shape).
  const single = minimalProofForCell(universe, target, kind, 1);
  if (single && !single.region) {
    return { name: 'count', family: 'count', clues: single.candidates[0].map(c => rc(c.origin)) };
  }
  return { name: 'region', family: 'enumeration', clues: [] };
}

// Curriculum difficulty order (== LESSON_ORDER). The Gym require-gate asks
// "must the player reach for shape T, or is something SIMPLER enough?" — so it
// needs the CHEAPEST read, ranked here, not classifyByProof's richest.
export const SHAPE_RANK = {
  count: 0, '1-1': 1, '1-2': 2, hole: 3, triangle: 4,
  '1-2-1': 5, '1-2-2-1': 6, '1-3-1': 7, '2-2-2': 8,
};

// The SIMPLEST shape (lowest curriculum rank) whose clues PROVABLY force this
// cell. Counting is rank 0; a cell with any single-clue proof is rank 0 even
// if richer geometry also fits (that geometry is incidental — a real player
// just counts it). Returns Infinity when only enumeration proves it. Soundness
// is the same gate as classifyByProof: every rank is confirmed by subsetForces.
export function simplestGatingRank(board, ded, opts = {}) {
  if (!ded || typeof ded.row !== 'number' || typeof ded.col !== 'number') return Infinity;
  const rows = opts.rows || board.length;
  const cols = opts.cols || board[0].length;
  const nc = opts.neighborCache || buildNeighborCache(board, rows, cols);
  const kind = ded.kind === 'mine' ? 'mine' : 'safe';
  const target = ded.row * cols + ded.col;
  const universe = opts.universe || clueUniverse(board, opts);
  const byOrigin = new Map();
  for (const c of universe) if (c.origin != null && !byOrigin.has(c.origin)) byOrigin.set(c.origin, c);
  const gate = (origins) => {
    if (!origins || !origins.length) return false;
    const subset = [];
    for (const o of origins) { const c = byOrigin.get(o); if (!c) return false; subset.push(c); }
    return subsetForces(subset, target, kind);
  };
  // rank 0 — counting (a single clue forces it).
  const single = minimalProofForCell(universe, target, kind, 1);
  if (single && !single.region) return 0;
  const out = {};
  // rank 1/2 — the bare 1-1 / 1-2 (and bigger-digit) overlap pairs.
  out.clues = null;
  const op = matchesOverlapPair(board, rows, cols, nc, target, kind, out);
  if (op && gate(out.clues)) return op[0] === op[1] ? 1 : 2;
  // rank 3/4 — pockets (NOT named by the overlap pair above, so a real hole
  // reaches here instead of masquerading as a 1-1).
  out.clues = null; if (isHole(board, rows, cols, nc, target, out) && gate(out.clues)) return 3;
  out.clues = null; if (isTriangle(board, rows, cols, nc, target, out) && gate(out.clues)) return 4;
  // rank 5/6 — collinear line composites.
  out.clues = null; if (isOneTwoOne(board, rows, cols, nc, target, out) && gate(out.clues)) return 5;
  out.clues = null; if (isOneTwoTwoOne(board, rows, cols, nc, target, out) && gate(out.clues)) return 6;
  // rank 7 — 1-3-1 corner. rank 8 — 2-2-2 corner.
  out.clues = null; if (isOneThreeOneCorner(board, rows, cols, nc, target, kind, out) && gate(out.clues)) return 7;
  out.clues = null; if (kind === 'safe' && isTwoTwoTwoCorner(board, rows, cols, nc, target, out) && gate(out.clues)) return 8;
  return Infinity;
}
