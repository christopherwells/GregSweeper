// The sw.js precache must contain main.js's ENTIRE static import closure
// (issue #191).
//
// ASSETS is the only cache content guaranteed to survive a CACHE_NAME bump:
// activate deletes every cache whose key is not the current CACHE_NAME, so
// immediately after any deploy the cache holds exactly ASSETS and nothing
// else. A static module missing from the list means the app cannot boot
// offline until an online page load happens to re-fetch it through the
// runtime handler — and the list had silently drifted 29 modules behind
// (the whole 2026-07-10 main.js split, plus every pure-logic helper added
// since), because nothing pinned it. iconCoverage.test.mjs guards the
// SPRITES half of this invariant; this file guards the modules half by
// walking the real import graph, so a module added to the static closure
// tomorrow fails the suite until it is precached.
//
// Lazy (dynamic-import) modules are deliberately NOT required — the runtime
// fetch handler caches them on first use, and sw.js documents which are
// precached anyway for offline coverage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Static import closure of main.js: line-start `import ... from './x.js'`
// and bare `import './x.js'`. Dynamic `import(...)` is deliberately not
// matched — those modules are runtime-cached on first use.
function staticClosure(entry) {
  const seen = new Set();
  const stack = [resolve(ROOT, entry)];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    let src;
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    const re = /^import\s[^;]*?from\s*['"](\.[^'"]+)['"]|^import\s*['"](\.[^'"]+)['"]/gm;
    for (const m of src.matchAll(re)) stack.push(resolve(dirname(f), m[1] || m[2]));
  }
  return [...seen].map(f => relative(ROOT, f).replace(/\\/g, '/')).sort();
}

function precacheEntries() {
  const sw = readFileSync(resolve(ROOT, 'sw.js'), 'utf8');
  const start = sw.indexOf('const ASSETS');
  const block = sw.slice(start, sw.indexOf('];', start));
  const assets = [];
  for (const line of block.split('\n')) {
    const t = line.trim();
    if (t.startsWith('//')) continue;
    const m = t.match(/^'\.\/([^']*)'/);
    if (m && m[1]) assets.push(m[1]);
  }
  return assets;
}

test('every static import of main.js is in the sw.js precache', () => {
  const closure = staticClosure('src/main.js').filter(f => f.endsWith('.js'));
  assert.ok(closure.length > 60, `sanity: closure should be large (got ${closure.length})`);
  const assets = new Set(precacheEntries());
  const missing = closure.filter(f => !assets.has(f));
  assert.deepEqual(missing, [],
    `static modules missing from sw.js ASSETS (app cannot boot offline after a deploy without them):\n  ${missing.join('\n  ')}`);
});

test('every precached file exists on disk — a stale entry bricks the SW install', () => {
  // install does cache.addAll(ASSETS); ONE 404 rejects the whole install,
  // so a deleted module left in the list breaks every future SW update.
  const missing = precacheEntries().filter(a => a && a !== '' && !existsSync(resolve(ROOT, a)));
  assert.deepEqual(missing, [],
    `sw.js ASSETS entries with no file on disk:\n  ${missing.join('\n  ')}`);
});

test('REGRESSION #191: the 2026-07-10 split modules are precached', () => {
  const assets = new Set(precacheEntries());
  for (const f of [
    'src/game/startupGate.js', 'src/game/parResolve.js', 'src/ui/titleScreen.js',
    'src/ui/statsModal.js', 'src/ui/leaderboardModal.js', 'src/ui/shareActions.js',
    'src/logic/moltDay.js', 'src/logic/resumeEligibility.js', 'src/logic/worms.js',
    'src/logic/canonicalSignature.js',
  ]) {
    assert.ok(assets.has(f), `${f} must be precached`);
  }
});
