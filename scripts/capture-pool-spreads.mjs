// Measure every shipped pool face's within-face price spread and stamp it
// onto its entry, so the validator's band can be sized per face.
//
// spread = maxPar / minPar over the face's own draws, the definition the
// search tools already use. It is a property of the FACE under a given model,
// so it is re-measured whenever the model moves, exactly like the price.
//
// THE EDIT IS TEXTUAL AND MINIMAL, deliberately. The pool is a generated
// table but it is also the thing every proven price lives in, and
// re-rendering it from a parse would rewrite 694 lines to change one number
// on each. So this appends the spread as E()'s third argument and leaves
// every other byte alone, which keeps the diff readable and makes an
// unintended change to a spec impossible rather than merely unlikely.
//
// Usage:
//   node scripts/capture-pool-spreads.mjs [--seeds 16] [--minutes 30] [--dry-run]

import fs from 'node:fs';
import { LADDER_POOL, ENDLESS_POOL, CHALLENGE_POOL } from '../src/logic/challengePool.js';
import { buildChallenge250Board, challengeBoardSeed } from '../src/logic/challenge250Builder.js';
import { modelFingerprint } from '../src/logic/parModelFingerprint.js';

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const K = Number(argVal('--seeds', 16));
const BUDGET_MS = Number(argVal('--minutes', 30)) * 60000;
const DRY = args.includes('--dry-run');
const FILE = new URL('../src/logic/challengePool.js', import.meta.url);

// ALL THREE TABLES. The coverage table is the one that gets forgotten (the
// repricer's own migration had to be taught it), and forgetting it here was
// not harmless: 93 of the ladder's priced levels draw from coverage, so the
// per-face band read the flat width for them and the first validator run
// after the wiring still carried their failures.
const TABLES = [
  { marker: 'POOL', pool: LADDER_POOL, label: 'ladder' },
  { marker: 'ENDLESS', pool: ENDLESS_POOL, label: 'endless' },
  { marker: 'CHALLENGE', pool: CHALLENGE_POOL, label: 'coverage' },
];

function measureSpread(spec) {
  const pars = [];
  for (let k = 0; k < K; k++) {
    let r = null;
    try { r = buildChallenge250Board(spec, challengeBoardSeed(2000 + k, k, 'spread')); } catch { r = null; }
    if (r && r.par > 0) pars.push(r.par);
  }
  if (pars.length < 2) return null;
  const lo = Math.min(...pars);
  return lo > 0 ? Number((Math.max(...pars) / lo).toFixed(3)) : null;
}

const t0 = Date.now();
let src = fs.readFileSync(FILE, 'utf8');
console.log(`capture-pool-spreads: ${K} seeds per face, model ${modelFingerprint()}`);

let stamped = 0, skipped = 0, ranOut = false;
for (const { marker, pool, label } of TABLES) {
  const a = src.indexOf(`// ${marker}:START`);
  const b = src.indexOf(`// ${marker}:END`);
  if (a < 0 || b < 0) throw new Error(`${marker} markers missing from challengePool.js`);
  const head = src.slice(0, a);
  const block = src.slice(a, b);
  const tail = src.slice(b);
  const lines = block.split('\n');
  // Entry lines, in array order. One entry per line is the emitter's own
  // format; anything else here would mean the table was hand-edited.
  const idxs = lines.map((l, i) => (/^\s*E\(/.test(l) ? i : -1)).filter((i) => i >= 0);
  if (idxs.length !== pool.length) {
    throw new Error(`${marker}: ${idxs.length} entry lines but ${pool.length} entries — the table is not one-per-line`);
  }
  let done = 0;
  for (let n = 0; n < pool.length; n++) {
    if (Date.now() - t0 > BUDGET_MS) { ranOut = true; break; }
    const spec = pool[n];
    if (spec.ppc == null) { skipped++; continue; }   // openers carry no price
    const spread = measureSpread(spec);
    if (spread == null) { skipped++; continue; }
    const i = idxs[n];
    const line = lines[i];
    // Either append a third argument or replace the one already there.
    // Replace an existing third argument, or append one. The guard tests that
    // the PATTERN matched, never that the text changed: a re-measure can
    // legitimately land on the identical spread, and treating that as a
    // failure made the tool refuse its own second run.
    const hasSpread = /\),\s*[\d.]+\),?\s*$/;
    const noSpread = /\)(\),?\s*)$/;
    if (hasSpread.test(line)) {
      lines[i] = line.replace(/\),\s*[\d.]+(\),?\s*)$/, `), ${spread}$1`);
    } else if (noSpread.test(line)) {
      lines[i] = line.replace(noSpread, `), ${spread}$1`);
    } else {
      throw new Error(`${marker} line ${i} did not match the entry shape: ${line.trim().slice(0, 80)}`);
    }
    stamped++; done++;
    if (done % 100 === 0) console.log(`  ${label}: ${done}/${pool.length} (${((Date.now() - t0) / 1000 | 0)}s)`);
  }
  src = head + lines.join('\n') + tail;
  if (ranOut) break;
}

if (!DRY) fs.writeFileSync(FILE, src);
console.log(`capture-pool-spreads: stamped ${stamped}, skipped ${skipped}`
  + (ranOut ? ', BUDGET SPENT (rerun to finish)' : '')
  + ` in ${((Date.now() - t0) / 1000 | 0)}s`
  + (DRY ? ' (dry run: nothing written)' : ''));
