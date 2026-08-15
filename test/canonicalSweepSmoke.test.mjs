// The nightly sweep's pre-merge smoke: main() must RUN, over every key
// family, before 2 AM does.
//
// REGRESSION: verify-canonical-boards died twice in production on key
// families its loops had never seen. #260: the {weekStart}_weekly_first rows
// were looked up at a node that does not exist and silently dropped under a
// clean line. 2026-08-13/14: the first match_ row under daily/ made
// canonicalSeedPath return null, dbGet split null, and the thrown exception
// ended the whole scan two nights running. The pure verdict functions were
// unit-tested both times; the ORCHESTRATION had never run before production.
//
// This test replays main() over a committed snapshot
// (test/fixtures/canonical-sweep.json, rebuilt by
// scripts/build-sweep-fixture.mjs) whose clock is frozen inside the file, so
// the data stays "future" forever. The snapshot plants one divergent row and
// one key from a family nobody has invented yet, so the assertions prove
// DETECTION and SURVIVAL rather than mere completion — a smoke that only
// checks the exit code would pass a scan that quietly skipped everything
// (the vacuity class).
//
// If this reddens on a deliberate change (a feature definition moved, a
// solver change un-certifies the frozen board), that is the sweep's designed
// alarm surfacing at PR time instead of overnight: re-run the builder in the
// same PR, the fixture equivalent of the regenerate remediation.

import test from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixtureGet } from '../scripts/verify-canonical-boards.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/verify-canonical-boards.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/canonical-sweep.json', import.meta.url));

test('fixtureGet resolves paths the way Firebase would', () => {
  const db = { a: { b: { c: 'leaf' } }, list: { x: 1, y: 2 } };
  assert.equal(fixtureGet(db, 'a/b/c'), 'leaf');
  assert.equal(fixtureGet(db, 'a/b/missing'), null);
  assert.equal(fixtureGet(db, 'missing/deeper'), null);
  assert.deepEqual(fixtureGet(db, 'list?shallow=true'), { x: true, y: true });
  assert.deepEqual(fixtureGet(db, 'a/b'), { c: 'leaf' });
});

test('REGRESSION: the sweep completes over every daily/ key family and still detects', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--fixture', FIXTURE],
    { encoding: 'utf8', timeout: 180000 });
  const out = `${r.stdout}\n${r.stderr}`;

  // The scan must have RUN — this line is the tombstone of the 08-13/14
  // incident and must never appear on the fixture.
  assert.doesNotMatch(out, /SCAN DID NOT RUN/, out);

  // Exit 1 is the alarm FIRING, not the smoke failing: the snapshot plants a
  // divergent row precisely so a pass cannot be vacuous.
  assert.equal(r.status, 1, out);
  assert.match(out, /DIVERGENT SCORE ROW\(S\)/, out);
  assert.match(out, /planted-divergent-seed/, out);

  // The match family is counted as skipped-by-rule, never compared, never
  // fatal; the unknown family must be absorbed the same way (skipped or
  // counted, anything but a crash — the assertion above already proved no
  // crash, this one proves the rule-skip line still narrates it).
  assert.match(out, /match row\(s\) have no canonical/, out);

  // The future board actually verified (signature included), and fixture
  // mode announced itself so a fixture pass can never read as production.
  assert.match(out, /dailyBoard\/\S+ certifies/, out);
  assert.match(out, /FIXTURE MODE/, out);
});
