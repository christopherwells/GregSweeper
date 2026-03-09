// ── Advanced Constraint Solver for Minesweeper ────────────────
// Two-layer solver that goes beyond simple rule + subset analysis.
// Layer 1: Tank Solver — partition-based brute-force enumeration
//          for small connected components (≤20 unknowns).
// Layer 2: Gaussian Elimination — integer row-reduction for
//          larger components, extracting forced variables.

const TANK_LIMIT = 20; // max unknowns per component for enumeration (2^20 ≈ 1M)

/**
 * Given a set of linear constraints over binary (0/1) unknowns,
 * determine which cells are provably mines or provably safe.
 *
 * @param {Array<{unknowns: number[], mines: number}>} constraints
 *   Each constraint says: "among these unknown cell indices,
 *   exactly `mines` of them are mines."
 * @returns {{ mines: Set<number>, safe: Set<number> }}
 */
export function solveConstraints(constraints) {
  const result = { mines: new Set(), safe: new Set() };
  if (constraints.length === 0) return result;

  const components = findComponents(constraints);

  for (const comp of components) {
    if (comp.unknowns.length <= TANK_LIMIT) {
      tankSolve(comp.unknowns, comp.constraints, result);
    } else {
      gaussSolve(comp.unknowns, comp.constraints, result);
    }
  }

  return result;
}

// ── Union-Find to partition unknowns into independent components ──

function findComponents(constraints) {
  const parent = new Map();

  function find(x) {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x))); // path compression
      x = parent.get(x);
    }
    return x;
  }

  function union(a, b) {
    a = find(a);
    b = find(b);
    if (a !== b) parent.set(a, b);
  }

  // Two unknowns are connected if they appear in the same constraint
  for (const c of constraints) {
    if (c.unknowns.length < 2) continue;
    for (let i = 1; i < c.unknowns.length; i++) {
      union(c.unknowns[0], c.unknowns[i]);
    }
  }

  // Group unknowns and constraints by component root
  const groups = new Map();
  for (const c of constraints) {
    if (c.unknowns.length === 0) continue;
    const root = find(c.unknowns[0]);
    if (!groups.has(root)) groups.set(root, { unknowns: new Set(), constraints: [] });
    const g = groups.get(root);
    for (const u of c.unknowns) g.unknowns.add(u);
    g.constraints.push(c);
  }

  return [...groups.values()].map(g => ({
    unknowns: [...g.unknowns],
    constraints: g.constraints,
  }));
}

// ── Tank Solver: brute-force enumeration ──────────────────────
// For each valid binary assignment of unknowns, track which cells
// are mine in ALL solutions and which are safe in ALL solutions.

function tankSolve(unknowns, constraints, result) {
  const n = unknowns.length;
  if (n === 0) return;

  // Map unknown cell indices to bit positions 0..n-1
  const idxMap = new Map();
  unknowns.forEach((u, i) => idxMap.set(u, i));

  // Pre-compute constraint bitmasks for fast checking
  const cInfo = constraints.map(c => ({
    mask: c.unknowns.reduce((m, u) => m | (1 << idxMap.get(u)), 0),
    mines: c.mines,
  }));

  let alwaysMine = (1 << n) - 1; // bits that are 1 in ALL valid assignments
  let alwaysSafe = (1 << n) - 1; // bits that are 0 in ALL valid assignments
  let validCount = 0;

  const limit = 1 << n;
  for (let asgn = 0; asgn < limit; asgn++) {
    let valid = true;
    for (const { mask, mines } of cInfo) {
      if (popcount(asgn & mask) !== mines) {
        valid = false;
        break;
      }
    }
    if (!valid) continue;

    validCount++;
    alwaysMine &= asgn;
    alwaysSafe &= ~asgn;

    // Early exit: if nothing is forced anymore, no point continuing
    if (alwaysMine === 0 && alwaysSafe === 0) return;
  }

  if (validCount === 0) return; // contradictory constraints — shouldn't happen

  for (let i = 0; i < n; i++) {
    if (alwaysMine & (1 << i)) result.mines.add(unknowns[i]);
    if (alwaysSafe & (1 << i)) result.safe.add(unknowns[i]);
  }
}

// Fast popcount (Hamming weight) for 32-bit integers
function popcount(x) {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  return ((x + (x >> 4)) & 0x0f0f0f0f) * 0x01010101 >>> 24;
}

// ── Gaussian Elimination for larger components ────────────────
// Row-reduce the constraint matrix over integers to find
// any variables that are forced to 0 or 1.

function gaussSolve(unknowns, constraints, result) {
  const n = unknowns.length;
  const m = constraints.length;
  const colMap = new Map();
  unknowns.forEach((u, i) => colMap.set(u, i));

  // Build augmented matrix [A | b] with integer entries
  const matrix = constraints.map(c => {
    const row = new Array(n + 1).fill(0);
    for (const u of c.unknowns) row[colMap.get(u)] = 1;
    row[n] = c.mines;
    return row;
  });

  // Row-reduce using integer arithmetic
  // Since all initial coefficients are 0 or 1, pivots are always ±1,
  // and row subtraction keeps entries as small integers.
  let pivotRow = 0;
  for (let col = 0; col < n && pivotRow < m; col++) {
    // Find a row with non-zero entry in this column
    let found = -1;
    for (let r = pivotRow; r < m; r++) {
      if (matrix[r][col] !== 0) { found = r; break; }
    }
    if (found === -1) continue;

    // Swap to pivot position
    if (found !== pivotRow) {
      [matrix[pivotRow], matrix[found]] = [matrix[found], matrix[pivotRow]];
    }

    // Eliminate this column from all other rows
    const pv = matrix[pivotRow][col];
    for (let r = 0; r < m; r++) {
      if (r === pivotRow || matrix[r][col] === 0) continue;
      const factor = matrix[r][col] / pv;
      for (let c = col; c <= n; c++) {
        matrix[r][c] -= factor * matrix[pivotRow][c];
      }
    }

    pivotRow++;
  }

  // Extract forced variables from reduced matrix
  for (let r = 0; r < m; r++) {
    const vars = [];
    for (let c = 0; c < n; c++) {
      if (Math.abs(matrix[r][c]) > 0.001) {
        vars.push({ col: c, val: Math.round(matrix[r][c]) });
      }
    }
    if (vars.length === 0) continue;

    const rhs = Math.round(matrix[r][n]);

    // Single variable → directly determined
    if (vars.length === 1) {
      const v = rhs / vars[0].val;
      if (v === 1) result.mines.add(unknowns[vars[0].col]);
      else if (v === 0) result.safe.add(unknowns[vars[0].col]);
      continue;
    }

    // All coefficients are +1: standard minesweeper constraint form
    if (vars.every(v => v.val === 1)) {
      if (rhs === vars.length) {
        // All must be mines
        for (const v of vars) result.mines.add(unknowns[v.col]);
      } else if (rhs === 0) {
        // All must be safe
        for (const v of vars) result.safe.add(unknowns[v.col]);
      }
    }

    // All coefficients are -1: inverted form (-x1 - x2 - ... = -k → x1+x2+...=k)
    if (vars.every(v => v.val === -1)) {
      const posRhs = -rhs;
      if (posRhs === vars.length) {
        for (const v of vars) result.mines.add(unknowns[v.col]);
      } else if (posRhs === 0) {
        for (const v of vars) result.safe.add(unknowns[v.col]);
      }
    }
  }
}
