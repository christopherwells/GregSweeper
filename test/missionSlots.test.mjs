// Candidate-slot → mission arithmetic. The daily board is chosen by scoring
// CANDIDATE_COUNT candidate seeds, one mission per slot, and that mapping is
// consumed by TWO paths that must agree exactly or they select different
// boards: the client (selectDailyRngSeed / parResolve, via
// experimentDesign.getMissionForSlot) and the Node precompute
// (daily-board-pipeline.missionForSlot).
//
// REGRESSION (found 2026-07-18 during the PR F decorrelation feasibility
// sweep): the two carried SEPARATE copies of the arithmetic and had drifted.
// The pipeline wrapped — `coverage_targets[(slotIndex - 1) % length]` — where
// the client returned null, so with the live 7-to-8-entry coverage list the
// precompute evaluated slots 8 and 9 as duplicates of coverage[0]/[1] and
// could pick a `:trial8`/`:trial9` seed the client would never choose. Actual
// play still converged (clients read the written canonical verbatim), but
// parResolve's pre-play par estimate re-runs the client's no-wrap selection
// and could land on a different board than the date's canonical, quoting a
// par for a board nobody plays. Both paths now delegate to one pure
// resolveMissionForSlot, so the copies cannot drift again.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resolveMissionForSlot, getMissionForSlot } =
  await import('../src/logic/experimentDesign.js');
const { missionForSlot } = await import('../scripts/daily-board-pipeline.mjs');

// Mirrors the live experimentTarget.json shape (feature + deficit_weight).
const coverage = (n) => Array.from({ length: n }, (_, i) => ({
  feature: `feature${i}`,
  deficit_weight: 0.5 / (i + 1),
}));

const CANDIDATE_COUNT = 10; // mirrors both selection loops

test('REGRESSION: the precompute and client agree on every candidate slot', () => {
  // The live list has been 7-8 entries, which is exactly the range where the
  // old modulo-wrap diverged from the client's no-wrap. Cover shorter, equal,
  // and longer than the candidate count.
  for (const n of [0, 1, 5, 7, 8, 9, 12]) {
    const spec = { target: 'primaryFeature', coverage_targets: coverage(n) };
    for (let slot = 0; slot < CANDIDATE_COUNT; slot++) {
      const fromPipeline = missionForSlot(spec, slot);
      const fromShared = resolveMissionForSlot(slot, spec.target, spec.coverage_targets);
      assert.deepEqual(
        fromPipeline, fromShared,
        `slot ${slot} with a ${n}-entry coverage list must resolve identically`,
      );
    }
  }
});

test('no-wrap: slots past the coverage list have no mission, never a duplicate', () => {
  const spec = { target: 'primaryFeature', coverage_targets: coverage(7) };
  // Slots 1..7 map one-to-one onto the coverage list.
  for (let slot = 1; slot <= 7; slot++) {
    assert.equal(missionForSlot(spec, slot).target, `feature${slot - 1}`);
  }
  // Slots 8 and 9 are the ones the old wrap aliased back onto coverage[0]
  // and coverage[1], giving the two most-undersampled features double slots
  // and silently halving everything below them.
  assert.equal(missionForSlot(spec, 8), null, 'slot 8 must not wrap to coverage[0]');
  assert.equal(missionForSlot(spec, 9), null, 'slot 9 must not wrap to coverage[1]');
});

test('slot 0 is the primary mission; an empty coverage list collapses to primary', () => {
  const spec = { target: 'primaryFeature', coverage_targets: coverage(7) };
  const primary = missionForSlot(spec, 0);
  assert.equal(primary.target, 'primaryFeature');
  assert.equal(primary.isPrimary, true);
  assert.equal(primary.singleOnly, false, 'the primary slot may roll a second gimmick');

  // Legacy / offline shape: no coverage list, so every slot optimises the
  // primary target (the pre-multi-objective behaviour).
  const legacy = { target: 'primaryFeature', coverage_targets: [] };
  for (let slot = 0; slot < CANDIDATE_COUNT; slot++) {
    const m = missionForSlot(legacy, slot);
    assert.equal(m.target, 'primaryFeature');
    assert.equal(m.isPrimary, true);
  }
});

test('coverage slots are single-gimmick and carry their deficit weight', () => {
  const spec = { target: 'primaryFeature', coverage_targets: coverage(3) };
  const m = missionForSlot(spec, 2);
  assert.equal(m.target, 'feature1');
  assert.equal(m.isPrimary, false);
  assert.equal(m.singleOnly, true, 'coverage slots never roll a second gimmick');
  assert.equal(m.deficitWeight, 0.25);

  // A malformed entry (no numeric weight) falls back rather than poisoning
  // the score with NaN.
  const malformed = { target: 'p', coverage_targets: [{ feature: 'f' }] };
  assert.equal(resolveMissionForSlot(1, malformed.target, malformed.coverage_targets).deficitWeight, 0.1);
});

test('the client entry point resolves through the same shared arithmetic', () => {
  // getMissionForSlot supplies the fetch-cached target/coverage; with no
  // experimentTarget loaded in a test process the coverage list is empty, so
  // every slot must collapse to the primary default exactly as the shared
  // function does for an empty list.
  const viaClient = getMissionForSlot(0);
  const viaShared = resolveMissionForSlot(0, viaClient.target, []);
  assert.deepEqual(viaClient, viaShared);
});
