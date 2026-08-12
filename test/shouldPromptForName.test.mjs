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
  for (const mode of ['daily', 'weekly']) {
    assert.equal(shouldPromptForName({ mode, savedName: '' }), true, `${mode} with no name should prompt`);
  }
});

test('does not prompt once a usable name is saved', () => {
  for (const mode of ['daily', 'weekly']) {
    assert.equal(shouldPromptForName({ mode, savedName: 'Greg' }), false, `${mode} with a name should not prompt`);
  }
});

test('a whitespace-only saved name is treated as unset', () => {
  assert.equal(shouldPromptForName({ mode: 'daily', savedName: '   ' }), true);
});

test('never prompts for non-leaderboard modes', () => {
  // 'match' is here deliberately: a solo Challenge match submits nothing,
  // so demanding a handle for one would gate a private game. The
  // head-to-head build gives matches a public surface and moves it.
  for (const mode of ['normal', 'match', 'chaos', undefined, null, 'gym']) {
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
