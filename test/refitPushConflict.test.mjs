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
import { readFileSync, existsSync } from 'node:fs';
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
    'scripts/data/match-library/match-summary.json',
    'scripts/data/climb-library/level-030.json',
    'src/logic/challengePool.js',
  ]);
  assert.equal(v.resolvable, true);
  assert.equal(v.derived.length, 3);
  assert.deepEqual(v.unexpected, []);
});

test('THE INCIDENT ITSELF: a lone match-library index file resolves', () => {
  const v = classifyConflicts(['scripts/data/match-library/match-summary.json']);
  assert.equal(v.resolvable, true,
    // The 2026-08-13 conflict was in match-index.json, which the index split
    // replaced with match-summary.json plus per-shape shards. The incident is
    // the same one; the fixture names a file the producer can still emit,
    // because a fixture for a file nothing writes proves nothing.
    'the match library index is derived data and a conflict in it is resolvable');
});

test('a conflict touching anything else is REFUSED, not papered over', () => {
  for (const path of [
    'src/logic/difficulty.js',          // a fit output: nothing else writes it
    'src/logic/experimentTarget.json',
    'src/main.js',                      // not the refit's at all
    'CLAUDE.md',
  ]) {
    const v = classifyConflicts(['scripts/data/match-library/match-summary.json', path]);
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

// ── The direction the lockstep did NOT cover (2026-08-18) ───────────────
//
// The tests above check that everything the refit STAGES is classified. The
// bug that broke three nightly runs was the other way round: the pool
// repricer rewrites scripts/data/pool-features.json, a TRACKED file, and the
// commit step never staged it. So every run committed with a dirty working
// tree, which nobody notices until a human pushes to main while Stan is
// sampling. Then the push is rejected, `git rebase` REFUSES TO START on a
// dirty tree, `git diff --diff-filter=U` is empty because no rebase began,
// the classifier correctly reports nothing conflicted, and the else branch
// runs `git rebase --abort` with no rebase in progress, which under `set -e`
// kills the step with a bare 128 before the diagnostic can print.
//
// This scans what the nightly actually RUNS and asserts every tracked data
// file it can write is staged.

test('REGRESSION: every tracked data file the nightly writes is staged', () => {
  const staged = stagedPaths();
  const covered = (p) => staged.some((s) => p === s || p.startsWith(`${s}/`));

  // The scripts the workflow itself invokes, read from the workflow so a new
  // step joins this check with no edit here.
  const scripts = [...new Set([...WF.matchAll(/node (scripts\/[a-z0-9-]+\.mjs)/g)].map((m) => m[1]))];
  assert.ok(scripts.length >= 8,
    `only ${scripts.length} nightly scripts parsed; the workflow's shape moved`);

  // Ignored files are caches by design and must NOT be committed.
  const ignored = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  // Glob matching by hand rather than by regex: the patterns are simple
  // (a trailing slash, at most one star) and a hand-escaped regex is one
  // lost backslash away from silently matching nothing.
  const isIgnored = (p) => ignored.some((pat) => {
    const base = p.split('/').pop();
    if (pat.endsWith('/')) return p.startsWith(pat);
    if (pat.includes('*')) {
      const [head, tail] = pat.split('*');
      return (p.startsWith(head) && p.endsWith(tail))
        || (base.startsWith(head) && base.endsWith(tail));
    }
    return p === pat || base === pat;
  });

  const offenders = [];
  for (const rel of scripts) {
    let src;
    try { src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'); } catch { continue; }
    for (const m of src.matchAll(/'([A-Za-z0-9._-]+\.json)'/g)) {
      for (const dir of ['scripts/data/', 'src/logic/']) {
        const path = dir + m[1];
        if (!existsSync(new URL(`../${path}`, import.meta.url))) continue;
        if (isIgnored(path) || covered(path)) continue;
        offenders.push(`${path} (written by ${rel})`);
      }
    }
  }
  assert.deepEqual([...new Set(offenders)], [],
    'these tracked files a nightly script writes are NOT in the commit step\'s `git add`, '
    + 'so the refit commits with a dirty tree and its rebase retry cannot start. Stage them '
    + '(and classify them in scripts/refit-push-conflict.mjs), or gitignore them if caches.');
});

test('the rebase retry survives a dirty tree and never swallows its diagnostic', () => {
  // --autostash: a rebase refuses to start on a dirty tree. The staged set is
  // the real fix; this is the guard that keeps the next stray file from
  // costing another night.
  assert.ok(WF.includes('git rebase --autostash origin/main'),
    'the retry must rebase with --autostash so a stray unstaged file cannot stop it');
  // `|| true` on the abort, or `set -e` kills the step before the ::error.
  assert.ok(WF.includes('git rebase --abort || true'),
    'aborting a rebase that never started must not kill the step before its error prints');
});
