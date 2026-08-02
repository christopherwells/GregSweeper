// Validate the ENTIRE Par Lab battery offline: every spec must generate a
// CERTIFIED board through the same builder the client uses
// (buildParLabBoard), within a generation-time budget. Generation is
// deterministic, so a spec that passes here passes forever on-device — this
// script is the design-time proof, run before any battery revision ships.
//
// Not in CI: the four Laves lattices at large sizes cost seconds each and
// the full run is minutes. test/parLab.test.mjs carries the structural
// guards plus a fast-shape generation sample; THIS run is the exhaustive
// one, re-run after any spec change:
//
//   node scripts/validate-parlab-battery.mjs
//
// Exit 1 on any failure (null build, uncertified, or over budget), with the
// offending ids listed so the spec (or its seed) can be retuned.

import { PAR_LAB_BATTERY, buildParLabBoard, parLabSeed } from '../src/logic/parLab.js';

const BUDGET_MS = 20000; // worst acceptable single-board generation

const failures = [];
let worst = { id: null, ms: 0 };
let totalMs = 0;

console.log(`Validating ${PAR_LAB_BATTERY.length} Par Lab boards...\n`);
for (const spec of PAR_LAB_BATTERY) {
  const t0 = Date.now();
  const res = buildParLabBoard(spec, 0);
  const ms = Date.now() - t0;
  totalMs += ms;
  if (ms > worst.ms) worst = { id: spec.id, ms };

  const label = `${spec.seq.toString().padStart(3)} ${spec.id.padEnd(22)} ${String(spec.mines).padStart(3)} mines`;
  if (!res) {
    failures.push(`${spec.id}: generation returned null (seed ${parLabSeed(spec, 0)})`);
    console.log(`  ✗ ${label} — NULL`);
    continue;
  }
  const certified = res.check && (res.check.solvable || res.check.remainingUnknowns === 0);
  if (!certified) {
    failures.push(`${spec.id}: board not certified`);
    console.log(`  ✗ ${label} — UNCERTIFIED`);
    continue;
  }
  if (ms > BUDGET_MS) {
    failures.push(`${spec.id}: ${ms} ms exceeds the ${BUDGET_MS} ms budget`);
  }
  const gimmickNote = spec.gimmicks.length ? ` +${spec.gimmicks.join(',')}` : '';
  console.log(`  ✓ ${label} ${String(ms).padStart(6)} ms  tier ${res.check.techniqueLevel || 0}${gimmickNote}`);
}

console.log(`\nTotal generation: ${(totalMs / 1000).toFixed(1)} s; worst single board: ${worst.id} at ${worst.ms} ms.`);
if (failures.length) {
  console.error(`\n*** ${failures.length} SPEC(S) FAILED ***`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('Every board in the battery generates certified. ✓');
