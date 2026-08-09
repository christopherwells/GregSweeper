// RE-PRICE the challenge pool against the current par model.
//
// Every entry in src/logic/challengePool.js carries a measured `ppc` — the
// median par-per-cell over the search's seeds — and that number is what the
// ladder's band matches against, what the endless floor admits on, and what
// the validator's acceptance band centres on. It is measured at the par model
// OF THE DAY, so a refit that moves a shape's equation leaves the whole pool
// mislabelled, and nothing says so: the validator that would catch it is not
// in CI and takes minutes.
//
// THE KEY OBSERVATION. Measuring a spec is expensive — generate, certify,
// check strict load-bearing, time it — and every one of those is
// MODEL-INDEPENDENT. Only the price depends on the model. So a re-price does
// not need to build a single board: given the feature vector of the draw that
// set an entry's median, `predictPar` answers instantly. That turns a
// twenty-minute re-measurement into a sub-second one, and it removes the
// erosion that re-measuring causes — re-measurement drops entries to seed
// noise, and re-pricing drops only entries whose price genuinely left the
// rulings.
//
// So the pool's composition is UNCHANGED by a re-price. Entries are relabelled
// in place, and anything that genuinely crosses a boundary is reported and
// fails the run rather than being silently dropped.
//
//   node scripts/reprice-challenge-pool.mjs --capture   # (re)build the feature store
//   node scripts/reprice-challenge-pool.mjs --check     # report drift, write nothing
//   node scripts/reprice-challenge-pool.mjs             # re-price and rewrite the pool

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LADDER_POOL, ENDLESS_POOL } from '../src/logic/challengePool.js';
import { buildChallenge250Board, challengeBoardSeed } from '../src/logic/challenge250Builder.js';
import { predictPar } from '../src/logic/dailyFeatures.js';
import {
  specFace, PAR_CEILING_SECONDS, endlessParCeiling, endlessPpcFloor,
} from '../src/logic/challengeRules.js';
import { modelFingerprint } from '../src/logic/parModelFingerprint.js';
import { referenceScale } from './ladder-reference-cohort.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FEATURES_PATH = path.join(__dirname, 'data', 'pool-features.json');
const POOL_PATH = path.join(__dirname, '..', 'src', 'logic', 'challengePool.js');

const args = process.argv.slice(2);
const CAPTURE = args.includes('--capture');
const CHECK = args.includes('--check');
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

// The seed count the shipped prices were measured at. Reproducing a stored
// median needs the same draws, and the draws are deterministic, so this has to
// match the pass that set them (the 16-seed absorb of 2026-08-08).
const SEEDS = Number(argVal('--seeds', 16));

// How far a re-price may move an entry before the run says so out loud. Not a
// failure on its own — a refit moving prices IS the model learning — but a
// number worth printing, because a shape whose whole equation moved should
// look different from one that did not.
const NOTABLE_DRIFT = 0.05;

const shipped = () => [
  ...LADDER_POOL.map((e) => ({ e, pool: 'ladder' })),
  ...ENDLESS_POOL.map((e) => ({ e, pool: 'endless' })),
];

const specOf = (e) => (e.shape === 'rect'
  ? { shape: 'rect', rows: e.rows, cols: e.cols, cells: e.cells, mines: e.mines,
      gimmicks: [...e.gimmicks], gimmickLevel: e.gimmickLevel, wallSegments: e.wallSegments }
  : { shape: e.shape, M: e.M, N: e.N, cells: e.cells, mines: e.mines,
      gimmicks: [...e.gimmicks], gimmickLevel: e.gimmickLevel, constructive: e.constructive });

// ── Capture ────────────────────────────────────────────────────────────

/**
 * Rebuild the feature store: for each shipped entry, generate its SEEDS draws
 * and keep the feature vector of the one whose par is the median.
 *
 * Storing the median DRAW's features rather than the median of the features is
 * deliberate. Par is a monotone function of the linear predictor, so the
 * median-par draw is the median-linear-predictor draw, and re-pricing exactly
 * that board reproduces the median par under any coefficients — where an
 * averaged feature vector would describe a board that was never generated and
 * never certified.
 */
function capture() {
  const out = {};
  const rows = shipped();
  let n = 0, restated = 0;
  const scale = referenceScale();

  for (const { e, pool } of rows) {
    const face = specFace(e);
    if (out[face]) continue;
    const spec = specOf(e);
    const draws = [];
    for (let k = 0; k < SEEDS; k++) {
      const built = buildChallenge250Board(spec, challengeBoardSeed(300, k, 'pool-search'));
      if (!built || !built.features) continue;
      draws.push({ par: built.par, features: built.features });
    }
    if (!draws.length) { console.warn(`  no draw for ${face}`); continue; }
    draws.sort((a, b) => a.par - b.par);
    const med = draws[Math.floor(draws.length / 2)];

    // THE STORE IS AUTHORITATIVE, and the pool's price is derived from it.
    //
    // It had to be this way round. The first cut checked the captured vector
    // against the shipped price and refused on disagreement, and 51 of 498
    // entries disagreed — not because the capture was wrong, but because the
    // shipped prices had MIXED PROVENANCE: a 3-seed sweep, then a 10-seed
    // absorb, then a 16-seed one, so different entries carried medians over
    // different draw counts (worst gap 21%). Deriving the price here gives the
    // whole pool one provenance and makes every future re-price EXACT rather
    // than approximately faithful.
    //
    // Exact, not approximate: par is exp() of the linear predictor, so it is
    // monotone in it, so the median-par draw IS the median-linear-predictor
    // draw and re-pricing that one board reproduces the median par under any
    // coefficients.
    const ppc = (predictPar(med.features) * scale) / e.cells;
    if (Math.abs(ppc / e.ppc - 1) > 0.005) restated++;

    out[face] = { pool, cells: e.cells, ppc, features: med.features };
    if (++n % 50 === 0) console.log(`  ${n}/${rows.length}`);
  }

  fs.mkdirSync(path.dirname(FEATURES_PATH), { recursive: true });
  fs.writeFileSync(FEATURES_PATH, JSON.stringify({
    capturedAt: new Date().toISOString(),
    seeds: SEEDS,
    // WHICH MODEL the prices were derived under. Without it there is no way to
    // tell a pool that is correctly in sync from one that is merely stale, and
    // the difference matters constantly: the refit runs nightly, so any branch
    // older than a day carries a pool priced under yesterday's coefficients.
    model: modelFingerprint(),
    note: 'Median-draw feature vectors for every shipped pool entry. Regenerate with --capture whenever the pool composition changes.',
    entries: out,
  }));
  console.log(`captured ${Object.keys(out).length} entries; ${restated} carried a price of different provenance and were restated`);
  console.log('now run: node scripts/reprice-challenge-pool.mjs   (writes the derived prices into the pool)');
}

// ── Re-price ───────────────────────────────────────────────────────────

function reprice() {
  let store;
  try {
    store = JSON.parse(fs.readFileSync(FEATURES_PATH, 'utf8'));
  } catch {
    console.error(`no feature store at ${path.relative(process.cwd(), FEATURES_PATH)} — run --capture first`);
    process.exit(1);
  }
  const scale = referenceScale();
  const priced = [];
  const missing = [];

  for (const { e, pool } of shipped()) {
    const face = specFace(e);
    const rec = store.entries[face];
    if (!rec) { missing.push(face); continue; }
    const ppc = (predictPar(rec.features) * scale) / e.cells;
    priced.push({ face, pool, e, was: e.ppc, now: ppc, par: ppc * e.cells });
  }

  // A shipped entry with no stored features cannot be re-priced, and shipping
  // a pool where some entries moved and others did not is worse than shipping
  // one that did not move at all. So this is fatal, not a warning.
  if (missing.length) {
    console.error(`${missing.length} shipped entries have no captured features (pool changed without a re-capture?):`);
    for (const f of missing.slice(0, 10)) console.error(`  ${f}`);
    process.exit(1);
  }

  const moved = priced.filter((p) => Math.abs(p.now / p.was - 1) > NOTABLE_DRIFT);
  const byShape = new Map();
  for (const p of priced) {
    const s = byShape.get(p.e.shape) || { n: 0, sum: 0 };
    s.n++; s.sum += Math.log(p.now / p.was);
    byShape.set(p.e.shape, s);
  }
  console.log(`re-priced ${priced.length} entries; ${moved.length} moved more than ${NOTABLE_DRIFT * 100}%`);
  for (const [shape, s] of byShape) {
    console.log(`  ${shape.padEnd(11)} ${String(s.n).padStart(4)} entries, median shift ${((Math.exp(s.sum / s.n) - 1) * 100).toFixed(1)}%`);
  }

  // ── Guards. A re-price relabels; it must never quietly ship a pool that
  // breaks a ruling, and it must never quietly delete a shape.
  const violations = [];
  for (const p of priced) {
    const ceiling = p.pool === 'endless' ? endlessParCeiling(p.e.shape) : PAR_CEILING_SECONDS;
    if (p.par > ceiling) {
      violations.push(`${p.face} (${p.pool}) now prices ${p.par.toFixed(0)}s against a ${ceiling}s ceiling`);
    }
    if (p.pool === 'endless' && p.now < endlessPpcFloor(p.e.shape)) {
      violations.push(`${p.face} now prices ${p.now.toFixed(2)} s/cell, under the ${endlessPpcFloor(p.e.shape)} endless floor`);
    }
  }
  if (violations.length) {
    console.error(`\n${violations.length} entries left the rulings after re-pricing:`);
    for (const v of violations.slice(0, 20)) console.error(`  ${v}`);
    console.error('\nThis is a RE-SEARCH, not a re-price: run scripts/search-endless-specs.mjs');
    console.error('and scripts/write-challenge-pool.mjs, then re-capture. Nothing was written.');
    process.exit(1);
  }

  if (CHECK) { console.log('\n--check: nothing written'); return; }

  // Patch the prices in place. Every entry keeps its position and its spec;
  // only the leading E(...) price changes, which is what "relabel, do not
  // reselect" means concretely.
  // Keyed on the emitted constructor call, so a line is matched on IDENTITY
  // rather than on position. Deliberately NOT consumed on first use: the same
  // spec can legitimately sit in both the ladder and the endless table, and a
  // consuming match left the second copy unpatched and then failed the count
  // (498 of 522), which reads as a corrupt file rather than as duplicates.
  const byCtor = new Map(priced.map((p) => [emitCtor(p.e), p]));
  let src = fs.readFileSync(POOL_PATH, 'utf8');
  let patched = 0, lines = 0;
  src = src.replace(/^(\s*)E\(\d+\.\d+, (.*)\),$/gm, (line, indent, rest) => {
    lines++;
    const p = byCtor.get(rest);
    if (!p) return line;
    patched++;
    return `${indent}E(${p.now.toFixed(2)}, ${rest}),`;
  });
  if (patched !== lines) {
    console.error(`patched ${patched} of ${lines} price lines — the pool file does not match the loaded pool; nothing written`);
    process.exit(1);
  }
  fs.writeFileSync(POOL_PATH, src);
  console.log(`\nrewrote ${patched} prices in ${path.relative(process.cwd(), POOL_PATH)}`);
}

/** The constructor call as write-challenge-pool emits it, for identity matching. */
function emitCtor(e) {
  const dims = e.shape === 'rect' ? `${e.rows}, ${e.cols}` : `'${e.shape}', ${e.M}, ${e.N}, ${e.cells}`;
  const opts = [];
  if (e.gimmickLevel) opts.push(`gimmickLevel: ${e.gimmickLevel}`);
  if (e.wallSegments) opts.push(`wallSegments: ${e.wallSegments}`);
  if (e.constructive) opts.push('constructive: true');
  const g = e.gimmicks.length
    ? `, [${e.gimmicks.map((x) => `'${x}'`).join(', ')}]${opts.length ? `, { ${opts.join(', ')} }` : ''}`
    : (opts.length ? `, [], { ${opts.join(', ')} }` : '');
  return `${e.shape === 'rect' ? 'R' : 'T'}(${dims}, ${e.mines}${g})`;
}

if (CAPTURE) capture(); else reprice();
