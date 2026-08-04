// Challenge 250 spec validator — times and certifies EVERY authored ladder
// spec through the ONE builder the play path uses, and refuses the table if
// any spec breaks a ruling (CHALLENGE_250_MAP.md, all rulings Christopher's
// 2026-08-03):
//
//   - every probe draw must come back CERTIFIED and STRICTLY LOAD-BEARING
//     (the builder returns null otherwise — a null draw is a failure here);
//   - THE 2-SECOND GENERATION CAP: worst draw time per spec <= 2000ms in
//     this run's own frame (as measured, no margin; desktop Node — phones
//     run ~3-5x slower and death-retries draw fresh layouts, so this is
//     player-facing);
//   - the 8-minute par ceiling: median par <= 480s;
//   - tier-band par-per-cell: median ppc within [0.93, 1.11] x the block's
//     authored target (opener blocks validate on the deduction floor
//     instead: every accepted draw needs >= 3 deductions past the opener,
//     with the 3-to-5 sizing medians reported for eyes).
//
// Levels sharing a spec fingerprint draw from one distribution, so each
// distinct spec proves once. Deterministic seeds: same table + same seeds
// => same boards (the validate-parlab-battery contract); wall clock is the
// one non-deterministic reading, which is why the cap is "as this run
// measures it".
//
// THE ENDLESS POOL is validated by the same run, under its own rulings: the
// par ceiling lifts to ten minutes, the ppc band becomes a FLOOR (the summit's
// 3.6 s/cell, since the zone is unbounded above it), and pool admission keeps
// its self-imposed generation margin. Every entry is proven independently of
// which level draws it, which is what makes the per-level draw safe.
//
//   node scripts/validate-challenge250-specs.mjs               # table + pool
//   node scripts/validate-challenge250-specs.mjs --blocks 42-50
//   node scripts/validate-challenge250-specs.mjs --seeds 3     # quick pass
//   node scripts/validate-challenge250-specs.mjs --quick       # = --seeds 3
//   node scripts/validate-challenge250-specs.mjs --endless     # pool only
//   node scripts/validate-challenge250-specs.mjs --no-endless  # table only

import {
  CHALLENGE_MAX_LEVEL, challengeSpecForLevel, specFingerprint, ppcBandFor,
  PAR_CEILING_SECONDS, GEN_CAP_MS, OPENER_MIN_DEDUCTIONS,
  ENDLESS_SPECS, ENDLESS_PAR_CEILING_SECONDS, ENDLESS_GEN_BUDGET_MS, TIER_PPC,
} from '../src/logic/challenge250.js';
import { buildChallenge250Board, challengeBoardSeed } from '../src/logic/challenge250Builder.js';

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const K = args.includes('--quick') ? 3 : Number(argVal('--seeds') || 10);

let blockFilter = null;
const blocksArg = argVal('--blocks');
if (blocksArg) {
  blockFilter = new Set();
  for (const part of blocksArg.split(',')) {
    const m = part.match(/^(\d+)-(\d+)$/);
    if (m) {
      for (let b = Number(m[1]); b <= Number(m[2]); b++) blockFilter.add(b);
    } else {
      blockFilter.add(Number(part));
    }
  }
}

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Group levels by spec fingerprint (insertion order = ladder order).
const ONLY_ENDLESS = args.includes('--endless');
const groups = new Map();
for (let level = 1; !ONLY_ENDLESS && level <= CHALLENGE_MAX_LEVEL; level++) {
  const spec = challengeSpecForLevel(level);
  if (blockFilter && !blockFilter.has(spec.block)) continue;
  const key = specFingerprint(spec);
  if (!groups.has(key)) groups.set(key, { spec, levels: [] });
  groups.get(key).levels.push(level);
}

console.log(`Challenge 250 spec validation — ${groups.size} distinct specs`
  + `${blockFilter ? ` (blocks ${blocksArg})` : ''}, ${K} seeds each.`);
console.log(`Rulings: certified+strict every draw · worst gen <= ${GEN_CAP_MS}ms`
  + ` · median par <= ${PAR_CEILING_SECONDS}s · ppc band [0.93, 1.11] x target`
  + ` · opener floor ${OPENER_MIN_DEDUCTIONS} deductions\n`);

let failures = 0;
let specIdx = 0;
const t0all = Date.now();

for (const { spec, levels } of groups.values()) {
  specIdx++;
  const times = [], pars = [], ppcs = [], deds = [];
  let ok = 0;
  for (let k = 0; k < K; k++) {
    const seed = challengeBoardSeed(levels[0], k, 'val');
    const t0 = Date.now();
    const res = buildChallenge250Board(spec, seed);
    const ms = Date.now() - t0;
    times.push(ms);
    if (!res) continue; // uncertified or decorative — the builder refused
    ok++;
    pars.push(res.par);
    ppcs.push(res.par / spec.cells);
    deds.push((res.check.totalClicks || 1) - 1);
  }

  const worst = Math.max(...times);
  const medPar = pars.length ? median(pars) : NaN;
  const medPpc = ppcs.length ? median(ppcs) : NaN;
  const medDed = deds.length ? median(deds) : NaN;
  const band = ppcBandFor(spec);

  const problems = [];
  if (ok !== K) problems.push(`${K - ok}/${K} draws refused`);
  if (worst > GEN_CAP_MS) problems.push(`worst gen ${worst}ms > ${GEN_CAP_MS}ms`);
  if (pars.length && medPar > PAR_CEILING_SECONDS) problems.push(`median par ${medPar.toFixed(0)}s > ${PAR_CEILING_SECONDS}s`);
  if (band && ppcs.length && (medPpc < band[0] || medPpc > band[1])) {
    problems.push(`ppc ${medPpc.toFixed(2)} outside [${band[0].toFixed(2)}, ${band[1].toFixed(2)}]`);
  }
  if (!band && deds.length && Math.min(...deds) < OPENER_MIN_DEDUCTIONS) {
    // The builder gates per draw; a violation here means the gate broke.
    problems.push(`accepted draw under the ${OPENER_MIN_DEDUCTIONS}-deduction floor`);
  }
  if (spec.maxDeductions && deds.length && Math.max(...deds) > spec.maxDeductions) {
    problems.push(`accepted draw over the ${spec.maxDeductions}-deduction cap`);
  }

  const pass = problems.length === 0;
  if (!pass) failures++;

  const lv = levels.length === 1 ? `L${levels[0]}` : `L${levels[0]}-${levels[levels.length - 1]}`;
  const shape = spec.shape === 'rect' ? `${spec.rows}x${spec.cols}` : `${spec.shape} ${spec.cells}c`;
  const gims = spec.gimmicks.length ? spec.gimmicks.join('+') : 'plain';
  const dedRange = deds.length ? `${Math.min(...deds)}-${Math.max(...deds)}` : '--';
  const bandTxt = band
    ? `ppc ${Number.isNaN(medPpc) ? ' -- ' : medPpc.toFixed(2)} (tgt ${spec.ppc.toFixed(2)})`
    : `deds ${dedRange} med ${Number.isNaN(medDed) ? '--' : medDed}`
      + ` (floor ${OPENER_MIN_DEDUCTIONS}${spec.maxDeductions ? `, cap ${spec.maxDeductions}` : ''})`;
  console.log(`${pass ? ' PASS' : ' FAIL'}  B${String(spec.block).padStart(2)} ${lv.padEnd(9)}`
    + ` ${shape.padEnd(16)} ${gims.padEnd(28)} ${String(ok).padStart(2)}/${K}`
    + `  worst ${String(worst).padStart(5)}ms  par ${Number.isNaN(medPar) ? '  --' : medPar.toFixed(0).padStart(4)}s  ${bandTxt}`
    + (pass ? '' : `\n        ^^ ${problems.join(' · ')}`));
}

// ── The endless pool ─────────────────────────────────────────────
//
// Each entry proves on its own terms, independent of which level draws it.
// That independence is the whole safety argument for the per-level draw:
// the draw only ever chooses among entries that have already passed here.
//
// Two rulings differ from the authored table's. The par ceiling is TEN
// minutes, and the ppc band becomes a FLOOR at the T12 summit rather than a
// window, because the zone is unbounded above 3.6 by ruling. The stored ppc
// is also re-checked against this run's measurement, since the escalation
// targets those numbers and a refit that moves a shape's equation moves them.
let endlessFailures = 0;
if (!args.includes('--no-endless') && !blockFilter) {
  console.log(`\nEndless pool — ${ENDLESS_SPECS.length} proven specs, ${K} seeds each.`);
  console.log(`Rulings: certified+strict every draw · worst gen <= ${ENDLESS_GEN_BUDGET_MS}ms`
    + ` (margin under the ${GEN_CAP_MS}ms cap) · median par <= ${ENDLESS_PAR_CEILING_SECONDS}s`
    + ` · ppc >= ${TIER_PPC[12]} (the summit is a FLOOR here)\n`);

  for (let i = 0; i < ENDLESS_SPECS.length; i++) {
    const spec = ENDLESS_SPECS[i];
    const times = [], pars = [], ppcs = [];
    let ok = 0;
    for (let k = 0; k < K; k++) {
      // A pool entry is not tied to a level, so its probe level is only a
      // seed ingredient; the spec is what is under test.
      const seed = challengeBoardSeed(900 + i, k, 'val-endless');
      const t0 = Date.now();
      const res = buildChallenge250Board(spec, seed);
      times.push(Date.now() - t0);
      if (!res) continue;
      ok++;
      pars.push(res.par);
      ppcs.push(res.par / spec.cells);
    }
    const worst = Math.max(...times);
    const medPar = pars.length ? median(pars) : NaN;
    const medPpc = ppcs.length ? median(ppcs) : NaN;

    const problems = [];
    if (ok !== K) problems.push(`${K - ok}/${K} draws refused`);
    if (worst > ENDLESS_GEN_BUDGET_MS) problems.push(`worst gen ${worst}ms > ${ENDLESS_GEN_BUDGET_MS}ms`);
    if (pars.length && medPar > ENDLESS_PAR_CEILING_SECONDS) {
      problems.push(`median par ${medPar.toFixed(0)}s > ${ENDLESS_PAR_CEILING_SECONDS}s`);
    }
    if (ppcs.length && medPpc < TIER_PPC[12]) {
      problems.push(`ppc ${medPpc.toFixed(2)} below the ${TIER_PPC[12]} summit floor`);
    }
    // The stored price is what the escalation aims at. A generous 25% drift
    // window: this is an alarm for a moved equation, not a re-measurement.
    if (ppcs.length && Math.abs(Math.log(medPpc / spec.ppc)) > Math.log(1.25)) {
      problems.push(`stored ppc ${spec.ppc.toFixed(2)} vs measured ${medPpc.toFixed(2)}`
        + ' — re-run scripts/search-endless-specs.mjs');
    }

    const pass = problems.length === 0;
    if (!pass) endlessFailures++;
    const shape = spec.shape === 'rect' ? `${spec.rows}x${spec.cols}` : `${spec.shape} ${spec.cells}c`;
    const gims = spec.gimmicks.length ? spec.gimmicks.join('+') : 'plain';
    console.log(`${pass ? ' PASS' : ' FAIL'}  E${String(i).padStart(2)} ${shape.padEnd(16)}`
      + ` ${gims.padEnd(28)} ${String(ok).padStart(2)}/${K}  worst ${String(worst).padStart(5)}ms`
      + `  par ${Number.isNaN(medPar) ? '  --' : medPar.toFixed(0).padStart(4)}s`
      + `  ppc ${Number.isNaN(medPpc) ? ' -- ' : medPpc.toFixed(2)} (stored ${spec.ppc.toFixed(2)})`
      + (pass ? '' : `\n        ^^ ${problems.join(' · ')}`));
  }
}

const mins = ((Date.now() - t0all) / 60000).toFixed(1);
const total = failures + endlessFailures;
if (total) {
  console.error(`\n*** ${total} SPEC(S) FAILED (${failures} authored, ${endlessFailures} endless; ${mins} min) ***`);
  process.exit(1);
}
console.log(`\nEvery spec proves out (${groups.size} authored + ${ENDLESS_SPECS.length} endless,`
  + ` ${K} seeds each, ${mins} min).`);
