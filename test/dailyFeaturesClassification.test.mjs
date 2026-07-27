// Which dailyMeta features are SOLVER-derived and which are pure STRUCTURE —
// the split the nightly canonical sweep's hard-fail-vs-warn decision rests on.
//
// Issue #180: the sweep kept its own hand-written ALLOWLIST of structural key
// names. Two of them (`wormholeCellCount` / `mirrorCellCount`) named fields
// computeDailyFeatures never emits — it emits the PAIR counts — and because
// the comparison loop iterates the RECOMPUTED keys, those dead names matched
// nothing while both real modifier counts fell through to warn-only with the
// workflow staying green. Everything the allowlist simply never mentioned
// (density, gimmickTypeCount, nonZeroSafeCellCount, zeroClusterCount — a
// SHIPPED par predictor — and the four clueShare*) was unguarded the same way.
//
// The fix inverts the default: structural unless the PRODUCER tags it
// solver-derived. That only holds if the tag list is right, so these pin it by
// DIFFERENTIAL rather than by eye — compute the vector twice over one real
// board with two different solverResults and see which keys actually move.
// A name that drifts, or a new solver-fed key, breaks this immediately.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { computeDailyFeatures, SOLVER_DERIVED_FEATURE_KEYS } =
  await import('../src/logic/dailyFeatures.js');
const { deserializeBoard } = await import('../src/firebase/dailyBoardSync.js');

const dailyRaw = JSON.parse(readFileSync(new URL('./fixtures/dailyBoard-2026-06-14.json', import.meta.url), 'utf8'));

function stateFor(raw) {
  const d = deserializeBoard(raw);
  return {
    board: d.board, rows: d.rows, cols: d.cols, totalMines: d.totalMines,
    activeGimmicks: d.activeGimmicks, rngSeed: d.rngSeed || '',
  };
}

// Two solver verdicts that share NO value on any field, so a key which reads
// the solver cannot coincidentally agree across them. Distinct primes, and a
// zero baseline, because `solverResult.x ?? 0` makes a missing field read 0 —
// an all-zero A therefore also covers the "field absent" shape.
const SOLVER_A = {
  passAMoves: 0, canonicalSubsetMoves: 0, genericSubsetMoves: 0,
  advancedLogicMoves: 0, disjunctiveMoves: 0, totalClicks: 0,
  remainingUnknowns: 0, techniqueLevel: 0,
};
const SOLVER_B = {
  passAMoves: 7, canonicalSubsetMoves: 11, genericSubsetMoves: 13,
  advancedLogicMoves: 17, disjunctiveMoves: 19, totalClicks: 23,
  remainingUnknowns: 29, techniqueLevel: 3,
};

test('REGRESSION #180: exactly the tagged keys move when the solver verdict changes', () => {
  const a = computeDailyFeatures(stateFor(dailyRaw), SOLVER_A);
  const b = computeDailyFeatures(stateFor(dailyRaw), SOLVER_B);

  const moved = Object.keys(b).filter((k) => a[k] !== b[k]).sort();
  const tagged = [...SOLVER_DERIVED_FEATURE_KEYS].sort();

  // Both directions matter, and they catch opposite bugs. A tagged key that
  // does NOT move is a dead name — the #180 defect exactly, a guard that
  // cannot fire. An untagged key that DOES move would be silently warned
  // when the sweep should be failing on it.
  assert.deepEqual(moved, tagged,
    'the keys that follow the solver must be exactly SOLVER_DERIVED_FEATURE_KEYS');
});

test('REGRESSION #180: every tagged key is actually emitted by computeDailyFeatures', () => {
  // The literal #180 failure: a name in the list that the producer never
  // emits matches nothing, so the guard it stands for silently does not exist.
  const emitted = computeDailyFeatures(stateFor(dailyRaw), SOLVER_B);
  for (const key of SOLVER_DERIVED_FEATURE_KEYS) {
    assert.ok(key in emitted, `SOLVER_DERIVED_FEATURE_KEYS names "${key}", which is never emitted`);
  }
});

test('the features #180 left unguarded are structural, and stay that way', () => {
  const emitted = computeDailyFeatures(stateFor(dailyRaw), SOLVER_B);
  const unguardedBefore = [
    'density', 'gimmickTypeCount', 'nonZeroSafeCellCount', 'zeroClusterCount',
    'clueShare2', 'clueShare3', 'clueShare4', 'clueShare5plus',
    'wormholePairCount', 'mirrorPairCount',
  ];
  for (const key of unguardedBefore) {
    assert.ok(key in emitted, `${key} must still be emitted`);
    assert.ok(!SOLVER_DERIVED_FEATURE_KEYS.includes(key),
      `${key} is pure structure — tagging it solver-derived would re-disarm its guard`);
  }
});

test('the sweep reads the producer\'s tag rather than keeping its own list', () => {
  // The "one source both sides read" contract from #180's suggested direction.
  // A future edit that reintroduces a local allowlist reopens the whole class,
  // so it is asserted against the source text, like the scrub-coverage gate.
  const src = readFileSync(new URL('../scripts/verify-canonical-boards.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{[^}]*SOLVER_DERIVED_FEATURE_KEYS[^}]*\} from '\.\.\/src\/logic\/dailyFeatures\.js'/,
    'the sweep must import the tag from computeDailyFeatures, not restate it');
  assert.doesNotMatch(src, /STRUCTURAL_FEATURE_KEYS/,
    'a local structural allowlist is what #180 was about — the default must be structural');
});
