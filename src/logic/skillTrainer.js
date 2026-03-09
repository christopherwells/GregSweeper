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
    description: 'Learn what the numbers on cells mean.',
    explanation: 'Each number shows how many mines touch that cell, including diagonals. Use the numbers to figure out where mines hide.',
    puzzles: [
      buildPuzzle(3, 3, [[0,2]], allExcept(3,3,[[0,2]]), [], [[0,2,'flag']], 'The 1 has only one hidden neighbor.'),
      buildPuzzle(3, 3, [[2,0]], allExcept(3,3,[[2,0]]), [], [[2,0,'flag']], 'Which hidden cell does the 1 point to?'),
      buildPuzzle(4, 4, [[0,0],[3,3]], allExcept(4,4,[[0,0],[3,3]]), [], [[0,0,'flag'],[3,3,'flag']], 'Two 1s in opposite corners each point to one mine.'),
      buildPuzzle(4, 4, [[0,3],[3,0]], allExcept(4,4,[[0,3],[3,0]]), [], [[0,3,'flag'],[3,0,'flag']], 'Edge 1s have fewer neighbors — easier to spot mines.'),
      buildPuzzle(5, 5, [[0,4],[2,2],[4,0]], allExcept(5,5,[[0,4],[2,2],[4,0]]), [], [[0,4,'flag'],[2,2,'flag'],[4,0,'flag']], 'Find all three mines using the number clues.'),
    ],
  },
  {
    id: 'first-flags',
    name: 'Your First Flags',
    category: 'Beginner',
    description: 'When to place flags on mines.',
    explanation: 'If a number equals its hidden neighbor count, ALL those hidden cells must be mines. Flag them!',
    puzzles: [
      buildPuzzle(4, 4, [[0,3]], allExcept(4,4,[[0,3],[3,0],[3,1]]), [], [[0,3,'flag']], 'The 1 at the top edge has only one hidden neighbor.'),
      buildPuzzle(4, 4, [[3,0]], allExcept(4,4,[[3,0],[0,2],[0,3]]), [], [[3,0,'flag']], 'Look at the 1 in the bottom-left area.'),
      buildPuzzle(4, 4, [[0,0],[0,1]], allExcept(4,4,[[0,0],[0,1],[3,2],[3,3]]), [], [[0,0,'flag'],[0,1,'flag']], 'The 2 has exactly 2 hidden neighbors — both must be mines.'),
      buildPuzzle(5, 5, [[2,2]], allExcept(5,5,[[2,2],[0,0],[4,4],[0,4]]), [], [[2,2,'flag']], 'Multiple numbers all point to the same hidden cell.'),
      buildPuzzle(5, 5, [[0,4],[4,0]], allExcept(5,5,[[0,4],[4,0],[2,0],[2,4]]), [], [[0,4,'flag'],[4,0,'flag']], 'Find both mines using the corner numbers.'),
    ],
  },
  {
    id: 'safe-cells',
    name: 'Finding Safe Cells',
    category: 'Beginner',
    description: 'Identify cells safe to reveal.',
    explanation: 'When all mines around a number are flagged, its remaining hidden neighbors are guaranteed safe. Reveal them!',
    puzzles: [
      buildPuzzle(4, 4, [[0,0]], allExcept(4,4,[[0,0],[2,3]]), [[0,0]], [[2,3,'reveal']], 'The 1 has its mine flagged. Remaining hidden cells are safe.'),
      buildPuzzle(4, 4, [[0,3]], allExcept(4,4,[[0,3],[3,0],[3,1]]), [[0,3]], [[3,0,'reveal'],[3,1,'reveal']], 'Mine flagged. Reveal all safe hidden cells.'),
      buildPuzzle(5, 5, [[2,2]], allExcept(5,5,[[2,2],[0,0],[4,4]]), [[2,2]], [[0,0,'reveal'],[4,4,'reveal']], 'Center mine flagged. Far corners are safe.'),
      buildPuzzle(4, 4, [[0,0],[0,3]], allExcept(4,4,[[0,0],[0,3],[3,1],[3,2]]), [[0,0],[0,3]], [[3,1,'reveal'],[3,2,'reveal']], 'Both mines flagged. Reveal the safe cells.'),
      buildPuzzle(5, 5, [[0,0],[2,4],[4,0]], allExcept(5,5,[[0,0],[2,4],[4,0],[0,4],[4,4]]), [[0,0],[2,4],[4,0]], [[0,4,'reveal'],[4,4,'reveal']], 'All mines flagged. Which remaining cells are safe?'),
    ],
  },
  {
    id: 'chord-clicking',
    name: 'Chord Clicking',
    category: 'Beginner',
    description: 'Reveal multiple cells at once.',
    explanation: 'When a number has all its mines flagged, clicking it reveals ALL remaining hidden neighbors. This is called chording — a big time saver!',
    puzzles: [
      buildPuzzle(4, 4, [[1,0]], allExcept(4,4,[[1,0],[0,0],[2,0]]), [[1,0]], [[0,0,'reveal'],[2,0,'reveal']], 'The 1 is satisfied. Chord to reveal both neighbors.'),
      buildPuzzle(4, 4, [[0,0]], allExcept(4,4,[[0,0],[1,1],[2,2]]), [[0,0]], [[1,1,'reveal'],[2,2,'reveal']], 'Mine flagged. Chord the adjacent 1 to reveal safe cells.'),
      buildPuzzle(5, 5, [[0,0],[0,4]], allExcept(5,5,[[0,0],[0,4],[1,2]]), [[0,0],[0,4]], [[1,2,'reveal']], 'Both corners flagged. Chord to reveal the center.'),
      buildPuzzle(5, 5, [[2,0],[2,4]], allExcept(5,5,[[2,0],[2,4],[0,0],[4,4]]), [[2,0],[2,4]], [[0,0,'reveal'],[4,4,'reveal']], 'Two mines flagged. Chord to clear the corners.'),
      buildPuzzle(5, 5, [[1,1],[3,3]], allExcept(5,5,[[1,1],[3,3],[0,0],[4,4],[2,2]]), [[1,1],[3,3]], [[0,0,'reveal'],[4,4,'reveal'],[2,2,'reveal']], 'Multiple chord opportunities. Reveal all safe cells.'),
    ],
  },
  {
    id: 'edges-corners',
    name: 'Edge & Corner Logic',
    category: 'Beginner',
    description: 'Use board edges to your advantage.',
    explanation: 'Corner cells have only 3 neighbors, edge cells 5. Fewer neighbors = more constraining numbers = easier deductions!',
    puzzles: [
      buildPuzzle(4, 4, [[0,1]], [[0,0],[1,0],[1,1],[1,2],[2,0],[2,1],[2,2],[2,3],[3,0],[3,1],[3,2],[3,3]], [], [[0,1,'flag']], 'The corner 1 has only 3 neighbors. Which is the mine?'),
      buildPuzzle(4, 4, [[0,2]], [[0,0],[0,1],[0,3],[1,0],[1,1],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3]], [], [[0,2,'flag']], 'The edge 1 points to one hidden cell.'),
      buildPuzzle(4, 4, [[0,0],[1,0]], [[0,1],[1,1],[2,0],[2,1],[3,0],[3,1],[0,2],[0,3],[1,2],[1,3],[2,2],[2,3],[3,2],[3,3]], [], [[0,0,'flag'],[1,0,'flag']], 'The 2 has exactly 2 hidden corner neighbors.'),
      buildPuzzle(5, 5, [[0,2]], [[0,0],[0,1],[0,3],[0,4],[1,0],[1,1],[1,2],[1,3],[1,4],[2,0],[2,1],[2,2],[2,3],[2,4]], [], [[0,2,'flag']], 'Use edge numbers to pinpoint the mine.'),
      buildPuzzle(5, 5, [[0,0],[0,4]], [[0,1],[0,2],[0,3],[1,0],[1,1],[1,2],[1,3],[1,4],[2,0],[2,1],[2,2],[2,3],[2,4]], [], [[0,0,'flag'],[0,4,'flag']], 'Both corner 1s point to one hidden cell each.'),
    ],
  },

  // ═════════════════════ INTERMEDIATE ═════════════════════
  {
    id: 'pattern-1-1',
    name: 'The 1-1 Pattern',
    category: 'Intermediate',
    description: 'Two adjacent 1s along a wall reveal safe cells.',
    explanation: 'Two 1s side by side along a wall: the mine must be at one end of the pair. Cells beyond the far 1 are safe.',
    puzzles: [
      buildPuzzle(3, 4, [[0,0]], [[1,0],[1,1],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3]], [], [[0,2,'reveal'],[0,3,'reveal']], 'The 1-1 along the wall: cells beyond are safe.'),
      buildPuzzle(3, 4, [[0,3]], [[1,0],[1,1],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3]], [], [[0,0,'reveal'],[0,1,'reveal']], 'Same pattern, opposite direction.'),
      buildPuzzle(4, 3, [[0,0]], [[0,1],[0,2],[1,1],[1,2],[2,1],[2,2],[3,0],[3,1],[3,2]], [], [[2,0,'reveal']], 'The pattern works vertically too.'),
      buildPuzzle(3, 5, [[0,1]], [[1,0],[1,1],[1,2],[1,3],[1,4],[2,0],[2,1],[2,2],[2,3],[2,4]], [], [[0,3,'reveal'],[0,4,'reveal']], 'Identify safe cells past the 1-1 pair.'),
      buildPuzzle(3, 5, [[0,0],[0,4]], [[1,0],[1,1],[1,2],[1,3],[1,4],[2,0],[2,1],[2,2],[2,3],[2,4]], [], [[0,2,'reveal']], 'Two 1-1 pairs from each end — the middle is safe.'),
    ],
  },
  {
    id: 'pattern-1-2',
    name: 'The 1-2 Pattern',
    category: 'Intermediate',
    description: '1-2 adjacent cells reveal mine locations.',
    explanation: 'A 1 next to a 2 along a wall: the 2 needs one more mine than the 1. The cell only the 2 can see must be a mine.',
    puzzles: [
      buildPuzzle(3, 4, [[0,0],[0,2]], [[1,0],[1,1],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3]], [], [[0,2,'flag']], 'The 2 needs more mines than the 1. Where is the extra?'),
      buildPuzzle(3, 4, [[0,1],[0,3]], [[1,0],[1,1],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3]], [], [[0,0,'reveal']], 'The wall-edge 1 tells you (0,0) is safe.'),
      buildPuzzle(3, 5, [[0,0],[0,2]], [[1,0],[1,1],[1,2],[1,3],[1,4],[2,0],[2,1],[2,2],[2,3],[2,4]], [], [[0,3,'reveal'],[0,4,'reveal']], 'Cells beyond the 1-2 pair are safe.'),
      buildPuzzle(3, 5, [[0,0],[0,1]], [[1,0],[1,1],[1,2],[1,3],[1,4],[2,0],[2,1],[2,2],[2,3],[2,4]], [], [[0,3,'reveal'],[0,4,'reveal']], 'Use the 1-2 constraint to find safe cells.'),
      buildPuzzle(4, 4, [[0,0],[0,1]], [[1,0],[1,1],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3],[3,0],[3,1],[3,2],[3,3],[0,2],[0,3]], [], [[0,0,'flag'],[0,1,'flag']], 'The corner 2 must have both mines above it.'),
    ],
  },
  {
    id: 'wall-logic',
    name: 'Wall & Edge Logic',
    category: 'Intermediate',
    description: 'Board boundaries constrain mine placement.',
    explanation: 'Board edges act like walls — no cells beyond them. This limits possibilities and enables deductions impossible in the board center.',
    puzzles: [
      buildPuzzle(4, 4, [[0,0]], [[0,1],[1,0],[1,1],[0,2],[0,3],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3],[3,0],[3,1],[3,2],[3,3]], [], [[0,0,'flag']], 'Corner 1 — the wall limits neighbors.'),
      buildPuzzle(5, 4, [[0,1]], [[0,0],[0,2],[0,3],[1,0],[1,1],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3]], [], [[0,1,'flag']], 'Edge 1 with limited hidden neighbors.'),
      buildPuzzle(4, 5, [[3,2]], [[0,0],[0,1],[0,2],[0,3],[0,4],[1,0],[1,1],[1,2],[1,3],[1,4],[2,0],[2,1],[2,2],[2,3],[2,4],[3,0],[3,1],[3,3],[3,4]], [], [[3,2,'flag']], 'Bottom edge 1 has only one hidden neighbor.'),
      buildPuzzle(5, 4, [[2,0]], [[0,0],[0,1],[0,2],[0,3],[1,0],[1,1],[1,2],[1,3],[2,1],[2,2],[2,3],[3,0],[3,1],[3,2],[3,3],[4,0],[4,1],[4,2],[4,3]], [], [[2,0,'flag']], 'The wall limits where this mine can be.'),
      buildPuzzle(4, 4, [[0,0],[1,1]], [[0,1],[0,2],[0,3],[1,0],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3],[3,0],[3,1],[3,2],[3,3]], [], [[0,0,'flag'],[1,1,'flag']], 'Corner 2 has exactly 2 hidden neighbors.'),
    ],
  },
  {
    id: 'corner-deduction',
    name: 'Corner Deduction',
    category: 'Intermediate',
    description: 'Corner-specific deduction patterns.',
    explanation: 'Corners have only 3 neighbors. Corner 1 = instant mine ID. Corner 2 = two of three are mines. Use corners as anchors.',
    puzzles: [
      buildPuzzle(4, 4, [[1,0]], [[0,0],[0,1],[0,2],[0,3],[1,1],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3],[3,0],[3,1],[3,2],[3,3]], [], [[1,0,'flag']], 'The corner 1 at (0,0) points to exactly one cell.'),
      buildPuzzle(4, 4, [[0,1],[1,0]], [[0,0],[1,1],[0,2],[0,3],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3],[3,0],[3,1],[3,2],[3,3]], [], [[0,1,'flag'],[1,0,'flag']], 'Corner 2: two of three neighbors are mines.'),
      buildPuzzle(4, 4, [[0,1],[3,2]], [[0,0],[0,2],[0,3],[1,0],[1,1],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3],[3,0],[3,1],[3,3]], [], [[0,1,'flag'],[3,2,'flag']], 'Corner deduction at opposite corners.'),
      buildPuzzle(4, 4, [[0,1],[1,3]], [[0,0],[0,2],[0,3],[1,0],[1,1],[1,2],[2,0],[2,1],[2,2],[2,3],[3,0],[3,1],[3,2],[3,3]], [], [[0,1,'flag'],[1,3,'flag']], 'Solve one corner, then the next.'),
      buildPuzzle(5, 5, [[0,1],[1,4]], [[0,0],[0,2],[0,3],[0,4],[1,0],[1,1],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3],[2,4],[3,0],[3,1],[3,2],[3,3],[3,4],[4,0],[4,1],[4,2],[4,3],[4,4]], [], [[0,1,'flag'],[1,4,'flag']], 'Combine corner and edge constraints.'),
    ],
  },
  {
    id: 'reduction',
    name: 'Reduction Technique',
    category: 'Intermediate',
    description: 'Subtract known mines from constraints.',
    explanation: 'If a number has some mines flagged, subtract them. The remaining count applies to remaining hidden neighbors — often revealing new mines or safe cells.',
    puzzles: [
      buildPuzzle(4, 4, [[0,0],[0,2]], allExcept(4,4,[[0,0],[0,2]]), [[0,0]], [[0,2,'flag']], 'The 2 has one flagged. It needs one more.'),
      buildPuzzle(4, 5, [[0,0],[0,1],[0,3]], allExcept(4,5,[[0,0],[0,1],[0,3]]), [[0,0],[0,1]], [[0,3,'flag']], 'The 3 has 2 flagged. One more mine remains.'),
      buildPuzzle(4, 4, [[0,0],[1,3]], allExcept(4,4,[[0,0],[1,3],[3,0]]), [[0,0]], [[3,0,'reveal']], 'After subtracting the flag, which cells are safe?'),
      buildPuzzle(5, 5, [[0,0],[2,4]], allExcept(5,5,[[0,0],[2,4],[4,0]]), [[0,0]], [[4,0,'reveal']], 'Reduce constraints step by step.'),
      buildPuzzle(5, 5, [[0,0],[0,4],[4,2]], allExcept(5,5,[[0,0],[0,4],[4,2]]), [[0,0],[0,4]], [[4,2,'flag']], 'Two flags placed. Find the last mine.'),
    ],
  },

  // ═════════════════════ ADVANCED ═════════════════════
  {
    id: 'subset-superset',
    name: 'Subset / Superset',
    category: 'Advanced',
    description: 'When one constraint contains another.',
    explanation: 'If constraint A\'s unknowns are a subset of B\'s, subtract A from B. The remaining cells have (B_count - A_count) mines.',
    puzzles: [
      buildPuzzle(3, 5, [[0,0],[0,3]], [[1,0],[1,1],[1,2],[1,3],[1,4],[2,0],[2,1],[2,2],[2,3],[2,4]], [], [[0,4,'reveal']], 'The 1\'s constraint is a subset of the 2\'s.'),
      buildPuzzle(3, 5, [[0,1],[0,4]], [[1,0],[1,1],[1,2],[1,3],[1,4],[2,0],[2,1],[2,2],[2,3],[2,4]], [], [[0,0,'reveal']], 'Subtract the smaller constraint from the larger.'),
      buildPuzzle(4, 5, [[0,0],[0,3]], [[1,0],[1,1],[1,2],[1,3],[1,4],[2,0],[2,1],[2,2],[2,3],[2,4],[3,0],[3,1],[3,2],[3,3],[3,4]], [], [[0,4,'reveal']], 'Apply subset analysis to find the safe cell.'),
      buildPuzzle(3, 6, [[0,0],[0,4]], [[1,0],[1,1],[1,2],[1,3],[1,4],[1,5],[2,0],[2,1],[2,2],[2,3],[2,4],[2,5]], [], [[0,5,'reveal']], 'Far-right cell is outside the subset — safe!'),
      buildPuzzle(4, 5, [[0,0],[0,1],[0,4]], [[1,0],[1,1],[1,2],[1,3],[1,4],[2,0],[2,1],[2,2],[2,3],[2,4],[3,0],[3,1],[3,2],[3,3],[3,4]], [], [[0,4,'flag']], 'Subset difference reveals the mine.'),
    ],
  },
  {
    id: 'coupled-constraints',
    name: 'Coupled Constraints',
    category: 'Advanced',
    description: 'Multi-cell inference chains.',
    explanation: 'Sometimes no single number gives the answer. Combine info from multiple numbers: if A implies B, and B implies C, then A implies C.',
    puzzles: [
      buildPuzzle(4, 5, [[0,0],[0,4]], [[1,0],[1,1],[1,2],[1,3],[1,4],[2,0],[2,1],[2,2],[2,3],[2,4],[3,0],[3,1],[3,2],[3,3],[3,4]], [], [[0,2,'reveal']], 'Neither 1 alone solves it. Combine constraints.'),
      buildPuzzle(3, 5, [[0,0],[0,2]], [[1,0],[1,1],[1,2],[1,3],[1,4],[2,0],[2,1],[2,2],[2,3],[2,4]], [], [[0,4,'reveal']], 'Chain deductions along the wall.'),
      buildPuzzle(4, 4, [[0,0],[2,3]], [[1,0],[1,1],[0,1],[0,2],[0,3],[1,2],[1,3],[2,0],[2,1],[2,2],[3,0],[3,1],[3,2],[3,3]], [], [[0,0,'flag'],[2,3,'flag']], 'Two separate constraints each ID a mine.'),
      buildPuzzle(4, 5, [[0,1],[0,3]], [[1,0],[1,1],[1,2],[1,3],[1,4],[2,0],[2,1],[2,2],[2,3],[2,4],[3,0],[3,1],[3,2],[3,3],[3,4]], [], [[0,0,'reveal'],[0,4,'reveal']], 'Coupled 1s along a wall — ends are safe.'),
      buildPuzzle(5, 5, [[0,0],[0,4],[4,2]], allExcept(5,5,[[0,0],[0,4],[4,2]]), [], [[0,0,'flag'],[0,4,'flag'],[4,2,'flag']], 'Multiple coupled constraints flag all mines.'),
    ],
  },
  {
    id: 'probability',
    name: 'Probability Thinking',
    category: 'Advanced',
    description: 'Make educated guesses when logic fails.',
    explanation: 'Sometimes you must guess. Choose the cell with the lowest mine probability. Cells far from known mines, or with more safe neighbors, are safer.',
    puzzles: [
      buildPuzzle(3, 3, [[0,0]], [[0,2],[1,0],[1,1],[1,2],[2,0],[2,1],[2,2]], [], [[0,1,'reveal']], 'Two hidden cells, one mine. Pick the less likely.'),
      buildPuzzle(3, 4, [[0,0]], [[1,0],[1,1],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3]], [], [[0,2,'reveal'],[0,3,'reveal']], 'More hidden cells = lower chance each is a mine.'),
      buildPuzzle(4, 4, [[0,0],[3,3]], [[1,0],[1,1],[0,1],[0,2],[0,3],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3],[3,0],[3,1],[3,2]], [], [[0,0,'flag'],[3,3,'flag']], 'Constrained cells give more info. Start there.'),
      buildPuzzle(4, 5, [[0,0]], [[1,0],[1,1],[1,2],[1,3],[1,4],[2,0],[2,1],[2,2],[2,3],[2,4],[3,0],[3,1],[3,2],[3,3],[3,4]], [], [[0,3,'reveal'],[0,4,'reveal']], 'Cells far from constraints are least likely mines.'),
      buildPuzzle(5, 5, [[2,2]], [[1,1],[1,2],[1,3],[2,1],[2,3],[3,1],[3,2],[3,3],[0,0],[0,4],[4,0],[4,4]], [], [[0,1,'reveal'],[0,2,'reveal'],[0,3,'reveal']], 'Mine surrounded by numbers. Far edges are safe.'),
    ],
  },
  {
    id: 'endgame',
    name: 'Endgame Strategies',
    category: 'Advanced',
    description: 'Techniques for the last few cells.',
    explanation: 'In the endgame, count remaining mines vs cells. Mines = hidden cells? Flag all. 0 mines left? Reveal all. Track the mine counter!',
    puzzles: [
      buildPuzzle(3, 3, [[2,2]], allExcept(3,3,[[2,2]]), [], [[2,2,'flag']], 'One mine, one hidden cell. Flag it!'),
      buildPuzzle(4, 4, [[0,0]], allExcept(4,4,[[0,0],[3,2],[3,3]]), [[0,0]], [[3,2,'reveal'],[3,3,'reveal']], 'All mines flagged. Remaining cells are safe.'),
      buildPuzzle(4, 4, [[3,0],[3,3]], allExcept(4,4,[[3,0],[3,3]]), [], [[3,0,'flag'],[3,3,'flag']], 'Two mines for two cells. Flag both.'),
      buildPuzzle(4, 4, [[3,1]], allExcept(4,4,[[3,0],[3,1],[3,2]]), [], [[3,0,'reveal'],[3,2,'reveal']], 'One mine among three. Use numbers to find safe ones.'),
      buildPuzzle(5, 5, [[4,0],[4,4]], allExcept(5,5,[[4,0],[4,1],[4,3],[4,4]]), [], [[4,1,'reveal'],[4,3,'reveal']], 'Two mines in four cells. Which are safe?'),
    ],
  },
  {
    id: 'speed-techniques',
    name: 'Speed Techniques',
    category: 'Advanced',
    description: 'Efficient solving patterns.',
    explanation: 'Speed = pattern recognition. Flag obvious mines fast, chord to mass-reveal, work edges inward, never re-analyze solved regions.',
    puzzles: [
      buildPuzzle(4, 4, [[0,0]], [[0,1],[0,2],[0,3],[1,0],[1,1],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3]], [], [[0,0,'flag']], 'Corner 1 = instant flag. No hesitation.'),
      buildPuzzle(4, 5, [[0,0],[0,4]], [[0,1],[0,2],[0,3],[1,0],[1,1],[1,2],[1,3],[1,4],[2,0],[2,1],[2,2],[2,3],[2,4],[3,0],[3,1],[3,2],[3,3],[3,4]], [], [[0,0,'flag'],[0,4,'flag']], 'Two instant corner flags. Go!'),
      buildPuzzle(5, 5, [[0,0]], allExcept(5,5,[[0,0],[4,3],[4,4]]), [], [[0,0,'flag']], 'Flag the mine, then chord to clear fast.'),
      buildPuzzle(5, 5, [[0,2],[4,2]], [[0,0],[0,1],[0,3],[0,4],[1,0],[1,1],[1,2],[1,3],[1,4],[2,0],[2,1],[2,2],[2,3],[2,4],[3,0],[3,1],[3,2],[3,3],[3,4],[4,0],[4,1],[4,3],[4,4]], [], [[0,2,'flag'],[4,2,'flag']], 'Work edges — constraints are strongest there.'),
      buildPuzzle(4, 4, [[0,0],[3,3]], [[0,1],[0,2],[0,3],[1,0],[1,1],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3],[3,0],[3,1],[3,2]], [], [[0,0,'flag'],[3,3,'flag']], 'Both corner mines — speed = pattern recognition.'),
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
    const data = localStorage.getItem(SKILL_PROGRESS_KEY);
    return data ? JSON.parse(data) : {};
  } catch {
    return {};
  }
}

export function saveSkillProgress(progress) {
  try {
    localStorage.setItem(SKILL_PROGRESS_KEY, JSON.stringify(progress));
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
