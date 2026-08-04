// Challenge 250 expected-time cue (his ruling: expected time is
// DISPLAYED, handicap-adjusted, as a pre-level card plus a quiet in-game
// bar — "go go go, but no real punishment"). The pure half, so the fill
// math and the copy are checkable without a DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatExpected, paceState, expectedTimeLine } from '../src/logic/expectedTime.js';

test('formatExpected: seconds under a minute, clock above', () => {
  assert.equal(formatExpected(0), '0s');
  assert.equal(formatExpected(48), '48s');
  assert.equal(formatExpected(59.4), '59s');
  assert.equal(formatExpected(60), '1:00');
  assert.equal(formatExpected(112), '1:52');
  assert.equal(formatExpected(400), '6:40');
  assert.equal(formatExpected(480), '8:00', 'the par ceiling reads cleanly');
});

test('NO PUNISHMENT: the bar fills and stops — an overrun never exceeds full', () => {
  const half = paceState(50, 100);
  assert.equal(half.known, true);
  assert.equal(half.fill, 0.5);
  assert.equal(half.over, false);
  assert.equal(half.remaining, 50);

  const exact = paceState(100, 100);
  assert.equal(exact.fill, 1);
  assert.equal(exact.over, true);
  assert.equal(exact.remaining, 0);

  // Three times over par: still exactly full, still zero remaining. This
  // clamp IS the no-punishment rule — a slow solve has nothing left to
  // show rather than a meter that keeps scolding.
  const slow = paceState(300, 100);
  assert.equal(slow.fill, 1);
  assert.equal(slow.over, true);
  assert.equal(slow.remaining, 0);
});

test('an unknown or absent expected time renders nothing rather than a fake bar', () => {
  for (const bad of [0, null, undefined, NaN, -5, 'x']) {
    const p = paceState(30, bad);
    assert.equal(p.known, false, `expected ${String(bad)} to be unknown`);
    assert.equal(p.fill, 0);
    assert.equal(p.over, false);
    assert.equal(expectedTimeLine(bad), '', 'no line without a number');
  }
});

test('negative or junk elapsed clamps to the start (a fresh board reads empty)', () => {
  assert.equal(paceState(-10, 100).fill, 0);
  assert.equal(paceState(null, 100).fill, 0);
  assert.equal(paceState(undefined, 100).remaining, 100);
});

test('the card line always hedges — personalPar is an estimate, not a promise', () => {
  assert.equal(expectedTimeLine(48), 'About 48s');
  assert.equal(expectedTimeLine(112), 'About 1:52');
  assert.match(expectedTimeLine(300), /^About /);
});
