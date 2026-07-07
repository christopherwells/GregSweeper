// Pages-deploy retry watchdog (scripts/pages-deploy-retry.mjs, consumed by
// .github/workflows/retry-pages-deploy.yml). Incident: the 2026-07-04..06
// Pages congestion window (~15:00-16:30 UTC) failed actions/deploy-pages@v4
// within seconds — "Deployment failed, try again later." — in clusters that
// only cleared when a HUMAN re-dispatched; a refit-dispatched deploy failing
// there left the new PAR_MODEL committed but undeployed. These pin the
// retry/backoff/alarm decisions so such a cluster clears unattended, plus
// the workflow-file couplings (a renamed workflow or drifted output key
// would silently disarm the watchdog — the mis-keyed-sound-palette class).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  retryDecision,
  dispatchCheck,
  toOutputLines,
  RETRY_DELAYS_MINUTES,
  MAX_RETRIES,
  MAX_STREAK_GAP_HOURS,
} from '../scripts/pages-deploy-retry.mjs';

// Newest run = smallest minutesAgo. gh run list returns newest-first, but
// builders here deliberately produce ISO timestamps so sorting is exercised.
const T0 = Date.parse('2026-07-06T16:10:00Z');
function run(minutesAgo, conclusion, status = 'completed') {
  return { status, conclusion, createdAt: new Date(T0 - minutesAgo * 60000).toISOString() };
}

// ── retryDecision: the backoff ladder ────────────────────────────────────
test('REGRESSION: the 2026-07-06 cluster (three consecutive failures) schedules a retry instead of waiting for a human', () => {
  // 15:55, 16:02, 16:10 UTC — three failures minutes apart, older history green.
  const d = retryDecision([run(0, 'failure'), run(8, 'failure'), run(15, 'failure'), run(120, 'success')]);
  assert.equal(d.action, 'retry');
  assert.equal(d.attempt, 3);
  assert.equal(d.delayMinutes, RETRY_DELAYS_MINUTES[2]);
});

test('first failure after a success retries on the shortest delay', () => {
  const d = retryDecision([run(0, 'failure'), run(60, 'success'), run(120, 'failure')]);
  assert.equal(d.action, 'retry');
  assert.equal(d.attempt, 1);
  assert.equal(d.delayMinutes, RETRY_DELAYS_MINUTES[0]);
});

test('a queued or in-progress deploy run means someone else is on it — skip', () => {
  for (const status of ['queued', 'in_progress']) {
    const d = retryDecision([run(0, null, status), run(5, 'failure'), run(60, 'success')]);
    assert.equal(d.action, 'skip', `status=${status} must skip`);
  }
});

test('latest completed deploy succeeded — nothing to heal', () => {
  const d = retryDecision([run(0, 'success'), run(10, 'failure'), run(20, 'failure')]);
  assert.equal(d.action, 'skip');
});

test('superseded-cancelled runs are neutral: they neither break nor extend the streak', () => {
  // deploy-pages' `pages` concurrency group cancels superseded pending runs
  // mid-incident; the backoff clock must survive them.
  const d = retryDecision([run(0, 'failure'), run(5, 'cancelled'), run(10, 'failure'), run(60, 'success')]);
  assert.equal(d.action, 'retry');
  assert.equal(d.attempt, 2);
  assert.equal(d.delayMinutes, RETRY_DELAYS_MINUTES[1]);
});

test('startup_failure and timed_out count toward the streak', () => {
  const d = retryDecision([run(0, 'failure'), run(10, 'startup_failure'), run(20, 'timed_out'), run(60, 'success')]);
  assert.equal(d.action, 'retry');
  assert.equal(d.attempt, 3);
});

test('an incident that outlives the whole ladder alarms instead of retrying forever', () => {
  // 7 consecutive failures ~35 min apart (all within the 3h gap bound).
  const runs = Array.from({ length: 7 }, (_, i) => run(i * 35, 'failure'));
  runs.push(run(7 * 35, 'success'));
  const d = retryDecision(runs);
  assert.equal(d.action, 'alert');
  assert.equal(d.attempt, 7);
  assert.ok(d.attempt > MAX_RETRIES);
});

test("a fresh failure hours after an exhausted cluster starts a NEW cycle (yesterday's incident can't eat today's retries)", () => {
  // No success ever intervened (the site stayed undeployed), but the old
  // cluster is far outside MAX_STREAK_GAP_HOURS — today's refit-dispatched
  // failure must get its own backoff ladder, not jump straight to the alarm.
  const staleStart = 22 * 60; // minutes ago
  const runs = [run(0, 'failure'), ...Array.from({ length: 7 }, (_, i) => run(staleStart + i * 35, 'failure'))];
  const d = retryDecision(runs);
  assert.equal(d.action, 'retry');
  assert.equal(d.attempt, 1);
  assert.equal(d.delayMinutes, RETRY_DELAYS_MINUTES[0]);
  assert.ok(staleStart / 60 > MAX_STREAK_GAP_HOURS, 'fixture must actually exceed the gap bound');
});

test('input order does not matter — runs are sorted by createdAt', () => {
  const runs = [run(15, 'failure'), run(120, 'success'), run(0, 'failure'), run(8, 'failure')];
  const d = retryDecision(runs);
  assert.equal(d.action, 'retry');
  assert.equal(d.attempt, 3);
});

test('empty run history skips (defensive)', () => {
  assert.equal(retryDecision([]).action, 'skip');
  assert.equal(dispatchCheck([]).action, 'skip');
});

test('backoff schedule contract: 6 nondecreasing tiers from 10 to 60 minutes', () => {
  assert.deepEqual(RETRY_DELAYS_MINUTES, [10, 20, 30, 45, 60, 60]);
  assert.equal(MAX_RETRIES, RETRY_DELAYS_MINUTES.length);
  for (let i = 1; i < RETRY_DELAYS_MINUTES.length; i++) {
    assert.ok(RETRY_DELAYS_MINUTES[i] >= RETRY_DELAYS_MINUTES[i - 1], 'delays must not shrink');
  }
});

// ── dispatchCheck: the post-sleep anti-spam gate ─────────────────────────
test('post-sleep: still failed and idle — dispatch', () => {
  const d = dispatchCheck([run(0, 'failure'), run(60, 'success')]);
  assert.equal(d.action, 'dispatch');
});

test('post-sleep: a newer deploy succeeded while we slept — skip', () => {
  const d = dispatchCheck([run(0, 'success'), run(30, 'failure')]);
  assert.equal(d.action, 'skip');
});

test('post-sleep: a newer run is queued or in progress — skip', () => {
  const d = dispatchCheck([run(0, null, 'in_progress'), run(30, 'failure')]);
  assert.equal(d.action, 'skip');
});

test('post-sleep: a superseded-cancelled run on top of a failure still dispatches', () => {
  const d = dispatchCheck([run(0, 'cancelled'), run(5, 'failure'), run(60, 'success')]);
  assert.equal(d.action, 'dispatch');
});

// ── the GITHUB_OUTPUT contract ───────────────────────────────────────────
test('toOutputLines emits exactly the keys the workflow reads', () => {
  assert.equal(
    toOutputLines({ action: 'retry', attempt: 2, delayMinutes: 20 }),
    'action=retry\nattempt=2\ndelay_minutes=20'
  );
  assert.equal(toOutputLines({ action: 'skip' }), 'action=skip');
  assert.equal(toOutputLines({ action: 'alert', attempt: 7 }), 'action=alert\nattempt=7');
  assert.equal(toOutputLines({ action: 'dispatch' }), 'action=dispatch');
});

test('CLI: stdout carries ONLY key=value lines (a stray log would corrupt $GITHUB_OUTPUT)', () => {
  const script = fileURLToPath(new URL('../scripts/pages-deploy-retry.mjs', import.meta.url));
  const input = JSON.stringify([run(0, 'failure'), run(60, 'success')]);
  const decide = spawnSync(process.execPath, [script, 'decide'], { input, encoding: 'utf8' });
  assert.equal(decide.status, 0, decide.stderr);
  assert.equal(decide.stdout.trim(), 'action=retry\nattempt=1\ndelay_minutes=10');
  const recheck = spawnSync(process.execPath, [script, 'recheck'], { input, encoding: 'utf8' });
  assert.equal(recheck.status, 0, recheck.stderr);
  assert.equal(recheck.stdout.trim(), 'action=dispatch');
});

// ── workflow-file couplings ──────────────────────────────────────────────
const retryYml = readFileSync(
  fileURLToPath(new URL('../.github/workflows/retry-pages-deploy.yml', import.meta.url)), 'utf8');
const deployYml = readFileSync(
  fileURLToPath(new URL('../.github/workflows/deploy-pages.yml', import.meta.url)), 'utf8');

test('watchdog watches deploy-pages by its exact workflow name (a rename silently disarms it)', () => {
  const deployName = deployYml.match(/^name:\s*(.+)$/m)?.[1].trim();
  assert.ok(deployName, 'deploy-pages.yml must declare a name');
  assert.ok(
    retryYml.includes(`workflows: ["${deployName}"]`),
    `retry-pages-deploy.yml must trigger on workflow_run of "${deployName}"`
  );
  assert.match(retryYml, /types:\s*\[completed\]/);
  assert.match(retryYml, /workflow_run\.conclusion == 'failure'/);
});

test('watchdog re-dispatch target stays dispatchable', () => {
  // The retry re-runs deploy-pages via workflow_dispatch; dropping that
  // trigger from deploy-pages.yml would break every retry.
  assert.match(deployYml, /workflow_dispatch/);
  assert.match(retryYml, /gh workflow run deploy-pages\.yml/);
});

test('watchdog calls the decision script in both modes and reads its output keys', () => {
  assert.match(retryYml, /node scripts\/pages-deploy-retry\.mjs decide/);
  assert.match(retryYml, /node scripts\/pages-deploy-retry\.mjs recheck/);
  // Step conditions must read exactly what toOutputLines emits.
  assert.match(retryYml, /steps\.decide\.outputs\.action == 'retry'/);
  assert.match(retryYml, /steps\.decide\.outputs\.action == 'alert'/);
  assert.match(retryYml, /steps\.decide\.outputs\.delay_minutes/);
  assert.match(retryYml, /steps\.decide\.outputs\.attempt/);
});

test('watchdog keeps single-sleeper concurrency (newer completion supersedes an older sleeping retry)', () => {
  assert.match(retryYml, /group: pages-retry/);
  assert.match(retryYml, /cancel-in-progress: true/);
});
