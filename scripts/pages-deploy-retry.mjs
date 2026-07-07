// Retry decisions for the Pages-deploy watchdog
// (.github/workflows/retry-pages-deploy.yml).
//
// GitHub's Pages backend has a recurring congestion window (observed
// 2026-07-04..06, ~15:00-16:30 UTC) where actions/deploy-pages@v4 fails
// within seconds of creating the deployment — the generic "Deployment
// failed, try again later." — while the artifact, pages/health, and the
// GitHub status page are all normal. A re-dispatch after the window
// clears succeeds. Until this watchdog, clearing a cluster took a human
// noticing; the sharpest edge was the daily refit, whose explicitly
// dispatched deploy could fail in the window and leave the new PAR_MODEL
// committed but undeployed — the exact stale-deploy class that explicit
// dispatch was added to prevent (2026-06-10).
//
// Pure decision helpers (imported by test/pagesDeployRetry.test.mjs) plus
// a guarded CLI. The CLI reads the output of
//   gh run list --workflow deploy-pages.yml --json status,conclusion,createdAt
// from stdin and prints GITHUB_OUTPUT-style key=value lines to stdout
// (the human-readable reason goes to stderr, keeping stdout safe to
// append to $GITHUB_OUTPUT):
//   ... | node scripts/pages-deploy-retry.mjs decide    # size the backoff
//   ... | node scripts/pages-deploy-retry.mjs recheck   # after the sleep

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Escalating backoff, indexed by consecutive-failure count (the first
// failure is the original run, so the first RETRY sleeps 10 minutes).
// The observed windows outlast a quick retry — the 2026-07-05 cluster
// was still failing 66 minutes after it started — so the schedule
// stretches to an hour and covers ~3h45m from the first failure. Past
// MAX_RETRIES consecutive failures it is not congestion anymore; the
// watchdog alarms instead of retrying forever.
export const RETRY_DELAYS_MINUTES = [10, 20, 30, 45, 60, 60];
export const MAX_RETRIES = RETRY_DELAYS_MINUTES.length;

// A fresh failure more than this long after the previous one starts a
// NEW retry cycle. Without it, an exhausted cluster (streak stuck above
// MAX_RETRIES because no deploy succeeded since) would eat the retries
// of every later incident: the next day's refit-dispatched deploy would
// jump straight to the alarm instead of getting its own backoff ladder.
// Within one incident the gap between failures is bounded by the longest
// sleep (60 min) plus run overhead, so 3 hours cleanly separates
// incidents without splitting one.
export const MAX_STREAK_GAP_HOURS = 3;

// Run-level conclusions that count toward the consecutive-failure streak.
const FAILURE_CONCLUSIONS = new Set(['failure', 'startup_failure', 'timed_out']);
// Conclusions that neither extend nor break the streak: deploy-pages'
// `pages` concurrency group (cancel-in-progress: false) cancels
// SUPERSEDED pending runs mid-incident, and those benign cancellations
// must not reset the backoff clock.
const NEUTRAL_CONCLUSIONS = new Set(['cancelled', 'skipped', 'neutral', 'stale', 'action_required']);

function newestFirst(runs) {
  // gh run list already returns newest-first; sort defensively anyway —
  // the streak logic silently misbehaves on out-of-order input.
  return [...(runs ?? [])].sort(
    (a, b) => String(b?.createdAt ?? '').localeCompare(String(a?.createdAt ?? ''))
  );
}

// Consecutive failures at the head of the run history — the measure of
// "how long has this incident lasted", which is what the backoff scales
// on. A success (or any unrecognized conclusion) ends the streak; so does
// a gap of more than MAX_STREAK_GAP_HOURS between failures (a separate,
// older incident).
function failureStreak(sorted) {
  const gapMs = MAX_STREAK_GAP_HOURS * 3600 * 1000;
  let streak = 0;
  let prevFailureTime = null;
  for (const run of sorted) {
    if (FAILURE_CONCLUSIONS.has(run.conclusion)) {
      const t = Date.parse(run.createdAt);
      if (prevFailureTime !== null && prevFailureTime - t > gapMs) break;
      streak++;
      if (!Number.isNaN(t)) prevFailureTime = t;
    } else if (NEUTRAL_CONCLUSIONS.has(run.conclusion)) {
      continue;
    } else {
      break;
    }
  }
  return streak;
}

// Decision at trigger time (a deploy-pages run just concluded failure):
// skip when something newer is already handling it, alarm when the
// incident has outlived the whole backoff ladder, otherwise retry with
// the streak-sized delay.
export function retryDecision(runs) {
  const sorted = newestFirst(runs);
  if (sorted.some(r => r.status !== 'completed')) {
    return { action: 'skip', reason: 'a deploy run is already queued or in progress' };
  }
  const attempt = failureStreak(sorted);
  if (attempt === 0) {
    return { action: 'skip', reason: 'latest completed deploy did not fail' };
  }
  if (attempt > MAX_RETRIES) {
    return {
      action: 'alert',
      attempt,
      reason: `${attempt} consecutive failures — retries exhausted after ${MAX_RETRIES}`,
    };
  }
  const delayMinutes = RETRY_DELAYS_MINUTES[attempt - 1];
  return {
    action: 'retry',
    attempt,
    delayMinutes,
    reason: `failure streak ${attempt} — re-dispatch after ${delayMinutes} min`,
  };
}

// Decision after the sleep: the world may have moved on (a human pushed,
// or manually re-dispatched and it succeeded). Only dispatch when the
// latest completed deploy is still a failure and nothing newer is queued
// or running — this is the anti-spam gate.
export function dispatchCheck(runs) {
  const sorted = newestFirst(runs);
  if (sorted.some(r => r.status !== 'completed')) {
    return { action: 'skip', reason: 'a newer deploy run is already queued or in progress' };
  }
  const latest = sorted.find(r => !NEUTRAL_CONCLUSIONS.has(r.conclusion));
  if (!latest || !FAILURE_CONCLUSIONS.has(latest.conclusion)) {
    return { action: 'skip', reason: 'latest completed deploy no longer failed' };
  }
  return { action: 'dispatch', reason: 'deploy still failed and nothing newer is running' };
}

// GITHUB_OUTPUT key=value lines. The retry workflow's step conditions
// read exactly these keys (steps.decide.outputs.action / .attempt /
// .delay_minutes) — pinned in test/pagesDeployRetry.test.mjs so the
// contract can't silently drift.
export function toOutputLines(decision) {
  const lines = [`action=${decision.action}`];
  if (decision.attempt !== undefined) lines.push(`attempt=${decision.attempt}`);
  if (decision.delayMinutes !== undefined) lines.push(`delay_minutes=${decision.delayMinutes}`);
  return lines.join('\n');
}

// Run only when invoked directly (so the test file can import the pure
// decision helpers without the CLI firing) — same guard as send-push.mjs.
const _isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (_isMain) {
  const mode = process.argv[2];
  if (mode !== 'decide' && mode !== 'recheck') {
    console.error(
      'usage: gh run list --workflow deploy-pages.yml --json status,conclusion,createdAt' +
      ' | node scripts/pages-deploy-retry.mjs decide|recheck'
    );
    process.exit(2);
  }
  const raw = readFileSync(0, 'utf8').trim();
  const runs = raw ? JSON.parse(raw) : [];
  const decision = mode === 'decide' ? retryDecision(runs) : dispatchCheck(runs);
  console.error(`${mode}: ${decision.action} — ${decision.reason}`);
  console.log(toOutputLines(decision));
}
