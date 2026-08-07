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

test('the startup gate retries for the canonical rather than falling straight through', () => {
  assert.match(gateSrc, /CANONICAL_RETRIES/, 'the gate must define a retry budget');
  assert.match(gateSrc, /gate-daily-board-retry/, 'and report a retry failure distinctly');
  // The retry only runs when Firebase was READY — an offline player must
  // still get the local fallback rather than being stalled on the boot
  // overlay for a board that is never coming.
  // The USE of the constant, not its declaration above the function.
  const use = gateSrc.lastIndexOf('CANONICAL_RETRIES');
  const branch = gateSrc.lastIndexOf('if (firebaseReady', use);
  assert.ok(branch > 0 && branch < use,
    'the retry must sit inside the firebaseReady branch');
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
  assert.match(sweepSrc, /date < CANONICAL_ERA_START/,
    'and must skip pre-era dates, whose seeds disagree BY CONSTRUCTION');
  // It must not delete. The remediation is a named-rows human decision.
  const idx = sweepSrc.indexOf('DIVERGENT SCORE ROW');
  const block = sweepSrc.slice(idx - 2000, idx + 2000);
  assert.doesNotMatch(block, /method:\s*'DELETE'/, 'the sweep must never delete');
  assert.match(block, /audit-divergent-scores\.mjs --delete/, 'it must point at the tool that can');
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
