// Import-smoke gate: every module under src/{logic,firebase,state,storage,
// game,ui,audio} must EVALUATE without throwing. This is a LOAD test, not a
// behavior test — it catches the regressions a behavior test can't: a
// renamed/moved file that breaks an import path, a syntax error, a bad
// top-level reference, or a top-level throw. It runs in the existing
// `node --test` job (no browser).
//
// The modules occasionally grab DOM refs at import (domHelpers.js does
// document.querySelector(...) at module scope), so the shared headless shim
// (test/domShim.mjs — the same one the CALL-tests use) is installed BEFORE
// importing, rich enough that import-time element access is a no-op rather
// than a throw. ui/ and audio/ joined the gate 2026-07-12 (previously
// e2e-boot-smoke-only): every module there imports cleanly under the shim,
// so a white-screen-class break in a ui module now fails at the cheap unit
// layer instead of waiting for the e2e boot smoke. main.js stays out — it
// is the boot orchestrator and runs init() at load; that render is the e2e
// boot smoke's job.
//
// What the shim deliberately does NOT mask: module-resolution failures and
// syntax errors throw regardless of any DOM, and an undefined imported binding
// or a missing function still throws. Those are exactly the breakages we want.

import './domShim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

// ── The gate ───────────────────────────────────────────
// One test per file so a failure names the offending module.
const DIRS = ['logic', 'firebase', 'state', 'storage', 'game', 'ui', 'audio'];

// Modules that can't be import-smoked headless yet, each with the reason.
// (Empty: game/modeManager.js was excluded while it imported restorePreChaosTheme
// from ../main.js — importing it booted the whole app via main.js's top-level
// init(). That chaos-theme stash/restore now lives in ui/themeManager.js, so no
// game module imports the entry orchestrator and modeManager loads headless.)
const EXCLUDE = new Set();

for (const dir of DIRS) {
  const files = readdirSync(new URL(`../src/${dir}/`, import.meta.url), { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.js'))
    .map((d) => d.name)
    .sort();
  for (const file of files) {
    if (EXCLUDE.has(`${dir}/${file}`)) continue;
    test(`evaluates src/${dir}/${file}`, async () => {
      await assert.doesNotReject(import(`../src/${dir}/${file}`),
        `src/${dir}/${file} threw while loading — broken import, syntax error, or top-level throw`);
    });
  }
}
