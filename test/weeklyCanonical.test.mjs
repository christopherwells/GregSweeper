// The weekly's local-generation fallback: when may it play what it built?
//
// INCIDENT (2026-08-07, the weekly half of the divergent-daily arc). The daily
// stopped generating locally at all on this date, because a client that misses
// the canonical and re-derives the board lands on a different trial almost
// every time. The weekly kept its fallback deliberately — it is the
// precompute-failure recovery — but it kept the whole of the hole with it: a
// client whose reads failed generated its own board, wrote it into a write-once
// node that silently refused it, and then PLAYED it. That is a board nobody
// else is on, one of only seven attempts spent on it, and a score the submit
// guard added in #262 then refuses.
//
// The decision is tested here rather than in gameActions because the version
// that shipped was three conditions spread through sixty lines of generation
// code, and test/divergenceGuards.test.mjs — the only thing watching this
// area — is entirely source scan. A pure helper is CLAUDE.md's own stated
// remedy for exactly that.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { weeklyLocalGenPlan } from '../src/logic/weeklyCanonical.js';

const WEEK = '2026-08-10';
const plan = (over) => weeklyLocalGenPlan({
  wrote: false, settled: null, generatedSeed: `${WEEK}:trial4`, weekStart: WEEK, ...over,
});

test('a successful write means we established the week, so we play our own board', () => {
  // His ruling: the writer stays. A week with no canonical is worse than a week
  // whose canonical came from the first player through the door.
  const p = plan({ wrote: true });
  assert.equal(p.adopt, false);
  assert.equal(p.reason, 'established');
});

test('REGRESSION: a refused write plus a different canonical adopts the canonical', () => {
  // The hole. write-once refuses because a canonical is already there; before
  // this the refusal was discarded and the local board was played anyway.
  const p = plan({ wrote: false, settled: { rngSeed: `${WEEK}:trial9` } });
  assert.equal(p.adopt, true);
  assert.equal(p.reason, 'superseded');
  assert.equal(p.settledSeed, `${WEEK}:trial9`);
});

test('a refused write whose canonical agrees with us changes nothing', () => {
  // Two clients on the same build generate the same board (local generation is
  // deterministic from the weekStart), so losing the race is not divergence.
  const p = plan({ wrote: false, settled: { rngSeed: `${WEEK}:trial4` } });
  assert.equal(p.adopt, false);
  assert.equal(p.reason, 'agrees');
});

test('an unreachable server still lets the player play', () => {
  // loadWeeklyBoard returns null both for "reachable and empty" and for "could
  // not reach it". The write already separated those, so a null here means
  // offline (or a test build, whose writes are gated) and the weekly stays
  // playable rather than being taken away.
  const p = plan({ wrote: false, settled: null });
  assert.equal(p.adopt, false);
  assert.equal(p.reason, 'unreachable');
});

test('a canonical that omits its rngSeed reads as the weekStart, not as a mismatch', () => {
  // Same convention score rows use (effectiveRowSeed): the seed is omitted
  // when it equals its own key. Reading a missing seed as a mismatch would make
  // every plain-seeded week adopt itself in a loop.
  const p = weeklyLocalGenPlan({
    wrote: false, settled: { /* no rngSeed */ }, generatedSeed: WEEK, weekStart: WEEK,
  });
  assert.equal(p.adopt, false);
  assert.equal(p.reason, 'agrees');
  assert.equal(p.settledSeed, WEEK);
});

test('the plan is not vacuous: every branch is reachable and distinct', () => {
  // A helper that always returned {adopt:false} would satisfy four of the five
  // tests above, so the reasons are asserted to be four different values.
  const reasons = new Set([
    plan({ wrote: true }).reason,
    plan({ settled: { rngSeed: 'other' } }).reason,
    plan({ settled: { rngSeed: `${WEEK}:trial4` } }).reason,
    plan({ settled: null }).reason,
  ]);
  assert.equal(reasons.size, 4, `expected four distinct outcomes, got ${[...reasons].join(', ')}`);
});

// ── the call site ───────────────────────────────────────────────────
// A source guard, because the defect was never in the rule — it was that the
// caller never asked. Comments are stripped first: bootHang's first cut matched
// the word it was hunting inside its own explanatory prose and failed on a
// correct file.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const ACTIONS = stripComments(readFileSync(new URL('../src/game/gameActions.js', import.meta.url), 'utf8'));

test('the weekly generation path routes through the helper', () => {
  assert.match(ACTIONS, /import\s*\{\s*weeklyLocalGenPlan\s*\}\s*from\s*'\.\.\/logic\/weeklyCanonical\.js'/);
  assert.match(ACTIONS, /weeklyLocalGenPlan\(\{/);
});

test('saveWeeklyBoard is awaited, because its answer is the whole signal', () => {
  // Fire-and-forget is how the refusal went unread for as long as it did.
  assert.match(ACTIONS, /const\s+wrote\s*=\s*await\s+saveWeeklyBoard\(/);
});
