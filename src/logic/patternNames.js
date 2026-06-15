// ── Named technique detector (shared source of truth) ──────────
// Classifies a deduction into a named Minesweeper pattern the way a
// player names it ("that was a 1-2-1"), from the board GEOMETRY — not
// from the solver's tier buckets, which are geometry-blind (the same
// visual 1-2-1 can resolve at tier 1 or tier 2 depending on the flanking
// clues). Both Greg's Gym (lesson admission + coaching) and the
// receipts / Lens read this one module, so the game can never teach a
// pattern its receipts cannot recognize.
//
// Honesty contract: a named line shape is returned ONLY when its geometry
// recognizer passes against the actual board state; a tier-2/3 region
// with no recognizable shape returns 'region' (never a fabricated name),
// and a plain two-clue overlap that is not a known digit shape returns
// 'pair'. The recognizers read HIDDEN neighbors, so a caller must pass a
// board state in which the pattern's target cells are still hidden
// (mid-play in the gym; the pre-crux reconstruction in receipts). On a
// fully revealed board the recognizers find nothing and the tier-based
// fallback is used — which is correct, since there is nothing left to
// name.

import { buildNeighborCache } from './boardSolver.js';

// The number the player reads on a revealed cell.
function vis(cell) {
  return cell.displayedMines != null ? cell.displayedMines : cell.adjacentMines;
}

// A plain numeric clue the player can read as an ordinary neighbor count.
// Gimmick and liar cells display something other than their true count,
// so they never anchor a named line pattern.
function isPlainClue(cell) {
  return !!cell && cell.isRevealed && !cell.isMine
    && !cell.isSonar && !cell.isCompass && !cell.isWormhole
    && !cell.isLiar && !cell.isMystery;
}

// Hidden (unrevealed, unflagged) neighbors of a clue, as flat indices.
function hiddenNeighbors(board, cols, neighborCache, i) {
  const out = [];
  for (const ni of neighborCache[i]) {
    const cell = board[Math.floor(ni / cols)][ni % cols];
    if (!cell.isRevealed && !cell.isFlagged) out.push(ni);
  }
  return out;
}

// A single revealed clue that already has a KNOWN mine (a revealed /
// strike mine) among its neighbors — the "a flag drops the count" beat.
// Distinct from plain counting only in that the count is already reduced.
function hasKnownMineNeighbor(board, cols, neighborCache, i) {
  for (const ni of neighborCache[i]) {
    const cell = board[Math.floor(ni / cols)][ni % cols];
    if (cell.isRevealed && cell.isMine) return true;
  }
  return false;
}

const AXES = [[0, 1], [1, 0], [1, 1], [1, -1]];

// Look for a straight run of `values.length` revealed plain clues with
// exactly the given values, collinear and mutually adjacent along one
// axis, whose hidden neighbors all sit on ONE side of the clue line (the
// forcing "front"), with consecutive clues overlapping and the target
// cell among the front. This is the structural signature of the wall /
// edge 1-2-1 and 1-2-2-1 families. An incidental 1,2,1 digit run in open
// field (hidden cells on both sides of the line) fails the one-side test
// and is not named — which is the honesty guarantee.
function matchesClueLine(board, rows, cols, neighborCache, targetIdx, values) {
  const need = values.length;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const head = board[r][c];
      if (!isPlainClue(head) || vis(head) !== values[0]) continue;
      for (const [dr, dc] of AXES) {
        const clues = [r * cols + c];
        let ok = true;
        for (let k = 1; k < need; k++) {
          const pr = r + dr * k, pc = c + dc * k;
          if (pr < 0 || pr >= rows || pc < 0 || pc >= cols) { ok = false; break; }
          const idxK = pr * cols + pc;
          // Mutual adjacency must respect walls (a wall can break the line).
          if (!neighborCache[clues[k - 1]].includes(idxK)) { ok = false; break; }
          const cell = board[pr][pc];
          if (!isPlainClue(cell) || vis(cell) !== values[k]) { ok = false; break; }
          clues.push(idxK);
        }
        if (!ok) continue;

        const fronts = clues.map(ci => hiddenNeighbors(board, cols, neighborCache, ci));
        if (fronts.some(f => f.length === 0)) continue;

        // Consecutive clues must share at least one hidden square.
        let overlapOk = true;
        for (let k = 0; k < need - 1; k++) {
          const nextSet = new Set(fronts[k + 1]);
          if (!fronts[k].some(x => nextSet.has(x))) { overlapOk = false; break; }
        }
        if (!overlapOk) continue;

        // One-side test: every front cell on the same side of the line
        // through (r,c) with direction (dr,dc). cross = (R-r)*dc - (C-c)*dr;
        // zero means the cell sits ON the line (a hidden gap beside an end
        // clue), which breaks the forcing structure.
        const front = new Set();
        for (const f of fronts) for (const fi of f) front.add(fi);
        let sign = 0;
        let sideOk = true;
        for (const fi of front) {
          const fr = Math.floor(fi / cols), fc = fi % cols;
          const cross = (fr - r) * dc - (fc - c) * dr;
          if (cross === 0) { sideOk = false; break; }
          const s = cross > 0 ? 1 : -1;
          if (sign === 0) sign = s;
          else if (s !== sign) { sideOk = false; break; }
        }
        if (!sideOk) continue;

        if (front.has(targetIdx)) return true;
      }
    }
  }
  return false;
}

export function isOneTwoOne(board, rows, cols, neighborCache, targetIdx) {
  const nc = neighborCache || buildNeighborCache(board, rows, cols);
  return matchesClueLine(board, rows, cols, nc, targetIdx, [1, 2, 1]);
}

export function isOneTwoTwoOne(board, rows, cols, neighborCache, targetIdx) {
  const nc = neighborCache || buildNeighborCache(board, rows, cols);
  return matchesClueLine(board, rows, cols, nc, targetIdx, [1, 2, 2, 1]);
}

/**
 * Classify one deduction into a named pattern.
 * @param {Array} board live board (target cells still hidden)
 * @param {Object} ded  { row, col, tier, sources:[{row,col}], kind? } from
 *                       findDeducibleFrontier, or a trace entry mapped to it
 * @param {Object} opts { rows?, cols?, neighborCache? }
 * @returns {{name: string, family: string|null}}
 *   name: '1-1' | '1-2' | '1-2-1' | '1-2-2-1' | 'flag-reduction'
 *       | 'pair' (tier-1, non-canonical e.g. 2-3) | 'region' (tier-2/3,
 *       enumeration, deliberately unnamed) | 'count' (tier-0)
 */
export function classifyPattern(board, ded, opts = {}) {
  if (!ded || typeof ded.row !== 'number' || typeof ded.col !== 'number') {
    return { name: null, family: null };
  }
  const rows = opts.rows || board.length;
  const cols = opts.cols || board[0].length;
  const neighborCache = opts.neighborCache || buildNeighborCache(board, rows, cols);
  const tier = ded.tier;
  const targetIdx = ded.row * cols + ded.col;

  // Tier 0: a single clue settles it — counting, or flag-reduction when
  // that clue's count has already been dropped by a known mine.
  if (tier === 0) {
    const src = ded.sources && ded.sources[0];
    if (src) {
      const si = src.row * cols + src.col;
      if (hasKnownMineNeighbor(board, cols, neighborCache, si)) {
        return { name: 'flag-reduction', family: 'count' };
      }
    }
    return { name: 'count', family: 'count' };
  }

  // Named line geometry takes priority — it is the player's vocabulary
  // and the honest source of truth (the shape is literally on the board),
  // regardless of which tier the engine used to resolve it. Check the
  // longer shape first so a 1-2-2-1 is never mislabeled a 1-2-1.
  if (tier >= 1) {
    if (isOneTwoTwoOne(board, rows, cols, neighborCache, targetIdx)) {
      return { name: '1-2-2-1', family: '1-2' };
    }
    if (isOneTwoOne(board, rows, cols, neighborCache, targetIdx)) {
      return { name: '1-2-1', family: '1-2' };
    }
  }

  // Tier 1, no line shape: a two-clue overlap. Name the digit pair.
  if (tier === 1 && ded.sources && ded.sources.length >= 2) {
    const a = board[ded.sources[0].row]?.[ded.sources[0].col];
    const b = board[ded.sources[1].row]?.[ded.sources[1].col];
    if (isPlainClue(a) && isPlainClue(b)) {
      const d = [vis(a), vis(b)].sort((x, y) => x - y);
      if (d[0] === 1 && d[1] === 1) return { name: '1-1', family: '1-1' };
      if (d[0] === 1 && d[1] === 2) return { name: '1-2', family: '1-2' };
      return { name: 'pair', family: d[0] === d[1] ? '1-1' : '1-2' };
    }
    return { name: 'pair', family: null };
  }

  // Tier 2/3 with no recognizable shape: honest "whole region" answer.
  if (tier >= 2) return { name: 'region', family: 'enumeration' };
  return { name: 'pair', family: null };
}

/**
 * Does the board contain a teachable instance of `name` ('1-2-1' or
 * '1-2-2-1')? Scans every hidden cell for membership in that pattern's
 * forcing front. Used by lesson admission. The board must be in its
 * opening state (clues revealed, pattern targets hidden).
 */
export function boardContainsNamedPattern(board, rows, cols, name) {
  const neighborCache = buildNeighborCache(board, rows, cols);
  const fn = name === '1-2-2-1' ? isOneTwoTwoOne : isOneTwoOne;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (cell.isRevealed || cell.isFlagged) continue;
      if (fn(board, rows, cols, neighborCache, r * cols + c)) return true;
    }
  }
  return false;
}
