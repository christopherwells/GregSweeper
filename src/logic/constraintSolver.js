// ── Advanced Constraint Solver for Minesweeper ────────────────
// Two-layer solver that goes beyond simple rule + subset analysis.
// Layer 1: Tank Solver — partition-based brute-force enumeration
//          for small connected components (≤20 unknowns).
// Layer 2: Gaussian Elimination — integer row-reduction for
//          larger components, extracting forced variables.
//
// Constraint format: { unknowns: cellIdx[], allowedMines: number[], origin? }
// The mine count among `unknowns` must equal one of the `allowedMines`
// values. Single-element = exact constraint (normal cell). Multi-element
// = disjunctive (liar: { display-1, display+1 }). `origin` (optional) is
// the cell index that produced the constraint — provenance for the
// deduction trace, the Socratic lens, and per-deduction disjunctive
// attribution. Constraints without an origin solve identically; they just
// contribute nothing to a group's explanation.

const TANK_LIMIT = 20; // max unknowns per component for enumeration (2^20 ≈ 1M)

/**
 * Given a set of constraints over binary (0/1) unknowns, determine which
 * cells are provably mines or provably safe across ALL satisfying assignments.
 *
 * Besides the flat mines/safe sets the result carries provenance:
 *   groups[g]   = { unknowns, hasDisjunctive, origins } per independent
 *                 union-find component (origins = source cells of its
 *                 constraints — the honest "where the proof lives" region).
 *   cellGroup   = Map cellIdx → g for every solved cell, so a caller can
 *                 attribute each deduction to ITS component instead of
 *                 batch-flagging the whole round (the old disjunctiveMoves
 *                 inflation on liar boards).
 *   contradiction = true when a tank component admits ZERO satisfying
 *                 assignments — on live player state this means at least
 *                 one flag is provably wrong.
 *
 * @param {Array<{unknowns: number[], allowedMines: number[], origin?: number}>} constraints
 * @returns {{ mines: Set<number>, safe: Set<number>, groups: Array, cellGroup: Map, contradiction: boolean }}
 */
export function solveConstraints(constraints) {
  const result = { mines: new Set(), safe: new Set(), groups: [], cellGroup: new Map(), contradiction: false };
  if (constraints.length === 0) return result;

  const components = findComponents(constraints);

  for (const comp of components) {
    const compResult = { mines: new Set(), safe: new Set() };
    if (comp.unknowns.length <= TANK_LIMIT) {
      const satisfiable = tankSolve(comp.unknowns, comp.constraints, compResult);
      if (!satisfiable) result.contradiction = true;
    } else {
      // Gauss elimination only handles exact constraints; strip the disjunctive
      // (liar) ones for large components. They still contributed to component
      // partitioning above so the solver doesn't miss cross-constraint links.
      const exact = comp.constraints.filter(c => c.allowedMines.length === 1);
      gaussSolve(comp.unknowns, exact, compResult);
    }

    const gIdx = result.groups.length;
    const origins = [];
    const seen = new Set();
    for (const c of comp.constraints) {
      if (c.origin != null && !seen.has(c.origin)) { seen.add(c.origin); origins.push(c.origin); }
    }
    result.groups.push({
      unknowns: comp.unknowns,
      hasDisjunctive: comp.constraints.some(c => c.allowedMines.length > 1),
      origins,
    });
    for (const m of compResult.mines) { result.mines.add(m); result.cellGroup.set(m, gIdx); }
    for (const s of compResult.safe) { result.safe.add(s); result.cellGroup.set(s, gIdx); }
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

// Returns true when at least one satisfying assignment exists (false =
// the component's constraints are contradictory — on live player state
// that means a wrong flag poisoned the system).
function tankSolve(unknowns, constraints, result) {
  const n = unknowns.length;
  if (n === 0) return true;

  // Map unknown cell indices to bit positions 0..n-1
  const idxMap = new Map();
  unknowns.forEach((u, i) => idxMap.set(u, i));

  // Pre-compute constraint bitmasks and per-constraint allowed mine counts.
  const cCount = constraints.length;
  const masks = new Int32Array(cCount);
  const allowedSets = new Array(cCount);
  for (let i = 0; i < cCount; i++) {
    let m = 0;
    for (const u of constraints[i].unknowns) m |= (1 << idxMap.get(u));
    masks[i] = m;
    allowedSets[i] = constraints[i].allowedMines;
  }

  const allBits = n === 32 ? -1 : ((1 << n) - 1);
  let alwaysMine = allBits;
  let alwaysSafe = allBits;
  let validCount = 0;

  // Brute-force enumeration. For each assignment, every constraint's mine
  // count must be in its allowed set. Disjunctive (liar) constraints have
  // multiple allowed values; exact constraints have one.
  const limit = 1 << n;
  for (let asgn = 0; asgn < limit; asgn++) {
    let valid = true;
    for (let i = 0; i < cCount; i++) {
      const cnt = popcount(asgn & masks[i]);
      const allowed = allowedSets[i];
      let ok = false;
      for (let j = 0; j < allowed.length; j++) {
        if (allowed[j] === cnt) { ok = true; break; }
      }
      if (!ok) { valid = false; break; }
    }
    if (!valid) continue;

    validCount++;
    alwaysMine &= asgn;
    alwaysSafe &= ~asgn;

    if (alwaysMine === 0 && alwaysSafe === 0) return true;
  }

  if (validCount === 0) return false; // contradictory constraints (wrong flag on live state)

  for (let i = 0; i < n; i++) {
    if (alwaysMine & (1 << i)) result.mines.add(unknowns[i]);
    if (alwaysSafe & (1 << i)) result.safe.add(unknowns[i]);
  }
  return true;
}

// Fast popcount (Hamming weight) for 32-bit integers
function popcount(x) {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  return ((x + (x >> 4)) & 0x0f0f0f0f) * 0x01010101 >>> 24;
}

// ── Gaussian Elimination for larger components ────────────────
// Row-reduce the constraint matrix and extract variables that are
// forced to 0 or 1. Gauss is allowed to be INCOMPLETE (a missed
// deduction just means "couldn't prove it"), but it must never be
// UNSOUND: a false "provable mine / provably safe" poisons the
// certifier and every player-facing verdict built on it.
//
// The old version rounded float coefficients with Math.round before
// pattern-matching rows — a fractional entry like 0.5 (which 0/1
// systems legitimately produce under elimination) was read as 1, and
// the row then "proved" cells that nothing proved. Found 2026-06-10 as
// 17/360 monotonicity violations in the reveal-gating probe (boards
// certifying WITH FEWER constraints because the extra constraints
// routed a big component into the unsound gauss path).

// A row only yields deductions when every coefficient and the RHS sit
// within SNAP_EPS of an integer. True fractional values arising in 0/1
// systems are ratios of small minors (1/2, 1/3, 2/3, ...) — never
// closer to an integer than ~1/1000 in components this size — while
// float noise on genuinely-integer entries stays orders of magnitude
// below this. Rows that fail the snap are SKIPPED, never rounded.
const SNAP_EPS = 1e-6;

function gaussSolve(unknowns, constraints, result) {
  const n = unknowns.length;
  const m = constraints.length;
  const colMap = new Map();
  unknowns.forEach((u, i) => colMap.set(u, i));

  // Build augmented matrix [A | b].
  // Caller (solveConstraints) already filtered to single-allowed constraints,
  // so allowedMines[0] is the exact mine count.
  const matrix = constraints.map(c => {
    const row = new Array(n + 1).fill(0);
    for (const u of c.unknowns) row[colMap.get(u)] = 1;
    row[n] = c.allowedMines[0];
    return row;
  });

  // Row-reduce with partial pivoting (largest |entry| in the column) to
  // keep the float arithmetic well-conditioned.
  let pivotRow = 0;
  for (let col = 0; col < n && pivotRow < m; col++) {
    let found = -1;
    let best = SNAP_EPS;
    for (let r = pivotRow; r < m; r++) {
      const a = Math.abs(matrix[r][col]);
      if (a > best) { best = a; found = r; }
    }
    if (found === -1) continue;

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

  // Extract forced variables. For a row Σ c_i·x_i = b over binary x:
  //   max achievable = Σ positive c_i  (positives at 1, negatives at 0)
  //   min achievable = Σ negative c_i  (positives at 0, negatives at 1)
  // b == max forces every positive-coefficient var to 1 (mine) and every
  // negative-coefficient var to 0 (safe); b == min is the mirror image.
  // This is the standard sound bound rule — it subsumes the old
  // single-variable / all-(+1) / all-(−1) special cases.
  for (let r = 0; r < m; r++) {
    const vars = [];
    let snapped = true;
    for (let c = 0; c < n; c++) {
      const raw = matrix[r][c];
      const val = Math.round(raw);
      if (Math.abs(raw - val) > SNAP_EPS) { snapped = false; break; }
      if (val !== 0) vars.push({ col: c, val });
    }
    if (!snapped || vars.length === 0) continue;
    const rawRhs = matrix[r][n];
    const rhs = Math.round(rawRhs);
    if (Math.abs(rawRhs - rhs) > SNAP_EPS) continue;

    let minSum = 0, maxSum = 0;
    for (const v of vars) {
      if (v.val > 0) maxSum += v.val;
      else minSum += v.val;
    }

    if (rhs === maxSum) {
      for (const v of vars) {
        if (v.val > 0) result.mines.add(unknowns[v.col]);
        else result.safe.add(unknowns[v.col]);
      }
    } else if (rhs === minSum) {
      for (const v of vars) {
        if (v.val > 0) result.safe.add(unknowns[v.col]);
        else result.mines.add(unknowns[v.col]);
      }
    }
  }
}
