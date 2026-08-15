// List the corners where a single-modifier host gets an empty deal.
//
//   node scripts/match-narrow-holes.mjs [--out <file.json>]
//
// The deal's modifier filter is a SUBSET test, so a host permitting exactly
// one modifier draws only plain boards and boards wearing that one modifier
// alone. A (shape, modifier, time, density) cell can therefore read well
// stocked in the pooled count while holding NOTHING that host can draw: every
// board there wears the modifier in a stack. Measured 2026-08-15 that was 34
// cells, and this script exists so the number is re-derivable rather than
// remembered.
//
// Output is corner keys ("shape|modifier|time|density"), one per hole, in the
// exact form topup-match-library.mjs --corners consumes: the pair is the
// scalpel workflow, derive then aim. Cells whose POOLED count is also zero are
// deliberately not listed: nothing at that shape and band wears the modifier
// at all, so the gap is a band-reachability question (the sparse-and-long
// discussion), not a generation errand.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { matchPageNames, OUT_DIR } from './match-index-files.mjs';
import { timeBandOf, densityBandOf } from '../src/logic/matchRules.js';

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };

export function narrowHoles(rows) {
  const plain = new Map();          // "shape|time|dens" -> n
  const single = new Map();         // "shape|mod|time|dens" -> n
  const pooled = new Map();         // "shape|mod|time|dens" -> n
  for (const r of rows) {
    const cell = `${r.shape}|${r.time}|${r.dens}`;
    if (r.mods.length === 0) plain.set(cell, (plain.get(cell) || 0) + 1);
    if (r.mods.length === 1) {
      const k = `${r.shape}|${r.mods[0]}|${r.time}|${r.dens}`;
      single.set(k, (single.get(k) || 0) + 1);
    }
    for (const m of r.mods) {
      const k = `${r.shape}|${m}|${r.time}|${r.dens}`;
      pooled.set(k, (pooled.get(k) || 0) + 1);
    }
  }
  const holes = [];
  for (const [k, n] of pooled) {
    const [shape, mod, time, dens] = k.split('|');
    const narrow = (plain.get(`${shape}|${time}|${dens}`) || 0) + (single.get(k) || 0);
    if (narrow === 0) holes.push({ corner: k, pooled: n });
  }
  holes.sort((a, b) => (a.corner < b.corner ? -1 : 1));
  return holes;
}

function main() {
  const rows = [];
  for (const name of matchPageNames()) {
    const { boards } = JSON.parse(readFileSync(new URL(name, OUT_DIR), 'utf8'));
    for (const b of boards) {
      if (!b || b.evicted) continue;   // a tombstone is not supply
      rows.push({
        shape: b.spec.shape,
        mods: (b.spec.gimmicks || []).slice().sort(),
        time: timeBandOf(b.par),
        dens: densityBandOf(b.spec.mines, b.spec.cells),
      });
    }
  }
  const holes = narrowHoles(rows);
  console.log(`${rows.length} boards scanned; ${holes.length} single-modifier hole(s):`);
  for (const h of holes) console.log(`  ${h.corner}  (pooled ${h.pooled}, narrow 0)`);
  const out = argVal('--out', null);
  if (out) {
    writeFileSync(out, JSON.stringify(holes.map((h) => h.corner), null, 1));
    console.log(`wrote ${holes.length} corner key(s) to ${out}`);
  }
}

const _isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (_isMain) main();
