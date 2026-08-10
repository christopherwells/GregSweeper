// Price every phone-legal board shape once, so the library generator can AIM
// at a level's par target instead of sampling the spec list and hoping.
//
// Why this exists: the first generator run put L26 at 375s against a 120s
// target and reported OFF-BAND on every level, because it drew specs blindly
// and the ones that cleared the two-minute floor were simply the biggest.
// Par by size is steep and shape-specific (Classic reaches 120s at 132 cells,
// floret at 72 and then 502s by 126), so targeting needs a table.
//
// PLAIN boards only. Modifiers move par as well, but pricing all 51 modifier
// sets would cost 51x for no benefit: the map's job is to narrow candidates to
// roughly the right SIZE, and the generator then measures each real candidate's
// par and holds it to the band. The map targets; the measurement accepts.
//
//   node scripts/build-climb-price-map.mjs            # full, slow shapes last
//   node scripts/build-climb-price-map.mjs --fast     # skip rhombille/deltoidal

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { buildChallenge250Board } from '../src/logic/challenge250Builder.js';
import { buildTiling, containerIsStorable, containerFor, TILING_TYPES } from '../src/logic/tilingGeometry.js';
import { boardFitsPhone } from '../src/logic/boardFit.js';
import { modelFingerprint } from '../src/logic/parModelFingerprint.js';

const OUT = new URL('./data/', import.meta.url);
const DENSITIES = [0.18, 0.22, 0.26, 0.30];
const DRAWS = 2;
// Slowest first would stall the log; slowest LAST means a --fast run and a
// full run share a prefix and the partial output is already useful.
const SHAPE_ORDER = ['rect', 'hex', '4.8.8', 'cairo', 'floret', 'deltoidal', 'rhombille'];
const SLOW = new Set(['rhombille', 'deltoidal']);

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const hardOf = (c) => c.canonicalSubsetMoves + c.genericSubsetMoves
  + c.advancedLogicMoves + c.disjunctiveMoves;

function patches() {
  const out = [];
  for (const shape of TILING_TYPES) {
    for (let M = 2; M <= 16; M++) {
      for (let N = 2; N <= 16; N++) {
        let T;
        try { T = buildTiling(shape, M, N); } catch { continue; }
        if (!containerIsStorable(T.total) || !boardFitsPhone(shape, M, N)) continue;
        if (T.total < 40) continue;
        out.push({ shape, M, N, cells: T.total, ...containerFor(T.total) });
      }
    }
  }
  for (let rows = 6; rows <= 20; rows++) {
    for (const cols of [9, 10, 11, 12, 13]) {
      if (rows * cols < 40) continue;
      out.push({ shape: 'rect', rows, cols, cells: rows * cols });
    }
  }
  return out.sort((a, b) => SHAPE_ORDER.indexOf(a.shape) - SHAPE_ORDER.indexOf(b.shape) || a.cells - b.cells);
}

const fast = process.argv.includes('--fast');
const all = patches().filter((p) => !(fast && SLOW.has(p.shape)));
console.log(`pricing ${all.length} patches x ${DENSITIES.length} densities x ${DRAWS} draws`);

const rows = [];
const t0 = Date.now();
let done = 0;
for (const p of all) {
  for (const dens of DENSITIES) {
    const mines = Math.round(p.cells * dens);
    if (mines < 4 || mines > p.cells * 0.45) continue;
    const spec = { ...p, mines, gimmicks: [], constructive: true };
    const par = [], hard = [], ms = [];
    for (let i = 0; i < DRAWS; i++) {
      const t = Date.now();
      const r = buildChallenge250Board(spec, `price:${p.shape}:${p.cells}:${mines}:${i}`);
      ms.push(Date.now() - t);
      if (r && r.check && r.par) { par.push(r.par); hard.push(hardOf(r.check)); }
    }
    done++;
    if (!par.length) continue;
    rows.push({
      shape: p.shape, rows: p.rows, cols: p.cols, M: p.M, N: p.N,
      cells: p.cells, mines, par: Math.round(med(par)), hard: med(hard), genMs: med(ms),
    });
  }
  if (done % 40 < DENSITIES.length) {
    process.stdout.write(`  ${rows.length} priced, ${Math.round((Date.now() - t0) / 1000)}s elapsed (${p.shape} ${p.cells}c)\n`);
  }
}

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const file = new URL(`climb-price-map${fast ? '-fast' : ''}.json`, OUT);
writeFileSync(file, JSON.stringify({
  builtAt: null, parModel: modelFingerprint(), densities: DENSITIES, draws: DRAWS,
  entries: rows,
}, null, 0));

console.log(`\npriced ${rows.length} specs in ${Math.round((Date.now() - t0) / 1000)}s`);
const byShape = {};
for (const r of rows) (byShape[r.shape] ||= []).push(r);
console.log('\nshape        specs   par range        specs at 120s+   hard med');
console.log('-----------  -----   --------------   --------------   --------');
for (const s of SHAPE_ORDER) {
  const g = byShape[s];
  if (!g) continue;
  const ps = g.map((r) => r.par).sort((a, b) => a - b);
  console.log(`${s.padEnd(11)}  ${String(g.length).padStart(5)}   ${String(ps[0]).padStart(4)}s to ${String(ps.at(-1)).padStart(5)}s   `
    + `${String(g.filter((r) => r.par >= 120).length).padStart(14)}   ${String(med(g.map((r) => r.hard))).padStart(8)}`);
}
