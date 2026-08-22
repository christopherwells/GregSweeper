// Every pointer path that can REVEAL must consult the view-move grace.
//
// REGRESSION #422: the 200ms grace shipped guarding the TOUCH handler only,
// while his report was about clicking: "I've hit several mines because I
// tripled clicked by accident, revealing a cell that was a mine. The first
// two clicks moved the view and the third revealed."
//
// _navTap is shared, so double-CLICK centering is live on desktop exactly as
// double-tap is on a phone. The glide runs 380ms and moves the board under a
// cursor that has not moved, so a third click well inside that window lands
// on whatever cell slid under the pointer. On the mouse path it is WORSE than
// on touch, because the handler is mousedown: the reveal fires on the press,
// not the release.
//
// This is a source scan on purpose. The defect was a missing branch in one of
// two mirrored handlers, which is a shape no behavioural test of the working
// handler can ever catch, and the pure grace rule is already tested in
// test/boardCamera.test.mjs. What was missing was a second CALLER.
//
// Run: node --test test/viewMoveGraceCoverage.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

/** The body of one addEventListener block on the board element. */
function handlerBody(event) {
  const needle = `boardEl.addEventListener('${event}'`;
  const start = SRC.indexOf(needle);
  assert.notEqual(start, -1, `no ${event} handler found on the board`);
  // Up to the next board-level listener, which bounds every handler here.
  const next = SRC.indexOf('boardEl.addEventListener(', start + needle.length);
  return SRC.slice(start, next === -1 ? SRC.length : next);
}

test('REGRESSION #422: both pointer paths refuse a reveal while the view is gliding', () => {
  for (const event of ['mousedown', 'touchend']) {
    const body = handlerBody(event);
    // NON-VACUITY: this handler must actually be able to reveal, or asserting
    // that it guards revealing proves nothing.
    assert.ok(body.includes('revealCell('),
      `${event} does not reveal, so this scan is measuring the wrong handler`);
    assert.ok(body.includes('viewMoveGraceActive()'),
      `${event} can reveal mid-glide: it never asks viewMoveGraceActive()`);
    // The guard has to sit IN FRONT of the reveal, not merely somewhere in
    // the handler; an `else if` after `revealCell` would read as coverage.
    assert.ok(body.indexOf('viewMoveGraceActive()') < body.indexOf('revealCell('),
      `${event} asks the question after it has already revealed`);
  }
});

test('the keyboard path deliberately does NOT take the grace, and says why', () => {
  // Focus travels WITH the board: a glide does not move the focused cell, so
  // the player is always acting on the cell they chose. The reasoning belongs
  // in the file rather than in the reader's head, which is what makes the
  // absence a decision instead of the same omission twice.
  const kb = SRC.slice(SRC.indexOf("boardEl.addEventListener('keydown'"));
  const arm = kb.slice(kb.indexOf("case 'Enter'"), kb.indexOf("case 'Enter'") + 900);
  assert.ok(!arm.includes('viewMoveGraceActive()'),
    'the keyboard arm should not need the grace');
  assert.ok(/#422/.test(arm) && /focus/i.test(arm),
    'the keyboard exemption must be explained where the next reader will look');
});
