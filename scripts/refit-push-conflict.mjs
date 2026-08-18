// What the nightly refit should do when its push loses a race with a human
// merge (.github/workflows/refit-par-model.yml, "Commit and push if anything
// changed").
//
// THE INCIDENT, 2026-08-13. The refit fitted cleanly at 23:55, committed 327
// files at 00:23:55, and its push was rejected because a PR had merged three
// minutes earlier. The rebase retry then hit a conflict in
// scripts/data/match-library/match-index.json, which that PR had also
// rewritten, and `git pull --rebase || exit 1` threw the entire night away:
// the model, the handicaps, the experiment target, the ladder prices and the
// journal rewrite.
//
// The retry's own comment explains why it could not cope, and it was true when
// it was written: "the four files this commit touches are refit-OWNED, so
// rebasing onto whatever landed is always the right merge." The COMMIT LIST
// then grew, past that reasoning, to include generated library data. Nothing
// forced the author of that change to notice the comment no longer covered it,
// which is the drift this module and its test exist to stop.
//
// THE DISTINCTION, and the whole fix: the refit commits two KINDS of file.
//
//  - FIT OUTPUTS are genuinely refit-owned. Nothing else in the repo writes
//    them, so a conflict in one is not something to paper over; it means an
//    assumption has broken and the run should stop and say so.
//  - DERIVED DATA is generated from the model AND from board data a human PR
//    can also rewrite. A TEXT MERGE OF THESE IS MEANINGLESS: they are
//    single-line JSON blobs, and the "right" answer is not a blend of two
//    versions but the answer you get by re-deriving against whatever main now
//    holds. So the resolution is to take main's copy and re-run the repricers,
//    which cost seconds because they re-price from stored features and solve
//    nothing.
//
// A conflict confined to DERIVED data is therefore auto-resolvable. A conflict
// touching anything else is not, and the run fails loudly rather than pushing
// a file nobody reasoned about.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Refit-owned outputs: a conflict here is a broken assumption, not a merge. */
export const FIT_OUTPUT_PATHS = [
  'src/logic/difficulty.js',
  'src/logic/handicaps.json',
  'src/logic/experimentTarget.json',
  'src/logic/modelHistory.json',
  'src/logic/journalRewrite.json',
];

/** Generated data: re-derive rather than merge. */
export const DERIVED_PATHS = [
  'src/logic/challengePool.js',
  // The pool's feature store, re-stamped by the SAME repricer run that
  // rewrites challengePool.js. It is derived for the same reason the pool is,
  // and it has to be committed WITH the pool: a run that re-prices one and
  // not the other leaves the committed store describing a pool that no longer
  // exists. Missing from the staged set until 2026-08-18, which is what left
  // the working tree dirty after every commit and made `git rebase` refuse to
  // start on any night a human pushed while Stan was sampling.
  'scripts/data/pool-features.json',
  'scripts/data/climb-library',
  'scripts/data/match-library',
];

/** Re-run in order when derived data conflicts; each is cheap and idempotent. */
export const REDERIVE_COMMANDS = [
  'node scripts/reprice-challenge-pool.mjs',
  'node scripts/reprice-climb-library.mjs',
  'node scripts/reprice-match-library.mjs',
];

const under = (path, root) => path === root || path.startsWith(`${root}/`);

/** Is this path one the refit generates rather than owns outright? */
export function isDerivedPath(path) {
  return DERIVED_PATHS.some((root) => under(path, root));
}

/** Is this path a refit-owned fit output? */
export function isFitOutputPath(path) {
  return FIT_OUTPUT_PATHS.some((root) => under(path, root));
}

/**
 * Classify a rebase's conflicted paths.
 *
 * @param {string[]} paths `git diff --name-only --diff-filter=U`
 * @returns {{resolvable: boolean, derived: string[], unexpected: string[]}}
 *   `resolvable` is true only when there IS a conflict and every conflicted
 *   path is derived data. An empty list is not resolvable: nothing conflicted,
 *   so the caller has no business running the resolution.
 */
export function classifyConflicts(paths) {
  const list = (Array.isArray(paths) ? paths : [])
    .map((p) => String(p || '').trim())
    .filter(Boolean);
  const derived = list.filter(isDerivedPath);
  const unexpected = list.filter((p) => !isDerivedPath(p));
  return { resolvable: list.length > 0 && unexpected.length === 0, derived, unexpected };
}

// ── CLI ────────────────────────────────────────────────────────────────
//
// Reads conflicted paths on stdin, one per line, and prints a verdict the
// workflow's shell can branch on:
//   git diff --name-only --diff-filter=U | node scripts/refit-push-conflict.mjs
// Exit 0 = every conflict is derived data, safe to re-derive.
// Exit 1 = something else conflicted; the caller must not resolve it.

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const input = readFileSync(0, 'utf8').split('\n');
  const { resolvable, derived, unexpected } = classifyConflicts(input);
  if (resolvable) {
    console.error(`refit push: ${derived.length} derived path(s) conflicted, re-deriving: ${derived.join(', ')}`);
    process.exit(0);
  }
  if (unexpected.length > 0) {
    console.error(`refit push: REFUSING to auto-resolve ${unexpected.length} conflicted path(s) `
      + `outside the generated data: ${unexpected.join(', ')}`);
  } else {
    console.error('refit push: no conflicted paths to resolve');
  }
  process.exit(1);
}
