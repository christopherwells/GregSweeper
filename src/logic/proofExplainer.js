// ── Plain-language proof explanations ──────────────────
// Turns a deduction from findDeducibleFrontier ({row, col, tier,
// sources}) into a sentence a first-week player can follow. The
// substrate knows WHICH constraints prove a square; this module says
// WHY in plain words — no "provable", no "frontier", no "enumeration".
//
// Two styles:
//   'full'     — post-loss / post-strike surfaces, where naming the
//                answer is fine: "The 3 beside it already touches 3
//                known mines, so this square had to be clear."
//   'socratic' — the mid-game Lens, which must show WHERE to look but
//                never resolve it: "One of the highlighted numbers
//                already touches all its mines — what does that say
//                about its other neighbors?"
//
// Honesty constraint: explanations are computed the same flags-blind
// way the frontier is — "known mines" means revealed mines (strike
// cells), never player flags, so the sentence can't inherit a wrong
// flag's lie.

import { buildNeighborCache } from './boardSolver.js';

// The number the player sees on a revealed cell (liar/mirror display
// included — the explanation should reference what's on screen).
function visibleNumber(cell) {
  return cell.displayedMines != null ? cell.displayedMines : cell.adjacentMines;
}

function isGimmickClue(cell) {
  if (cell.isSonar) return 'sonar';
  if (cell.isCompass) return 'compass';
  if (cell.isWormhole) return 'wormhole';
  return null;
}

// Count, around one origin cell, what the player can SEE without
// trusting flags: revealed mines (strikes) and still-hidden squares.
function originView(board, rows, cols, origin, neighborCache) {
  const idx = origin.row * cols + origin.col;
  const nbrs = neighborCache[idx];
  let knownMines = 0;
  let hidden = 0;
  for (const ni of nbrs) {
    const cell = board[Math.floor(ni / cols)][ni % cols];
    if (cell.isRevealed && cell.isMine) knownMines++;
    else if (!cell.isRevealed) hidden++;
  }
  return { knownMines, hidden };
}

/**
 * Explain one deduction in plain words.
 * @param {Array} board live board
 * @param {Object} ded  { row, col, tier, sources } from findDeducibleFrontier
 * @param {Object} opts { style: 'full' | 'socratic', kind: 'safe' | 'mine' }
 * @returns {string|null} a sentence, or null if no honest sentence applies
 */
export function explainDeduction(board, ded, opts = {}) {
  const style = opts.style === 'socratic' ? 'socratic' : 'full';
  const kind = opts.kind === 'mine' ? 'mine' : 'safe';
  if (!ded || !Array.isArray(ded.sources) || ded.sources.length === 0) return null;
  const rows = board.length;
  const cols = board[0].length;
  const neighborCache = buildNeighborCache(board, rows, cols);

  // ── Tier 0: one number settles it ──
  if (ded.tier === 0) {
    const origin = ded.sources[0];
    const originCell = board[origin.row]?.[origin.col];
    if (!originCell) return null;
    const gimmick = isGimmickClue(originCell);
    const clue = gimmick ? `the ${gimmick} clue` : `the ${visibleNumber(originCell)}`;
    const { knownMines, hidden } = originView(board, rows, cols, origin, neighborCache);

    if (kind === 'safe') {
      // Its count is already met by known mines → everything else clear.
      if (style === 'socratic') {
        return `The highlighted clue already touches all of its mines — what does that mean for its other neighbors?`;
      }
      return gimmick
        ? `The ${gimmick} clue here is already satisfied by known mines, so this square had to be clear.`
        : `The ${visibleNumber(originCell)} beside it already touches ${knownMines} known mine${knownMines !== 1 ? 's' : ''} — every other square around it is clear.`;
    }
    // Mine: it needs exactly as many mines as it has hidden squares.
    if (style === 'socratic') {
      return `The highlighted clue needs exactly as many mines as it has hidden squares left — count them.`;
    }
    return gimmick
      ? `The ${gimmick} clue here can only be satisfied if this square is a mine.`
      : `${clue.charAt(0).toUpperCase()}${clue.slice(1)} beside it still needs ${hidden} mine${hidden !== 1 ? 's' : ''} and has exactly ${hidden} hidden square${hidden !== 1 ? 's' : ''} left — they must all be mines.`;
  }

  // ── Tier 1: two clues compared (the subset pattern) ──
  if (ded.tier === 1 && ded.sources.length >= 2) {
    const a = board[ded.sources[0].row]?.[ded.sources[0].col];
    const b = board[ded.sources[1].row]?.[ded.sources[1].col];
    const nameOf = (cell) => {
      if (!cell) return 'a clue';
      const g = isGimmickClue(cell);
      return g ? `the ${g} clue` : `the ${visibleNumber(cell)}`;
    };
    if (style === 'socratic') {
      return `Two of the highlighted clues overlap — what does subtracting one from the other leave?`;
    }
    return `Compare ${nameOf(a)} and ${nameOf(b)}: they share hidden squares, and the difference between their counts settles this one.`;
  }

  // ── Tier 2: the whole region at once ──
  if (ded.tier === 2) {
    const k = ded.sources.length;
    if (style === 'socratic') {
      return `No single clue cracks this — try mine layouts that satisfy ALL ${k} highlighted clues at once.`;
    }
    return kind === 'safe'
      ? `No single clue settles this square, but only one mine layout fits all ${k} highlighted clues at once — and in it, this square is clear.`
      : `Only one mine layout fits all ${k} highlighted clues at once — and in it, this square is a mine.`;
  }

  // ── Tier 3: the region contains a liar ──
  if (ded.tier === 3) {
    if (style === 'socratic') {
      return `One of the highlighted clues is lying by one — but even so, only certain layouts work. Test them.`;
    }
    return kind === 'safe'
      ? `Even allowing for the liar's off-by-one, every layout that fits the highlighted clues leaves this square clear.`
      : `Even allowing for the liar's off-by-one, every layout that fits the highlighted clues puts a mine here.`;
  }

  return null;
}
