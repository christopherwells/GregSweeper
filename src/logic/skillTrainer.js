import { safeGet, safeSet, safeGetJSON, safeSetJSON } from '../storage/storageAdapter.js?v=1.0';
// ── Skill Trainer Data ────────────────────────────────
// 21 lessons (5 beginner, 5 intermediate, 5 advanced, 6 modifiers)
// with hand-crafted puzzles teaching minesweeper techniques.

const SKILL_PROGRESS_KEY = 'minesweeper_skill_progress';

// ── Board/Puzzle Builder ──────────────────────────────
// Computes adjacency numbers automatically from mine positions.
// Cell format: { state: 'unrevealed'|'revealed'|'flagged', value: number }

function buildPuzzle(rows, cols, mines, revealed, flagged, moves, hint) {
  const ms = new Set(mines.map(([r, c]) => r * 100 + c));
  const rs = new Set(revealed.map(([r, c]) => r * 100 + c));
  const fs = new Set(flagged.map(([r, c]) => r * 100 + c));

  function adj(r, c) {
    let n = 0;
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && ms.has(nr * 100 + nc)) n++;
      }
    return n;
  }

  const board = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      const k = r * 100 + c;
      const isMine = ms.has(k);
      const value = isMine ? -1 : adj(r, c);
      if (fs.has(k)) row.push({ state: 'flagged', isMine, value });
      else if (rs.has(k)) row.push({ state: 'revealed', isMine, value });
      else row.push({ state: 'unrevealed', isMine, value });
    }
    board.push(row);
  }

  const correctMoves = moves.map(([r, c, action]) => {
    const m = { row: r, col: c, action };
    if (action === 'reveal') m.value = adj(r, c);
    return m;
  });

  return { board, correctMoves, hint };
}

function allExcept(rows, cols, ...excludeLists) {
  const ex = new Set();
  for (const list of excludeLists)
    for (const [r, c] of list) ex.add(r * 100 + c);
  const res = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (!ex.has(r * 100 + c)) res.push([r, c]);
  return res;
}

// ── Lesson Definitions ────────────────────────────────

const LESSONS = [
  // ═════════════════════ BEGINNER ═════════════════════
  {
    id: 'basic-counting',
    name: 'Basic Counting',
    category: 'Beginner',
    description: 'Learn what the numbers mean.',
    explanation: 'Each number tells you how many mines are in the 8 cells surrounding it (including diagonals). A 1 means exactly one mine nearby, a 2 means two, and so on.',
    puzzles: [
      // 2×2: simplest possible — one mine, one flag
      buildPuzzle(2, 2, [[0,1]], allExcept(2,2,[[0,1]]), [], [[0,1,'flag']], 'The 1 touches only one hidden cell — that must be the mine. Right-click (or long-press) to flag it!'),
      // 2×2: same concept, different position
      buildPuzzle(2, 2, [[1,0]], allExcept(2,2,[[1,0]]), [], [[1,0,'flag']], 'Find the 1 next to the hidden cell. Right-click to flag the mine!'),
      // 3×3: two flags, zero blanks
      buildPuzzle(3, 3, [[0,1],[2,1]], allExcept(3,3,[[0,1],[2,1]]), [], [[0,1,'flag'],[2,1,'flag']], 'Each 1 touches only one hidden cell. Flag both!'),
      // 2×4: wider board, two flags, zero blanks
      buildPuzzle(2, 4, [[0,0],[0,3]], allExcept(2,4,[[0,0],[0,3]]), [], [[0,0,'flag'],[0,3,'flag']], 'Edge cells have fewer neighbors. Each corner 1 only touches one hidden cell.'),
      // 3×4: three flags, zero blanks
      buildPuzzle(3, 4, [[0,0],[1,3],[2,0]], allExcept(3,4,[[0,0],[1,3],[2,0]]), [], [[0,0,'flag'],[1,3,'flag'],[2,0,'flag']], 'Start with the most constrained numbers — the ones with fewest hidden neighbors.'),
    ],
  },
  {
    id: 'flag-reveal',
    name: 'Flag and Reveal',
    category: 'Beginner',
    description: 'Learn when hidden cells are safe to click.',
    explanation: 'When a number\'s mines are all flagged, its other hidden neighbors are guaranteed safe. Click them to reveal! This is one of the most important skills in Minesweeper.',
    puzzles: [
      // 2×3: one flag placed, reveal the safe cell
      buildPuzzle(2, 2, [[0,0]], [[1,0]], [[0,0]], [[0,1,'reveal'],[1,1,'reveal']], 'The 1 already has its mine flagged. All other hidden neighbors must be safe — click them!'),
      // 3×3: two flags placed, reveal safe cell
      buildPuzzle(3, 3, [[0,1],[2,1]], allExcept(3,3,[[0,1],[2,1],[2,2]]), [[0,1],[2,1]], [[2,2,'reveal']], 'Both flags satisfy the nearby 2s. The remaining hidden cell must be safe!'),
      // 2×4: flags on both sides, reveal safe cell in the middle
      buildPuzzle(2, 4, [[0,0],[1,3]], allExcept(2,4,[[0,0],[1,2],[1,3]]), [[0,0],[1,3]], [[1,2,'reveal']], 'Both flags satisfy the 1s nearby. The remaining hidden cell must be safe!'),
      // 3×3: flag then reveal chain (different mine pattern)
      buildPuzzle(3, 3, [[1,0],[1,2]], allExcept(3,3,[[1,0],[1,2],[2,0]]), [[1,2]], [[1,0,'flag'],[2,0,'reveal']], 'The corner 1 pins the mine — flag it! Then the 2 below is fully satisfied, making its hidden neighbor safe.'),
      // 4×4: multi-step capstone
      buildPuzzle(4, 4, [[0,0],[0,3],[2,0],[3,3]], allExcept(4,4,[[0,0],[0,3],[2,0],[3,2],[3,3]]), [[0,0],[3,3]], [[0,3,'flag'],[2,0,'flag'],[3,2,'reveal']], 'Work from the edges — each 1 with one hidden neighbor pins a mine. Flag them, then the safe cell reveals itself!'),
    ],
  },
  {
    id: 'narrowing-down',
    name: 'Narrowing It Down',
    category: 'Beginner',
    description: 'Use one number to help solve another.',
    explanation: 'When a number has more hidden neighbors than its value, you can\'t flag yet. But another number nearby might have fewer possibilities — use it to eliminate candidates and find safe cells.',
    puzzles: [
      // 2×3: one number pins the mine, making the other cell safe
      buildPuzzle(2, 3, [[0,0],[1,2]], allExcept(2,3,[[0,0],[0,2],[1,2]]), [[1,2]], [[0,2,'reveal']], 'The bottom-left 1 only touches one hidden cell — that pins the mine. The other hidden cell is safe!'),
      // 2×3: mirrored
      buildPuzzle(2, 3, [[0,2],[1,0]], allExcept(2,3,[[0,0],[0,2],[1,0]]), [[1,0]], [[0,0,'reveal']], 'The bottom-right 1 tells you which hidden cell is the mine. The other is safe.'),
      // 3×3: use edge 1 to clear an ambiguous cell
      buildPuzzle(3, 3, [[0,1],[2,1]], allExcept(3,3,[[0,1],[2,0],[2,1]]), [[0,1]], [[2,0,'reveal']], 'The bottom-right 1 only touches one hidden cell — that\'s the mine. So the other is safe.'),
      // 3×3: two flags placed, find the safe cell
      buildPuzzle(3, 3, [[0,1],[2,0],[2,2]], allExcept(3,3,[[0,1],[2,0],[2,1],[2,2]]), [[0,1],[2,2]], [[2,1,'reveal']], 'The bottom-right 2 is already satisfied by both flags. Its hidden neighbor must be safe!'),
      // 2×4: flag satisfies a 1, clearing cells further away
      buildPuzzle(2, 4, [[0,0],[1,3]], allExcept(2,4,[[0,0],[0,2],[0,3],[1,3]]), [[1,3]], [[0,2,'reveal'],[0,3,'reveal']], 'The 1 next to the flag is satisfied — its other hidden neighbors are safe!'),
    ],
  },
  {
    id: 'chord-clicking',
    name: 'Chord Clicking',
    category: 'Beginner',
    description: 'Use satisfied numbers to clear cells fast.',
    explanation: 'When a number has all its mines flagged, every other hidden neighbor is safe. In the real game, clicking that number auto-reveals them all — this is called "chording"!',
    puzzles: [
      // 2×3: simple chord from a satisfied 1
      buildPuzzle(2, 3, [[0,0]], allExcept(2,3,[[0,0],[0,2]]), [[0,0]], [[0,2,'reveal']], 'The 1's mine is flagged. Click the 1 to chord — it reveals all safe neighbors!'),
      // 3×3: chord a satisfied 2
      buildPuzzle(3, 3, [[0,1],[2,1]], allExcept(3,3,[[0,1],[0,2],[1,2],[2,1]]), [[0,1],[2,1]], [[0,2,'reveal'],[1,2,'reveal']], 'The 2 has both mines flagged. All its hidden neighbors are safe!'),
      // 2×4: chord two satisfied 1s
      buildPuzzle(2, 4, [[0,0],[0,3]], allExcept(2,4,[[0,0],[0,3],[1,0],[1,3]]), [[0,0],[0,3]], [[1,0,'reveal'],[1,3,'reveal']], 'Both middle 1s are satisfied by flags. Their hidden neighbors are safe!'),
      // 3×3: flag then chord
      buildPuzzle(3, 3, [[0,1],[2,1]], allExcept(3,3,[[0,1],[2,0],[2,1],[2,2]]), [[0,1]], [[2,1,'flag'],[2,0,'reveal'],[2,2,'reveal']], 'Two 2s both need a mine in the bottom row. Which cell do they share? Then the rest are safe!'),
      // 3×3: chord from both sides
      buildPuzzle(3, 3, [[1,0],[1,2]], allExcept(3,3,[[0,0],[1,0],[1,2],[2,2]]), [[1,0],[1,2]], [[0,0,'reveal'],[2,2,'reveal']], 'The 2s in the middle column are fully satisfied. Their hidden neighbors are all safe!'),
    ],
  },
  {
    id: 'putting-together',
    name: 'Putting It All Together',
    category: 'Beginner',
    description: 'Combine everything to solve multi-step puzzles.',
    explanation: 'Use all the skills you\'ve learned — counting, flagging, finding safe cells, and chording — to solve puzzles that require multiple steps. Start with the most constrained numbers and work outward!',
    puzzles: [
      // 3×3: flag two, then reveal one
      buildPuzzle(3, 3, [[0,1],[2,1]], allExcept(3,3,[[0,1],[1,2],[2,1]]), [], [[0,1,'flag'],[2,1,'flag'],[1,2,'reveal']], 'Start with numbers that have only one hidden neighbor. Then the satisfied 2 reveals a safe cell.'),
      // 3×3: chain flag → flag → reveal
      buildPuzzle(3, 3, [[0,1],[1,0],[2,2]], allExcept(3,3,[[0,0],[0,1],[1,0],[2,2]]), [[2,2]], [[1,0,'flag'],[0,1,'flag'],[0,0,'reveal']], 'Start at the bottom edge. Each flag gives you info for the next step.'),
      // 3×3: flag edges, chord corners (4 moves)
      buildPuzzle(3, 3, [[1,0],[1,2]], allExcept(3,3,[[0,0],[1,0],[1,2],[2,2]]), [], [[1,2,'flag'],[1,0,'flag'],[0,0,'reveal'],[2,2,'reveal']], 'The corner 1s each pin down a mine. Then the satisfied 2s clear the rest.'),
      // 3×3: flag + reveal with pre-flag (3 moves)
      buildPuzzle(3, 3, [[1,0],[1,2]], allExcept(3,3,[[0,0],[1,0],[1,2],[2,2]]), [[1,0]], [[1,2,'flag'],[0,0,'reveal'],[2,2,'reveal']], 'Flag the mine the corner 1 points to. Then the satisfied 2s clear the remaining cells.'),
      // 3×4: five-step domino chain
      buildPuzzle(3, 4, [[0,0],[1,3],[2,0]], allExcept(3,4,[[0,0],[0,1],[1,3],[2,0],[2,2]]), [], [[1,3,'flag'],[2,2,'reveal'],[2,0,'flag'],[0,1,'reveal'],[0,0,'flag']], 'Start at the edges where numbers are most constrained. Each step unlocks the next.'),
    ],
  },

  // ═════════════════════ INTERMEDIATE ═════════════════════
  {
    id: 'pattern-1-1',
    name: 'The 1-1 Pattern',
    category: 'Intermediate',
    description: 'Recognize the 1-1 wall pattern.',
    explanation: 'Two 1s next to each other along a wall: the mine must be beside one of them. Any cell beyond the far end of the pair is guaranteed safe to reveal.',
    puzzles: [
      buildPuzzle(2, 4, [[0,0]], [[1,0],[1,1],[1,2],[1,3]], [], [[0,2,'reveal'],[0,3,'reveal']], 'The mine is next to one of the 1s. Cells past the pair can\'t be mines.'),
      buildPuzzle(2, 4, [[0,3]], [[1,0],[1,1],[1,2],[1,3]], [], [[0,0,'reveal'],[0,1,'reveal']], 'Same pattern, opposite direction. Cells past the pair are safe.'),
      buildPuzzle(3, 2, [[0,0]], [[0,1],[1,1],[2,1]], [], [[2,0,'reveal']], 'The 1-1 pattern works vertically too!'),
      buildPuzzle(2, 5, [[0,1]], [[1,0],[1,1],[1,2],[1,3],[1,4]], [], [[0,3,'reveal'],[0,4,'reveal']], 'Find the 1-1 pair and reveal the cells beyond them.'),
      buildPuzzle(2, 5, [[0,0],[0,4]], [[1,0],[1,1],[1,2],[1,3],[1,4]], [], [[0,2,'reveal']], 'Two 1-1 pairs from each end — the cell in the middle is safe.'),
    ],
  },
  {
    id: 'pattern-1-2',
    name: 'The 1-2 Pattern',
    category: 'Intermediate',
    description: 'Recognize the 1-2 wall pattern.',
    explanation: 'A 1 next to a 2 along a wall: the 2 needs one more mine than the 1. The extra mine must be on the 2\'s far side, away from the 1.',
    puzzles: [
      buildPuzzle(2, 4, [[0,0],[0,2]], [[1,0],[1,1],[1,2],[1,3]], [], [[0,2,'flag']], 'The 2 needs one more mine than the 1. That extra mine is on the 2\'s outer side.'),
      buildPuzzle(2, 4, [[0,1],[0,3]], [[1,0],[1,1],[1,2],[1,3]], [], [[0,0,'reveal']], 'The 1 on the edge tells you the corner cell is safe to reveal.'),
      buildPuzzle(2, 5, [[0,0],[0,2]], [[1,0],[1,1],[1,2],[1,3],[1,4]], [], [[0,3,'reveal'],[0,4,'reveal']], 'The mines are near the 1-2 pair. Cells beyond are safe.'),
      buildPuzzle(2, 5, [[0,0],[0,1]], [[1,0],[1,1],[1,2],[1,3],[1,4]], [], [[0,3,'reveal'],[0,4,'reveal']], 'The 1-2 constraint pins the mines to one side. Far cells are safe.'),
      buildPuzzle(2, 4, [[0,0],[0,1]], [[1,0],[1,1],[1,2],[1,3],[0,2],[0,3]], [], [[0,0,'flag'],[0,1,'flag']], 'The 2 in the corner needs 2 mines among its hidden neighbors. Flag them both!'),
    ],
  },
  {
    id: 'wall-logic',
    name: 'Wall & Edge Logic',
    category: 'Intermediate',
    description: 'Use board boundaries as extra clues.',
    explanation: 'The board edge limits where mines can hide. A number near a wall has fewer hidden neighbors, making it much easier to figure out which cells are mines.',
    puzzles: [
      buildPuzzle(2, 3, [[0,0]], [[0,1],[0,2],[1,0],[1,1],[1,2]], [], [[0,0,'flag']], 'The 1 in the corner only has one hidden neighbor — it must be the mine.'),
      buildPuzzle(2, 4, [[0,1]], [[0,0],[0,2],[0,3],[1,0],[1,1],[1,2],[1,3]], [], [[0,1,'flag']], 'The 1 on the top edge touches only one hidden cell.'),
      buildPuzzle(2, 3, [[1,1]], [[0,0],[0,1],[0,2],[1,0],[1,2]], [], [[1,1,'flag']], 'The 1 on the bottom edge has only one hidden neighbor — flag it!'),
      buildPuzzle(3, 2, [[1,0]], [[0,0],[0,1],[1,1],[2,0],[2,1]], [], [[1,0,'flag']], 'The left wall limits this number\'s neighbors. Only one cell is hidden.'),
      buildPuzzle(2, 3, [[0,0],[1,1]], [[0,1],[0,2],[1,0],[1,2]], [], [[0,0,'flag'],[1,1,'flag']], 'The 2 in the corner has exactly 2 hidden neighbors. Both are mines!'),
    ],
  },
  {
    id: 'corner-deduction',
    name: 'Corner Deduction',
    category: 'Intermediate',
    description: 'Solve corners quickly and easily.',
    explanation: 'Corner cells have only 3 neighbors. A corner 1 instantly tells you which cell is a mine. A corner 2 means two of its three neighbors are mines. Always check corners first!',
    puzzles: [
      buildPuzzle(2, 3, [[1,0]], [[0,0],[0,1],[0,2],[1,1],[1,2]], [], [[1,0,'flag']], 'The 1 in the top-left corner has only one hidden neighbor. Flag it!'),
      buildPuzzle(3, 3, [[0,1],[1,0]], [[0,0],[0,2],[1,1],[1,2],[2,0],[2,1],[2,2]], [], [[0,1,'flag'],[1,0,'flag']], 'The 2 in the corner has 3 neighbors, and 2 are hidden — both must be mines!'),
      buildPuzzle(4, 4, [[0,1],[3,2]], [[0,0],[0,2],[0,3],[1,0],[1,1],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3],[3,0],[3,1],[3,3]], [], [[0,1,'flag'],[3,2,'flag']], 'Use corner logic at two different corners to find both mines.'),
      buildPuzzle(4, 4, [[0,1],[1,3]], [[0,0],[0,2],[0,3],[1,0],[1,1],[1,2],[2,0],[2,1],[2,2],[2,3],[3,0],[3,1],[3,2],[3,3]], [], [[0,1,'flag'],[1,3,'flag']], 'Solve one corner first, then use what you learn for the next.'),
      buildPuzzle(2, 5, [[0,1],[1,4]], [[0,0],[0,2],[0,3],[0,4],[1,0],[1,1],[1,2],[1,3]], [], [[0,1,'flag'],[1,4,'flag']], 'Combine corner and edge clues to find both mines.'),
    ],
  },
  {
    id: 'reduction',
    name: 'Reduction Technique',
    category: 'Intermediate',
    description: 'Subtract flags to find new information.',
    explanation: 'When a number already has some mines flagged around it, subtract the flags from the number. The reduced count tells you how many mines remain among the unflagged hidden neighbors.',
    puzzles: [
      buildPuzzle(3, 3, [[0,0],[0,2]], allExcept(3,3,[[0,0],[0,2]]), [[0,0]], [[0,2,'flag']], 'The 2 already has 1 flag nearby. It still needs 1 more mine — find it!'),
      buildPuzzle(3, 4, [[0,0],[0,1],[0,3]], allExcept(3,4,[[0,0],[0,1],[0,3]]), [[0,0],[0,1]], [[0,3,'flag']], 'The 3 has 2 flags nearby. 3 minus 2 = 1 mine left to find.'),
      buildPuzzle(3, 4, [[0,0],[0,3]], allExcept(3,4,[[0,0],[0,3],[2,1]]), [[0,0]], [[2,1,'reveal']], 'The flag satisfies the nearby number. Remaining hidden cells are safe — reveal them!'),
      buildPuzzle(3, 4, [[0,0],[0,3]], allExcept(3,4,[[0,0],[0,3],[2,3]]), [[0,0]], [[2,3,'reveal']], 'Subtract the flag, then check what the reduced number tells you.'),
      buildPuzzle(3, 4, [[0,0],[0,3],[2,1]], allExcept(3,4,[[0,0],[0,3],[2,1]]), [[0,0],[0,3]], [[2,1,'flag']], 'Two flags are down. Subtract them from the numbers to find the last mine.'),
    ],
  },

  // ═════════════════════ ADVANCED ═════════════════════
  {
    id: 'subset-superset',
    name: 'Subset / Superset',
    category: 'Advanced',
    description: 'Compare overlapping number clues.',
    explanation: 'When two numbers share some hidden neighbors, compare them. If one number\'s hidden cells are entirely within another\'s group, subtract the smaller from the larger to learn about the leftover cells.',
    puzzles: [
      buildPuzzle(3, 5, [[0,0],[0,3]], [[1,0],[1,1],[1,2],[1,3],[1,4],[2,0],[2,1],[2,2],[2,3],[2,4]], [], [[0,4,'reveal']], 'The 1\'s hidden cells are entirely within the 2\'s group. The cell outside must be safe.'),
      buildPuzzle(3, 5, [[0,1],[0,4]], [[1,0],[1,1],[1,2],[1,3],[1,4],[2,0],[2,1],[2,2],[2,3],[2,4]], [], [[0,0,'reveal']], 'Compare the two numbers. The cell outside their overlap is safe.'),
      buildPuzzle(2, 5, [[0,0],[0,3]], [[1,0],[1,1],[1,2],[1,3],[1,4]], [], [[0,4,'reveal']], 'The far-right cell isn\'t covered by the smaller constraint — it\'s safe.'),
      buildPuzzle(2, 6, [[0,0],[0,4]], [[1,0],[1,1],[1,2],[1,3],[1,4],[1,5]], [], [[0,5,'reveal']], 'Cells outside the overlapping constraint zone are guaranteed safe.'),
      buildPuzzle(2, 5, [[0,0],[0,1],[0,4]], [[1,0],[1,1],[1,2],[1,3],[1,4]], [], [[0,4,'flag']], 'Subtracting the subset from the superset reveals: the leftover cell is a mine!'),
    ],
  },
  {
    id: 'coupled-constraints',
    name: 'Coupled Constraints',
    category: 'Advanced',
    description: 'Combine clues from multiple numbers.',
    explanation: 'Sometimes no single number gives the answer. Link information from several numbers: what one number tells you about shared cells can unlock deductions for another.',
    puzzles: [
      buildPuzzle(2, 5, [[0,0],[0,4]], [[1,0],[1,1],[1,2],[1,3],[1,4]], [], [[0,2,'reveal']], 'No single number solves this. Combine what both 1s tell you about the middle cell.'),
      buildPuzzle(2, 5, [[0,0],[0,2]], [[1,0],[1,1],[1,2],[1,3],[1,4]], [], [[0,4,'reveal']], 'Chain deductions along the wall to find the safe cell at the end.'),
      buildPuzzle(4, 4, [[0,0],[2,3]], [[1,0],[1,1],[0,1],[0,2],[0,3],[1,2],[1,3],[2,0],[2,1],[2,2],[3,0],[3,1],[3,2],[3,3]], [], [[0,0,'flag'],[2,3,'flag']], 'Two separate number groups each point to a different mine.'),
      buildPuzzle(2, 5, [[0,1],[0,3]], [[1,0],[1,1],[1,2],[1,3],[1,4]], [], [[0,0,'reveal'],[0,4,'reveal']], 'The coupled 1s along the wall pin the mines inward — the ends are safe!'),
      buildPuzzle(4, 5, [[0,0],[0,4],[3,2]], allExcept(4,5,[[0,0],[0,4],[3,2]]), [], [[0,0,'flag'],[0,4,'flag'],[3,2,'flag']], 'Use multiple number groups together to locate all three mines.'),
    ],
  },
  {
    id: 'probability',
    name: 'Probability Thinking',
    category: 'Advanced',
    description: 'Choose the safest cell when guessing.',
    explanation: 'When pure logic isn\'t enough, pick the cell least likely to be a mine. Cells far from numbers, or in larger groups of unknowns, are usually safer choices.',
    puzzles: [
      buildPuzzle(3, 3, [[0,0]], [[0,2],[1,0],[1,1],[1,2],[2,0],[2,1],[2,2]], [], [[0,1,'reveal']], 'Two hidden cells, one mine. Which is less likely? Pick the safer bet.'),
      buildPuzzle(2, 4, [[0,0]], [[1,0],[1,1],[1,2],[1,3]], [], [[0,2,'reveal'],[0,3,'reveal']], 'One mine among many hidden cells. The further from the 1, the safer.'),
      buildPuzzle(4, 4, [[0,0],[3,3]], [[1,0],[1,1],[0,1],[0,2],[0,3],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3],[3,0],[3,1],[3,2]], [], [[0,0,'flag'],[3,3,'flag']], 'Numbers with few hidden neighbors give the strongest clues. Start there.'),
      buildPuzzle(2, 5, [[0,0]], [[1,0],[1,1],[1,2],[1,3],[1,4]], [], [[0,3,'reveal'],[0,4,'reveal']], 'Cells far from the constraint are least likely to be mines.'),
      buildPuzzle(4, 5, [[2,2]], [[1,1],[1,2],[1,3],[2,1],[2,3],[3,1],[3,2],[3,3],[0,0],[0,4]], [], [[0,1,'reveal'],[0,2,'reveal'],[0,3,'reveal']], 'The mine is surrounded by numbers in the center. Far-away cells are safe.'),
    ],
  },
  {
    id: 'endgame',
    name: 'Endgame Strategies',
    category: 'Advanced',
    description: 'Close out the last few cells.',
    explanation: 'Near the end of a game, count remaining mines vs. remaining hidden cells. If they\'re equal, flag them all! If zero mines remain, reveal everything. Watch the mine counter!',
    puzzles: [
      buildPuzzle(3, 3, [[2,2]], allExcept(3,3,[[2,2]]), [], [[2,2,'flag']], 'One mine left, one hidden cell. It has to be the mine — flag it!'),
      buildPuzzle(3, 3, [[0,0]], allExcept(3,3,[[0,0],[2,1],[2,2]]), [[0,0]], [[2,1,'reveal'],[2,2,'reveal']], 'All mines are flagged (mine counter shows 0). Every remaining cell is safe!'),
      buildPuzzle(4, 4, [[3,0],[3,3]], allExcept(4,4,[[3,0],[3,3]]), [], [[3,0,'flag'],[3,3,'flag']], 'Two mines remaining, two hidden cells. Flag both!'),
      buildPuzzle(4, 4, [[3,1]], allExcept(4,4,[[3,0],[3,1],[3,2]]), [], [[3,0,'reveal'],[3,2,'reveal']], 'One mine among three cells. Use the numbers to figure out which ones are safe.'),
      buildPuzzle(2, 5, [[1,0],[1,4]], allExcept(2,5,[[1,0],[1,1],[1,3],[1,4]]), [], [[1,1,'reveal'],[1,3,'reveal']], 'Two mines in four cells. The numbers tell you which two are safe.'),
    ],
  },
  {
    id: 'speed-techniques',
    name: 'Speed Techniques',
    category: 'Advanced',
    description: 'Solve faster with pattern recognition.',
    explanation: 'Speed comes from recognizing patterns instantly: flag obvious corner mines without hesitation, chord to reveal multiple cells at once, and always work from the edges inward.',
    puzzles: [
      buildPuzzle(4, 4, [[0,0]], [[0,1],[0,2],[0,3],[1,0],[1,1],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3]], [], [[0,0,'flag']], 'Corner 1 with one hidden neighbor = instant flag. Don\'t hesitate!'),
      buildPuzzle(2, 5, [[0,0],[0,4]], [[0,1],[0,2],[0,3],[1,0],[1,1],[1,2],[1,3],[1,4]], [], [[0,0,'flag'],[0,4,'flag']], 'Two corner mines — recognize and flag both instantly!'),
      buildPuzzle(3, 3, [[0,0]], allExcept(3,3,[[0,0],[2,1],[2,2]]), [], [[0,0,'flag']], 'Flag the obvious mine first, then chord nearby numbers to clear fast.'),
      buildPuzzle(4, 3, [[0,1],[3,1]], [[0,0],[0,2],[1,0],[1,1],[1,2],[2,0],[2,1],[2,2],[3,0],[3,2]], [], [[0,1,'flag'],[3,1,'flag']], 'Start at the edges where constraints are strongest. Flag both edge mines!'),
      buildPuzzle(3, 3, [[0,0],[2,2]], [[0,1],[0,2],[1,0],[1,1],[1,2],[2,0],[2,1]], [], [[0,0,'flag'],[2,2,'flag']], 'Two corner 1s — instant pattern recognition. Flag both without thinking!'),
    ],
  },

  // ═════════════════════ MODIFIERS ═════════════════════

  {
    id: 'mod-mystery',
    name: 'Mystery Cells',
    category: 'Modifiers',
    description: 'Learn to play around hidden numbers.',
    explanation: 'Mystery cells show "?" instead of their number. The cell is safe \u2014 it just won\'t tell you its count. Use surrounding non-mystery numbers to deduce where mines are.',
    puzzles: (() => {
      // 3x3, mine at (0,2). (0,1) is mystery (real adj=1).
      const p1 = buildPuzzle(3, 3, [[0,2]], allExcept(3,3,[[0,2]]), [], [[0,2,'flag']], 'Ignore the "?" \u2014 the regular 1 next to the hidden cell tells you where the mine is.');
      p1.board[0][1].mystery = true;

      // 3x3, mine at (2,0). (1,1) is mystery.
      const p2 = buildPuzzle(3, 3, [[2,0]], allExcept(3,3,[[2,0]]), [], [[2,0,'flag']], 'The "?" hides a number, but the other 1s point to the mine.');
      p2.board[1][1].mystery = true;

      // 3x4, mine at (0,3). (0,2) and (1,2) are mystery.
      const p3 = buildPuzzle(3, 4, [[0,3]], allExcept(3,4,[[0,3]]), [], [[0,3,'flag']], 'Two mystery cells! Focus on the regular numbers to find the mine.');
      p3.board[0][2].mystery = true;
      p3.board[1][2].mystery = true;

      return [p1, p2, p3];
    })(),
  },
  {
    id: 'mod-locked',
    name: 'Locked Cells',
    category: 'Modifiers',
    description: 'Work around cells you can\'t open yet.',
    explanation: 'Locked cells can\'t be revealed until all 8 neighbors are revealed. Don\'t try to click them \u2014 solve the rest of the board first, then they\'ll unlock on their own.',
    puzzles: (() => {
      // 3x3, mine at (0,0). Center is locked.
      const p1 = buildPuzzle(3, 3, [[0,0]], [[0,1],[0,2],[1,0],[1,2],[2,0],[2,1],[2,2]], [], [[0,0,'flag']], 'The locked cell can\'t help you yet. Use the 1 next to the hidden cell!');
      p1.board[1][1].locked = true;

      // 3x3, mine at (0,2). Center is locked.
      const p2 = buildPuzzle(3, 3, [[0,2]], [[0,0],[0,1],[1,0],[1,2],[2,0],[2,1],[2,2]], [], [[0,2,'flag']], 'Work around the lock. The edge 1s point to the mine.');
      p2.board[1][1].locked = true;

      // 3x4, mine at (0,3). (1,2) locked.
      const p3 = buildPuzzle(3, 4, [[0,3]], [[0,0],[0,1],[0,2],[1,0],[1,1],[1,3],[2,0],[2,1],[2,2],[2,3]], [], [[0,3,'flag']], 'Locked cell blocks access, but nearby numbers reveal the mine.');
      p3.board[1][2].locked = true;

      return [p1, p2, p3];
    })(),
  },
  {
    id: 'mod-liar',
    name: 'Liar Cells',
    category: 'Modifiers',
    description: 'Spot numbers that lie by \u00b11.',
    explanation: 'Liar cells show a number off by exactly 1 \u2014 either too high or too low. They\'re marked with an orange border. Trust the regular numbers and use them to figure out the liar\'s true value.',
    puzzles: (() => {
      // 3x3, mine at (0,2). (0,1) is liar showing 2 (real: 1).
      const p1 = buildPuzzle(3, 3, [[0,2]], allExcept(3,3,[[0,2]]), [], [[0,2,'flag']], 'The orange 2 is lying \u2014 it\'s really 1. The regular 1 tells the truth!');
      p1.board[0][1].liar = true;
      p1.board[0][1].value = 2;

      // 3x3, mine at (2,2). (1,2) is liar showing 0 (real: 1).
      const p2 = buildPuzzle(3, 3, [[2,2]], allExcept(3,3,[[2,2]]), [], [[2,2,'flag']], 'The liar shows 0, but it\'s really 1. Regular numbers confirm the mine.');
      p2.board[1][2].liar = true;
      p2.board[1][2].value = 0;

      // 3x4, mine at (0,0). (0,1) is liar showing 2 (real: 1).
      const p3 = buildPuzzle(3, 4, [[0,0]], allExcept(3,4,[[0,0]]), [], [[0,0,'flag']], 'Don\'t trust the orange number! Regular 1s point to the mine.');
      p3.board[0][1].liar = true;
      p3.board[0][1].value = 2;

      return [p1, p2, p3];
    })(),
  },
  {
    id: 'mod-walls',
    name: 'Walls',
    category: 'Modifiers',
    description: 'Navigate around impassable wall cells.',
    explanation: 'Wall cells are impassable \u2014 you can\'t reveal or flag them, and numbers don\'t count walls as neighbors. Treat walls like the edge of the board.',
    puzzles: (() => {
      // 3x3, mine at (2,2), wall at (1,1).
      const p1 = buildPuzzle(3, 3, [[2,2]], [[0,0],[0,1],[0,2],[1,0],[1,2],[2,0],[2,1]], [], [[2,2,'flag']], 'The wall splits the board. The 1 near the hidden cell says: mine!');
      p1.board[1][1] = { state: 'wall' };

      // 3x4, mine at (0,3), walls at (1,1) and (1,2).
      const p2 = buildPuzzle(3, 4, [[0,3]], [[0,0],[0,1],[0,2],[1,0],[1,3],[2,0],[2,1],[2,2],[2,3]], [], [[0,3,'flag']], 'Walls create a barrier. Numbers near the gap point to the mine.');
      p2.board[1][1] = { state: 'wall' };
      p2.board[1][2] = { state: 'wall' };

      // 4x3, mine at (0,2), walls at (1,0) and (2,0).
      const p3 = buildPuzzle(4, 3, [[0,2]], [[0,0],[0,1],[1,1],[1,2],[2,1],[2,2],[3,0],[3,1],[3,2]], [], [[0,2,'flag']], 'Wall along the edge \u2014 find the mine on the open side!');
      p3.board[1][0] = { state: 'wall' };
      p3.board[2][0] = { state: 'wall' };

      return [p1, p2, p3];
    })(),
  },
  {
    id: 'mod-wormhole',
    name: 'Wormholes',
    category: 'Modifiers',
    description: 'Decode paired cells with summed numbers.',
    explanation: 'Wormhole cells come in pairs. Each shows the SUM of both cells\' real mine counts. If one has 1 mine nearby and the other has 0, both display 1. Use surrounding non-wormhole numbers to split the sum.',
    puzzles: (() => {
      // 3x5, mine at (0,0). Wormholes at (1,1) adj=1 and (1,3) adj=0. Sum=1.
      const p1 = buildPuzzle(3, 5, [[0,0]], allExcept(3,5,[[0,0]]), [], [[0,0,'flag']], 'Both wormholes show 1 (the sum). The regular 1 next to the hidden cell confirms the mine.');
      p1.board[1][1].wormhole = true;
      p1.board[1][1].pairIndex = 0;
      p1.board[1][3].wormhole = true;
      p1.board[1][3].pairIndex = 0;
      p1.board[1][3].value = 1; // sum: 1+0=1 (overwrite 0)

      // 2x5, mines at (0,0) and (0,4). Wormholes at (1,1) adj=1 and (1,3) adj=1. Sum=2.
      const p2 = buildPuzzle(2, 5, [[0,0],[0,4]], allExcept(2,5,[[0,0],[0,4]]), [], [[0,0,'flag'],[0,4,'flag']], 'Both wormholes show 2 (1+1). Regular 1s on each end pin down each mine.');
      p2.board[1][1].wormhole = true;
      p2.board[1][1].pairIndex = 0;
      p2.board[1][1].value = 2; // sum
      p2.board[1][3].wormhole = true;
      p2.board[1][3].pairIndex = 0;
      p2.board[1][3].value = 2; // sum

      // 3x5, mine at (0,4). Wormholes at (1,1) adj=0 and (1,3) adj=1. Sum=1.
      const p3 = buildPuzzle(3, 5, [[0,4]], allExcept(3,5,[[0,4]]), [], [[0,4,'flag']], 'The wormhole sum is 1. Use non-wormhole numbers to find which side has the mine.');
      p3.board[1][1].wormhole = true;
      p3.board[1][1].pairIndex = 0;
      p3.board[1][1].value = 1; // sum: 0+1=1 (overwrite 0)
      p3.board[1][3].wormhole = true;
      p3.board[1][3].pairIndex = 0;

      return [p1, p2, p3];
    })(),
  },
  {
    id: 'mod-mirror',
    name: 'Mirror Zone',
    category: 'Modifiers',
    description: 'Mentally un-swap mirrored numbers.',
    explanation: 'Inside a mirror zone, numbers are swapped with the cell at the opposite position. A 2x2 mirror zone swaps diagonally. Focus on numbers OUTSIDE the zone for reliable clues.',
    puzzles: (() => {
      // 3x3, mine at (2,2). Mirror zone: top-left 2x2.
      // Real: (0,0)=0, (0,1)=0, (1,0)=0, (1,1)=1. Swaps: (0,0)<->(1,1), (0,1)<->(1,0).
      const p1 = buildPuzzle(3, 3, [[2,2]], allExcept(3,3,[[2,2]]), [], [[2,2,'flag']], 'Mirror zone swaps numbers diagonally. The regular 1 outside tells the truth!');
      p1.board[0][0].mirror = true;
      p1.board[0][0].value = 1; // shows (1,1)'s real value
      p1.board[0][1].mirror = true;
      p1.board[1][0].mirror = true;
      p1.board[1][1].mirror = true;
      p1.board[1][1].value = 0; // shows (0,0)'s real value

      // 3x4, mine at (0,3). Mirror zone: (1,0)(1,1)(2,0)(2,1).
      // Real: (1,0)=0, (1,1)=1, (2,0)=0, (2,1)=0. Swaps: (1,0)<->(2,1), (1,1)<->(2,0).
      const p2 = buildPuzzle(3, 4, [[0,3]], allExcept(3,4,[[0,3]]), [], [[0,3,'flag']], 'The mirrored 1 moved to the wrong spot. Use non-mirrored numbers!');
      p2.board[1][0].mirror = true;
      p2.board[1][1].mirror = true;
      p2.board[1][1].value = 0; // swapped from (2,0)
      p2.board[2][0].mirror = true;
      p2.board[2][0].value = 1; // swapped from (1,1)
      p2.board[2][1].mirror = true;

      // 3x3, mine at (0,0). Mirror zone: bottom-right 2x2.
      // Real: (1,1)=1, (1,2)=0, (2,1)=0, (2,2)=0. Swaps: (1,1)<->(2,2), (1,2)<->(2,1).
      const p3 = buildPuzzle(3, 3, [[0,0]], allExcept(3,3,[[0,0]]), [], [[0,0,'flag']], 'Corner mirror zone \u2014 the 1 appears swapped. Trust the edge numbers!');
      p3.board[1][1].mirror = true;
      p3.board[1][1].value = 0; // swapped from (2,2)
      p3.board[1][2].mirror = true;
      p3.board[2][1].mirror = true;
      p3.board[2][2].mirror = true;
      p3.board[2][2].value = 1; // swapped from (1,1)

      return [p1, p2, p3];
    })(),
  },
];

// ── Build SKILL_LESSONS Object ────────────────────────
export const SKILL_LESSONS = {};
for (const lesson of LESSONS) {
  SKILL_LESSONS[lesson.id] = lesson;
}

// ── API Functions ─────────────────────────────────────
export function getLesson(id) {
  return SKILL_LESSONS[id] || null;
}

export function getLessonsByCategory(category) {
  return LESSONS.filter(l => l.category === category);
}

// ── Progress Storage ──────────────────────────────────
export function loadSkillProgress() {
  try {
    const data = safeGet(SKILL_PROGRESS_KEY);
    return data ? JSON.parse(data) : {};
  } catch {
    return {};
  }
}

export function saveSkillProgress(progress) {
  try {
    safeSet(SKILL_PROGRESS_KEY, JSON.stringify(progress));
  } catch { /* ignore */ }
}

export function markPuzzleCompleted(lessonId, puzzleIndex) {
  const progress = loadSkillProgress();
  if (!progress[lessonId]) progress[lessonId] = { completedPuzzles: [], stars: 0 };
  if (!progress[lessonId].completedPuzzles) progress[lessonId].completedPuzzles = [];
  if (!progress[lessonId].completedPuzzles.includes(puzzleIndex)) {
    progress[lessonId].completedPuzzles.push(puzzleIndex);
  }
  saveSkillProgress(progress);
}

export function getLessonStars(lessonId, progress) {
  if (!progress) progress = loadSkillProgress();
  const data = progress[lessonId];
  if (!data) return 0;
  return data.stars || 0;
}
