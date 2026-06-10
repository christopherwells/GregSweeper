// Gauss-path soundness: components larger than the tank limit (20
// unknowns) fall to Gaussian elimination, which may be INCOMPLETE (a
// missed deduction is honest) but must never be UNSOUND. The old
// extraction Math.round()ed float coefficients before pattern-matching —
// elimination of 0/1 systems legitimately produces fractional entries
// (0.5 rounds to 1), and on unsatisfiable systems (a wrong player flag)
// it fabricated "provable mine" verdicts out of nothing.
//
// Run: node --test test/gaussSoundness.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { solveConstraints } from '../src/logic/constraintSolver.js';
import { createDailyRNG } from '../src/logic/seededRandom.js';

const exact = (unknowns, count) => ({ unknowns, allowedMines: [count] });

test('unsatisfiable odd cycle must not fabricate deductions (old rounding bug)', () => {
  // x0+x1=1, x1+x2=1, x0+x2=1 has NO binary solution (reals force all
  // three to 0.5). Pad with a chain so the component exceeds the tank
  // limit and routes to gauss. The old code row-reduced to x0 = 0.5,
  // rounded the right-hand side to 1, and certified x0 a provable mine.
  const constraints = [
    exact([0, 1], 1),
    exact([1, 2], 1),
    exact([0, 2], 1),
  ];
  for (let v = 2; v < 25; v++) constraints.push(exact([v, v + 1], 1));

  const solved = solveConstraints(constraints);
  for (const v of [0, 1, 2]) {
    assert.ok(!solved.mines.has(v), `cycle var ${v} must not be certified a mine`);
    assert.ok(!solved.safe.has(v), `cycle var ${v} must not be certified safe`);
  }
});

test('gauss deductions never contradict a ground-truth witness (seeded sweep)', () => {
  // Build random satisfiable systems from a known assignment: every
  // constraint's count is computed FROM the witness, so the witness
  // satisfies the system by construction. A cell deduced "mine" must be
  // 1 in every solution — in particular in the witness; same for "safe"
  // and 0. The old rounding bug showed up exactly as deductions
  // contradicting ground truth.
  const rng = createDailyRNG('gauss-soundness-sweep');
  const N_SYSTEMS = 200;
  const N_VARS = 26; // > TANK_LIMIT so the component routes to gauss

  for (let s = 0; s < N_SYSTEMS; s++) {
    const truth = Array.from({ length: N_VARS }, () => (rng() < 0.35 ? 1 : 0));

    const constraints = [];
    // A chain keeps everything in ONE component.
    for (let v = 0; v + 1 < N_VARS; v++) {
      constraints.push(exact([v, v + 1], truth[v] + truth[v + 1]));
    }
    // Random small constraints (cell-number-like, 3-6 cells).
    for (let k = 0; k < 12; k++) {
      const size = 3 + Math.floor(rng() * 4);
      const cells = new Set();
      while (cells.size < size) cells.add(Math.floor(rng() * N_VARS));
      const list = [...cells];
      constraints.push(exact(list, list.reduce((acc, v) => acc + truth[v], 0)));
    }
    // One wide constraint (sonar-like, ~20 cells) — the shape that
    // merges components past the tank limit in real ungated solves.
    const wide = new Set();
    while (wide.size < 20) wide.add(Math.floor(rng() * N_VARS));
    const wideList = [...wide];
    constraints.push(exact(wideList, wideList.reduce((acc, v) => acc + truth[v], 0)));

    const solved = solveConstraints(constraints);
    for (const m of solved.mines) {
      assert.equal(truth[m], 1, `system ${s}: cell ${m} certified mine but witness says safe`);
    }
    for (const sf of solved.safe) {
      assert.equal(truth[sf], 0, `system ${s}: cell ${sf} certified safe but witness says mine`);
    }
  }
});
