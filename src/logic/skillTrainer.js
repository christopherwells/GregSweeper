import { safeGet, safeSet, safeGetJSON, safeSetJSON } from '../storage/storageAdapter.js?v=0.9.5';
// ── Skill Trainer Data ────────────────────────────────
// 15 lessons (5 beginner, 5 intermediate, 5 advanced)
// with 75 hand-crafted puzzles teaching minesweeper techniques.

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
      if (fs.has(k)) row.push({ state: 'flagged' });
      else if (rs.has(k)) row.push({ state: 'revealed', value: adj(r, c) });
      else row.push({ state: 'unrevealed' });
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
      buildPuzzle(3, 3, [[0,2]], allExcept(3,3,[[0,2]]), [], [[0,2,'flag']], 'The 1 touches only one hidden cell — that must be the mine. Flag it!'),
      buildPuzzle(3, 3, [[2,0]], allExcept(3,3,[[2,0]]), [], [[2,0,'flag']], 'Find the 1 and look at which hidden cell is next to it.'),
      buildPuzzle(3, 3, [[0,0],[2,2]], allExcept(3,3,[[0,0],[2,2]]), [], [[0,0,'flag'],[2,2,'flag']], 'Each 1 touches only one hidden cell. Flag both hidden cells.'),
      buildPuzzle(3, 4, [[0,3],[2,0]], allExcept(3,4,[[0,3],[2,0]]), [], [[0,3,'flag'],[2,0,'flag']], 'Edge cells have fewer neighbors. Each 1 only touches one hidden cell.'),
      buildPuzzle(4, 4, [[0,3],[2,1],[3,0]], allExcept(4,4,[[0,3],[2,1],[3,0]]), [], [[0,3,'flag'],[2,1,'flag'],[3,0,'flag']], 'Start with the most constrained numbers — the ones with fewest hidden neighbors.'),
    ],
  },
  {
    id: 'first-flags',
    name: 'Your First Flags',
    category: 'Beginner',
    description: 'Learn when to flag a cell as a mine.',
    explanation: 'If a number has the same count of hidden neighbors as its value, all those hidden cells must be mines. Right-click (or long-press on mobile) to place a flag.',
    puzzles: [
      // 3×3: mine at corner, one distractor nearby
      buildPuzzle(3, 3, [[0,2]], allExcept(3,3,[[0,0],[0,2]]), [], [[0,2,'flag']], 'The 1 on the right side has only one hidden neighbor — flag it!'),
      // 3×3: mine at bottom-left
      buildPuzzle(3, 3, [[2,0]], allExcept(3,3,[[2,0],[2,2]]), [], [[2,0,'flag']], 'The 1 on the left side touches only one hidden cell.'),
      // 3×3: two mines top row
      buildPuzzle(3, 3, [[0,0],[0,1]], allExcept(3,3,[[0,0],[0,1]]), [], [[0,0,'flag'],[0,1,'flag']], 'The 2 has exactly 2 hidden neighbors — both must be mines.'),
      // 3×3: center mine
      buildPuzzle(3, 3, [[1,1]], allExcept(3,3,[[1,1]]), [], [[1,1,'flag']], 'All the numbers surround one hidden cell. They all agree: it\'s a mine!'),
      // 3×4: two mines at edges
      buildPuzzle(3, 4, [[0,0],[0,3]], allExcept(3,4,[[0,0],[0,3]]), [], [[0,0,'flag'],[0,3,'flag']], 'Each 1 on the edges only touches one hidden cell. Flag them both.'),
    ],
  },
  {
    id: 'safe-cells',
    name: 'Finding Safe Cells',
    category: 'Beginner',
    description: 'Find cells that are safe to click.',
    explanation: 'Once all mines around a number are flagged, every other hidden neighbor of that number is guaranteed safe. Click them to reveal!',
    puzzles: [
      // 3×3: mine flagged at corner, one safe cell left
      buildPuzzle(3, 3, [[0,0]], allExcept(3,3,[[0,0],[0,2]]), [[0,0]], [[0,2,'reveal']], 'The 🚩 accounts for the 1. The other hidden cell can\'t be a mine — reveal it!'),
      // 3×3: mine flagged, two safe cells remain
      buildPuzzle(3, 3, [[0,2]], allExcept(3,3,[[0,2],[2,0],[2,1]]), [[0,2]], [[2,0,'reveal'],[2,1,'reveal']], 'The flag satisfies the 1. All other hidden neighbors are safe.'),
      // 3×3: mine flagged at corner, deduce remaining safe cell from satisfied number
      buildPuzzle(3, 3, [[2,2]], allExcept(3,3,[[2,2],[0,2],[0,0]]), [[2,2]], [[0,2,'reveal'],[0,0,'reveal']], 'The 1 next to the flag is satisfied. Its other hidden neighbors must be safe.'),
      // 3×3: two mines flagged, one safe remains
      buildPuzzle(3, 3, [[0,0],[0,2]], allExcept(3,3,[[0,0],[0,2],[2,1]]), [[0,0],[0,2]], [[2,1,'reveal']], 'Both mines are flagged. The last hidden cell has to be safe.'),
      // 3×4: two mines flagged, two safe cells remain
      buildPuzzle(3, 4, [[0,0],[0,3]], allExcept(3,4,[[0,0],[0,3],[2,1],[2,2]]), [[0,0],[0,3]], [[2,1,'reveal'],[2,2,'reveal']], 'Every mine is flagged — all remaining hidden cells are safe!'),
    ],
  },
  {
    id: 'chord-clicking',
    name: 'Chord Clicking',
    category: 'Beginner',
    description: 'Reveal multiple safe cells at once.',
    explanation: 'When a number already has all its mines flagged, clicking that number automatically reveals its other hidden neighbors. This is called "chording" — it saves a lot of time!',
    puzzles: [
      // 3×3: mine flagged on left edge, chord the 1 to reveal neighbors
      buildPuzzle(3, 3, [[1,0]], allExcept(3,3,[[1,0],[0,0],[2,0]]), [[1,0]], [[0,0,'reveal'],[2,0,'reveal']], 'The 1\'s mine is already flagged. Click the 1 to reveal its other neighbors at once.'),
      // 3×3: mine flagged at corner, chord to reveal diagonal
      buildPuzzle(3, 3, [[0,0]], allExcept(3,3,[[0,0],[0,2],[2,0]]), [[0,0]], [[0,2,'reveal'],[2,0,'reveal']], 'The mine is flagged. Click the 1 to chord and reveal the safe cells.'),
      // 3×4: two mines flagged, chord the 2 to reveal center
      buildPuzzle(3, 4, [[0,0],[0,3]], allExcept(3,4,[[0,0],[0,3],[0,1],[0,2]]), [[0,0],[0,3]], [[0,1,'reveal'],[0,2,'reveal']], 'Both mines are flagged. Click the 2 to reveal the safe cells between them.'),
      // 3×3: mine flagged, chord to clear remaining
      buildPuzzle(3, 3, [[0,2]], allExcept(3,3,[[0,2],[0,0],[2,2]]), [[0,2]], [[0,0,'reveal'],[2,2,'reveal']], 'The flag covers the mine. Chord the 1 to clear the rest.'),
      // 3×4: two mines flagged, multiple chords possible
      buildPuzzle(3, 4, [[0,0],[2,3]], allExcept(3,4,[[0,0],[2,3],[0,2],[2,1]]), [[0,0],[2,3]], [[0,2,'reveal'],[2,1,'reveal']], 'Two flags placed. Chord the satisfied numbers to reveal safe cells.'),
    ],
  },
  {
    id: 'edges-corners',
    name: 'Edge & Corner Logic',
    category: 'Beginner',
    description: 'Use the board edges to find mines faster.',
    explanation: 'Cells at corners only have 3 neighbors. Edge cells have 5. Fewer neighbors means fewer possibilities, making numbers at the edges much easier to solve!',
    puzzles: [
      // 3×3: mine on top edge, corner 1 constrains it
      buildPuzzle(3, 3, [[0,1]], [[0,0],[1,0],[1,1],[1,2],[2,0],[2,1],[2,2]], [], [[0,1,'flag']], 'The 1 in the top-left corner only has 3 neighbors. One is hidden — that\'s the mine!'),
      // 3×4: mine on edge, numbers narrow it down
      buildPuzzle(3, 4, [[0,2]], [[0,0],[0,1],[0,3],[1,0],[1,1],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3]], [], [[0,2,'flag']], 'Only one cell on the top edge is hidden. The 1 next to it tells you it\'s a mine.'),
      // 3×3: two mines in corner, the 2 constrains both
      buildPuzzle(3, 3, [[0,0],[1,0]], [[0,1],[0,2],[1,1],[1,2],[2,0],[2,1],[2,2]], [], [[0,0,'flag'],[1,0,'flag']], 'The 2 in the corner has exactly 2 hidden neighbors — both must be mines!'),
      // 3×4: mine on top edge, edge numbers pinpoint it
      buildPuzzle(3, 4, [[0,2]], [[0,0],[0,1],[0,3],[1,0],[1,1],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3]], [], [[0,2,'flag']], 'Edge numbers have limited hidden neighbors, making the mine easy to spot.'),
      // 3×4: two corner mines, each corner 1 constrains one
      buildPuzzle(3, 4, [[0,0],[0,3]], [[0,1],[0,2],[1,0],[1,1],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3]], [], [[0,0,'flag'],[0,3,'flag']], 'Each corner 1 only touches one hidden cell. Flag them both!'),
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
