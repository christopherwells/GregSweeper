// REGRESSION (2026-08-07): a score set on a board that was not the day's
// canonical reached the leaderboard and the par fit.
//
// One player's 2026-08-06 row sat on `:trial6` while the canonical was
// `:trial13`; another's had sat on a divergent 2026-06-08 board for two
// months. Nothing was wrong with how they played — their client missed the
// canonical and generated locally, which the precompute horizon makes
// near-certain rather than unlucky: the board is written up to seven days
// ahead against the experiment target of that moment, and the nightly refit
// rewrites that file underneath it, so a client re-deriving the day's board
// locally chooses from a differently-sized candidate pool.
//
// Three guards now exist and this file pins the two pure ones plus the source
// contract of the third:
//   1. the STARTUP GATE retries for the canonical before allowing local
//      generation (a slow read is not an offline client)
//   2. the SUBMIT PATH refuses a divergent row, while still writing
//      dailyHistory so the day counts toward the streak
//   3. the NIGHTLY SWEEP reports any that slip through, era-floored
//
// The streak split is the load-bearing part of (2), and it is his constraint
// verbatim: "I don't want people losing their streak, but I also don't want
// bad data." Streaks read users/{uid}/dailyHistory; leaderboards read daily/.
// Refusing one while writing the other is exactly that line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// The sweep guards its own main() behind an is-this-the-entry-point check, so
// importing it here runs nothing and reaches no network. Its per-bucket rule is
// pure, which is what lets the match-row regression below be a behavior test
// rather than one more grep at the source.
import { divergenceBucketPlan } from '../scripts/verify-canonical-boards.mjs';

const leaderboardSrc = readFileSync(new URL('../src/firebase/firebaseLeaderboard.js', import.meta.url), 'utf8');
const winSrc = readFileSync(new URL('../src/game/winLossHandler.js', import.meta.url), 'utf8');
const gateSrc = readFileSync(new URL('../src/game/startupGate.js', import.meta.url), 'utf8');
const sweepSrc = readFileSync(new URL('../scripts/verify-canonical-boards.mjs', import.meta.url), 'utf8');
const auditSrc = readFileSync(new URL('../scripts/audit-divergent-scores.mjs', import.meta.url), 'utf8');

// The DECISION these two used to scan for now lives in the pure
// logic/submitGate.js and is tested by BEHAVIOR in test/submitGate.test.mjs —
// which is the test this file could never be. What is left here is the wiring:
// that the submit path still routes through the gate, and that the reads
// feeding it still fall open. Those are properties of the async plumbing, which
// is the one part a pure test cannot reach.

test('the submit path routes its decision through the pure gate', () => {
  assert.match(leaderboardSrc, /from '\.\.\/logic\/submitGate\.js'/,
    'submit must import the gate rather than re-deciding inline');
  assert.match(leaderboardSrc, /planScoreSubmission\(/,
    'and must actually call it');
  assert.match(leaderboardSrc, /canonicalSeedPath\(/,
    'the canonical node must come from the gate, so a weekly bucket reads the WEEKLY board');
  assert.match(leaderboardSrc, /if \(verdict !== 'proceed'\) return verdict;/,
    "the verdict must gate the push, and be returned to the caller verbatim");
});

test("the reads feeding the guard fail OPEN, so a flaky read can never eat a real score", () => {
  // Both reads sit in their own try/catch that leaves the seed/rows as null —
  // "unavailable", never "mismatch". A guard that failed CLOSED would silently
  // drop scores whenever Firebase hiccupped, far worse than the bad row it
  // prevents. The gate's own half of this contract is behaviour-tested.
  const idx = leaderboardSrc.indexOf('canonicalSeedPath(');
  assert.ok(idx > 0, 'expected the canonical read to still exist');
  const around = leaderboardSrc.slice(idx - 600, idx + 300);
  assert.match(around, /let canonicalSeed = null;/,
    'an unread canonical must default to null, which the gate treats as unavailable');
  assert.match(around, /catch\s*\{[^}]*\}/, 'its catch must swallow, not rethrow');
  assert.match(around, /let existingRows = null;/,
    'and the dedupe read must default the same way');
});

test('a divergent submission still writes dailyHistory, so the streak survives', () => {
  const idx = winSrc.indexOf("ok === 'divergent'");
  assert.ok(idx > 0, 'the win path must handle the divergent outcome');
  // Up to the next branch, this arm must call saveDailyHistoryEntry.
  const arm = winSrc.slice(idx, winSrc.indexOf("ok === 'cheat'", idx));
  assert.match(arm, /saveDailyHistoryEntry/,
    'a divergent row must still record the DAY — streaks read dailyHistory, not daily/');
  // And the two arms that deliberately do NOT record must stay that way.
  const dupArm = winSrc.slice(winSrc.indexOf("ok === 'duplicate'"), idx);
  assert.doesNotMatch(dupArm, /saveDailyHistoryEntry/,
    'first completion wins — a duplicate must not overwrite the first device');
});

test('the startup gate retries for BOTH canonicals rather than falling straight through', () => {
  assert.match(gateSrc, /CANONICAL_RETRIES/, 'the gate must define a retry budget');
  // The daily and the weekly share one retry loop, so the distinct report
  // label is now composed inside it from the caller's own label rather than
  // written out twice. The label each caller passes is what this checks, plus
  // the suffix the loop appends; asserting on the literal 'gate-daily-board-
  // retry' would only be asserting that the loop was never shared.
  assert.match(gateSrc, /\$\{label\}-retry/, 'the shared loop must report a retry failure distinctly');
  assert.match(gateSrc, /retryCanonicalRead\('gate-daily-board'/, 'the daily must retry');
  // The weekly is the wider blast radius of the two: its local-generation
  // fallback WRITES to the write-once node, so the first client to miss the
  // read establishes the week for everyone after it.
  assert.match(gateSrc, /retryCanonicalRead\('gate-weekly-board'/, 'and so must the weekly');

  // The retries only run when Firebase was READY — an offline player must
  // still get the local fallback rather than being stalled on the boot
  // overlay for a board that is never coming. Anchored on the last CALL, not
  // on the constant: the constant now lives in the shared loop's declaration
  // above the gate function, so it no longer says anything about placement.
  const use = gateSrc.lastIndexOf('retryCanonicalRead(');
  const branch = gateSrc.lastIndexOf('if (firebaseReady', use);
  assert.ok(branch > 0 && branch < use,
    'the retries must sit inside the firebaseReady branch');
  // And the loop itself must stop the moment the device is known to be
  // offline, or an airplane-mode boot pays the whole budget twice over. The
  // check used to be written into the loop's own condition; issue #255 moved
  // it, with the rest of the retry rule, into the pure shouldRetryCanonical
  // (which is unit-tested on it directly in test/canonicalRetry.test.mjs).
  // What still has to be true HERE is that the gate feeds it the live reading
  // on every pass rather than sampling it once before the loop.
  assert.match(gateSrc, /shouldRetryCanonical\(\{[\s\S]{0,200}?online: navigator\.onLine !== false/,
    'the loop must pass the live online reading into the retry rule');
  const loopBody = gateSrc.slice(gateSrc.indexOf('async function retryCanonicalRead'));
  assert.ok(loopBody.indexOf('shouldRetryCanonical') < loopBody.indexOf('setTimeout'),
    'and must ask BEFORE sleeping, so a device that just went offline stops immediately');
});

// The DEFINITION, not the first mention: the bare name appears earlier as the
// call inside submitWeeklyScore, and anchoring there slices a few characters of
// wrapper instead of the function — which every assertion below would then pass
// or fail for the wrong reason.
function weeklyDoerBody() {
  const start = leaderboardSrc.indexOf('async function _doSubmitWeeklyScore');
  assert.ok(start > 0, 'expected _doSubmitWeeklyScore to still exist');
  const end = leaderboardSrc.indexOf('\nfunction _queueFailedWeeklySubmission', start);
  assert.ok(end > start, 'expected the doer to end before the queue helper');
  return leaderboardSrc.slice(start, end);
}

// ── The weekly's half (2026-08-07) ───────────────────────────────────────
// The decision is the daily's, reused — planScoreSubmission is behaviour-tested
// in submitGate.test.mjs. What is pinned here is the wiring, which is where the
// weekly's two ways of going wrong live: reading the wrong canonical node, and
// writing the seed on only one of the two shapes the row is built through.

test('the weekly compares against the WEEKLY canonical, not the daily one', () => {
  const body = weeklyDoerBody();
  assert.match(body, /weeklyBoard\/\$\{weekStart\}\/rngSeed/,
    'a weekly row must be checked against weeklyBoard, never dailyBoard');
  assert.doesNotMatch(body, /dailyBoard\//,
    'reading dailyBoard here is the bug that made the weekly-first guard a no-op');
  assert.match(body, /planScoreSubmission\(/, 'and it must reuse the one decision');
  assert.match(body, /return 'divergent'/);
});

test("REGRESSION: the weekly seed is written on BOTH shapes the row is built through", () => {
  // _doSubmitWeeklyScore writes through an update() map on an existing row and
  // a set() payload on the first write of the week. A seed on only one of them
  // means the row silently lacks it for half of all players — and an absent
  // seed reads as "no divergence to check", the failure this whole guard exists
  // to end.
  const body = weeklyDoerBody();
  assert.match(body, /updates\.rngSeed = playedSeed;/, 'the update() path must carry the seed');
  assert.match(body, /payload\.rngSeed = playedSeed;/, 'and so must the first-write set() path');
});

test("a divergent weekly is RESOLVED, never queued for a retry that can never succeed", () => {
  // The queue re-flushes on the next online boot. A divergent board will still
  // be divergent then, so queuing it would retry forever. Only a falsy result —
  // a real write failure — goes back in.
  const idx = leaderboardSrc.indexOf('const ok = await _doSubmitWeeklyScore');
  assert.ok(idx > 0);
  assert.match(leaderboardSrc.slice(idx, idx + 600), /if \(!ok\) _queueFailedWeeklySubmission/,
    "the queue must gate on falsy, so the truthy 'divergent' resolves instead of looping");
});

test('the nightly sweep scans for divergent rows, era-floored, and reports rather than deletes', () => {
  assert.match(sweepSrc, /DIVERGENT SCORE ROW/, 'the sweep must have a divergence report');
  // Anchored INSIDE the scan. The bare name also appears in the meta
  // verifier's pre-canonical-era provenance branch, so a file-wide match would
  // pass on a line that has nothing to do with this guard.
  const idx = sweepSrc.indexOf('DIVERGENT SCORE ROW');
  const block = sweepSrc.slice(idx - 4000, idx + 2000);
  // The era floor moved into divergenceBucketPlan, which is behaviour-tested
  // below; what this still has to pin is that the SCAN consults it, since a
  // loop that stopped calling the rule would skip nothing at all.
  assert.match(block, /divergenceBucketPlan\(bucket\)/,
    'the daily scan must get its per-bucket verdict from the one rule');
  assert.match(block, /plan\.skip === 'pre-era'/,
    'the daily scan must skip pre-era dates, whose seeds disagree BY CONSTRUCTION');
  // It must not delete. The remediation is a named-rows human decision.
  assert.doesNotMatch(block, /method:\s*'DELETE'/, 'the sweep must never delete');
  assert.match(block, /audit-divergent-scores\.mjs --delete/, 'it must point at the tool that can');
});

test('the sweep covers all THREE score families, not just the day-of daily', () => {
  const idx = sweepSrc.indexOf('DIVERGENT SCORE ROW');
  const block = sweepSrc.slice(idx - 4000, idx + 2000);
  // The weekly leaderboard: never looked at before 2026-08-07, and a weekly
  // attempt is one of only seven, so a row on the wrong board costs more than
  // a daily one does.
  assert.match(block, /dbGet\('weekly'\)/, 'the weekly leaderboard must be scanned');
  assert.match(block, /weeklyBoard\/\$\{weekStart\}\/rngSeed/,
    'and compared against the WEEKLY canonical');
  assert.match(block, /weekStart < FIRST_ARCHIVE_WEEK/, 'with its own era floor');
  // The weekly-first FIT rows live under daily/ and were silently skipped: the
  // seed was looked up at dailyBoard/{weekStart}_weekly_first, a node that does
  // not exist, so the "no canonical" guard dropped all 36 of them under a clean
  // line. canonicalSeedPath is the one rule that resolves it (#260).
  assert.match(sweepSrc, /from '\.\.\/src\/logic\/submitGate\.js'/,
    'the bucket-to-canonical rule must be imported, not re-implemented');
  assert.match(sweepSrc, /canonicalSeedPath\(bucket\)/,
    'and divergenceBucketPlan must resolve its canonical node through it');
  assert.doesNotMatch(block, /dbGet\(`dailyBoard\/\$\{bucket\}\/rngSeed`\)/,
    'hardcoding dailyBoard here is the bug that skipped every weekly-first row');
});

test('the sweep reports what it could NOT check, so clean never means unlooked-at', () => {
  // 34 of 36 weekly rows carry no seed (measured against production
  // 2026-08-07) because the weekly only started recording one in #262. Those
  // are unverifiable, and a green line over them would be the same failure as
  // the silent skip this replaced.
  const idx = sweepSrc.indexOf('DIVERGENT SCORE ROW');
  const block = sweepSrc.slice(idx - 4000, idx + 3000);
  assert.match(block, /unverifiable/, 'the sweep must track rows it could not check');
  assert.match(block, /could not be checked either way/, 'and must say so in the output');
  assert.match(sweepSrc, /rowPlayedSeed/,
    'the played-seed rule must be the pure one, which is behaviour-tested');
});

// REGRESSION (2026-08-14): the nightly sweep threw on the first Challenge match
// row it met and reported the ENTIRE divergence scan as "DID NOT RUN".
//
// Match rows submit into `daily/` under a match_<hash> key, and a match board
// has no canonical to diverge from, so canonicalSeedPath returns null for one
// deliberately. The submit path was taught to skip that read; this second
// caller was not, and passed the null into a dbGet that does path.split('/').
// 48 match buckets existed the night it first threw, so one new family under an
// existing path silenced the alarm for the other three as well. The lesson
// generalizes past this key: the sweep reads whatever `daily/`
// holds, so the answer for a bucket it does not recognize must be a REASON,
// never a read it cannot make.
test('every bucket family under daily/ gets a verdict, and a skipped one carries no path', () => {
  // The family that caused the incident, keyed exactly as production keys it.
  const match = divergenceBucketPlan('match_fe307a9405101a37');
  assert.equal(match.skip, 'no-canonical-by-rule',
    'a match bucket must be skipped by rule, not read and found empty');
  assert.equal(match.seedPath, null,
    'and it must hand back NO path — the null read is the crash');

  // The three families that must still be compared, unchanged.
  assert.deepEqual(divergenceBucketPlan('2026-08-13'),
    { seedPath: 'dailyBoard/2026-08-13/rngSeed', skip: null });
  assert.deepEqual(divergenceBucketPlan('2026-08-03_weekly_first'),
    { seedPath: 'weeklyBoard/2026-08-03/rngSeed', skip: null },
    'the weekly fit row still resolves to the WEEKLY canonical (#260)');
  assert.equal(divergenceBucketPlan('2026-04-01').skip, 'pre-era',
    'pre-era dates disagree BY CONSTRUCTION and stay floored out');

  // The invariant the crash violated, stated once over every family: a verdict
  // either names a path to read or names a reason not to, never both and never
  // neither. A caller that reads plan.seedPath after checking plan.skip cannot
  // then be handed a null.
  for (const bucket of ['match_fe307a9405101a37', '2026-08-13',
    '2026-08-03_weekly_first', '2026-04-01', '2026-05-07_bonus']) {
    const plan = divergenceBucketPlan(bucket);
    if (plan.skip) {
      assert.equal(plan.seedPath, null, `${bucket}: a skip must carry no path`);
    } else {
      assert.equal(typeof plan.seedPath, 'string', `${bucket}: a read must carry one`);
      assert.ok(plan.seedPath.length > 0, `${bucket}: and it must not be empty`);
    }
  }
});

test('a bucket the scan could not compare is COUNTED, never dropped under a clean line', () => {
  // Both skip reasons are silent-drop shapes, and one of them already cost 36
  // rows: the weekly fit rows spent their whole life being looked up at a node
  // that does not exist, and every one of them vanished under a green line
  // (#260). The scan may decline to compare a bucket; it may not do so
  // invisibly.
  const idx = sweepSrc.indexOf('DIVERGENT SCORE ROW');
  const block = sweepSrc.slice(idx - 4000, idx + 4000);
  assert.match(block, /skipped\.byRule \+= Object\.keys\(rows\)\.length/,
    'a by-rule skip must add its ROWS to the count, not silently continue');
  assert.match(block, /skipped\.noNode \+= Object\.keys\(rows\)\.length/,
    'and so must a bucket whose canonical node came back empty');
  assert.match(block, /match row\(s\) have no canonical to diverge from/,
    'the by-rule skip must be printed, naming what proves those boards instead');
  assert.match(block, /canonical node is empty/,
    'and the empty-node skip must be printed too — that is the #260 shape');
});

test('a sweep scan that could not run is not reported as clean', () => {
  // The failure mode this guards is subtle: an exception inside the scan used
  // to print the same "no divergent rows" line as a genuine pass, so a broken
  // detector looked exactly like a healthy database.
  assert.match(sweepSrc, /divergentScanFailed/, 'a failed scan must be tracked separately');
  assert.match(sweepSrc, /SCAN DID NOT RUN/, 'and must say so loudly');
});

test('the audit tool refuses a blanket delete', () => {
  // 94 rows are divergent and 91 of them are legitimate pre-era provenance,
  // so an unfiltered --delete would wipe most of the leaderboard's history to
  // remove a handful of real rows.
  assert.match(auditSrc, /Refusing a blanket --delete/);
  assert.match(auditSrc, /--only/, 'targeted deletion must be the only deletion');
  // And it must not repeat the stale claim that deletion needs no auth.
  assert.doesNotMatch(auditSrc, /does NOT require\s*\n?\/\/ authentication/,
    'the header must not claim public write access — daily rows are append-only');
  assert.match(auditSrc, /tokenFromEnv/, 'deletion runs on the service account');
});
