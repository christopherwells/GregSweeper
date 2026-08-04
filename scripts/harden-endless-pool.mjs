// Re-measure endless-pool candidates over a WIDE seed sample and keep only
// the ones whose worst generation stays inside the budget.
//
// Why this exists, and why the search alone is not enough: generation time is
// the one non-deterministic reading in the whole ladder, and it is heavy-
// tailed. The first pool was admitted on 5 seeds per spec and 12 of its 50
// entries failed the validator on a DIFFERENT 5 seeds — one rhombille entry
// measured 1216ms in the search and 9843ms in validation. A five-draw sample
// does not see a tail that only shows up one layout in ten, and an endless
// board is drawn fresh on every attempt AND every death-retry, so the tail is
// exactly what the player meets.
//
// So admission is worst-of-N over several salts, not a median and not a small
// sample. Entries that survive here are the ones the validator then re-proves.
//
// The same argument applies to PAR, one step subtler. A median par moves about
// +/-30s between samples, so an entry measured at 595s against the 600s
// ceiling passes here and fails in validation on different seeds, and the pool
// then fails intermittently with nobody having changed it. Admission therefore
// requires par under ENDLESS_PAR_HEADROOM of the ceiling, while the validator
// keeps checking the real ceiling. Whack-a-mole on individual entries is the
// symptom of not having this rule; four entries were swapped one at a time
// before it existed.
//
//   node scripts/harden-endless-pool.mjs                  # the shipped pool
//   node scripts/harden-endless-pool.mjs --seeds 24
//   node scripts/harden-endless-pool.mjs --file cands.json

import { buildChallenge250Board, challengeBoardSeed } from '../src/logic/challenge250Builder.js';
import { ENDLESS_SPECS, ENDLESS_GEN_BUDGET_MS, ENDLESS_PAR_CEILING_SECONDS, TIER_PPC } from '../src/logic/challenge250.js';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };
const N = Number(argVal('--seeds') || 20);
// Admission par bar: comfortably under the ceiling, so sample-to-sample
// variation in the median cannot push a pool entry over it.
const PAR_BAR = ENDLESS_PAR_CEILING_SECONDS * 0.93;   // 558s
const SALTS = ['harden-a', 'harden-b', 'harden-c'];

const file = argVal('--file');
const specs = file ? JSON.parse(readFileSync(file, 'utf8')) : ENDLESS_SPECS;

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

console.log(`Hardening ${specs.length} endless candidates: ${N} seeds x ${SALTS.length} salts`
  + ` = ${N * SALTS.length} draws each, budget ${ENDLESS_GEN_BUDGET_MS}ms worst.\n`);

const kept = [];
for (let i = 0; i < specs.length; i++) {
  const spec = specs[i];
  const times = [], pars = [];
  let refused = 0;
  let bailed = false;
  for (const salt of SALTS) {
    for (let k = 0; k < N; k++) {
      const t0 = Date.now();
      const res = buildChallenge250Board(spec, challengeBoardSeed(700 + i, k, salt));
      const ms = Date.now() - t0;
      times.push(ms);
      if (!res) { refused++; continue; }
      pars.push(res.par);
      // Bail early on a spec that is clearly out: no point spending a minute
      // proving a 9-second board is a 9-second board.
      if (ms > ENDLESS_GEN_BUDGET_MS * 2) { bailed = true; break; }
    }
    if (bailed) break;
  }

  const worst = Math.max(...times);
  const medPar = pars.length ? median(pars) : NaN;
  const medPpc = medPar / spec.cells;
  const shape = spec.shape === 'rect' ? `${spec.rows}x${spec.cols}` : `${spec.shape} ${spec.cells}c`;
  const gims = spec.gimmicks.length ? spec.gimmicks.join('+') : 'plain';

  const problems = [];
  if (refused) problems.push(`${refused} refused`);
  if (worst > ENDLESS_GEN_BUDGET_MS) problems.push(`worst ${worst}ms`);
  if (pars.length && medPar > PAR_BAR) problems.push(`par ${medPar.toFixed(0)}s > ${PAR_BAR.toFixed(0)}s bar`);
  if (pars.length && medPpc < TIER_PPC[12]) problems.push(`ppc ${medPpc.toFixed(2)} under the summit`);

  const ok = problems.length === 0;
  if (ok) kept.push({ ...spec, ppc: Number(medPpc.toFixed(2)) });
  console.log(`${ok ? ' KEEP' : ' DROP'} ${String(i).padStart(3)} ${shape.padEnd(16)} ${gims.padEnd(28)}`
    + ` draws ${String(times.length).padStart(3)}  worst ${String(worst).padStart(5)}ms`
    + `  p50 ${String(median(times)).padStart(4)}ms  ppc ${Number.isNaN(medPpc) ? ' -- ' : medPpc.toFixed(2)}`
    + (ok ? '' : `   << ${problems.join(' · ')}`));
}

console.log(`\n${kept.length}/${specs.length} survive. By shape:`);
const byShape = {};
for (const k of kept) (byShape[k.shape] ||= []).push(k.ppc);
for (const [sh, ppcs] of Object.entries(byShape)) {
  console.log(`  ${sh.padEnd(11)} ${ppcs.length} entries, ppc ${Math.min(...ppcs)}-${Math.max(...ppcs)}`);
}

console.log('\n--- table ---');
kept.sort((a, b) => a.ppc - b.ppc);
for (const k of kept) {
  const g = k.gimmicks.length
    ? `, [${k.gimmicks.map((x) => `'${x}'`).join(', ')}]${k.gimmickLevel ? `, { gimmickLevel: ${k.gimmickLevel} }` : ''}`
    : '';
  const ctor = k.shape === 'rect'
    ? `R(${k.rows}, ${k.cols}, ${k.mines}${g})`
    : `T('${k.shape}', ${k.M}, ${k.N}, ${k.cells}, ${k.mines}${g})`;
  console.log(`  E(${k.ppc.toFixed(2)}, ${ctor}),`);
}
