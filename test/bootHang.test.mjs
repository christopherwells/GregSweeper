// The boot overlay comes down at the END of init(), so anything the boot path
// awaits holds the whole app on the loading screen until it settles. init()'s
// .catch is a safety net for a THROW and cannot help with a HANG — a promise
// that never settles is never rejected, so nothing fires and the player sits on
// "Verifying today's play…" indefinitely.
//
// Two hang shapes have actually shipped, and both are structural rather than
// logical, which is why they are pinned by SOURCE SCAN: there is no cheaper
// layer. Reproducing either needs a Firebase socket that accepts a read and
// never answers, or a browser that refuses sessionStorage writes.
//
//   1. Realtime DB's once('value') has NO timeout of its own. On a half-open
//      socket (a phone waking from sleep, a captive portal, a dropped wifi
//      handover) it simply never settles. Every other Firebase read on the boot
//      path is Promise.race'd against a deadline; the reconcile read was not.
//   2. A throw inside a setTimeout callback does not reject the promise the
//      callback was meant to resolve. sessionStorage throws on write in a
//      storage-restricted context (Safari private browsing, a locked-down PWA
//      container) — which is precisely the iOS path that block exists for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../src/game/startupGate.js', import.meta.url), 'utf8');

test('REGRESSION: every Firebase read in the startup gate is raced against a timeout', () => {
  const reads = [...SRC.matchAll(/\.once\s*\(/g)];
  assert.ok(reads.length > 0, 'expected the gate to still perform a Firebase read');
  for (const m of reads) {
    // Walk back to the statement this read belongs to and require the race to
    // be part of it. 400 chars comfortably spans an awaited Promise.race block
    // without reaching the previous statement.
    const window = SRC.slice(Math.max(0, m.index - 400), m.index);
    assert.match(
      window, /Promise\.race\s*\(\s*\[/,
      `once() at index ${m.index} is not inside a Promise.race — an unanswered read `
      + 'strands the boot overlay forever, and init\'s .catch cannot see a hang');
  }
});

test('REGRESSION: the gate never awaits a bare loadDailyBoard-style read without a deadline', () => {
  // The gate's own retry loop re-enters loadDailyBoard, which carries its own
  // budget. What must never appear is a raw `await ref.on...`-shaped read or an
  // await on a promise with no timer behind it. Covered by the scan above; this
  // pins the companion constant so the budget cannot be silently removed.
  assert.match(SRC, /RECONCILE_READ_TIMEOUT_MS\s*=\s*\d+/,
    'the reconcile read must keep an explicit, named timeout budget');
});

// Comments discuss the very identifiers this scan looks for, so strip them
// first — otherwise the guard reads its own prose as code and fires on a
// correctly-written file.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

test('REGRESSION: sessionStorage use inside the SW-wait timer cannot strand the promise', () => {
  // Locate the forced-reload block and require its storage access to sit inside
  // a try. Without it, one setItem throw means `resolve` is never called.
  const code = stripComments(SRC);
  const block = /_gs_skip_force_reload/.exec(code);
  assert.ok(block, 'expected the iOS forced-reload guard to still exist');
  const start = code.lastIndexOf('setTimeout', block.index);
  assert.ok(start >= 0, 'expected the guard to live inside a setTimeout callback');
  const body = code.slice(start, code.indexOf('}, 2000)', start));
  const tryAt = body.indexOf('try {');
  const useAt = body.indexOf('sessionStorage');
  assert.ok(tryAt >= 0, 'the forced-reload callback must wrap its storage access in try');
  assert.ok(tryAt < useAt,
    'sessionStorage is touched before the try opens — a throw there skips resolve() '
    + 'and the boot overlay never comes down');
});
