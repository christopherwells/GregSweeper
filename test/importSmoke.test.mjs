// Import-smoke gate: every module under src/{logic,firebase,state,storage,game}
// must EVALUATE without throwing. This is a LOAD test, not a behavior test —
// it catches the regressions a behavior test can't: a renamed/moved file that
// breaks an import path, a syntax error, a bad top-level reference, or a
// top-level throw. It runs in the existing `node --test` job (no browser).
//
// The modules occasionally grab DOM refs at import (domHelpers.js does
// document.querySelector(...) at module scope), so we install a headless DOM/
// window/navigator shim BEFORE importing — rich enough that import-time element
// access is a no-op rather than a throw. ui/ modules aren't enumerated directly
// (the e2e boot-smoke spec covers their real render), but the ones reachable
// from game/ are evaluated transitively and so are covered here for free.
//
// What the shim deliberately does NOT mask: module-resolution failures and
// syntax errors throw regardless of any DOM, and an undefined imported binding
// or a missing function still throws. Those are exactly the breakages we want.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

// ── Headless DOM/window shim ───────────────────────────
// A universal element stub: any property access returns a chainable no-op
// function, and the few hot data props (style/classList/children/text) return
// sane shapes. Callable so `el()` never throws; primitives to '' so string
// coercion is safe; non-thenable so an accidental await won't hang.
function stubStyle() {
  return new Proxy({ setProperty() {}, getPropertyValue() { return ''; }, removeProperty() {} }, {
    get(t, p) { return p in t ? t[p] : ''; },
    set() { return true; },
  });
}
function stubEl() {
  return new Proxy(function () {}, {
    get(_t, prop) {
      switch (prop) {
        case 'style': return stubStyle();
        case 'dataset': return {};
        case 'classList': return { add() {}, remove() {}, toggle() {}, replace() {}, contains() { return false; } };
        case 'children': case 'childNodes': return [];
        case 'length': return 0;
        case 'value': case 'textContent': case 'innerHTML': case 'innerText':
        case 'className': case 'id': case 'tagName': case 'nodeName': return '';
        case 'parentNode': case 'parentElement': case 'nextSibling':
        case 'previousSibling': case 'firstChild': case 'lastChild': return null;
        case 'getContext': return () => stubEl();
        case 'getBoundingClientRect':
          return () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });
        case 'querySelector': case 'closest': return () => null;
        case 'querySelectorAll': case 'getElementsByClassName': case 'getElementsByTagName': return () => [];
        case 'then': return undefined; // never look thenable
        case Symbol.toPrimitive: return () => '';
        case Symbol.iterator: return [][Symbol.iterator].bind([]);
        default: return () => stubEl(); // appendChild, setAttribute, addEventListener, focus, …
      }
    },
    apply() { return stubEl(); },
  });
}

if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    documentElement: stubEl(), body: stubEl(), head: stubEl(),
    createElement: () => stubEl(), createElementNS: () => stubEl(),
    createDocumentFragment: () => stubEl(), createTextNode: () => stubEl(),
    getElementById: () => stubEl(), querySelector: () => stubEl(),
    querySelectorAll: () => [], getElementsByClassName: () => [], getElementsByTagName: () => [],
    addEventListener() {}, removeEventListener() {},
    cookie: '', visibilityState: 'visible', hidden: false,
  };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    location: { search: '', hostname: 'localhost', pathname: '/', href: 'http://localhost/', origin: 'http://localhost' },
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    devicePixelRatio: 1, innerWidth: 800, innerHeight: 600,
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
}
if (typeof globalThis.navigator === 'undefined') {
  globalThis.navigator = { userAgent: 'node', platform: 'node', maxTouchPoints: 0, language: 'en-US', onLine: true };
}
if (typeof globalThis.location === 'undefined') globalThis.location = globalThis.window.location;
if (typeof globalThis.requestAnimationFrame === 'undefined') globalThis.requestAnimationFrame = () => 0;
if (typeof globalThis.matchMedia === 'undefined') globalThis.matchMedia = globalThis.window.matchMedia;
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    key: (i) => Array.from(store.keys())[i] ?? null,
    clear: () => store.clear(),
    get length() { return store.size; },
  };
}

// ── The gate ───────────────────────────────────────────
// One test per file so a failure names the offending module. ui/ is excluded
// here (the e2e boot-smoke spec exercises its real DOM render); main.js is the
// boot orchestrator and is likewise an e2e concern.
const DIRS = ['logic', 'firebase', 'state', 'storage', 'game'];

// Modules that can't be import-smoked headless yet, each with the reason.
// game/modeManager.js imports restorePreChaosTheme from ../main.js, and main.js
// runs init() at module top level — so importing modeManager boots the whole
// app (preloadSprites → the browser-only Image constructor → throw) in Node.
// That game-module-reaches-into-the-entry-orchestrator coupling is a real smell
// the smoke test surfaced; breaking it belongs to the Layer-1 modeSwitchPlan
// extraction, which will relocate restorePreChaosTheme out of main.js and
// re-add modeManager here. Excluding is honest only because it's tracked.
const EXCLUDE = new Set(['game/modeManager.js']);

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
