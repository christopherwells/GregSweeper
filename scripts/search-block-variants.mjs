// Find five DISTINCT board specs for a challenge block that all price into
// the same tier band.
//
// Christopher's ruling, 2026-08-07, after hitting L76-80: "training blocks
// should probably be the same set of shape and modifier, but they MUST not be
// the same board. That's unacceptable game mechanics."
//
// The generator was never the problem — a fresh certified layout is drawn on
// every attempt, and five draws of one spec give five different mine layouts.
// The problem is the authored table: 25 of the 50 blocks repeat ONE spec five
// times, so all five levels have the same shape, size, mine count and modifier
// set, and only the invisible layout differs. Measured, the ladder carries 31
// runs of four-or-more consecutive identical specs.
//
// Block 3 (the liar intro) already shows the shape of the fix: one shape, one
// modifier, but 8x8 -> 9x9 and mines 11/12/14/15/16. Same lesson, five real
// boards. This script finds that ladder for any block.
//
// What it holds fixed, and why: the block's TIER. That is the par ladder and
// the whole progression contract, and it is what the validator checks. What it
// varies is the pair the player actually sees — dimensions and mine count.
//
//   node scripts/search-block-variants.mjs 16          # one block
//   node scripts/search-block-variants.mjs 16 --wide   # allow modifier swaps
//
// Candidates are MEASURED, not predicted: each is built through the same
// buildChallenge250Board the play path uses, so a printed row has really
// generated. Feed the winners into CHALLENGE_BLOCKS and re-run
// validate-challenge250-specs.mjs, which is still the gate.

import { challengeSpecForLevel, TIER_PPC, PPC_BAND_LO, PPC_BAND_HI, GEN_CAP_MS } from '../src/logic/challenge250.js';
import { buildChallenge250Board, challengeBoardSeed } from '../src/logic/challenge250Builder.js';
import { buildTiling, containerIsStorable, TILING_TYPES } from '../src/logic/tilingGeometry.js';
import { boardFitsPhone } from '../src/logic/boardFit.js';

const LEAN = process.argv.includes('--lean');
const SEEDS = LEAN ? 4 : 6;   // draws per candidate; enough to median a price
const GEN_HEADROOM = 0.8; // leave margin under the cap (the headroom lesson)

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Every (M,N) or (rows,cols) this shape can legally take, phone-cap included. */
function dimsFor(shape) {
  const out = [];
  if (shape === 'rect') {
    for (let r = 5; r <= 16; r++) for (let c = 5; c <= 12; c++) out.push({ rows: r, cols: c, cells: r * c });
    return out;
  }
  for (let M = 1; M <= 20; M++) {
    for (let N = 1; N <= 14; N++) {
      if (!boardFitsPhone(shape, M, N)) continue;
      let t;
      try { t = buildTiling(shape, M, N); } catch { continue; }
      if (!containerIsStorable(t.total)) continue;
      out.push({ M, N, cells: t.total });
    }
  }
  return out;
}

function measure(spec, level) {
  const pars = [];
  let worst = 0;
  for (let k = 0; k < SEEDS; k++) {
    const t0 = Date.now();
    const res = buildChallenge250Board(spec, challengeBoardSeed(level, k, 'search'));
    worst = Math.max(worst, Date.now() - t0);
    if (!res) return null;                       // refused: uncertified or decorative
    pars.push(res.par);
  }
  const par = median(pars);
  return { par, ppc: par / spec.cells, worst };
}

const blocks = process.argv.slice(2).filter(a => /^\d+$/.test(a)).map(Number);
if (!blocks.length) {
  console.error('usage: node scripts/search-block-variants.mjs <blockNumber…> [--lean]');
  process.exit(1);
}
for (const block of blocks) runBlock(block);

function runBlock(block) {
const lv0 = (block - 1) * 5 + 1;
const base = challengeSpecForLevel(lv0);
const target = base.ppc || TIER_PPC[base.tier];
const lo = target * PPC_BAND_LO;
const hi = target * PPC_BAND_HI;
const budget = GEN_CAP_MS * GEN_HEADROOM;

const faceOf = (s) => `${s.shape}|${s.shape === 'rect' ? `${s.rows}x${s.cols}` : `${s.M}x${s.N}`}|${s.mines}`;
console.log(`block ${block} (L${lv0}-${lv0 + 4}) · tier ${base.tier} · target ppc ${target.toFixed(2)} · band [${lo.toFixed(2)}, ${hi.toFixed(2)}] · gen budget ${budget}ms`);
console.log(`currently ships: ${[...new Set([...Array(5)].map((_, i) => faceOf(challengeSpecForLevel(lv0 + i))))].join('  ')}`);
console.log(`\nsearching ${base.shape} variants holding modifiers [${base.gimmicks.join('+') || 'plain'}]…\n`);
console.log('  dims    cells mines   par     ppc    worst   verdict');

const hits = [];
for (const d of dimsFor(base.shape)) {
  // Only sizes near the block's own, so the block keeps its scale identity.
  if (d.cells < base.cells * 0.55 || d.cells > base.cells * 1.8) continue;
  const step = LEAN ? 2 : 1;
    for (let mines = Math.round(d.cells * 0.12); mines <= Math.round(d.cells * 0.42); mines += step) {
    const spec = { ...base, ...d, mines, level: lv0 };
    const m = measure(spec, lv0);
    if (!m) continue;
    if (m.ppc < lo || m.ppc > hi) continue;
    const ok = m.worst <= budget;
    const dims = base.shape === 'rect' ? `${d.rows}x${d.cols}` : `${d.M}x${d.N}`;
    console.log(`  ${dims.padEnd(7)} ${String(d.cells).padStart(4)} ${String(mines).padStart(5)}  ${m.par.toFixed(0).padStart(5)}s  ${m.ppc.toFixed(2)}  ${String(m.worst).padStart(5)}ms  ${ok ? 'OK' : 'over budget'}`);
    if (ok) hits.push({ dims, ...d, mines, ...m });
  }
}

console.log(`\n${hits.length} in-band candidates.`);
if (hits.length) {
  // A block should read as a climb, not a shuffle. Sorting by ppc alone gives
  // an incoherent ladder — on cairo, whose fitted per-mine term cancels its
  // base rate, price barely tracks mine count at all, so a ppc sort happily
  // proposes 18 mines then 9 then 7. Order by what a PLAYER perceives instead:
  // the board grows, and within one size the mines grow. Price only has to
  // stay in band, which every candidate here already does.
  const byFace = new Map();
  for (const h of hits) {
    const k = `${h.cells}|${h.mines}`;
    if (!byFace.has(k)) byFace.set(k, h);
  }
  const ladder = [...byFace.values()].sort((a, b) => a.cells - b.cells || a.mines - b.mines);
  // Spread the five picks across the ladder so the block spans its size range
  // rather than clustering at one end.
  const pick = [];
  for (let i = 0; i < 5 && ladder.length; i++) {
    pick.push(ladder[Math.min(ladder.length - 1, Math.round(i * (ladder.length - 1) / 4))]);
  }
  const uniq = pick.filter((p, i) => pick.findIndex(q => q.cells === p.cells && q.mines === p.mines) === i);
  console.log(`suggested ladder (${uniq.length} distinct, easiest first):`);
  for (const p of uniq) {
    console.log(`   ${base.shape === 'rect' ? `R(${p.rows}, ${p.cols}, ${p.mines}` : `T('${base.shape}', ${p.M}, ${p.N}, ${p.cells}, ${p.mines}`}, [${base.gimmicks.map(g => `'${g}'`).join(', ')}])   // ppc ${p.ppc.toFixed(2)}, ${p.worst}ms`);
  }
  if (uniq.length < 5) console.log(`   !! only ${uniq.length} distinct faces available — widen the size window or vary a modifier`);
}
console.log('');
}
