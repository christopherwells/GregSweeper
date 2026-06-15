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

// The 1-3-1 corner: a 3 at the concave corner of an L, with a 1 on each
// orthogonal arm (one vertical neighbor, one horizontal neighbor). The 3
// sees five hidden squares; each 1 caps a disjoint PAIR of them at one
// mine, so the single square only the 3 can see is forced to be a MINE,
// and each 1's far square (only it can see) is SAFE. It is the 1-2 logic
// bent around a corner: a modified 1-2 where the bigger clue is a 3
// seeing five cells. `kind` selects which role the target plays — the
// corner is the mine, the two outers are the safe squares.
export function isOneThreeOneCorner(board, rows, cols, neighborCache, targetIdx, kind) {
  const nc = neighborCache || buildNeighborCache(board, rows, cols);
  const at = (i) => board[Math.floor(i / cols)][i % cols];
  for (let i = 0; i < rows * cols; i++) {
    if (!isPlainClue(at(i)) || vis(at(i)) !== 3) continue;
    const H3 = new Set(hiddenNeighbors(board, cols, nc, i));
    if (H3.size < 4) continue; // a saturated 3 is plain counting, not this
    const r = Math.floor(i / cols), c = i % cols;
    // Orthogonal neighbors of the 3 that are wall-reachable.
    const inLine = (idx, rr, cc) => rr >= 0 && rr < rows && cc >= 0 && cc < cols && nc[i].includes(idx);
    const vNbrs = [];
    if (inLine((r - 1) * cols + c, r - 1, c)) vNbrs.push((r - 1) * cols + c);
    if (inLine((r + 1) * cols + c, r + 1, c)) vNbrs.push((r + 1) * cols + c);
    const hNbrs = [];
    if (inLine(r * cols + (c - 1), r, c - 1)) hNbrs.push(r * cols + (c - 1));
    if (inLine(r * cols + (c + 1), r, c + 1)) hNbrs.push(r * cols + (c + 1));
    for (const v of vNbrs) {
      if (!isPlainClue(at(v)) || vis(at(v)) !== 1) continue;
      const HV = new Set(hiddenNeighbors(board, cols, nc, v));
      for (const h of hNbrs) {
        if (!isPlainClue(at(h)) || vis(at(h)) !== 1) continue;
        const HH = new Set(hiddenNeighbors(board, cols, nc, h));
        const sharedV = [...H3].filter(x => HV.has(x));
        const sharedH = [...H3].filter(x => HH.has(x));
        if (sharedV.length === 0 || sharedH.length === 0) continue;
        if (sharedV.some(x => HH.has(x))) continue; // the two pairs must be disjoint
        const onlyThree = [...H3].filter(x => !HV.has(x) && !HH.has(x));
        if (onlyThree.length !== 1) continue;
        // The 3's squares are exactly the two shared pairs plus the corner.
        if (sharedV.length + sharedH.length + 1 !== H3.size) continue;
        if (kind === 'mine') {
          if (onlyThree[0] === targetIdx) return true;
        } else {
          const outerV = [...HV].filter(x => !H3.has(x));
          const outerH = [...HH].filter(x => !H3.has(x));
          if (outerV.includes(targetIdx) || outerH.includes(targetIdx)) return true;
        }
      }
    }
  }
  return false;
}

// Hole / triangle: the 1-1/1-2 OVERLAP read in a boxed-pocket shape. A
// revealed clue is BOXED so its only hidden neighbors are a pocket of
// exactly k cells (k=2 hole, k=3 triangle); a WIDER revealed clue (>=4
// hidden — the cell cluster the canonical 1-1/1-2 lessons never reach)
// shares that pocket, so once the boxed clue pins the pocket's mines, the
// wider clue's extra cells are all forced. We SCAN the board for this
// structure rather than read the frontier's chosen sources: the frontier
// attributes each cell to the FIRST (usually smallest) subset that proves
// it, which shadows the boxed-3 triangle behind a 2-cell subset (that is
// why a count-based read of the sources found zero triangles). Returns the
// family ('1-1' equal digits / '1-2' differ) when the target is a forced
// cell of such a structure, else null. Honest: only a genuine cA-subset-cB
// forcing (the wide clue's extra is all-safe or all-mine) matches.
function matchesPocket(board, rows, cols, neighborCache, targetIdx, k) {
  const at = (i) => board[Math.floor(i / cols)][i % cols];
  const total = rows * cols;
  for (let i = 0; i < total; i++) {
    if (!isPlainClue(at(i))) continue;
    const P = hiddenNeighbors(board, cols, neighborCache, i);
    if (P.length !== k) continue;            // boxed to exactly the pocket
    const Pset = new Set(P);
    for (let j = 0; j < total; j++) {
      if (j === i || !isPlainClue(at(j))) continue;
      const W = hiddenNeighbors(board, cols, neighborCache, j);
      if (W.length < 4) continue;            // the wider clue must be GENERIC
      if (!P.every(x => W.includes(x))) continue; // pocket ⊆ wide
      const extra = W.filter(x => !Pset.has(x));
      if (!extra.includes(targetIdx)) continue;
      // Exact constraints: mines(pocket) = box value, so mines(extra) =
      // wideValue - boxValue. The target is forced only when that is 0
      // (extra all safe) or === extra.length (extra all mines).
      const diffMines = vis(at(j)) - vis(at(i));
      if (diffMines === 0 || diffMines === extra.length) {
        return vis(at(i)) === vis(at(j)) ? '1-1' : '1-2';
      }
    }
  }
  return null;
}

export function isHole(board, rows, cols, neighborCache, targetIdx) {
  const nc = neighborCache || buildNeighborCache(board, rows, cols);
  return matchesPocket(board, rows, cols, nc, targetIdx, 2);
}

export function isTriangle(board, rows, cols, neighborCache, targetIdx) {
  const nc = neighborCache || buildNeighborCache(board, rows, cols);
  return matchesPocket(board, rows, cols, nc, targetIdx, 3);
}

// The 2-2-2 corner: a central 2 (C) adjacent to the safe target X, whose
// OTHER hidden cells (`rest`) split into two disjoint groups each forced
// to hold >=1 mine by a flanking 2. Those two groups then already hold
// C's two mines, so X is clear. Sound by construction: two disjoint
// subsets of `rest`, each lower-bounded >=1, give rest >= 2 = C's full
// count, leaving 0 for X. A flanking 2 (D) forces its share g = rest ∩
// D.hidden to >= Deff - |D.hidden \ g| (Deff = 2 minus D's revealed-mine
// neighbors); >=1 means D sees at most one cell outside g. Flags-blind
// (revealed/strike mines only), matching the gate. Names the move '2-2-2'.
export function isTwoTwoTwoCorner(board, rows, cols, neighborCache, targetIdx) {
  const nc = neighborCache || buildNeighborCache(board, rows, cols);
  const at = (i) => board[Math.floor(i / cols)][i % cols];
  const total = rows * cols;
  const knownMines = (i) => {
    let n = 0;
    for (const ni of nc[i]) { const c = at(ni); if (c.isRevealed && c.isMine) n++; }
    return n;
  };
  for (let ci = 0; ci < total; ci++) {
    if (!isPlainClue(at(ci)) || vis(at(ci)) !== 2) continue;
    const Chid = hiddenNeighbors(board, cols, nc, ci);
    if (!Chid.includes(targetIdx)) continue;
    const Ceff = 2 - knownMines(ci);
    if (Ceff < 1) continue;
    const rest = Chid.filter(x => x !== targetIdx);
    if (rest.length < Ceff) continue;
    const restSet = new Set(rest);
    // Flanking 2s and the part of `rest` each forces to >=1.
    const gs = [];
    for (let di = 0; di < total; di++) {
      if (di === ci || !isPlainClue(at(di)) || vis(at(di)) !== 2) continue;
      const Dhid = hiddenNeighbors(board, cols, nc, di);
      const g = Dhid.filter(x => restSet.has(x));
      if (g.length === 0) continue;
      const lb = (2 - knownMines(di)) - (Dhid.length - g.length);
      if (lb >= 1) gs.push(new Set(g));
    }
    // Two DISJOINT forced groups cover C's two mines inside `rest`.
    for (let a = 0; a < gs.length; a++) {
      for (let b = a + 1; b < gs.length; b++) {
        let disjoint = true;
        for (const x of gs[a]) { if (gs[b].has(x)) { disjoint = false; break; } }
        if (disjoint) return true;
      }
    }
  }
  return false;
}

/**
 * Classify one deduction into a named pattern.
 * @param {Array} board live board (target cells still hidden)
 * @param {Object} ded  { row, col, tier, sources:[{row,col}], kind? } from
 *                       findDeducibleFrontier, or a trace entry mapped to it
 * @param {Object} opts { rows?, cols?, neighborCache? }
 * @returns {{name: string, family: string|null}}
 *   name: '1-1' | '1-2' | '1-2-1' | '1-2-2-1' | '1-3-1' | 'hole' | 'triangle'
 *       | 'flag-reduction' | 'pair' (tier-1, non-canonical e.g. 2-3)
 *       | 'region' (tier-2/3, enumeration, unnamed) | 'count' (tier-0)
 */
export function classifyPattern(board, ded, opts = {}) {
  if (!ded || typeof ded.row !== 'number' || typeof ded.col !== 'number') {
    return { name: null, family: null };
  }
  const rows = opts.rows || board.length;
  const cols = opts.cols || board[0].length;
  const neighborCache = opts.neighborCache || buildNeighborCache(board, rows, cols);
  const tier = ded.tier;
  const kind = ded.kind === 'mine' ? 'mine' : 'safe';
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
    if (isOneThreeOneCorner(board, rows, cols, neighborCache, targetIdx, kind)) {
      return { name: '1-3-1', family: '1-2' };
    }
    // Boxed-pocket overlaps: triangle (3-cell pocket) checked before hole
    // (2-cell) so the rarer shape is never shadowed by the commoner one.
    const triFam = isTriangle(board, rows, cols, neighborCache, targetIdx);
    if (triFam) return { name: 'triangle', family: triFam };
    const holeFam = isHole(board, rows, cols, neighborCache, targetIdx);
    if (holeFam) return { name: 'hole', family: holeFam };
    // The 2-2-2 corner (tier-2 multi-clue) proves a safe cell only.
    if (kind === 'safe' && isTwoTwoTwoCorner(board, rows, cols, neighborCache, targetIdx)) {
      return { name: '2-2-2', family: 'enumeration' };
    }
  }

  // Tier 1, no line shape: a two-clue overlap. Name the digit pair.
  if (tier === 1 && ded.sources && ded.sources.length >= 2) {
    const a = board[ded.sources[0].row]?.[ded.sources[0].col];
    const b = board[ded.sources[1].row]?.[ded.sources[1].col];
    if (isPlainClue(a) && isPlainClue(b)) {
      // Holes/triangles (boxed-pocket overlaps) were already caught in the
      // geometry block above; here it is an ordinary adjacent pair.
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
