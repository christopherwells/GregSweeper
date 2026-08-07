// Give all 250 challenge levels a board of their own.
//
// Christopher, 2026-08-07, after L65-70: "I do not want a duplicate at all and
// that should be double-checked since that is absolutely no fun."
//
// Measured before this ran: 250 levels carried 109 DISTINCT boards, so 141
// levels repeated one. Fifty specs appeared more than once and the worst
// appeared eight times (cairo 8x8 27m locked+sonar+walls, across L211-215 plus
// L233, L239 and L245). The generator was never at fault — every attempt draws
// a fresh certified layout — but shape, size, mine count and modifier set were
// identical, and those are the whole of what a player perceives.
//
// WHAT IS HELD FIXED. Each block keeps its TIER (the par ladder and the
// progression contract), its SHAPE, and its MODIFIER SET. The block's beat
// names those and the intro blocks teach them, which is his ruling: a training
// block may hold shape and modifier, it may not hold the board. So variety
// comes from the pair left over — dimensions and mine count — exactly as the
// liar intro at block 3 already does it (8x8 -> 9x9, mines 11/12/14/15/16).
//
// WHY A GLOBAL PASS rather than 50 local ones: a per-block fix cannot see that
// three different blocks all landed on the same cairo spec. Faces are assigned
// against a running set of everything already used, so uniqueness is a property
// of the whole ladder.
//
// Everything is MEASURED through the real builder, never predicted. The
// measurement pass is the expensive part and is cached to disk, so re-running
// the assignment is cheap.
//
//   node scripts/dedupe-challenge-ladder.mjs --measure   # build the cache
//   node scripts/dedupe-challenge-ladder.mjs             # assign + emit
//
// The emitted table still has to pass validate-challenge250-specs.mjs, which
// remains the gate for generation time, tier band and strict load-bearing.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import {
  challengeSpecForLevel, CHALLENGE_MAX_LEVEL, CHALLENGE_BLOCK_SIZE,
  TIER_PPC, PPC_BAND_LO, PPC_BAND_HI, GEN_CAP_MS, ppcBandFor,
} from '../src/logic/challenge250.js';
import { buildChallenge250Board, challengeBoardSeed } from '../src/logic/challenge250Builder.js';
import { buildTiling, containerIsStorable } from '../src/logic/tilingGeometry.js';
import { boardFitsPhone } from '../src/logic/boardFit.js';

const CACHE = new URL('./data/ladder-candidates.json', import.meta.url);
// Three draws is enough to MEDIAN a price for a shortlist; the ten-seed read
// that actually gates a spec is validate-challenge250-specs.mjs, which every
// emitted table still has to pass.
const SEEDS = 3;
// Enough to choose five distinct boards from, with room for the global
// uniqueness pass to reject some.
const CANDIDATES_PER_BLOCK = 22;
const OPENER_MIN_DEDUCTIONS = 3;   // mirrors the validator's opener floor
const GEN_HEADROOM = 0.8;          // margin under the cap; the headroom lesson
const BLOCKS = CHALLENGE_MAX_LEVEL / CHALLENGE_BLOCK_SIZE;

/**
 * Which tiers a measured ppc would satisfy, nearest-first from the block's own.
 * Only the immediate neighbours are offered: a block two rungs off its authored
 * target stops being the difficulty step the ladder promised.
 */
function tiersFor(ppc, ownTier) {
  const out = [];
  for (const t of [ownTier, ownTier + 1, ownTier - 1]) {
    const target = TIER_PPC[t];
    if (!target) continue;
    if (ppc >= target * PPC_BAND_LO && ppc <= target * PPC_BAND_HI) out.push(t);
  }
  return out;
}

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** What a player perceives. gimmickLevel is excluded: 81 vs 84 is invisible. */
export function faceOf(spec) {
  const dims = spec.shape === 'rect' ? `${spec.rows}x${spec.cols}` : `${spec.M}x${spec.N}`;
  return `${spec.shape}|${dims}|${spec.mines}|${[...spec.gimmicks].sort().join('+')}`;
}

/** Legal dimensions for a shape, phone cap included. */
function dimsFor(shape) {
  const out = [];
  if (shape === 'rect') {
    // Daily/weekly cap columns at 12; the ladder has always drawn from the
    // same envelope, and a wider board scrolls on a phone.
    for (let r = 5; r <= 16; r++) {
      for (let c = 5; c <= 12; c++) out.push({ rows: r, cols: c, cells: r * c });
    }
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

function measureSpec(spec, level) {
  const pars = [];
  const dedList = [];
  let worst = 0;
  for (let k = 0; k < SEEDS; k++) {
    const t0 = Date.now();
    const res = buildChallenge250Board(spec, challengeBoardSeed(level, k, 'dedupe'));
    worst = Math.max(worst, Date.now() - t0);
    if (!res) return null;                       // refused: uncertified or decorative
    pars.push(res.par);
    dedList.push((res.check.totalClicks || 1) - 1);
  }
  const par = median(pars);
  return { par, ppc: par / spec.cells, worst, deds: median(dedList) };
}

// ── measurement pass ────────────────────────────────────────────────
function measureAll() {
  const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
  let measured = 0;
  for (let b = 1; b <= BLOCKS; b++) {
    const lv0 = (b - 1) * CHALLENGE_BLOCK_SIZE + 1;
    const base = challengeSpecForLevel(lv0);
    const target = base.ppc || TIER_PPC[base.tier];
    const lo = target * PPC_BAND_LO;
    const hi = target * PPC_BAND_HI;
    const key = `b${b}`;
    if (cache[key]) { console.log(`block ${b}: cached (${cache[key].length})`); continue; }

    // Blocks that already ship five distinct boards are left ALONE. Block 1 is
    // one: 5x5/3, 5x5/4, 6x6/5, 6x6/6, 6x6/7. Re-picking them would churn
    // proven specs for nothing.
    const levels = [];
    for (let i = 0; i < CHALLENGE_BLOCK_SIZE; i++) levels.push(challengeSpecForLevel(lv0 + i));
    if (new Set(levels.map(faceOf)).size === CHALLENGE_BLOCK_SIZE) {
      cache[key] = levels.map((s) => ({
        shape: s.shape, rows: s.rows, cols: s.cols, M: s.M, N: s.N,
        cells: s.cells, mines: s.mines, gimmicks: s.gimmicks,
        gimmickLevel: s.gimmickLevel ?? null, constructive: s.constructive ?? null,
        maxDeductions: s.maxDeductions ?? null, wallSegments: s.wallSegments ?? null,
        alreadyDistinct: true,
      }));
      console.log(`block ${b}: already five distinct — kept as-is`);
      writeFileSync(CACHE, JSON.stringify(cache));
      continue;
    }

    // OPENER blocks are not graded on par. ppcBandFor returns null for them and
    // the validator gates on the deduction FLOOR instead, so filtering these by
    // TIER_PPC rejects nearly everything (block 1 came back with 2 candidates
    // before this was fixed). The ramp levels also each carry their own
    // maxDeductions — 5/5/7/9/11 across L1-5 — so a block cannot be searched as
    // one uniform spec.
    const band = ppcBandFor(base);

    const loosestCap = Math.max(...levels.map((s) => s.maxDeductions || 0)) || null;
    const hits = [];

    // A block needs FIVE distinct boards, not an exhaustive census. Enumerating
    // every legal size x every mine count was thousands of real generations per
    // block — hours across the ladder for an answer that only ever uses five of
    // them. Two economies, and the ORDER matters as much as the cap: sizes are
    // walked from the block's own scale outward, so an early stop still spans
    // the range rather than collecting only the smallest boards.
    const sizes = dimsFor(base.shape)
      .filter((d) => d.cells >= base.cells * 0.5 && d.cells <= base.cells * 1.9)
      .sort((a, x) => Math.abs(a.cells - base.cells) - Math.abs(x.cells - base.cells));

    outer:
    for (const d of sizes) {
      const step = Math.max(1, Math.round(d.cells * 0.03));
      for (let mines = Math.round(d.cells * 0.12); mines <= Math.round(d.cells * 0.42); mines += step) {
        if (hits.length >= CANDIDATES_PER_BLOCK) break outer;
        // Per-level opts (maxDeductions, gimmickLevel, wallSegments) are
        // re-applied at emit time from the level being replaced; the search
        // only needs the loosest cap in the block so it does not reject a
        // board that is fine for L5 because L1 is capped tighter.
        let tierFit = null;
        const spec = { ...base, ...d, mines, level: lv0, maxDeductions: loosestCap };
        const m = measureSpec(spec, lv0);
        if (!m) continue;
        if (band) {
          // Measured against the block's tier AND its neighbours, tagged with
          // which it satisfies. His ruling 2026-08-07, when a block could not
          // fill five distinct boards at its own tier: "if that's the case move
          // the block one later or something. These are really silly problems
          // to have." He is right that the tier assignment is self-imposed —
          // the ladder is a smooth x1.18 ramp, so one step is a small
          // perturbation, and a repeated board is a much worse outcome than a
          // block sitting a rung off its authored target.
          const fits = tiersFor(m.ppc, base.tier);
          if (!fits.length) continue;
          tierFit = fits;
        } else if (m.deds < OPENER_MIN_DEDUCTIONS) {
          continue;                              // opener: graded on deductions
        }
        if (m.worst > GEN_CAP_MS * GEN_HEADROOM) continue;
        hits.push({
          shape: base.shape, ...d, mines,
          gimmicks: base.gimmicks, gimmickLevel: base.gimmickLevel ?? null,
          constructive: base.constructive ?? null,
          par: m.par, ppc: m.ppc, worst: m.worst,
        });
      }
    }
    cache[key] = hits;
    measured++;
    console.log(`block ${b} (L${lv0}-${lv0 + 4}) ${base.shape} tier ${base.tier}: ${hits.length} in-band candidates`);
    writeFileSync(CACHE, JSON.stringify(cache));
  }
  console.log(`\nmeasured ${measured} new block(s); cache at ${CACHE.pathname}`);
}

// ── assignment pass ─────────────────────────────────────────────────
function assign() {
  if (!existsSync(CACHE)) {
    console.error('no candidate cache — run with --measure first');
    process.exit(1);
  }
  const cache = JSON.parse(readFileSync(CACHE, 'utf8'));
  const used = new Set();
  const plan = [];
  const shifted = [];
  const shortfalls = [];

  for (let b = 1; b <= BLOCKS; b++) {
    const lv0 = (b - 1) * CHALLENGE_BLOCK_SIZE + 1;
    const base = challengeSpecForLevel(lv0);
    const pool = (cache[`b${b}`] || []).slice()
      // A block should read as a climb: bigger board, then more mines.
      .sort((a, x) => a.cells - x.cells || a.mines - x.mines);

    if (pool.length && pool[0].alreadyDistinct) {
      for (const c of pool) used.add(faceOf(c));
      plan.push({ block: b, lv0, tier: base.tier, picks: pool, untouched: true });
      continue;
    }

    // Try the block's OWN tier first, and only widen to a neighbour if five
    // distinct boards cannot be found there. A repeated board is a worse
    // outcome than a block sitting one rung off its authored target.
    let picks = [];
    let tier = base.tier;
    for (const candidateTier of [base.tier, base.tier + 1, base.tier - 1]) {
      const fresh = pool.filter((c) => (c.tierFit || [base.tier]).includes(candidateTier)
        && !used.has(faceOf(c)));
      const got = spread(fresh, used);
      if (got.length > picks.length) { picks = got; tier = candidateTier; }
      if (picks.length === CHALLENGE_BLOCK_SIZE) break;
    }
    for (const c of picks) used.add(faceOf(c));
    if (tier !== base.tier) shifted.push({ block: b, from: base.tier, to: tier });
    if (picks.length < CHALLENGE_BLOCK_SIZE) {
      shortfalls.push({ block: b, got: picks.length, pool: pool.length, shape: base.shape });
    }
    plan.push({ block: b, lv0, tier, picks });
  }

  const totalPicked = plan.reduce((n, p) => n + p.picks.length, 0);
  console.log(`assigned ${totalPicked}/${CHALLENGE_MAX_LEVEL} levels · ${used.size} distinct faces`);
  console.log(`duplicates: ${totalPicked - used.size}`);
  if (shifted.length) {
    console.log(`
${shifted.length} block(s) moved a tier to find five distinct boards:`);
    for (const s2 of shifted) console.log(`   block ${s2.block}: tier ${s2.from} -> ${s2.to}`);
  }
  if (shortfalls.length) {
    console.log(`
${shortfalls.length} block(s) STILL short even after shifting:`);
    for (const s2 of shortfalls) console.log(`   block ${s2.block} (${s2.shape}): ${s2.got}/5, pool ${s2.pool}`);
  }
  // The ladder must still climb. A shifted block that overtakes its successor
  // would make the progression non-monotonic, which is a worse bargain than
  // the duplicate it was avoiding.
  const bad = [];
  for (let i = 1; i < plan.length; i++) {
    if (plan[i].tier < plan[i - 1].tier) bad.push(`block ${plan[i].block} (tier ${plan[i].tier}) follows block ${plan[i - 1].block} (tier ${plan[i - 1].tier})`);
  }
  if (bad.length) {
    console.log(`
NON-MONOTONIC after shifting — needs a look:`);
    for (const x of bad) console.log(`   ${x}`);
  }
  writeFileSync(new URL('./data/ladder-plan.json', import.meta.url), JSON.stringify(plan, null, 1));
  console.log('\nplan written to scripts/data/ladder-plan.json');
}

/** Five picks spread across a pool, skipping anything already used. */
function spread(fresh, used) {
  const picks = [];
  const taken = new Set();
  for (let i = 0; i < CHALLENGE_BLOCK_SIZE && fresh.length; i++) {
    const want = Math.round(i * (fresh.length - 1) / (CHALLENGE_BLOCK_SIZE - 1));
    for (let step = 0; step < fresh.length; step++) {
      let placed = false;
      for (const idx of [want + step, want - step]) {
        if (idx < 0 || idx >= fresh.length || taken.has(idx)) continue;
        const f = faceOf(fresh[idx]);
        if (used.has(f) || picks.some((p) => faceOf(p) === f)) continue;
        taken.add(idx);
        picks.push(fresh[idx]);
        placed = true;
        break;
      }
      if (placed) break;
    }
  }
  return picks;
}

if (process.argv.includes('--measure')) measureAll();
else assign();
