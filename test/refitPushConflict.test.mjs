// The nightly refit's push-conflict rule (scripts/refit-push-conflict.mjs).
//
// REGRESSION, 2026-08-13: the refit fitted cleanly, committed 327 files, lost
// a three-minute race with a merged PR, and its rebase hit a conflict in
// scripts/data/match-library/match-index.json that the PR had also rewritten.
// `git pull --rebase || exit 1` discarded the entire night, model included.
//
// The deeper failure is the one this file is really about. The retry's comment
// said the commit touched only refit-owned files, which was true when written;
// the `git add` list later grew to include generated library data, and NOTHING
// forced whoever grew it to notice the reasoning no longer covered it. So the
// load-bearing test here is not the classifier, it is the LOCKSTEP: every path
// the workflow commits must be classified, and a new one that is neither a fit
// output nor derived data reddens this file until someone decides which it is.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  FIT_OUTPUT_PATHS, DERIVED_PATHS, REDERIVE_COMMANDS,
  isDerivedPath, isFitOutputPath, classifyConflicts,
} from '../scripts/refit-push-conflict.mjs';

const WF = readFileSync(new URL('../.github/workflows/refit-par-model.yml', import.meta.url), 'utf8');

// ── The lockstep that would have caught the incident ────────────────────

/** The paths the workflow's commit step actually stages. */
function stagedPaths() {
  const line = WF.split('\n').find((l) => l.trim().startsWith('git add '));
  assert.ok(line, 'the refit workflow no longer has a `git add` line to check');
  return line.trim().replace(/^git add /, '').split(/\s+/).filter(Boolean);
}

test('REGRESSION: every path the refit commits is classified', () => {
  const staged = stagedPaths();
  assert.ok(staged.length >= 6, `only ${staged.length} staged paths parsed: the step's shape moved`);
  const unclassified = staged.filter((p) => !isDerivedPath(p) && !isFitOutputPath(p));
  assert.deepEqual(unclassified, [],
    'these paths are staged by the refit but are neither a fit output nor derived data. '
    + 'Decide which they are in scripts/refit-push-conflict.mjs: a fit output stops the run '
    + 'on conflict, derived data is re-derived. Leaving one unclassified is what threw away '
    + 'the 2026-08-13 refit.');
});

test('the classification covers the staged set in BOTH directions', () => {
  // A path listed here but no longer committed is dead weight that would let
  // the check above pass while covering nothing real.
  const staged = new Set(stagedPaths());
  for (const p of [...FIT_OUTPUT_PATHS, ...DERIVED_PATHS]) {
    assert.ok(staged.has(p), `${p} is classified but the refit no longer commits it`);
  }
});

test('the workflow re-derives with the commands this module names', () => {
  for (const cmd of REDERIVE_COMMANDS) {
    assert.ok(WF.includes(cmd), `the push step must run \`${cmd}\` when re-deriving`);
  }
  // And it must consult the classifier rather than resolving blind.
  assert.ok(WF.includes('node scripts/refit-push-conflict.mjs'),
    'the push step must ask refit-push-conflict.mjs before auto-resolving');
  assert.ok(/git checkout origin\/main -- /.test(WF),
    're-deriving starts from what main holds, never from --ours/--theirs, whose '
    + 'meaning inverts during a rebase');
  assert.ok(!/git pull --rebase --autostash origin main \|\| exit 1/.test(WF),
    'the bare `|| exit 1` rebase is what discarded the night; it must not come back');
});

// ── The classifier ──────────────────────────────────────────────────────

test('a conflict confined to generated data is auto-resolvable', () => {
  const v = classifyConflicts([
    'scripts/data/match-library/match-index.json',
    'scripts/data/climb-library/level-030.json',
    'src/logic/challengePool.js',
  ]);
  assert.equal(v.resolvable, true);
  assert.equal(v.derived.length, 3);
  assert.deepEqual(v.unexpected, []);
});

test('THE INCIDENT ITSELF: match-index.json alone resolves', () => {
  const v = classifyConflicts(['scripts/data/match-library/match-index.json']);
  assert.equal(v.resolvable, true, 'the exact file that threw away 2026-08-13');
});

test('a conflict touching anything else is REFUSED, not papered over', () => {
  for (const path of [
    'src/logic/difficulty.js',          // a fit output: nothing else writes it
    'src/logic/experimentTarget.json',
    'src/main.js',                      // not the refit's at all
    'CLAUDE.md',
  ]) {
    const v = classifyConflicts(['scripts/data/match-library/match-index.json', path]);
    assert.equal(v.resolvable, false, `${path} must not be auto-resolved`);
    assert.deepEqual(v.unexpected, [path]);
  }
});

test('no conflicts is NOT resolvable: there is nothing to resolve', () => {
  // The caller only runs the resolution when a rebase actually failed, and an
  // empty list reporting "safe to re-derive" would let it checkout-and-reprice
  // over a clean tree for no reason.
  assert.equal(classifyConflicts([]).resolvable, false);
  assert.equal(classifyConflicts(['', '  ']).resolvable, false);
  assert.equal(classifyConflicts(null).resolvable, false);
});

test('path matching is by directory boundary, never a bare prefix', () => {
  assert.equal(isDerivedPath('scripts/data/match-library/match-000.json'), true);
  assert.equal(isDerivedPath('scripts/data/match-library'), true);
  // The trap: a sibling directory whose name starts with a classified one.
  assert.equal(isDerivedPath('scripts/data/match-library-backup/x.json'), false);
  assert.equal(isFitOutputPath('src/logic/difficulty.js.orig'), false);
  assert.equal(isFitOutputPath('src/logic/difficulty.js'), true);
});

test('the two classes do not overlap', () => {
  for (const p of FIT_OUTPUT_PATHS) {
    assert.equal(isDerivedPath(p), false, `${p} cannot be both`);
  }
  for (const p of DERIVED_PATHS) {
    assert.equal(isFitOutputPath(p), false, `${p} cannot be both`);
  }
});
