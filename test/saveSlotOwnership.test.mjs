// Who owns a mode's save slot (issue #247).
//
// Three lanes borrow a live mode's name without owning its storage key: an
// archive daily and a past-weekly replay run as 'daily' / 'weekly', and a
// ?level= / coastline practice run as 'normal'. persistGameState has always
// refused to WRITE from those lanes. The clear at the other end of the same
// key had no such guard, so winning a past daily ran
// clearGameState('daily') and deleted the real daily in progress — the
// player's reveals gone, and the board back with a zeroed clock in the one
// mode where a manual restart is deliberately impossible.
//
// The predicate is pure; the two ENDS of the slot are guarded by a source
// scan, because that is where the defect lived — the rule was right and one
// caller simply did not ask it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { ownsSaveSlot } = await import('../src/state/gameState.js');

const winLoss = readFileSync(new URL('../src/game/winLossHandler.js', import.meta.url), 'utf8');
const persistence = readFileSync(new URL('../src/game/gamePersistence.js', import.meta.url), 'utf8');

// ── The predicate ────────────────────────────────────────────────────────

test('an ordinary game owns its slot', () => {
  assert.equal(ownsSaveSlot({}), true);
  assert.equal(ownsSaveSlot({ isArchivePlay: false, isWeeklyArchive: false, isLevelPractice: false }), true);
});

test('REGRESSION: every borrowed lane disowns the slot', () => {
  // Each of these runs under a live mode's gameMode and shares its key.
  assert.equal(ownsSaveSlot({ isArchivePlay: true }), false, 'archive daily borrows the daily slot');
  assert.equal(ownsSaveSlot({ isWeeklyArchive: true }), false, 'past-weekly replay borrows the weekly slot');
  assert.equal(ownsSaveSlot({ isLevelPractice: true }), false, '?level= / coastline borrow the challenge slot');
});

test('no argument at all is not read as ownership', () => {
  // A caller that forgets to pass state must not silently claim the slot.
  assert.equal(ownsSaveSlot(), true, 'an empty context is an ordinary game, which is the honest default');
  assert.equal(ownsSaveSlot(null), true);
});

// ── Both ends of the slot ask the same question ──────────────────────────

test('REGRESSION: winLossHandler clears the slot only through the ownership guard', () => {
  // Pre-fix this file carried three bare `clearGameState(state.gameMode)`
  // calls — win, loss and time-up — none of which asked whose slot it was.
  const bare = winLoss.match(/clearGameState\(state\.gameMode\)/g) || [];
  assert.equal(bare.length, 1,
    'exactly one clear site: the guarded helper. A second is a lane clearing a slot it does not own.');

  const helper = winLoss.match(/function _clearOwnSave\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(helper, '_clearOwnSave must exist as the single clear site');
  assert.match(helper[0], /ownsSaveSlot\(state\)/,
    'the clear must be gated on ownership, not on the mode name');
  assert.match(helper[0], /clearGameState\(state\.gameMode\)/,
    'and the one bare call must be the one inside it');

  // Every end-of-game path routes through it.
  const calls = winLoss.match(/_clearOwnSave\(\)/g) || [];
  assert.ok(calls.length >= 4,
    'win, loss, time-up and the helper itself — a path that clears directly would have skipped the guard');
});

test('persistGameState refuses the same lanes, through the same predicate', () => {
  assert.match(persistence, /if \(!ownsSaveSlot\(state\)\) return;/,
    'the write end reads the shared predicate too, so the two ends cannot drift');
  // The old per-flag early returns are gone; one question, asked once.
  assert.equal((persistence.match(/if \(state\.isArchivePlay\) return;/g) || []).length, 0);
  assert.equal((persistence.match(/if \(state\.isWeeklyArchive\) return;/g) || []).length, 0);
});
