// handleWin is async (the name gate awaits) and its callers fire it without
// awaiting — every call site must carry a labeled .catch so a mid-win
// rejection lands in errors/{uid} as [caught:handle-win] with a stack,
// instead of an anonymous unhandledrejection whose reason may be a
// stack-less Firebase object (2026-07-12, audit follow-up). Source scan in
// the iconCoverage style: a new bare `handleWin()` call fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FILES = [
  'src/game/gameActions.js',
  'src/game/winLossHandler.js',
  'src/game/powerUpActions.js',
];

test('every fire-and-forget handleWin() call carries a labeled .catch', () => {
  for (const file of FILES) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    // Bare invocations only: `handleWin()` not followed by `.catch`. The
    // declaration (`function handleWin()`) is excluded by lookbehind; the
    // setter (`setHandleWin(...)`) doesn't match the call pattern.
    const bare = [...src.matchAll(/(?<!function )(?<![\w$])handleWin\(\)(?!\s*\.catch)/g)];
    // Allow awaited calls (none today, but an `await handleWin()` is safe).
    const offenders = bare.filter((m) => !/await\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index)));
    assert.equal(offenders.length, 0,
      `${file}: ${offenders.length} bare handleWin() call(s) without .catch — a rejection there loses its [caught:handle-win] label`);
  }
});

test('the injected _handleWin reference is the wrapped one', () => {
  const src = readFileSync(new URL('../src/game/winLossHandler.js', import.meta.url), 'utf8');
  assert.match(src, /setHandleWin\(\(\) => handleWin\(\)\.catch/,
    'powerUpActions fires _handleWin without await — the registration must inject the labeled wrapper');
});
