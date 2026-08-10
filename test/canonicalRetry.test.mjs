// Which canonical reads are worth asking about again.
//
// REGRESSION (issue #255): the startup gate's retry treated every empty result
// as "a slow or dropped read". A canonical read comes back with no board for
// four different reasons and only ONE of them can improve on a second look, so
// the loop spent its budget on the cases guaranteed not to benefit: a date the
// server says is EMPTY answers the same way next time, and an UNTRUSTED
// payload returns the same bytes. The budget was also counted in ATTEMPTS
// rather than time, so with the loaders' 5s fetch timeout the true ceiling was
// ~11.5s while the comment beside it promised "about a second and a half".
//
// The arithmetic is the part worth pinning, because it is what went stale:
// every bound below is derived from the shipped constants rather than written
// out, so a change to one of them fails here instead of silently making the
// documented cost wrong again.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldRetryCanonical, canonicalRetryDelay, canonicalReadReason,
  CANONICAL_OK, CANONICAL_ABSENT, CANONICAL_UNTRUSTED, CANONICAL_UNREAD,
  CANONICAL_RETRIES, CANONICAL_RETRY_DELAY_MS, CANONICAL_RETRY_BUDGET_MS,
} from '../src/logic/canonicalRetry.js';

// The loaders' own fetch timeout, read off the source so this cannot drift
// from the number the ceiling is actually built out of.
import { readFileSync } from 'node:fs';
const FETCH_TIMEOUT_MS = Number(
  /const FETCH_TIMEOUT_MS = (\d+);/.exec(
    readFileSync(new URL('../src/firebase/dailyBoardSync.js', import.meta.url), 'utf8'))[1]);

const retry = (over) => shouldRetryCanonical({
  reason: CANONICAL_UNREAD, attempt: 1, elapsedMs: 0, online: true, ...over,
});

// ── Which reasons are worth a second read ────────────────────────────────

test('REGRESSION: only an unread canonical is retried', () => {
  assert.equal(retry({ reason: CANONICAL_UNREAD }), true,
    'a timed-out or unreachable read is exactly what the retry exists for');

  assert.equal(retry({ reason: CANONICAL_ABSENT }), false,
    'the server answered: this date has no board, and asking again cannot change that');
  assert.equal(retry({ reason: CANONICAL_UNTRUSTED }), false,
    'a tampered payload returns the same bytes; local generation is the designed response');
  assert.equal(retry({ reason: CANONICAL_OK }), false,
    'there is already a board');

  // An unrecognised reason must not be treated as retryable — the safe
  // direction is to stop, since the fallback is always available.
  assert.equal(retry({ reason: 'something-new' }), false);
  assert.equal(retry({ reason: undefined }), false);
});

test('an offline player is never made to sleep out the budget', () => {
  assert.equal(retry({ online: false }), false);
  assert.equal(retry({ online: true }), true);
  // Unknown online-ness defaults to trying: navigator.onLine is only
  // trustworthy when it says false.
  assert.equal(shouldRetryCanonical({ reason: CANONICAL_UNREAD, attempt: 1, elapsedMs: 0 }), true);
});

// ── The bounds ───────────────────────────────────────────────────────────

test('the attempt cap and the wall-clock budget both bind', () => {
  assert.equal(retry({ attempt: CANONICAL_RETRIES }), true, 'the last allowed attempt still runs');
  assert.equal(retry({ attempt: CANONICAL_RETRIES + 1 }), false, 'and nothing past it does');
  assert.equal(retry({ attempt: 0 }), false, 'attempts are 1-based');

  assert.equal(retry({ elapsedMs: CANONICAL_RETRY_BUDGET_MS - 1 }), true);
  assert.equal(retry({ elapsedMs: CANONICAL_RETRY_BUDGET_MS }), false, 'the budget is inclusive');
  assert.equal(retry({ elapsedMs: Infinity }), false);
  assert.equal(retry({ elapsedMs: NaN }), false, 'an unusable clock reading stops rather than loops');
});

test('REGRESSION: the worst case is one fetch timeout past the budget, not two', () => {
  // Walk the loop the way the gate does and add up the ceiling.
  let elapsed = 0, attempts = 0;
  for (let attempt = 1; attempt <= CANONICAL_RETRIES; attempt++) {
    if (!shouldRetryCanonical({ reason: CANONICAL_UNREAD, attempt, elapsedMs: elapsed, online: true })) break;
    attempts++;
    elapsed += canonicalRetryDelay(attempt) + FETCH_TIMEOUT_MS;  // sleep, then a read that times out
  }

  assert.equal(attempts, 1,
    'after one timed-out read the budget is already spent, so no second read starts');
  assert.equal(elapsed, CANONICAL_RETRY_DELAY_MS + FETCH_TIMEOUT_MS);
  assert.ok(elapsed <= CANONICAL_RETRY_BUDGET_MS + FETCH_TIMEOUT_MS,
    `the ceiling must be the budget plus at most one fetch timeout, got ${elapsed}ms`);

  // What the attempt-count-only version allowed, for contrast: every attempt
  // running to its own timeout.
  let unbounded = 0;
  for (let attempt = 1; attempt <= CANONICAL_RETRIES; attempt++) {
    unbounded += canonicalRetryDelay(attempt) + FETCH_TIMEOUT_MS;
  }
  assert.ok(unbounded > elapsed * 1.8,
    `the fix must actually cut the ceiling (was ${unbounded}ms, now ${elapsed}ms)`);
});

test('a FAST failure still gets its full attempt count', () => {
  // The bound is on time, not tries: when reads fail immediately (an errored
  // connection rather than a hanging one) both attempts should still happen,
  // because they are nearly free and one of them may land.
  let elapsed = 0, attempts = 0;
  for (let attempt = 1; attempt <= CANONICAL_RETRIES; attempt++) {
    if (!shouldRetryCanonical({ reason: CANONICAL_UNREAD, attempt, elapsedMs: elapsed, online: true })) break;
    attempts++;
    elapsed += canonicalRetryDelay(attempt) + 50;
  }
  assert.equal(attempts, CANONICAL_RETRIES, 'a cheap failure is worth retrying to the cap');
  assert.ok(elapsed < CANONICAL_RETRY_BUDGET_MS, `and still lands inside the budget (${elapsed}ms)`);
});

test('the backoff is linear and starts at the shipped delay', () => {
  assert.equal(canonicalRetryDelay(1), CANONICAL_RETRY_DELAY_MS);
  assert.equal(canonicalRetryDelay(2), CANONICAL_RETRY_DELAY_MS * 2);
  assert.equal(canonicalRetryDelay(0), CANONICAL_RETRY_DELAY_MS, 'never a zero-length sleep');
});

// ── Classifying a read ───────────────────────────────────────────────────

test('canonicalReadReason names the four outcomes the loaders can produce', () => {
  const board = { rows: 9 };
  assert.equal(canonicalReadReason({ board, reached: true, exists: true }), CANONICAL_OK);
  assert.equal(canonicalReadReason({ board, reached: false }), CANONICAL_OK,
    'a trusted CACHED board is still a board — offline is not a failure when the cache answers');

  assert.equal(canonicalReadReason({ board: null, reached: true, exists: false }), CANONICAL_ABSENT);
  assert.equal(canonicalReadReason({ board: null, reached: true, exists: true }), CANONICAL_UNTRUSTED,
    'data was there and the trust gate refused it');
  assert.equal(canonicalReadReason({ board: null, reached: false }), CANONICAL_UNREAD);
});

test('every reason the loaders emit is one the retry rule knows', () => {
  // A reason the classifier can produce but shouldRetryCanonical has never
  // heard of would fall through to "do not retry" silently, which is safe but
  // is not a decision anyone made.
  const known = new Set([CANONICAL_OK, CANONICAL_ABSENT, CANONICAL_UNTRUSTED, CANONICAL_UNREAD]);
  const produced = [
    canonicalReadReason({ board: {}, reached: true, exists: true }),
    canonicalReadReason({ board: null, reached: true, exists: true }),
    canonicalReadReason({ board: null, reached: true, exists: false }),
    canonicalReadReason({ board: null, reached: false }),
  ];
  for (const r of produced) assert.ok(known.has(r), `${r} is emitted but unclassified`);
  assert.equal(new Set(produced).size, 4, 'all four outcomes must be distinguishable');
});

// ── The gate uses it ─────────────────────────────────────────────────────

test('the startup gate retries through the helper, not a private loop', () => {
  // A pure rule nothing consults is decoration. This is the same source-scan
  // guard the save-slot and weekly-entry contracts use, and it is the shape
  // that matters here because the defect was a loop that looked reasonable.
  const gate = readFileSync(new URL('../src/game/startupGate.js', import.meta.url), 'utf8');

  assert.match(gate, /shouldRetryCanonical\(/, 'the gate must ask the shared rule');
  assert.match(gate, /canonicalRetryDelay\(/, 'and take its backoff from the same place');
  assert.match(gate, /loadDailyBoardResult|loadWeeklyBoardResult/,
    'it needs the reason-carrying loaders, or it has nothing to decide on');

  // The old shape: an attempt counter with the delay multiplied inline.
  assert.ok(!/CANONICAL_RETRY_DELAY_MS\s*\*\s*attempt/.test(gate),
    'the inline backoff was replaced by canonicalRetryDelay — two copies would drift');
});

test('both loaders expose a reason-carrying sibling and keep the plain one', () => {
  // Nine callers want a board or nothing, so the original signature must stay.
  for (const [file, plain, withReason] of [
    ['../src/firebase/dailyBoardSync.js', 'loadDailyBoard', 'loadDailyBoardResult'],
    ['../src/firebase/weeklyBoardSync.js', 'loadWeeklyBoard', 'loadWeeklyBoardResult'],
  ]) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(src, new RegExp(`export async function ${plain}\\(`), `${plain} must survive`);
    assert.match(src, new RegExp(`export async function ${withReason}\\(`), `${withReason} must exist`);
    assert.match(src, /canonicalReadReason\(/, `${file} must classify through the shared helper`);
  }
});
