// Re-measure endless-pool candidates over a WIDE seed sample and keep only
// the ones that hold the zone's rulings.
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
// GENERATION IS JUDGED ON THE NORM, NOT ON THE WORST OF THE SAMPLE
// (2026-08-11, completing the 34bb136 ruling the validator already applies).
// This tool used to hold worst-of-N to the admission budget, and that bar was
// the mistake challengeRules.js documents: it dropped every Classic endless
// candidate on tails their medians never showed (medians 241-447ms, tails
// past 2s), while his ruling is explicit that an occasional 2.5s draw is
// fine and only slow-as-the-norm is not. So the checks here are the
// validator's own: the MEDIAN inside the shape's generation cap, and at most
// GEN_SLOW_DRAW_RATE of draws past the peak allowance (scaled to the
// shape's cap exactly as the validator scales it). The worst draw is still
// printed — it is information — but it no longer decides anything alone.
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
//
// The emitted table is in REFERENCE-COHORT seconds (the ladder's yardstick,
// applied 2026-08-11): the pool's shipped prices are cohort-scaled at emit,
// so a hand-spliced harden line must be on the same scale or it lands a few
// percent off and the nightly re-price restates it on day one.

import { buildChallenge250Board, challengeBoardSeed } from '../src/logic/challenge250Builder.js';
import {
  ENDLESS_SPECS, endlessGenCap, endlessParCeiling, endlessPpcFloor,
  GEN_CAP_MS, GEN_CAP_PEAK_MS, GEN_SLOW_DRAW_RATE,
} from '../src/logic/challenge250.js';
import { referenceScale } from './ladder-reference-cohort.mjs';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };
const N = Number(argVal('--seeds') || 20);
// Admission par bar: comfortably under the shape's own ceiling, so
// sample-to-sample variation in the median cannot push an entry over it.
const PAR_HEADROOM = 0.93;
// And a margin ABOVE the admission floor, for the same reason in the other
// direction: an entry admitted at exactly its floor reads below it on a
// smaller sample. The floor is the SHAPE's — cairo and 3D Cubes carry their
// own (his every-tiling-available ruling), and holding them to the shared
// 3.5 here would drop entries the rules explicitly admit.
const PPC_FLOOR_MARGIN = 1.03;
const parBar = (shape) => endlessParCeiling(shape) * PAR_HEADROOM;
const SALTS = ['harden-a', 'harden-b', 'harden-c'];
const SCALE = referenceScale();

const file = argVal('--file');
const specs = file ? JSON.parse(readFileSync(file, 'utf8')) : ENDLESS_SPECS;

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

console.log(`Hardening ${specs.length} endless candidates: ${N} seeds x ${SALTS.length} salts`
  + ` = ${N * SALTS.length} draws each. Generation on the NORM (median <= the shape's cap,`
  + ` at most ${GEN_SLOW_DRAW_RATE * 100}% of draws past its peak allowance),`
  + ` par bar at ${(PAR_HEADROOM * 100).toFixed(0)}% of each shape's ceiling, prices cohort-scaled (x${SCALE.toFixed(4)}).
`);

const kept = [];
for (let i = 0; i < specs.length; i++) {
  const spec = specs[i];
  const genCap = endlessGenCap(spec.shape);
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
      // Bail early on a spec that is clearly out — but "clearly out" is a
      // property of the NORM now, never of one draw: a single slow draw is
      // exactly what the peak allowance permits. A 9-second board still
      // bails on its first draw (4x the cap is past any allowance).
      if (ms > genCap * 4) { bailed = true; break; }
      if (times.length >= 10 && median(times) > genCap * 1.5) { bailed = true; break; }
    }
    if (bailed) break;
  }

  const worst = Math.max(...times);
  const medMs = median(times);
  const peak = genCap * (GEN_CAP_PEAK_MS / GEN_CAP_MS);
  const slow = times.filter((t) => t > peak).length;
  const medPar = pars.length ? median(pars) * SCALE : NaN;
  const medPpc = medPar / spec.cells;
  const shape = spec.shape === 'rect' ? `${spec.rows}x${spec.cols}` : `${spec.shape} ${spec.cells}c`;
  const gims = spec.gimmicks.length ? spec.gimmicks.join('+') : 'plain';

  const problems = [];
  if (refused) problems.push(`${refused} refused`);
  if (bailed) problems.push('bailed: slow as the norm');
  if (medMs > genCap) problems.push(`median ${medMs}ms > ${genCap}ms cap`);
  if (slow / times.length > GEN_SLOW_DRAW_RATE) {
    problems.push(`${slow}/${times.length} draws over ${peak.toFixed(0)}ms — past "on occasion"`);
  }
  const bar = parBar(spec.shape);
  if (pars.length && medPar > bar) problems.push(`par ${medPar.toFixed(0)}s > ${bar.toFixed(0)}s bar`);
  const ppcBar = endlessPpcFloor(spec.shape) * PPC_FLOOR_MARGIN;
  if (pars.length && medPpc < ppcBar) {
    problems.push(`ppc ${medPpc.toFixed(2)} under the ${ppcBar.toFixed(2)} bar`);
  }

  const ok = problems.length === 0;
  if (ok) kept.push({ ...spec, ppc: Number(medPpc.toFixed(2)) });
  console.log(`${ok ? ' KEEP' : ' DROP'} ${String(i).padStart(3)} ${shape.padEnd(16)} ${gims.padEnd(28)}`
    + ` draws ${String(times.length).padStart(3)}  med ${String(medMs).padStart(4)}ms`
    + ` worst ${String(worst).padStart(5)}ms  ppc ${Number.isNaN(medPpc) ? ' -- ' : medPpc.toFixed(2)}`
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
  // EVERY spec option rides the line: dropping wallSegments here would
  // splice a walled spec into the pool that silently generates unwalled.
  const opts = [];
  if (k.gimmickLevel) opts.push(`gimmickLevel: ${k.gimmickLevel}`);
  if (k.wallSegments) opts.push(`wallSegments: ${k.wallSegments}`);
  if (k.constructive) opts.push('constructive: true');
  const g = k.gimmicks.length
    ? `, [${k.gimmicks.map((x) => `'${x}'`).join(', ')}]${opts.length ? `, { ${opts.join(', ')} }` : ''}`
    : (opts.length ? `, [], { ${opts.join(', ')} }` : '');
  const ctor = k.shape === 'rect'
    ? `R(${k.rows}, ${k.cols}, ${k.mines}${g})`
    : `T('${k.shape}', ${k.M}, ${k.N}, ${k.cells}, ${k.mines}${g})`;
  console.log(`  E(${k.ppc.toFixed(2)}, ${ctor}),`);
}
