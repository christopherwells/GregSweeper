// ── The board's crux: one source of truth ──────────────
// The "crux" is the first deduction, in solver order, that plain
// counting cannot reach: the first trace entry at tier >= 1. Both the
// post-win receipt (the board's confession) and the daily crux teaser
// read the crux from HERE, so the two can never disagree about which
// square it is or how hard it was.
//
//   extractCrux()      — the crux identity: which square, what tier, the
//                        proving clues, plain-language sentences, and the
//                        pre-crux board snapshot. Used by the win receipt.
//   materializeCrux()  — a self-contained mini-puzzle that re-proves the
//                        crux from a cropped, consistency-rebuilt region.
//                        The cruxes/{date} payload the precompute writes.
//   cruxPayloadFromBoard() — extract + materialize in one call (pipelines).
//
// Voice: these describe the BOARD's proof, never the player's reasoning.
// All trace entries are SAFE reveals (mines are flagged, never traced),
// so the crux is always a safe deduction — kind is always 'safe'.

import { isBoardSolvable, buildNeighborCache, findDeducibleFrontier } from './boardSolver.js';
import { explainDeduction } from './proofExplainer.js';

const rc = (i, cols) => ({ row: Math.floor(i / cols), col: i % cols });

// Teaser sizing. The crop must stay a glanceable phone-sized grid; if the
// crux's proving region is wider than this, no teaser is offered for the
// date (better none than an unreadable one).
const MINI_MAX_DIM = 9;
const RING_MIN = 1;
const RING_MAX = 3;

/**
 * Find the board's crux from a fixed first click (default: board center,
 * matching the win receipt and the feature/par solve).
 *
 * @param {Array<Array<object>>} board
 * @param {number} rows
 * @param {number} cols
 * @param {number} [firstRow]
 * @param {number} [firstCol]
 * @returns {null | {
 *   cell: {row:number, col:number},
 *   tier: 1|2|3,
 *   sources: {row:number, col:number}[],
 *   sentence: string|null,
 *   sentenceSocratic: string|null,
 *   cruxSim: Uint8Array|null,
 *   firstRow: number,
 *   firstCol: number,
 * }}
 */
export function extractCrux(board, rows, cols, firstRow, firstCol) {
  const fr = Number.isInteger(firstRow) ? firstRow : Math.floor(rows / 2);
  const fc = Number.isInteger(firstCol) ? firstCol : Math.floor(cols / 2);
  const traced = isBoardSolvable(board, rows, cols, fr, fc, undefined, {
    trace: true,
    captureCruxState: true,
  });
  if (!traced.solvable || !Array.isArray(traced.trace)) return null;
  const entry = traced.trace.find(e => e.tier >= 1);
  if (!entry) return null;

  const cell = rc(entry.cell, cols);
  const sources = (entry.sources || []).map(i => rc(i, cols));
  const ded = { row: cell.row, col: cell.col, tier: entry.tier, sources };
  const sentence = explainDeduction(board, ded, { style: 'full', kind: 'safe' });
  const sentenceSocratic = explainDeduction(board, ded, { style: 'socratic', kind: 'safe' });

  return {
    cell,
    tier: entry.tier,
    sources,
    sentence,
    sentenceSocratic,
    cruxSim: traced.cruxSim || null,
    firstRow: fr,
    firstCol: fc,
  };
}

// Build and re-verify one cropped mini-board at a fixed crop window.
// Returns the teaser geometry ({ rows, cols, cells, answer, sources }) or
// null if the answer is not provably safe (at tier >= 1) from the crop
// alone — the caller widens the ring and retries.
//
// The mini is plain minesweeper (gimmicks stripped) with walls carried
// over. Every revealed number is RECOMPUTED to count the mines actually
// shown inside the crop, so the real in-crop layout satisfies all of
// them: findDeducibleFrontier on a satisfiable system can never prove a
// false square. (Gimmick-entangled cruxes simply fail re-verification and
// the date gets no teaser.)
function _buildMini(board, rows, cols, sim, isMine, wallEdges, r0, c0, R, C, answer, sources) {
  const inCrop = (r, c) => r >= r0 && r < r0 + R && c >= c0 && c < c0 + C;

  const mini = new Array(R);
  for (let mr = 0; mr < R; mr++) {
    const row = new Array(C);
    for (let mc = 0; mc < C; mc++) {
      const r = r0 + mr, c = c0 + mc;
      const i = r * cols + c;
      const isAnswer = r === answer.row && c === answer.col;
      // Pre-crux revealed, with the answer forced back to fog (the player
      // deduces it). Flagged mines (sim===2) stay hidden — the teaser is
      // flags-blind, like every player-facing verdict.
      row[mc] = {
        row: mr,
        col: mc,
        isMine: isMine[i] === 1,
        isRevealed: sim[i] === 1 && !isAnswer,
        isFlagged: false,
        adjacentMines: 0,
        displayedMines: 0,
        isMystery: false,
        isLiar: false,
        inLiarZone: false,
        isLocked: false,
        isWormhole: false,
        isSonar: false,
        isCompass: false,
        isPressurePlate: false,
        plateDisarmed: false,
      };
    }
    mini[mr] = row;
  }

  // The teaser renders a plain OPEN grid (no wall lines), so a wall that
  // changes adjacency INSIDE the crop would leave the shown numbers
  // inconsistent with what the player can see and count. Refuse such a
  // crop: the caller widens (a wider crop only ever adds in-crop walls,
  // so it stays refused) and the date ends up with no teaser. Walls
  // OUTSIDE the crop don't affect in-crop counts, so those boards are
  // fine. (Drawing the walls in the mini, to keep walls-board cruxes, is
  // a future step.)
  if (wallEdges && wallEdges.size > 0) {
    for (const key of wallEdges) {
      const m = /^(\d+),(\d+)-(\d+),(\d+)$/.exec(key);
      if (!m) continue;
      if (inCrop(+m[1], +m[2]) && inCrop(+m[3], +m[4])) return null;
    }
  }

  // Recompute every cell's adjacency over its open-grid mini neighbors.
  const nbr = buildNeighborCache(mini, R, C);
  for (let mr = 0; mr < R; mr++) {
    for (let mc = 0; mc < C; mc++) {
      let n = 0;
      for (const ni of nbr[mr * C + mc]) {
        if (mini[Math.floor(ni / C)][ni % C].isMine) n++;
      }
      const cell = mini[mr][mc];
      cell.adjacentMines = n;
      cell.displayedMines = n;
    }
  }

  // Re-verify: the answer must be provably safe from this region alone,
  // flags-blind, and NOT by a single clue (tier >= 1) — a one-clue answer
  // would undersell the crux and clash with the sentence. (findDeducible-
  // Frontier speaks {row,col}; the payload speaks {r,c} like cells/sources.)
  const ansR = answer.row - r0, ansC = answer.col - c0;
  const frontier = findDeducibleFrontier(mini, { respectFlags: false, gateGimmickOrigins: false });
  if (frontier.contradiction) return null;
  const proven = frontier.safe.find(s => s.row === ansR && s.col === ansC);
  if (!proven || proven.tier < 1) return null;

  const cells = [];
  for (let mr = 0; mr < R; mr++) {
    for (let mc = 0; mc < C; mc++) {
      const cell = mini[mr][mc];
      if (cell.isRevealed) cells.push({ r: mr, c: mc, n: cell.displayedMines });
    }
  }
  // Source clues, remapped. These are the crux's proving clues from the
  // full-board solve, so highlighting them matches the sentence's wording.
  const srcMini = sources
    .map(p => ({ r: p.row - r0, c: p.col - c0 }))
    .filter(p => p.r >= 0 && p.r < R && p.c >= 0 && p.c < C);

  return { rows: R, cols: C, cells, answer: { r: ansR, c: ansC }, sources: srcMini };
}

/**
 * Materialize a crux into the self-contained teaser payload, or null if
 * the crux's region is too wide or cannot be re-proven once cropped and
 * stripped to plain minesweeper.
 *
 * @param {Array<Array<object>>} board
 * @param {number} rows
 * @param {number} cols
 * @param {object} crux  the result of extractCrux()
 * @returns {null | {
 *   rows:number, cols:number,
 *   cells:{r:number,c:number,n:number}[],
 *   answer:{r:number,c:number},
 *   sources:{r:number,c:number}[],
 *   tier:number,
 *   sentence:string|null,
 *   sentenceSocratic:string|null,
 * }}
 */
export function materializeCrux(board, rows, cols, crux) {
  if (!crux || !crux.cruxSim || !Array.isArray(crux.sources) || crux.sources.length === 0) {
    return null;
  }
  const sim = crux.cruxSim;
  const answer = crux.cell;
  const sources = crux.sources;

  const total = rows * cols;
  const isMine = new Uint8Array(total);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (board[r][c].isMine) isMine[r * cols + c] = 1;
    }
  }
  const wallEdges = board._wallEdges instanceof Set ? board._wallEdges : null;

  // Anchor box: every source clue plus the answer.
  let minR = answer.row, maxR = answer.row, minC = answer.col, maxC = answer.col;
  for (const s of sources) {
    if (s.row < minR) minR = s.row;
    if (s.row > maxR) maxR = s.row;
    if (s.col < minC) minC = s.col;
    if (s.col > maxC) maxC = s.col;
  }

  // Widen the ring until the answer re-proves (cropping can sever a
  // constraint the proof needed), capped at a phone-sized grid.
  for (let ring = RING_MIN; ring <= RING_MAX; ring++) {
    const r0 = Math.max(0, minR - ring);
    const r1 = Math.min(rows - 1, maxR + ring);
    const c0 = Math.max(0, minC - ring);
    const c1 = Math.min(cols - 1, maxC + ring);
    const R = r1 - r0 + 1;
    const C = c1 - c0 + 1;
    if (R > MINI_MAX_DIM || C > MINI_MAX_DIM) break;
    const mini = _buildMini(board, rows, cols, sim, isMine, wallEdges, r0, c0, R, C, answer, sources);
    if (mini) {
      return {
        ...mini,
        tier: crux.tier,
        sentence: crux.sentence,
        sentenceSocratic: crux.sentenceSocratic,
      };
    }
  }
  return null;
}

/**
 * Extract + materialize in one call. Returns the cruxes/{date} payload
 * (sans writtenAt, which the writer stamps server-side) or null.
 */
export function cruxPayloadFromBoard(board, rows, cols, firstRow, firstCol) {
  const crux = extractCrux(board, rows, cols, firstRow, firstCol);
  if (!crux) return null;
  return materializeCrux(board, rows, cols, crux);
}
