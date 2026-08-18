// Name-gate decision contract.
//
// REGRESSION (name-gate): a player could finish a daily/weekly/timed game
// without a name — weekly dropped the score silently, timed posted
// "Anonymous", and the daily's inline form was dismissible. shouldPromptForName
// is the gate; these pin exactly when it fires.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldPromptForName } from '../src/logic/shouldPromptForName.js';

test('prompts for the leaderboard modes when no name is saved', () => {
  for (const mode of ['daily', 'weekly', 'match']) {
    assert.equal(shouldPromptForName({ mode, savedName: '' }), true, `${mode} with no name should prompt`);
  }
});

test('does not prompt once a usable name is saved', () => {
  for (const mode of ['daily', 'weekly', 'match']) {
    assert.equal(shouldPromptForName({ mode, savedName: 'Greg' }), false, `${mode} with a name should not prompt`);
  }
});

test('REGRESSION (match node): a match win prompts, because the name is now public', () => {
  // PR 3 exempted 'match' on the reasoning that a solo run submitted nothing
  // anywhere. The match node made both halves false in one change: every
  // cleared board files a par-fit row under this name, and a shared match puts
  // it in a standings panel the other players are watching. This assertion is
  // the one that fails if the mode is ever quietly dropped from the set again.
  assert.equal(shouldPromptForName({ mode: 'match', savedName: '' }), true);
});

test('a pinned practice match board never prompts — it records nothing', () => {
  // ?matchboard= is the test-env practice lane: no stats, no node, no fit row,
  // so there is no name to demand. winLossHandler passes isLevelPractice here.
  assert.equal(shouldPromptForName({ mode: 'match', savedName: '', isPractice: true }), false);
});

test('a whitespace-only saved name is treated as unset', () => {
  assert.equal(shouldPromptForName({ mode: 'daily', savedName: '   ' }), true);
});

test('never prompts for non-leaderboard modes', () => {
  // 'match' left this list when the match node shipped (see the regression
  // above). The Climb, chaos and the gym stay: none of them puts a name in
  // front of anyone.
  for (const mode of ['normal', 'chaos', undefined, null, 'gym']) {
    assert.equal(shouldPromptForName({ mode, savedName: '' }), false, `${mode} should never prompt`);
  }
});

test('never prompts for archive replays or practice dailies', () => {
  assert.equal(shouldPromptForName({ mode: 'daily', savedName: '', isArchive: true }), false);
  assert.equal(shouldPromptForName({ mode: 'daily', savedName: '', isPractice: true }), false);
});

test('DOES prompt in the test environment — the gate must be reviewable on /test/', () => {
  // Deliberately NOT gated on isTestEnvironment: submissions are suppressed
  // downstream, so the gate is harmless in test env, and a human reviewing the
  // /test/ build needs to see it. (No e2e spec wins a game, so nothing blocks.)
  assert.equal(shouldPromptForName({ mode: 'daily', savedName: '' }), true);
  assert.equal(shouldPromptForName({ mode: 'weekly', savedName: '' }), true);
});

// ── The playerNames boot self-heal (the Kate gap, 2026-08-18) ────────────
// A player named before the registry existed passes the name gate, never
// re-opens Settings, never switches uid, so no call site publishes and the
// canonical playerNames entry stays empty forever while every score row
// carries the name (found live: 296 rows named "Kate", playerNames null).
// The heal is one idempotent publish per boot after auth settles; this scan
// keeps it wired.
import { readFileSync as _rf } from 'node:fs';
test('boot publishes the local name once auth settles (the registry self-heal)', () => {
  const src = _rf(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(src, /initAnonymousAuth\(\)[\s\S]{0,700}publishPlayerName\(getPlayerName\(\)\)/,
    'the boot auth-settle path must publish the stored name; without it a pre-registry player never gains a canonical entry');
});
