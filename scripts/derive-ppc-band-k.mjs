// Re-derive k for the per-face ppc band: max(PPC_BAND, k * (spread - 1)).
//
// HIS RULING (2026-08-20): Option 1, the per-face band at k = 0.20, which
// covered 93% of 70 measured faces. IT WAS NEVER BUILT, and the measurement
// behind it predates the RATE FORM (#404, 2026-08-21), which re-scales par
// per cell entirely. The spreads k was fitted against were measured under
// M1's concave size curve, so shipping 0.20 unexamined would be exactly the
// stale-number trap that produced the hand-set width cap twice.
//
// WHAT THIS MEASURES, and why it is set up this way. In production the band
// judges a FRESH median against the face's STORED price, using the face's
// STORED spread to size the tolerance. So the experiment is that setup: draw
// two INDEPENDENT seed families per face, take family A as the stored
// measurement (its median and its spread) and family B as the fresh one, and
// ask whether the band A implies contains the move to B.
//
// spread = maxPar / minPar over a family's own draws, which is the definition
// the search tools already store.
//
// Usage:
//   node scripts/derive-ppc-band-k.mjs [--faces 80] [--seeds 10] [--minutes 40]
//   node scripts/derive-ppc-band-k.mjs --out scripts/data/ppc-band-derivation.json

import fs from 'node:fs';
import { ENDLESS_POOL } from '../src/logic/challengePool.js';
import { challengeSpecForLevel, CHALLENGE_MAX_LEVEL } from '../src/logic/challenge250.js';
import { buildChallenge250Board, challengeBoardSeed } from '../src/logic/challenge250Builder.js';
import { PPC_BAND } from '../src/logic/challenge250.js';
import { modelFingerprint } from '../src/logic/parModelFingerprint.js';

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const FACES = Number(argVal('--faces', 80));
// FAITHFUL TO PRODUCTION, and this matters more than it looks. The band
// judges a FRESH validator median (K = 10 by default) against the face's
// STORED price, and that stored price is a 16-seed capture. Measuring 10
// against 10 overstates the noise the band has to contain: it did, by nearly
// three times, implying a 15.3% failure rate where the validator's own run
// over the same pool found 5.8%.
const K_STORED = Number(argVal('--stored-seeds', 16));
const K_FRESH = Number(argVal('--seeds', 10));
const BUDGET_MS = Number(argVal('--minutes', 40)) * 60000;
const OUT = argVal('--out', '');

const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quant = (xs, q) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

const faceOf = (s) => [s.shape || 'rect', `${s.rows ?? s.M}x${s.cols ?? s.N}`, s.cells,
  s.mines, (s.gimmicks || []).join('+') || 'plain'].join('|');

// THE VALIDATOR'S OWN POPULATION, not the raw pool.
//
// The validator groups by spec over the reachable levels and judges 318
// distinct specs. The pool holds 694 entries carrying a price; the rest are
// alternates no level currently draws. Sizing the band on the pool measures a
// population the band never judges, and it showed: the pool sample implied a
// 19.2% flat-band failure rate against the validator's own 12.6% over the
// same evening. The band is an instrument for the validator, so it is sized
// on what the validator looks at.
function validatorSpecs() {
  const byFace = new Map();
  for (let level = 1; level <= CHALLENGE_MAX_LEVEL; level++) {
    const spec = challengeSpecForLevel(level);
    if (!spec || spec.ppc == null) continue;   // openers validate on deductions
    const key = faceOf(spec);
    if (!byFace.has(key)) byFace.set(key, { spec, pool: 'ladder' });
  }
  for (const spec of ENDLESS_POOL) {
    if (!spec || spec.ppc == null) continue;
    const key = faceOf(spec);
    if (!byFace.has(key)) byFace.set(key, { spec, pool: 'endless' });
  }
  return [...byFace.values()];
}

const picks = validatorSpecs().slice(0, FACES);


function drawFamily(spec, salt, n) {
  const pars = [];
  let refused = 0;
  for (let k = 0; k < n; k++) {
    const seed = challengeBoardSeed(1000 + k, k, salt);
    let r = null;
    try { r = buildChallenge250Board(spec, seed); } catch { r = null; }
    if (!r || !(r.par > 0)) { refused++; continue; }
    pars.push(r.par);
  }
  if (!pars.length) return null;
  return {
    med: median(pars),
    spread: Math.min(...pars) > 0 ? Math.max(...pars) / Math.min(...pars) : null,
    n: pars.length, refused,
  };
}

const t0 = Date.now();
const rows = [];
console.log(`derive-ppc-band-k: ${picks.length} faces, store ${K_STORED} seeds vs fresh ${K_FRESH},`
  + ` budget ${BUDGET_MS / 60000} min, model ${modelFingerprint()}`);
for (const { spec, pool } of picks) {
  if (Date.now() - t0 > BUDGET_MS) { console.log('  budget spent'); break; }
  // A is the STORE (16 seeds: its median is the price, its draws the spread);
  // B is a validator pass (10 seeds).
  const A = drawFamily(spec, 'kdrvA', K_STORED);
  const B = drawFamily(spec, 'kdrvB', K_FRESH);
  if (!A || !B || A.spread == null) continue;
  const deviation = Math.abs(B.med - A.med) / A.med;
  rows.push({
    face: faceOf(spec), pool, shape: spec.shape || 'rect', cells: spec.cells,
    storedPpc: spec.ppc, medA: A.med, medB: B.med,
    spread: Number(A.spread.toFixed(3)), deviation: Number(deviation.toFixed(4)),
    refusedA: A.refused, refusedB: B.refused,
  });
  if (rows.length % 10 === 0) {
    console.log(`  ${rows.length} faces measured (${((Date.now() - t0) / 1000 | 0)}s)`);
  }
}

if (!rows.length) { console.error('no faces measured'); process.exit(1); }

const spreads = rows.map((r) => r.spread);
const devs = rows.map((r) => r.deviation);
console.log(`\nmeasured ${rows.length} faces in ${((Date.now() - t0) / 1000 | 0)}s`);
console.log(`  spread    median ${median(spreads).toFixed(2)}  p25 ${quant(spreads, 0.25).toFixed(2)}`
  + `  p75 ${quant(spreads, 0.75).toFixed(2)}  max ${Math.max(...spreads).toFixed(2)}`);
console.log(`  deviation median ${(median(devs) * 100).toFixed(1)}%  p75 ${(quant(devs, 0.75) * 100).toFixed(1)}%`
  + `  p90 ${(quant(devs, 0.9) * 100).toFixed(1)}%  max ${(Math.max(...devs) * 100).toFixed(1)}%`);

// The flat band as it ships today, for the comparison that matters.
const flatCover = rows.filter((r) => r.deviation <= PPC_BAND).length / rows.length;
console.log(`\n  FLAT band (${(PPC_BAND * 100).toFixed(0)}%) covers ${(flatCover * 100).toFixed(1)}% of faces`);

console.log('\n  per-face band max(0.12, k x (spread - 1)):');
const grid = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50];
const coverage = {};
for (const k of grid) {
  const cov = rows.filter((r) => r.deviation <= Math.max(PPC_BAND, k * (r.spread - 1))).length / rows.length;
  coverage[k] = cov;
  const widths = rows.map((r) => Math.max(PPC_BAND, k * (r.spread - 1)));
  console.log(`    k=${k.toFixed(2)}  covers ${(cov * 100).toFixed(1)}%`
    + `   median width ${(median(widths) * 100).toFixed(0)}%  max width ${(Math.max(...widths) * 100).toFixed(0)}%`);
}

const out = {
  measuredAt: new Date().toISOString(), model: modelFingerprint(),
  faces: rows.length, storedSeeds: K_STORED, freshSeeds: K_FRESH, flatBand: PPC_BAND,
  flatCoverage: flatCover, coverage, rows,
};
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(out, null, 1)); console.log(`\nwrote ${OUT}`); }
