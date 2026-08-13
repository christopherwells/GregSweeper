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
//   node scripts/reprice-challenge-pool.mjs --capture           # rebuild the whole store
//   node scripts/reprice-challenge-pool.mjs --capture --merge   # measure only new faces
//   node scripts/reprice-challenge-pool.mjs --check     # report drift, write nothing
//   node scripts/reprice-challenge-pool.mjs             # re-price and rewrite the pool
//
// MERGE EXISTS BECAUSE A RE-EMIT IS USUALLY A FEW FACES, NOT A NEW POOL.
// Capture builds SEEDS boards per face and the dear lattices take seconds
// each, so rebuilding 900 entries to learn about 44 of them is hours spent
// re-deriving numbers that cannot have changed: the stored vector is the
// median DRAW's features, and generation is deterministic and
// model-independent. Merge measures the absent faces at the store's OWN seed
// count and refuses to run at any other, because the whole value of the store
// is that every entry in it has one provenance.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LADDER_POOL, ENDLESS_POOL, CHALLENGE_POOL } from '../src/logic/challengePool.js';
import { buildChallenge250Board, challengeBoardSeed } from '../src/logic/challenge250Builder.js';
import { predictPar } from '../src/logic/dailyFeatures.js';
import {
  specFace, PAR_CEILING_SECONDS, endlessParCeiling, endlessPpcFloor, endlessPpcAdmission,
} from '../src/logic/challengeRules.js';
import { modelFingerprint } from '../src/logic/parModelFingerprint.js';
import { referenceScale } from './ladder-reference-cohort.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FEATURES_PATH = path.join(__dirname, 'data', 'pool-features.json');
const POOL_PATH = path.join(__dirname, '..', 'src', 'logic', 'challengePool.js');

const args = process.argv.slice(2);
const CAPTURE = args.includes('--capture');
const MERGE = args.includes('--merge');
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

// EVERY pool in the file, and the writer is why it has to be every one: it
// asserts it patched all of them, so a pool present in challengePool.js but
// absent here aborts the re-price with "the pool file does not match the
// loaded pool" and the nightly refit stops updating prices altogether.
//
// The coverage pool takes the ladder's rules, not the endless one's: the par
// ceiling applies (the branch below defaults to it) and there is no ppc floor,
// since the whole point of that pool is the gentle end the ladder's slicing
// leaves thin.
const shipped = () => [
  ...LADDER_POOL.map((e) => ({ e, pool: 'ladder' })),
  ...ENDLESS_POOL.map((e) => ({ e, pool: 'endless' })),
  ...CHALLENGE_POOL.map((e) => ({ e, pool: 'challenge' })),
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
  let n = 0, restated = 0, kept = 0;
  const scale = referenceScale();

  // MERGE: keep every stored vector and measure only what is missing. The
  // stored features are re-priced below either way, so a merged store is
  // internally consistent under today's model rather than half under
  // yesterday's.
  if (MERGE) {
    let prior;
    try {
      prior = JSON.parse(fs.readFileSync(FEATURES_PATH, 'utf8'));
    } catch {
      console.error(`--merge needs an existing store at ${path.relative(process.cwd(), FEATURES_PATH)}`);
      process.exit(1);
    }
    if (prior.seeds !== SEEDS) {
      console.error(`the store was captured at ${prior.seeds} seeds and this run is at ${SEEDS}. `
        + `Re-run with --seeds ${prior.seeds}, or drop --merge to rebuild the whole store: `
        + 'a store with two seed counts in it has no single provenance, which is the '
        + 'exact confusion the derive-the-price-here rule was written to end.');
      process.exit(1);
    }
    // Carried over, but only what the pool still SHIPS. A store entry for a
    // face nobody can be dealt is not merely harmless payload: the store is
    // what the next reader reasons about, so a stale face is a board it
    // believes in. A full --capture drops them by construction (it walks the
    // shipped list); merge has to drop them on purpose.
    const live = new Set(rows.map(({ e }) => specFace(e)));
    for (const [face, rec] of Object.entries(prior.entries)) {
      if (live.has(face)) out[face] = rec;
    }
    kept = Object.keys(out).length;
    const dropped = Object.keys(prior.entries).length - kept;
    if (dropped) console.log(`  dropped ${dropped} stored entries the pool no longer ships`);
  }

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

  // EVERY entry is re-priced from its own stored vector before the store is
  // written, carried-over ones included. The store stamps ONE model
  // fingerprint, so a merged store whose kept entries still held yesterday's
  // prices would be making a claim about them that is not true, and the
  // faithfulness test reads exactly that claim. Re-pricing is free (no board
  // is built) and exact, for the monotonicity reason above.
  const poolOf = new Map(rows.map(({ e, pool }) => [specFace(e), pool]));
  for (const [face, rec] of Object.entries(out)) {
    rec.ppc = (predictPar(rec.features) * scale) / rec.cells;
    // A face that has moved pool since it was captured keeps its vector and
    // takes its current home, so the field never contradicts the shipped pool.
    if (poolOf.has(face)) rec.pool = poolOf.get(face);
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
  console.log(`captured ${Object.keys(out).length} entries`
    + (MERGE ? ` (${kept} carried over, ${n} newly measured)` : '')
    + `; ${restated} carried a price of different provenance and were restated`);
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
  // ── An entry that leaves its pool's rulings MIGRATES ───────────────────
  //
  // His ruling, 2026-08-13: "shouldn't something that exceeds the ceiling of
  // the ladder go to endless and something that is in endless that falls
  // below the endless floor go to the levels?"
  //
  // It should, and the library one layer up has worked exactly that way since
  // 2026-08-11 ("boards flow BOTH ways"). The SPEC pool did not: it refused
  // the whole write and demanded a re-search, so one entry drifting four
  // seconds past a ceiling left the ladder priced under an old model and
  // reddened main until a human ran a long search. A spec that outgrew the
  // ladder has not become worthless, it has become an endless spec, and the
  // reverse holds too.
  //
  // Migration is judged against the DESTINATION's own rulings, never assumed:
  // a ladder entry over the 480s ceiling still has to clear the endless
  // shape's ppc floor and its par ceiling, and an endless entry under the ppc
  // floor still has to fit under the ladder's ceiling. An entry that qualifies
  // for NEITHER pool is homeless, and it is DROPPED from the shipped tables
  // rather than shipped somewhere it does not belong, which is the one place
  // this can lose material. It is reported loudly and by face, so a shape
  // quietly bleeding entries is visible on the night it starts.
  // Judged at the ADMISSION bar, not the bare floor. The emitter admits at
  // floor x margin and the pool's own test asserts the same, so a re-price
  // that kept anything above the bare floor left entries in a band all three
  // disagreed about: admitted by the emitter at its 3-seed cache price, kept
  // here at the 16-seed re-price, and refused by the test on the same commit.
  const fitsLadder = (p) => p.par <= PAR_CEILING_SECONDS;
  const fitsEndless = (p) => p.par <= endlessParCeiling(p.e.shape)
    && p.now >= endlessPpcAdmission(p.e.shape);

  const migrations = [];
  const homeless = [];
  for (const p of priced) {
    const ok = p.pool === 'endless' ? fitsEndless(p) : fitsLadder(p);
    if (ok) { p.finalPool = p.pool; continue; }
    const other = p.pool === 'endless' ? 'ladder' : 'endless';
    const otherOk = other === 'endless' ? fitsEndless(p) : fitsLadder(p);
    if (otherOk) {
      p.finalPool = other;
      migrations.push(`${p.face}: ${p.pool} -> ${other} (${p.par.toFixed(0)}s, ${p.now.toFixed(2)} s/cell)`);
    } else {
      p.finalPool = null;
      homeless.push(`${p.face} (${p.pool}): ${p.par.toFixed(0)}s, ${p.now.toFixed(2)} s/cell fits neither pool`);
    }
  }

  if (migrations.length) {
    console.log(`\n${migrations.length} entries migrated between pools:`);
    for (const m of migrations) console.log(`  ${m}`);
  }
  if (homeless.length) {
    console.log(`\n${homeless.length} entries fit NEITHER pool and were dropped:`);
    for (const h of homeless) console.log(`  ${h}`);
    console.log('Re-search to replace them: node scripts/search-endless-specs.mjs --absorb');
  }

  // A SHAPE THAT EMPTIES OUT OF A POOL IS REPORTED, NEVER PINNED.
  //
  // The first cut of this policy PINNED such a shape's last leaver in place,
  // on the reasoning that losing the last rhombille endless spec leaves a
  // future endless build unable to make the shape at all, which is a bigger
  // loss than one entry sitting a little under its floor. It is not. A pinned
  // entry is an entry the file says belongs to a pool whose rulings it does
  // not meet, and the pool's own contract test refuses that — correctly, and
  // on the refit's own commit, so the pin bought a red main rather than
  // avoiding one. Weakening the test to let the pin through would be moving
  // the goalposts on a rule that exists to keep the ladder's prices honest.
  //
  // The honest reading is that the model and the cache no longer put that
  // shape in that pool, which is a true statement worth acting on rather than
  // hiding. Nothing a PLAYER touches is lost by saying so: the endless pool
  // feeds the L251+ FALLBACK braid, while the play path is the pre-generated
  // library, which re-bins the same night and flows boards both ways. So the
  // remedy is more material, and this names it.
  const emptied = [];
  for (const pool of ['ladder', 'endless']) {
    const before = new Set(priced.filter((p) => p.pool === pool).map((p) => p.e.shape));
    const after = new Set(priced.filter((p) => p.finalPool === pool).map((p) => p.e.shape));
    for (const shape of before) {
      if (!after.has(shape)) emptied.push({ shape, pool });
    }
  }
  if (emptied.length) {
    console.log(`\n${emptied.length} shape(s) no longer have any spec in a pool they used to fill:`);
    for (const { shape, pool } of emptied) console.log(`  ${shape} is now absent from the ${pool} pool`);
    console.log('Search for replacements rather than re-shipping the ones that left:');
    for (const { shape } of emptied) {
      console.log(`  node scripts/search-endless-specs.mjs --shape ${shape} --seeds 10 --refine`);
    }
    console.log('  node scripts/write-challenge-pool.mjs --only endless');
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

  // A migration MOVES a line between the two tables, which a price patch
  // cannot express, so the table bodies are rebuilt from the priced list
  // whenever anything moved or was dropped. Rebuilding both bodies rather
  // than splicing single lines keeps the file's shape exactly what the
  // emitter produces, and each entry's own constructor text is reused
  // verbatim, so a spec can never be altered by being moved.
  if (migrations.length || homeless.length) {
    // CRLF-tolerant on purpose: this repo's checkouts carry \r\n, and a
    // \n-only anchor silently matches nothing, which reads as a corrupt pool
    // file rather than as a regex that missed.
    const eol = src.includes('\r\n') ? '\r\n' : '\n';
    const body = (pool) => priced
      .filter((p) => p.finalPool === pool)
      .map((p) => `  E(${p.now.toFixed(2)}, ${emitCtor(p.e)}),`)
      .join(eol);
    const replaceTable = (text, startMark, endMark, rows) => {
      const re = new RegExp(
        `(// ${startMark}[^\\r\\n]*\\r?\\n[^\\r\\n]*\\r?\\n)[\\s\\S]*?(\\r?\\n\\]\\);\\r?\\n// ${endMark})`);
      if (!re.test(text)) {
        console.error(`could not find the ${startMark}..${endMark} table; nothing written`);
        process.exit(1);
      }
      return text.replace(re, `$1${rows}$2`);
    };
    src = replaceTable(src, 'POOL:START', 'POOL:END', body('ladder'));
    src = replaceTable(src, 'ENDLESS:START', 'ENDLESS:END', body('endless'));
  }

  fs.writeFileSync(POOL_PATH, src);
  const kept = priced.filter((p) => p.finalPool).length;
  console.log(`\nrewrote ${patched} prices in ${path.relative(process.cwd(), POOL_PATH)}`
    + (migrations.length ? `; ${migrations.length} migrated` : '')
    + (homeless.length ? `; ${homeless.length} dropped (${kept} shipped)` : ''));
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
