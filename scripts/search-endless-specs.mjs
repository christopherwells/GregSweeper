// Search the ladder's SPEC SPACE: certified, strictly load-bearing boards
// across every shape, size, density and modifier stack a phone can hold —
// one pool that both the authored ladder (L26-250) and the endless zone
// (L251+) draw from.
//
// WHY IT IS STRATIFIED, and this is the whole point of the rewrite.
// Christopher's ruling, 2026-08-08: "I would like to see somewhat equal
// representation of gimmicks, tilings, etc. I do not want it to default to
// classic compass boards or something when there is a ton of space to
// explore here." A sweep that spends one budget greedily measures whatever
// certifies cheapest, and the shapes are two ORDERS OF MAGNITUDE apart on
// generation cost (4.8.8 ~21ms worst, rhombille ~2371ms). Left alone a
// bigger sweep drifts straight to a monoculture — which is exactly what the
// old 39-entry pool shows (floret 10, deltoidal 9, against rect 1 and
// rhombille 1). So the budget is spent in ROUND-ROBIN over strata, one
// stratum = (shape x modifier set), and every stratum gets the same number
// of VISITS regardless of what a visit costs it. Representation is then a
// property of the search rather than a hope about its output.
//
// WHAT THE OLD SCRIPT MISSED. It swept a hand-written grid of 3 sizes and 5
// stacks per shape — about 1,250 candidates against a legal space of
// ~467,000 distinct faces — and floored at 3.5 s/cell, so it could only ever
// serve the endless zone. Everything the ladder needs (0.55 to 3.6 s/cell)
// was outside what it looked at.
//
// ECONOMIES, all carried over from the ladder dedupe tool where they were
// measured:
//   - BAIL AFTER THE FIRST OVER-BUDGET DRAW, never after three. One draw ran
//     7.7 minutes on a spec the budget rejects; 35 minutes of wall clock went
//     into 150 such measurements.
//   - A RUNAWAY SIZE CEILING per shape: once a cell count has failed on time
//     twice, stop offering that shape anything larger.
//   - STRIDE-1 REFINEMENT (--refine) around keepers, because a coarse mine
//     stride jumps over a narrow band: 3% of cells is a stride of 5 on a
//     168-cell board.
//
// It is RESUMABLE and BUDGETED: every measurement lands in a cache keyed by
// specFace, and --minutes caps wall clock, so the sweep can be run in
// sittings and the pool grows across them.
//
// PRICES IN THE CACHE FOLLOW THE MODEL. A measurement's expensive half —
// generation, certification, strict load-bearing, timing — is
// MODEL-INDEPENDENT, and only its price is not. So every entry stores the
// feature vector of its median draw alongside the price, exactly as the
// shipped pool does, and `--reprice-cache` re-answers every one of them under
// the current model in about a second.
//
// Without that, a re-search after a refit selects — and applies its ceilings
// and floors — using yesterday's numbers, on a cache that takes hours to
// rebuild. That went wrong once, on 2026-08-09, and was worked around by hand.
// Entries measured before this change carry no features; they keep their old
// price, `--reprice-cache` reports how many, and the number falls to zero as
// the sweep revisits them.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildChallenge250Board, challengeBoardSeed } from '../src/logic/challenge250Builder.js';
import {
  endlessParCeiling, endlessGenCap, endlessGenBudget, endlessPpcFloor,
  PAR_CEILING_SECONDS, GEN_CAP_MS, ENDLESS_GEN_HEADROOM, specFace,
} from '../src/logic/challengeRules.js';
import { buildTiling, containerIsStorable, TILING_TYPES } from '../src/logic/tilingGeometry.js';
import { boardFitsPhone } from '../src/logic/boardFit.js';
import { predictPar } from '../src/logic/dailyFeatures.js';
import { modelFingerprint } from '../src/logic/parModelFingerprint.js';
import { referenceScale } from './ladder-reference-cohort.mjs';
import { BOARD_WIDTH_CAP } from '../src/logic/difficulty.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(__dirname, 'data', 'spec-search-cache.json');

const args = process.argv.slice(2);
const argVal = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const hasFlag = (n) => args.includes(n);

const SEEDS = Number(argVal('--seeds', 3));
const ONLY_SHAPE = argVal('--shape');
const BUDGET_MS = Number(argVal('--minutes', 45)) * 60_000;
const REFINE = hasFlag('--refine');
const REPORT_ONLY = hasFlag('--report');
const EMIT = argVal('--emit');
const ABSORB = hasFlag('--absorb');
const REPRICE = hasFlag('--reprice-cache');

// 3% above whatever floor applies (see emitPool's floorFn).
const PPC_FLOOR_MARGIN = 1.03;

// And the SAME margin on the par ceiling, for the same reason and learned the
// same way three times over — first on the generation cap, then on the endless
// floor, now here. An entry admitted at 479s against a 480s ceiling crosses it
// on any re-measurement and on any refit, and then the nightly re-price
// refuses to write and the run goes red on a pool nobody changed. Admission
// wants HEADROOM, never merely a passing measurement.
const PAR_CEILING_MARGIN = 0.95;

// The ladder is priced in the REFERENCE COHORT's seconds, not the population's
// — see ladder-reference-cohort.mjs for why, and for what it was measured to be
// worth. Applied at EMIT (the cache stays in population seconds), and read once
// per run so a whole pool is emitted on one yardstick.
const SCALE = referenceScale();

// The equations every price in this run is answered by.
const MODEL = modelFingerprint();

// ── The legal space ────────────────────────────────────────────────────

export const SHAPES = ['rect', ...TILING_TYPES];

// Every modifier the ladder may use. Pressure plates and mineShift are
// Chaos-only by ruling and never appear here.
const LADDER_GIMMICKS = ['walls', 'liar', 'mystery', 'locked', 'wormhole', 'mirror', 'sonar', 'compass', 'worm'];

// Density rails the authored table is held to (test/difficulty-and-stats):
// past these the generator stops finding certified layouts at all.
const DENSITY_MAX = { rect: 0.46, tiling: 0.38 };
const DENSITY_MIN = 0.08;

// Below this a tiling falls back to rejection sampling, which is weak
// exactly there (rhombille 0/12 at 0.211), so the spec opts into the
// constructive placer. RE-DERIVED from the shipped mine count, never copied.
const CONSTRUCTIVE_BELOW = 0.22;

// Rect does not go through boardFitsPhone — the phone cap is a
// tiling-geometry question and test/boardFit.test.mjs skips rect specs
// explicitly — but it is NOT unbounded: BOARD_WIDTH_CAP in difficulty.js is
// the rectangular width rule and test/difficulty-and-stats.test.mjs holds
// every ladder level to it. Read from there rather than restated, because a
// second copy of a shipped cap is a second thing to keep in step.
//
// Height has no equivalent cap (the height budget is the looser axis on a
// phone for every shape), so it is bounded by the cell-count window below
// plus the same tallest-shipped reasoning.
const RECT_MAX_COLS = BOARD_WIDTH_CAP;
const RECT_MAX_ROWS = 14;
const RECT_MIN_DIM = 5;

// Cell-count window. The floor is the smallest authored opener (25); the
// ceiling is what the dearest par ceiling can hold at the pool's gentlest
// rate, plus room — a board bigger than this cannot price inside any
// consumer's ceiling no matter how it is filled.
const MIN_CELLS = 25;
const MAX_CELLS = 200;

/** Every (a, b) a shape can legally take, with its cell count. */
function legalDims(shape) {
  const out = [];
  if (shape === 'rect') {
    for (let rows = RECT_MIN_DIM; rows <= RECT_MAX_ROWS; rows++) {
      for (let cols = RECT_MIN_DIM; cols <= RECT_MAX_COLS; cols++) {
        const cells = rows * cols;
        if (cells < MIN_CELLS || cells > MAX_CELLS) continue;
        out.push({ a: rows, b: cols, cells });
      }
    }
    return out;
  }
  for (let M = 2; M <= 14; M++) {
    for (let N = 2; N <= 14; N++) {
      let cells;
      try { cells = buildTiling(shape, M, N).total; } catch { continue; }
      if (cells < MIN_CELLS || cells > MAX_CELLS) continue;
      // A container the canonical rules cannot store is unshippable, and a
      // board wider than a phone can hold is refused by his cap.
      if (!containerIsStorable(cells)) continue;
      if (!boardFitsPhone(shape, M, N)) continue;
      out.push({ a: M, b: N, cells });
    }
  }
  return out;
}

/** Every modifier set: none, every single, every pair, every triple. */
function allGimmickSets() {
  const byArity = [[[]], [], [], []];
  for (let i = 0; i < LADDER_GIMMICKS.length; i++) {
    byArity[1].push([LADDER_GIMMICKS[i]]);
    for (let j = i + 1; j < LADDER_GIMMICKS.length; j++) {
      byArity[2].push([LADDER_GIMMICKS[i], LADDER_GIMMICKS[j]]);
      for (let k = j + 1; k < LADDER_GIMMICKS.length; k++) {
        byArity[3].push([LADDER_GIMMICKS[i], LADDER_GIMMICKS[j], LADDER_GIMMICKS[k]]);
      }
    }
  }
  return byArity;
}

/**
 * The modifier sets a SHAPE is offered, BALANCED BY ARITY.
 *
 * Counting sets alone would spend the budget almost entirely on 3-stacks —
 * there are 84 triples against 36 pairs, 9 singles and 1 plain, so 65% of
 * every rotation would go to the arity the ladder uses least (3-stacks debut
 * at block 40 of 50 in the authored table, and the whole L26-100 stretch is
 * plain, single and pair). So low-arity sets are REPLICATED to roughly even
 * the four classes out, and the triples are sub-sampled on a per-shape
 * offset so their union across the seven shapes still covers all 84.
 */
function shapeGimmickSets(shapeIndex) {
  const [plain, singles, pairs, triples] = allGimmickSets();
  const step = shapeIndex * 12;
  const lanes = [
    Array.from({ length: 30 }, () => plain[0]),
    Array.from({ length: 36 }, (_, i) => singles[i % singles.length]),
    pairs.slice(),
    Array.from({ length: 36 }, (_, i) => triples[(step + i) % triples.length]),
  ];
  // INTERLEAVED, not concatenated. A budget always runs out mid-rotation, so
  // whatever order the lanes sit in is the order a truncated sweep measures:
  // concatenated, a 90-second smoke run came back with 192 plain boards and
  // zero carrying mirror, sonar, compass or worm. Interleaved, every prefix
  // is balanced across arity as well as across shape.
  const out = [];
  for (let k = 0; k < 36; k++) for (const lane of lanes) if (k < lane.length) out.push(lane[k]);
  return out;
}

// The intensity dial, in OLD-LADDER units (see challenge250.js's header).
// Spanning the authored range rather than the old script's [100, 120], which
// could only ever produce endless-grade boards.
const GIMMICK_LEVELS = [45, 70, 100, 120];

// ── Measurement ────────────────────────────────────────────────────────

function makeSpec(shape, a, b, cells, mines, gimmicks, gl) {
  const base = shape === 'rect'
    ? { shape: 'rect', rows: a, cols: b, cells, mines, gimmicks }
    : { shape, M: a, N: b, cells, mines, gimmicks };
  if (gimmicks.length) base.gimmickLevel = gl;
  if (shape === 'rect' && gimmicks.includes('walls')) {
    base.wallSegments = cells >= 100 ? 3 : 2;
  }
  // Re-derived from the SHIPPED mine count, per the standing rule.
  if (shape !== 'rect' && mines / cells < CONSTRUCTIVE_BELOW) base.constructive = true;
  return base;
}

/**
 * Measure a spec over SEEDS draws through the ONE builder the play path
 * uses. Bails on the FIRST over-budget or failed draw — the economy that
 * matters most, because the dear failures are the ones that eat the budget.
 */
function measure(spec, budgetMs) {
  const draws = [];
  let worstMs = 0;
  for (let k = 0; k < SEEDS; k++) {
    const t0 = Date.now();
    const built = buildChallenge250Board(spec, challengeBoardSeed(300, k, 'pool-search'));
    const ms = Date.now() - t0;
    if (ms > worstMs) worstMs = ms;
    if (worstMs > budgetMs) return { ok: false, why: 'gen', worstMs };
    if (!built) return { ok: false, why: 'draw', worstMs };
    if (!built.par) return { ok: false, why: 'par', worstMs };
    draws.push({ par: built.par, features: built.features });
  }
  draws.sort((x, y) => x.par - y.par);
  const pars = draws.map((d) => d.par);
  // The MEDIAN DRAW's vector, not an average of the draws'. Par is exp() of
  // the linear predictor and so monotone in it, which makes the median-par
  // draw the median-linear-predictor draw — re-pricing that one board
  // reproduces this median under any future coefficients. An averaged vector
  // would describe a board that was never generated and never certified.
  const medFeatures = draws[Math.floor(draws.length / 2)].features;
  // Measurement stays in POPULATION seconds — the raw `predictPar` answer. The
  // conversion to reference-cohort seconds happens at EMIT, not here, because
  // the cache is long-lived and resumable: baking a scale into it would leave
  // entries measured before a refit sitting on a different yardstick than
  // entries measured after, with nothing recording which was which.
  const medPar = pars[Math.floor(pars.length / 2)];
  return {
    ok: true, medPar, ppc: medPar / spec.cells, worstMs, medFeatures,
    minPar: pars[0], maxPar: pars[pars.length - 1],
  };
}

// ── Cache ──────────────────────────────────────────────────────────────

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { return {}; }
}
function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 0));
}

function record(cache, spec, r) {
  cache[specFace(spec)] = {
    shape: spec.shape,
    a: spec.rows ?? spec.M, b: spec.cols ?? spec.N,
    cells: spec.cells, mines: spec.mines,
    gimmicks: spec.gimmicks, gl: spec.gimmickLevel || null,
    wallSegments: spec.wallSegments || null,
    constructive: spec.constructive || false,
    seeds: SEEDS,
    ok: r.ok,
    ...(r.ok
      ? {
        ppc: Number(r.ppc.toFixed(3)), medPar: Math.round(r.medPar), worstMs: r.worstMs,
        // The two halves of a re-priceable measurement: WHAT was measured, and
        // WHICH equations turned it into a price.
        features: r.medFeatures,
        model: MODEL,
      }
      : { why: r.why, worstMs: r.worstMs }),
  };
}

// ── Deterministic candidate draw ───────────────────────────────────────
// FNV-1a, so a stratum's Nth candidate is the same on every run and a
// resumed sweep continues the sequence instead of re-rolling it.
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

function drawCandidate(shape, gimmicks, visit, dims) {
  const key = `${shape}|${gimmicks.join('+')}|${visit}`;
  const h1 = hash(key);
  const h2 = hash(`${key}|m`);
  const h3 = hash(`${key}|g`);
  const dim = dims[h1 % dims.length];
  const rail = shape === 'rect' ? DENSITY_MAX.rect : DENSITY_MAX.tiling;
  // Uniform over the legal MINE COUNTS rather than over density, so small
  // boards are not sampled coarsely: on a 36-cell board a 3% density stride
  // is one mine, on a 168-cell board it is five.
  const lo = Math.max(3, Math.ceil(dim.cells * DENSITY_MIN));
  const hi = Math.max(lo, Math.floor(dim.cells * rail));
  const mines = lo + (h2 % (hi - lo + 1));
  const gl = gimmicks.length ? GIMMICK_LEVELS[h3 % GIMMICK_LEVELS.length] : null;
  return makeSpec(shape, dim.a, dim.b, dim.cells, mines, gimmicks, gl);
}

// ── The sweep ──────────────────────────────────────────────────────────

function sweep(cache) {
  const shapes = ONLY_SHAPE ? [ONLY_SHAPE] : SHAPES;
  const dimsByShape = Object.fromEntries(shapes.map((s) => [s, legalDims(s)]));

  for (const s of shapes) {
    if (!dimsByShape[s].length) throw new Error(`no legal dims for ${s}`);
  }

  // One stratum per (shape x modifier set), INTERLEAVED SHAPE-MINOR so a
  // short or interrupted run still touches every shape. Ordering these
  // shape-major instead is not a cosmetic difference: the first smoke run
  // measured 89 specs and every one of them was a rectangle, because 130
  // rect strata sat in front of the first hexagon.
  const setsByShape = shapes.map((_, idx) => shapeGimmickSets(idx));
  const strata = [];
  const perShape = setsByShape[0].length;
  for (let k = 0; k < perShape; k++) {
    for (let s = 0; s < shapes.length; s++) {
      // The stratum INDEX rides the draw key. Without it the 30 replicated
      // plain strata share (shape, gimmicks) and step their visit counters in
      // lockstep, so all 30 draw the identical candidate and 29 are cache hits.
      strata.push({ shape: shapes[s], gimmicks: setsByShape[s][k], visit: 0, idx: `${s}.${k}` });
    }
  }

  // Runaway size ceiling: a shape that has failed on TIME twice at a cell
  // count is not offered anything larger. Two rather than one because a
  // single slow draw can be a seed, not a size.
  const timeFails = new Map();   // shape -> Map(cells -> count)
  const sizeCeiling = new Map(); // shape -> max cells still on offer

  const t0 = Date.now();
  let measured = 0, kept = 0, cached = 0, skipped = 0;
  let i = 0;
  let lastSave = Date.now();

  while (Date.now() - t0 < BUDGET_MS) {
    const st = strata[i % strata.length];
    i++;
    st.visit++;

    const cap = sizeCeiling.get(st.shape);
    let dims = dimsByShape[st.shape];
    if (cap != null) dims = dims.filter((d) => d.cells <= cap);
    if (!dims.length) { skipped++; continue; }

    const spec = drawCandidate(st.shape, st.gimmicks, `${st.idx}#${st.visit}`, dims);
    const face = specFace(spec);
    if (cache[face]) { cached++; continue; }

    // Admission is judged against the LOOSEST consumer (endless, whose
    // per-shape allowances are his rulings), so one pool serves both and the
    // ladder filters down to its own 480s ceiling at emit time.
    const genBudget = endlessGenBudget(st.shape);
    const r = measure(spec, genBudget);
    record(cache, spec, r);
    measured++;

    if (r.ok) {
      kept++;
    } else if (r.why === 'gen') {
      const m = timeFails.get(st.shape) || new Map();
      m.set(spec.cells, (m.get(spec.cells) || 0) + 1);
      timeFails.set(st.shape, m);
      if (m.get(spec.cells) >= 2) {
        const cur = sizeCeiling.get(st.shape);
        const next = spec.cells - 1;
        if (cur == null || next < cur) sizeCeiling.set(st.shape, next);
      }
    }

    if (Date.now() - lastSave > 30_000) {
      saveCache(cache); lastSave = Date.now();
      const mins = ((Date.now() - t0) / 60000).toFixed(1);
      console.log(`  ${mins}m  measured ${measured}  ok ${kept}  (cache hits ${cached}, size-capped ${skipped})`);
    }
  }
  saveCache(cache);
  console.log(`\nsweep done: ${measured} measured, ${kept} ok, ${cached} already cached, ${skipped} size-capped`);
  for (const [shape, cells] of sizeCeiling) console.log(`  size ceiling ${shape}: <= ${cells} cells`);
}

/**
 * STRIDE-1 REFINEMENT around every keeper: probe mines +-1 and +-2 on the
 * same dims. A coarse mine draw jumps over narrow slices of the par range,
 * and one family went 6 -> 11 in-band in 26 seconds under this pass.
 */
function refine(cache) {
  const keepers = Object.values(cache).filter((e) => e.ok && (!ONLY_SHAPE || e.shape === ONLY_SHAPE));
  console.log(`refining around ${keepers.length} keepers`);
  const t0 = Date.now();
  let measured = 0, kept = 0;
  // Nearest neighbours first, so a truncated run still widens every keeper
  // rather than exhausting a few.
  for (const delta of [1, -1, 2, -2]) {
    for (const e of keepers) {
      if (Date.now() - t0 > BUDGET_MS) { saveCache(cache); console.log(`refine done (budget): ${measured} measured, ${kept} ok`); return; }
      const mines = e.mines + delta;
      const rail = e.shape === 'rect' ? DENSITY_MAX.rect : DENSITY_MAX.tiling;
      if (mines < 3 || mines / e.cells > rail || mines / e.cells < DENSITY_MIN) continue;
      const spec = makeSpec(e.shape, e.a, e.b, e.cells, mines, e.gimmicks, e.gl);
      if (cache[specFace(spec)]) continue;
      const r = measure(spec, endlessGenBudget(e.shape));
      record(cache, spec, r);
      measured++;
      if (r.ok) kept++;
      if (measured % 50 === 0) saveCache(cache);
    }
  }
  saveCache(cache);
  console.log(`refine done: ${measured} measured, ${kept} ok`);
}

// ── Reporting ──────────────────────────────────────────────────────────
// Judge the result by REPRESENTATION, not by count — his ruling. So the
// per-shape and per-gimmick histograms print BESIDE the total, never
// instead of it.

function report(cache) {
  const all = Object.values(cache);
  const ok = all.filter((e) => e.ok);
  console.log(`\n=== cache: ${all.length} measured, ${ok.length} certified ===`);

  const byShape = new Map();
  for (const e of ok) {
    const s = byShape.get(e.shape) || { n: 0, lo: Infinity, hi: 0 };
    s.n++; s.lo = Math.min(s.lo, e.ppc); s.hi = Math.max(s.hi, e.ppc);
    byShape.set(e.shape, s);
  }
  console.log('\nper SHAPE:');
  for (const shape of SHAPES) {
    const s = byShape.get(shape);
    if (!s) { console.log(`  ${shape.padEnd(11)} 0`); continue; }
    console.log(`  ${shape.padEnd(11)} ${String(s.n).padStart(5)}   ppc ${s.lo.toFixed(2)} - ${s.hi.toFixed(2)}`);
  }

  console.log('\nper MODIFIER (specs carrying it):');
  for (const g of LADDER_GIMMICKS) {
    const n = ok.filter((e) => e.gimmicks.includes(g)).length;
    const shapes = new Set(ok.filter((e) => e.gimmicks.includes(g)).map((e) => e.shape));
    console.log(`  ${g.padEnd(11)} ${String(n).padStart(5)}   on ${shapes.size}/${SHAPES.length} shapes`);
  }
  console.log(`  ${'(plain)'.padEnd(11)} ${String(ok.filter((e) => !e.gimmicks.length).length).padStart(5)}`);

  console.log('\nper PPC BAND (what each consumer can draw from):');
  const bands = [[0, 0.7], [0.7, 1.1], [1.1, 1.6], [1.6, 2.2], [2.2, 3.0], [3.0, 3.6], [3.6, 5], [5, 99]];
  for (const [lo, hi] of bands) {
    const inBand = ok.filter((e) => e.ppc >= lo && e.ppc < hi);
    const shapes = new Set(inBand.map((e) => e.shape));
    console.log(`  ${String(lo).padStart(4)}-${String(hi).padEnd(4)} ${String(inBand.length).padStart(5)}   ${shapes.size} shapes`);
  }

  const fails = all.filter((e) => !e.ok);
  const byWhy = new Map();
  for (const e of fails) byWhy.set(e.why, (byWhy.get(e.why) || 0) + 1);
  console.log(`\nfailures: ${[...byWhy].map(([w, n]) => `${w} ${n}`).join(', ') || 'none'}`);
}

// ── Emission ───────────────────────────────────────────────────────────

function emitLine(e) {
  const dims = e.shape === 'rect' ? `${e.a}, ${e.b}` : `'${e.shape}', ${e.a}, ${e.b}, ${e.cells}`;
  const opts = [];
  if (e.gl) opts.push(`gimmickLevel: ${e.gl}`);
  if (e.wallSegments) opts.push(`wallSegments: ${e.wallSegments}`);
  if (e.constructive) opts.push('constructive: true');
  const g = e.gimmicks.length
    ? `, [${e.gimmicks.map((x) => `'${x}'`).join(', ')}]${opts.length ? `, { ${opts.join(', ')} }` : ''}`
    : (opts.length ? `, [], { ${opts.join(', ')} }` : '');
  const ctor = e.shape === 'rect' ? 'R' : 'T';
  return `  E(${e.ppc.toFixed(2)}, ${ctor}(${dims}, ${e.mines}${g})),`;
}

/**
 * Emit a pool, balanced by construction: walk the ppc range in slices and
 * take a ROUND-ROBIN over shapes within each slice, so no slice can be
 * carried by whichever shape happens to have the most measurements there.
 */
function emitPool(cache, { floorFn, ceilFn, perSlice, slices, maxPerShape = Infinity }) {
  // The cache OUTLIVES a rule change — it is resumable by design — so
  // legality is re-checked on the way out and not only on the way in. When
  // the rect width cap was read from difficulty.js instead of guessed, every
  // 13-column entry already measured had to stop shipping, and nothing but
  // this filter would have caught them.
  const legal = new Map();
  for (const shape of SHAPES) legal.set(shape, new Set(legalDims(shape).map((d) => `${d.a}x${d.b}`)));
  const ok = Object.values(cache)
    .filter((e) => e.ok && legal.get(e.shape)?.has(`${e.a}x${e.b}`))
    // Population seconds in, ladder seconds out. Every threshold below — the
    // admission floor, the par ceiling, and the ppc that ships — is on the
    // cohort's yardstick from this line on.
    .map((e) => ({ ...e, ppc: e.ppc * SCALE, medPar: e.medPar * SCALE }))
    .filter((e) => e.ppc >= floorFn(e.shape) && e.medPar <= ceilFn(e.shape) * PAR_CEILING_MARGIN);

  // An entry priced under older equations is being judged by the ceilings and
  // floors on numbers that no longer describe it. Say so rather than let it
  // pass quietly — `--reprice-cache` fixes every entry that has features.
  const stalePriced = ok.filter((e) => e.model !== MODEL).length;
  if (stalePriced) {
    console.error(`// WARNING: ${stalePriced} of ${ok.length} candidates carry prices from an older model.`);
    console.error('// Run: node scripts/search-endless-specs.mjs --reprice-cache');
  }
  if (!ok.length) return [];
  const lo = Math.min(...ok.map((e) => e.ppc));
  const hi = Math.max(...ok.map((e) => e.ppc));
  const width = (hi - lo) / slices || 1;

  const out = [];
  const taken = new Set();
  // A PER-SHAPE CAP, because a slice-wise round-robin balances WITHIN a slice
  // and a shape present in more slices still ends up dominating. In the
  // endless pool floret cleared the admission floor almost everywhere and
  // rhombille almost nowhere, so floret came out holding a third of the pool
  // against rhombille's two entries — and a shape at a third cannot be dealt
  // one-per-block, which is what kept the endless block down to three shapes
  // however the deck was built. Fixing it here rather than in the deck is
  // fixing the producer.
  //
  // The cap is PER SLICE, and that is not a detail. Applied globally it is
  // spent by whichever slices are visited first: the low-difficulty slices
  // exhausted every shape's budget and the ladder could not reach its own
  // summit — L240 came back at ppc 2.24 against a 3.31 target while the
  // cache held 1,217 qualifying specs at 3.0 or above. Per slice, every
  // shape gets an equal allowance at every difficulty.
  const perSlicePerShape = Math.max(1, Math.ceil(maxPerShape / slices));
  for (let s = 0; s < slices; s++) {
    const perShape = new Map();
    const from = lo + s * width;
    const to = s === slices - 1 ? hi + 1e-9 : from + width;
    const inSlice = ok.filter((e) => e.ppc >= from && e.ppc < to);

    // ROUND-ROBIN OVER (shape x modifier set), not merely over shape. Taking
    // a shape's entries in arity order instead starves the modifiers: the
    // low-price slices fill with plain boards, and the ladder then cannot
    // find five locked boards to debut locked on until it is halfway up. That
    // is exactly what happened — all six shapes debuted in blocks 6-11 and
    // the first modifier debut fell to block 24. The stratification the
    // SEARCH does has to be preserved by the EMITTER or it is thrown away at
    // the last step.
    const buckets = new Map();
    for (const e of inSlice) {
      const k = `${e.shape}|${[...e.gimmicks].sort().join('+')}`;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(e);
    }
    for (const list of buckets.values()) list.sort((x, y) => x.cells - y.cells);

    // Interleave the bucket order by shape, so a truncated slice is still
    // balanced across shapes as well as across modifier sets.
    const byShape = new Map();
    for (const k of buckets.keys()) {
      const shape = k.slice(0, k.indexOf('|'));
      if (!byShape.has(shape)) byShape.set(shape, []);
      byShape.get(shape).push(k);
    }
    const order = [];
    for (let i = 0; ; i++) {
      let any = false;
      for (const list of byShape.values()) {
        if (i < list.length) { order.push(list[i]); any = true; }
      }
      if (!any) break;
    }

    let n = 0;
    for (let round = 0; n < perSlice && round < 50; round++) {
      let progressed = false;
      for (const k of order) {
        const list = buckets.get(k);
        if (round >= list.length) continue;
        const e = list[round];
        const face = specFace({ shape: e.shape, rows: e.a, cols: e.b, M: e.a, N: e.b, mines: e.mines, gimmicks: e.gimmicks });
        if (taken.has(face)) continue;
        if ((perShape.get(e.shape) || 0) >= perSlicePerShape) continue;
        perShape.set(e.shape, (perShape.get(e.shape) || 0) + 1);
        taken.add(face);
        out.push(e);
        progressed = true;
        if (++n >= perSlice) break;
      }
      if (!progressed) break;
    }
  }
  out.sort((a, b) => a.ppc - b.ppc);
  return out;
}

/**
 * Admissible candidates, on the ladder's yardstick: legal today, priced under
 * the par ceiling with its margin, and inside the generation headroom. The
 * same gate emitPool applies, factored out so the coverage emitter cannot
 * drift from it.
 */
function admissible(cache) {
  const legal = new Map();
  for (const shape of SHAPES) legal.set(shape, new Set(legalDims(shape).map((d) => `${d.a}x${d.b}`)));
  return Object.values(cache)
    .filter((e) => e.ok && legal.get(e.shape)?.has(`${e.a}x${e.b}`))
    .map((e) => ({ ...e, ppc: e.ppc * SCALE, medPar: e.medPar * SCALE }))
    .filter((e) => e.medPar <= PAR_CEILING_SECONDS * PAR_CEILING_MARGIN)
    .filter((e) => e.worstMs <= GEN_CAP_MS * ENDLESS_GEN_HEADROOM);
}

// The coverage pool wants MORE generation headroom than the ladder pool, and
// this is the fourth time the lesson has been paid for. The ladder's 0.35
// works there because that pool has been through repeated absorb passes: its
// entries carry a worst time measured over many seed samples. A pool emitted
// straight from 3-seed cache measurements has not, so its boundary entries are
// the ones whose tail nobody has seen yet. Validating at 0.35 admitted twelve
// entries that measured 706-1534ms, and dropping those admitted seven MORE on
// the next sample, because the boundary refills from a heavy tail.
//
// 0.2 of the standing cap is 400ms, which leaves room for the ~1.8x
// cached-to-measured ratio the failures actually showed.
const COVERAGE_GEN_HEADROOM = 0.2;

// Par bands a player can actually ask for. These are the buckets the Challenge
// setup sheet's time control selects over, so they are what "covered" has to
// mean here.
const COVERAGE_BANDS = [0, 30, 60, 120, 240, 480, Infinity];
const bandOf = (par) => COVERAGE_BANDS.findIndex((b, i) => par >= b && par < COVERAGE_BANDS[i + 1]);

/**
 * Emit the SUPPLEMENTARY pool Challenge draws from, selected for COVERAGE
 * rather than for a difficulty ramp.
 *
 * The ladder pool is not short of material, it is balanced for a different
 * job: emitPool walks the ppc range in slices and spends each slice on a
 * round-robin over (shape x modifier set), which is exactly right for a ladder
 * that has to introduce things in order and climb. What it produces is thin at
 * the corners a PLAYER can select — the cache holds 603 certified rect boards
 * with no modifiers and the shipped ladder pool carries 3 of them, because
 * plain rect is one bucket among ~130 and wins a slice slot only when the
 * round-robin reaches it.
 *
 * So this walks (shape x arity x par band) instead, and takes a spread of
 * sizes from each. It EXCLUDES everything the other two pools already ship, so
 * the three are disjoint and Challenge draws from the union; the ladder keeps
 * drawing from LADDER_POOL alone and does not reshuffle.
 */
async function emitCoveragePool(cache, { perBucket = 8 } = {}) {
  const { LADDER_POOL, ENDLESS_POOL } = await import('../src/logic/challengePool.js');
  const existing = [...LADDER_POOL, ...ENDLESS_POOL];
  const shipped = new Set(existing.map((e) => specFace(e)));

  // TOP UP, rather than add a flat count everywhere. The ladder pool is
  // already rich in three-modifier boards and poor in plain ones, so a flat
  // per-bucket quota would spend most of the payload re-covering what is
  // covered. Counting what the union already holds is what makes this pool
  // the COMPLEMENT of the other two instead of a second copy of them.
  const held = new Map();
  for (const e of existing) {
    const cells = e.cells != null ? e.cells : e.rows * e.cols;
    const key = `${e.shape}|${e.gimmicks.length}|${bandOf(e.ppc * cells)}`;
    held.set(key, (held.get(key) || 0) + 1);
  }

  const buckets = new Map();
  for (const e of admissible(cache).filter((x) => x.worstMs <= GEN_CAP_MS * COVERAGE_GEN_HEADROOM)) {
    const face = specFace({
      shape: e.shape, rows: e.a, cols: e.b, M: e.a, N: e.b, mines: e.mines, gimmicks: e.gimmicks,
    });
    if (shipped.has(face)) continue;
    const key = `${e.shape}|${e.gimmicks.length}|${bandOf(e.medPar)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ ...e, face });
  }

  const out = [];
  const taken = new Set();
  for (const [key, list] of buckets) {
    const want = perBucket - (held.get(key) || 0);
    if (want <= 0) continue;
    // Spread across SIZE rather than taking the smallest few: a player who
    // asks for "short classic boards" should meet different boards, and cell
    // count is the axis they feel most directly.
    list.sort((a, b) => a.cells - b.cells || a.mines - b.mines);
    const step = Math.max(1, list.length / want);
    for (let i = 0; i < want; i++) {
      const e = list[Math.min(list.length - 1, Math.floor(i * step))];
      if (!e || taken.has(e.face)) continue;
      taken.add(e.face);
      out.push(e);
    }
  }
  out.sort((a, b) => a.ppc - b.ppc);
  return out;
}

async function runEmit(cache, which) {
  if (which === 'challenge') {
    const pool = await emitCoveragePool(cache, { perBucket: Number(argVal('--per-bucket', 6)) });
    console.log(`\n// ${pool.length} entries, Challenge coverage pool\nexport const CHALLENGE_POOL = Object.freeze([`);
    for (const e of pool) console.log(emitLine(e));
    console.log(']);');
    return;
  }
  if (which === 'endless') {
    const pool = emitPool(cache, {
      // FLOOR MARGIN, not the bare floor. Price varies by seed sample, so an
      // entry measured exactly ON its floor lands under it on the next
      // measurement and the pool fails intermittently with nobody having
      // changed it — the same headroom reasoning the generation budget uses.
      floorFn: (s) => endlessPpcFloor(s) * PPC_FLOOR_MARGIN,
      ceilFn: (s) => endlessParCeiling(s),
      perSlice: 14, slices: 8,
      // No shape may hold more than this many endless entries (see the cap's
      // note in emitPool). Sized so the plentiful shapes stay near one card
      // per block of five while the scarce ones keep everything they have.
      maxPerShape: 16,
    });
    console.log(`\n// ${pool.length} entries, endless zone\nexport const ENDLESS_POOL = Object.freeze([`);
    for (const e of pool) console.log(emitLine(e));
    console.log(']);');
    return;
  }
  // The ladder pool: everything the 8-minute ceiling and the standing
  // 2-second cap admit, across the whole difficulty range.
  const pool = emitPool(cache, {
    floorFn: () => 0,
    ceilFn: () => PAR_CEILING_SECONDS,
    // Sized for the ladder's appetite: 225 levels need 225 distinct faces
    // and the assignment can only draw from the INTRODUCED subset at any
    // point, so the pool wants several times the level count to keep every
    // band supplied. Bigger than this is payload for nothing.
    perSlice: 50, slices: 14,
    // The per-shape cap applies to the ladder too. Without it the absorb pass
    // left floret on 153 entries and deltoidal on 111 against rect's 46 —
    // his representation ruling is about the whole pool, not only the
    // endless slice, and a shape's abundance in the CACHE is a fact about
    // how cheaply it certifies, not about how much of the ladder it deserves.
    maxPerShape: 90,
    // Same headroom the endless side uses, read from the ruling rather than
    // restated — a second copy of a margin is a second thing to keep in step.
  }).filter((e) => e.worstMs <= GEN_CAP_MS * ENDLESS_GEN_HEADROOM);
  console.log(`\n// ${pool.length} entries, ladder pool\nexport const LADDER_POOL = Object.freeze([`);
  for (const e of pool) console.log(emitLine(e));
  console.log(']);');
}

/**
 * ABSORB: re-measure the SHIPPED pool at the validator's own seed count and
 * fold the verdicts back into the cache.
 *
 * The sweep ranks candidates at 3 seeds and the validator gates at 10, and
 * that gap is real rather than cosmetic: a spec's median price moves by more
 * than the acceptance band between the two samples, so entries the search was
 * happy with fail validation and, without this, get re-proposed forever. The
 * old ladder tool needed the same loop and converged 53 -> 26 -> 18 -> 5 over
 * it. Re-emitting after an absorb ships prices the validator will agree with.
 */
async function absorb(cache) {
  const { LADDER_POOL, ENDLESS_POOL } = await import('../src/logic/challengePool.js');
  const shipped = [...LADDER_POOL, ...ENDLESS_POOL];
  const seen = new Set();
  const t0 = Date.now();
  let n = 0, moved = 0, dropped = 0;
  for (const e of shipped) {
    const face = specFace(e);
    if (seen.has(face)) continue;
    seen.add(face);
    if (Date.now() - t0 > BUDGET_MS) break;
    const spec = makeSpec(e.shape, e.rows ?? e.M, e.cols ?? e.N, e.cells, e.mines,
      [...e.gimmicks], e.gimmickLevel);
    const r = measure(spec, endlessGenBudget(e.shape));
    n++;
    const was = cache[face]?.ppc;
    record(cache, spec, r);
    if (!r.ok) { dropped++; continue; }
    if (was != null && Math.abs(r.ppc / was - 1) > 0.05) moved++;
    if (n % 25 === 0) saveCache(cache);
  }
  saveCache(cache);
  console.log(`absorb: ${n} shipped specs re-measured at ${SEEDS} seeds — ${moved} moved >5%, ${dropped} no longer certify`);
}

/**
 * Re-answer every cached price under the current model, from stored features.
 *
 * Instant, because it builds no boards. Also SEEDS itself from the shipped
 * pool's own feature store, so the entries that matter most — the ones
 * actually on the ladder — are re-priceable from the first run rather than
 * waiting for the sweep to revisit them.
 */
function repriceCache(cache) {
  // Seed from the pool store first.
  let seeded = 0;
  try {
    const store = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'pool-features.json'), 'utf8'));
    for (const [face, rec] of Object.entries(store.entries)) {
      if (cache[face] && !cache[face].features && rec.features) {
        cache[face].features = rec.features;
        seeded++;
      }
    }
  } catch { /* no store yet; nothing to seed from */ }

  let priced = 0, stale = 0, moved = 0;
  for (const e of Object.values(cache)) {
    if (!e.ok) continue;
    if (!e.features) { stale++; continue; }
    const par = predictPar(e.features) * SCALE;
    const ppc = Number((par / e.cells).toFixed(3));
    if (Math.abs(ppc / e.ppc - 1) > 0.05) moved++;
    e.ppc = ppc;
    e.medPar = Math.round(par);
    e.model = MODEL;
    priced++;
  }
  saveCache(cache);
  console.log(`re-priced ${priced} cached entries under model ${MODEL} (${moved} moved >5%)`);
  if (seeded) console.log(`  ${seeded} of them took their features from the shipped pool's store`);
  if (stale) {
    console.log(`  ${stale} entries were measured before features were stored and keep their old price;`);
    console.log('  that number falls to zero as the sweep revisits them.');
  }
}

// ── Main ───────────────────────────────────────────────────────────────

const cache = loadCache();
if (EMIT) { await runEmit(cache, EMIT); }
else if (REPORT_ONLY) { report(cache); }
else {
  const shapes = ONLY_SHAPE ? [ONLY_SHAPE] : SHAPES;
  console.log(`legal space: ${shapes.map((s) => `${s} ${legalDims(s).length} dims`).join(', ')}`);
  const nSets = shapeGimmickSets(0).length;
  console.log(`${nSets} modifier slots x ${shapes.length} shapes = ${nSets * shapes.length} strata`);
  if (REPRICE) repriceCache(cache);
  else if (ABSORB) await absorb(cache);
  else if (REFINE) refine(cache);
  else sweep(cache);
  report(cache);
}
