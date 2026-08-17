// The daily/weekly "Start here" anchor: where it is chosen, and by whom.
//
// HIS RULING (2026-08-17, after the corner-start daily): "This should
// definitely not be client-side ever." The anchor used to be searched by
// the client at load, zeros-first in reading order, stopping at the FIRST
// cell whose full solve certifies. On 2026-08-17 that was (0,0), the
// extreme top-left corner, whose 9-cell opening was followed by one subset
// deduction and four consecutive tank-class moves: a certified path that a
// human reads as "unsolvable at the start". A derived-at-load decision can
// also drift between clients and code versions (the match-guest-join
// class), so the anchor is now CHOSEN AT PRECOMPUTE, stored in the
// canonical payload (`bestStart`, a flat cell index, signed with the rest),
// and rendered by the client verbatim.
//
// Two functions, one file, so the pipeline's choice and the client's
// vintage fallback cannot drift apart:
//
//  - `chooseStartAnchor`: the pipeline's policy. Among CERTIFYING anchors,
//    prefer the friendliest opening: the longest run of plain (pass-A)
//    deductions before the first harder move, then the larger opening
//    cascade, then centrality, then reading order. Deterministic, and paid
//    only at precompute (one full solve per zero cell).
//  - `legacyStartSearch`: the exact search the client used to run, kept as
//    the ONE copy for canonicals that predate the stored field. First
//    certifying candidate wins, zeros first in reading order; when nothing
//    certifies, the candidate leaving the fewest unknowns, with NO
//    certificate.
//
// Both take the deserialized board and return { r, c, check } where check
// is the anchor's own full-solve result (null when nothing certifies), the
// witness the Certified chip stamps from.

import { isBoardSolvable } from './boardSolver.js';
import { buildNeighborCache } from './adjacency.js';

// Solver runs leak isRevealed onto cells; every caller of a repeated-solve
// loop must clean between runs (the generateBoard contract, held here too).
function cleanSolverArtifacts(board) {
  for (const row of board) for (const cell of row) delete cell.isRevealed;
}

function candidates(board, rows, cols) {
  const zeros = [];
  const nonZeros = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (cell.isMine || cell.isLocked) continue;
      (cell.adjacentMines === 0 ? zeros : nonZeros).push({ r, c });
    }
  }
  return { zeros, nonZeros };
}

/** The number of leading trace entries provable by plain pass-A reasoning. */
function tierZeroPrefix(trace) {
  let n = 0;
  for (const e of trace || []) {
    if (e.tier === 0) n++;
    else break;
  }
  return n;
}

/** Flood the zero-cascade a first click at (r, c) would open, wall-aware. */
export function openingCascadeSize(board, rows, cols, r, c, nbrCache) {
  const cache = nbrCache || buildNeighborCache(board, rows, cols);
  const idx = (rr, cc) => rr * cols + cc;
  const seen = new Set([idx(r, c)]);
  const queue = [[r, c]];
  while (queue.length) {
    const [cr, cc] = queue.pop();
    if (board[cr][cc].adjacentMines !== 0) continue;
    for (const ni of cache[idx(cr, cc)] || []) {
      if (seen.has(ni)) continue;
      seen.add(ni);
      queue.push([Math.floor(ni / cols), ni % cols]);
    }
  }
  return seen.size;
}

/**
 * The precompute's anchor choice. Evaluates every zero cell (and, only when
 * no zero certifies, walks the nonzeros in reading order for the first
 * certifying one, the rare fallback shape). Returns null when NO anchor
 * certifies, which the pipeline treats as its own loud problem, never a
 * reason to ship a partial anchor as if it were the promise.
 *
 * @returns {{r: number, c: number, check: object} | null}
 */
export function chooseStartAnchor(board, rows, cols) {
  const { zeros, nonZeros } = candidates(board, rows, cols);
  const nbrCache = buildNeighborCache(board, rows, cols);
  const midR = (rows - 1) / 2;
  const midC = (cols - 1) / 2;
  let best = null;
  for (const cand of zeros) {
    const check = isBoardSolvable(board, rows, cols, cand.r, cand.c, nbrCache, { trace: true });
    cleanSolverArtifacts(board);
    if (!check.solvable || check.remainingUnknowns !== 0) continue;
    const score = {
      prefix: tierZeroPrefix(check.trace),
      cascade: openingCascadeSize(board, rows, cols, cand.r, cand.c, nbrCache),
      centrality: -(Math.abs(cand.r - midR) + Math.abs(cand.c - midC)),
    };
    if (!best
      || score.prefix > best.score.prefix
      || (score.prefix === best.score.prefix && score.cascade > best.score.cascade)
      || (score.prefix === best.score.prefix && score.cascade === best.score.cascade
        && score.centrality > best.score.centrality)) {
      best = { r: cand.r, c: cand.c, check, score };
    }
  }
  if (best) return { r: best.r, c: best.c, check: best.check };
  for (const cand of nonZeros) {
    const check = isBoardSolvable(board, rows, cols, cand.r, cand.c, nbrCache);
    cleanSolverArtifacts(board);
    if (check.solvable && check.remainingUnknowns === 0) {
      return { r: cand.r, c: cand.c, check };
    }
  }
  return null;
}

/**
 * The search the client ran before the field was stored, byte-for-byte in
 * behavior: zeros first in reading order, break at the first certifying
 * candidate; otherwise the fewest-unknowns partial anchor with check null.
 * Serves canonicals that predate `bestStart` and nothing else.
 *
 * @returns {{r: number, c: number, check: object | null} | null}
 */
export function legacyStartSearch(board, rows, cols) {
  const { zeros, nonZeros } = candidates(board, rows, cols);
  const nbrCache = buildNeighborCache(board, rows, cols);
  let bestStart = null;
  let bestStartUnknowns = Infinity;
  for (const cand of [...zeros, ...nonZeros]) {
    const result = isBoardSolvable(board, rows, cols, cand.r, cand.c, nbrCache);
    cleanSolverArtifacts(board);
    if (result.solvable && result.remainingUnknowns === 0) {
      return { r: cand.r, c: cand.c, check: result };
    }
    if (result.remainingUnknowns < bestStartUnknowns) {
      bestStartUnknowns = result.remainingUnknowns;
      bestStart = { r: cand.r, c: cand.c, check: null };
    }
  }
  return bestStart;
}

/**
 * Resolve a stored anchor index against the board, verifying it on load the
 * way the center certification is verified on load: bounds, not a mine, and
 * its own full solve certifies (the chip's witness). Returns null on any
 * failure so the caller can fall back to the legacy search rather than
 * marking a cell the certificate does not stand behind.
 *
 * @returns {{r: number, c: number, check: object} | null}
 */
export function resolveStoredAnchor(board, rows, cols, storedIndex) {
  if (!Number.isInteger(storedIndex) || storedIndex < 0 || storedIndex >= rows * cols) return null;
  const r = Math.floor(storedIndex / cols);
  const c = storedIndex % cols;
  if (board[r][c].isMine || board[r][c].isLocked) return null;
  const check = isBoardSolvable(board, rows, cols, r, c);
  cleanSolverArtifacts(board);
  if (!check.solvable || check.remainingUnknowns !== 0) return null;
  return { r, c, check };
}
