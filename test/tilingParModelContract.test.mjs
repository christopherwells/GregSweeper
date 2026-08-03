// The refit contract for per-shape par equations (Project Coastline,
// architecture of 2026-08-01 — Christopher: "we might just want different par
// equations for each shape... priors can be informed by the square tilings").
//
// A tiling board no longer prices as PAR_MODEL plus a secPerShape* intercept
// offset. Instead PAR_MODEL_SHAPES carries one FULL coefficient set per
// tiling, composed by the nightly refit as base + deviations (a deviation is
// a signed shape-by-feature interaction in ONE joint brms fit), and modelFor
// dispatches a feature vector to its block. Since 2026-08-03 the core
// deviations are LAB-SEEDED (Christopher's seeding ruling): the completed
// Par Lab battery's posteriors (scripts/data/parlab-prior-centers.json)
// supply each core term's shipped center until live rows exist and its
// prior center thereafter, while the n=1 gimmick cells stay zero-centered
// (his observations-not-conclusions ruling) and unseeded terms keep the
// NEW_FEATURE_DATA_THRESHOLD earn guard. These tests pin:
//
//  - the LAB-SEED property, replacing the launch parity property: block
//    minus base equals the frozen lab center for every seeded term (within
//    emission rounding) and exactly zero for every unseeded coefficient, so
//    the blocks and the JSON cannot drift apart silently — and rectangles
//    still price byte-identically to the pre-shape model;
//  - the registry lockstep (blocks exactly cover TILING_TYPES, JS and R);
//  - the DEATH of the two hand-maintained sprintf templates the generated
//    emitter replaced (their slot/arg counts silently drifted twice);
//  - the R-side plumbing a deviation needs in order to ever be fit: the
//    TWO-PATH sampling geometry (the flat formula under the class-wide lb
//    blanket while no deviation column is active — restored after the
//    2026-08-01 divergence incident — and a brms non-linear split with a
//    bounded base nlpar and an unbounded dev nlpar when one is), the name
//    normalization at the extraction boundary, interaction columns,
//    per-column gates, the earn guard, and the modelHistory shapeDeviations
//    record that never reaches target_candidates.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PAR_MODEL, PAR_MODEL_TIMED, PAR_MODEL_SHAPES,
} from '../src/logic/difficulty.js';
import {
  modelFor, predictPar, applyParModel, breakdownPar,
} from '../src/logic/dailyFeatures.js';
import { TILING_TYPES } from '../src/logic/tilingGeometry.js';

const R_SRC = readFileSync(new URL('../scripts/refit-par-model.R', import.meta.url), 'utf8');
const JS_SRC = readFileSync(new URL('../src/logic/difficulty.js', import.meta.url), 'utf8');
const DF_SRC = readFileSync(new URL('../src/logic/dailyFeatures.js', import.meta.url), 'utf8');

// The retired offset keys. They must never come back: the emitter would not
// emit them, so a hand-added key would silently vanish on the next nightly.
const RETIRED_SHAPE_COEFS = ['secPerShape488', 'secPerShapeHex', 'secPerShapeCairo',
  'secPerShapeFloret', 'secPerShapeRhombille', 'secPerShapeDeltoidal'];

// R predictor stems, derived from the registry exactly as the R SHAPE_TABLE
// must map them — the same SHAPE_KEY discipline the offset-era test used.
const SHAPE_KEY = { '4.8.8': '488', hex: 'Hex', cairo: 'Cairo', floret: 'Floret',
  rhombille: 'Rhombille', deltoidal: 'Deltoidal' };
const SHAPE_PREDICTORS = TILING_TYPES.map((t) => {
  const key = SHAPE_KEY[t];
  if (!key) throw new Error(`tiling '${t}' has no predictor stem — add it to SHAPE_KEY`);
  return `shape${key}`;
});

// The frozen Par Lab posteriors the shipped blocks are seeded from, and the
// two seeding constants mirrored from refit-par-model.R (which the R-side
// test below pins against this file's values). Deviation-term names map back
// to block coefficients through PREDICTOR_TO_COEF — the inverse of the R
// COEF_TO_PREDICTOR table, mirrored here because the test cannot import R.
const LAB = JSON.parse(readFileSync(
  new URL('../scripts/data/parlab-prior-centers.json', import.meta.url), 'utf8'));
const LAB_SEED_MIN_ROWS = 5;
const PREDICTOR_TO_COEF = {
  cellCount: 'secPerCell', totalMines: 'secPerMineFlag',
  patternMoves: 'secPerPatternMove', searchMoves: 'secPerSearchMove',
  wallEdgeCount: 'secPerWallEdge', zeroClusterCount: 'secPerZeroCluster',
  mysteryCellCount: 'secPerMysteryCell', liarCellCount: 'secPerLiarCell',
  lockedCellCount: 'secPerLockedCell', wormholePairCount: 'secPerWormholePair',
  mirrorPairCount: 'secPerMirrorPair', sonarCellCount: 'secPerSonarCell',
  compassCellCount: 'secPerCompassCell', wormLoad: 'secPerWormLoad',
};
// coefficient key -> lab deviation mean, per shape stem; only terms at or
// above the seeding floor count (the n=1 gimmick cells stay zero-centered).
function seededDevsFor(stem) {
  const out = { intercept: 0 };
  for (const coef of Object.values(PREDICTOR_TO_COEF)) out[coef] = 0;
  for (const [term, d] of Object.entries(LAB.deviations)) {
    if (d.nRows < LAB_SEED_MIN_ROWS) continue;
    if (term === stem) out.intercept = d.mean;
    else if (term.startsWith(`${stem}_x_`)) {
      const coef = PREDICTOR_TO_COEF[term.slice(stem.length + 3)];
      if (coef) out[coef] = d.mean;
    }
  }
  return out;
}

// Realistic-ish feature vectors for the behavioral assertions.
const FEATS = [
  { cellCount: 100, totalMines: 20, canonicalSubsetMoves: 2, genericSubsetMoves: 1,
    advancedLogicMoves: 1, wallEdgeCount: 3, zeroClusterCount: 2 },
  { cellCount: 63, totalMines: 13, canonicalSubsetMoves: 5, genericSubsetMoves: 0,
    advancedLogicMoves: 0, sonarCellCount: 3, zeroClusterCount: 4 },
  { cellCount: 144, totalMines: 40, canonicalSubsetMoves: 0, genericSubsetMoves: 0,
    advancedLogicMoves: 9, lockedCellCount: 2, wormLoad: 4.2 },
];

// ── The shipped artifact ─────────────────────────────────────────────

test('PAR_MODEL_SHAPES covers exactly TILING_TYPES', () => {
  assert.ok(PAR_MODEL_SHAPES && typeof PAR_MODEL_SHAPES === 'object');
  assert.deepEqual(Object.keys(PAR_MODEL_SHAPES).sort(), [...TILING_TYPES].sort(),
    'one block per registry tiling, no extras (the alias 6.6.6 must NOT be a key — modelFor normalizes it)');
});

test('every shape block has exactly PAR_MODEL’s key set', () => {
  const baseKeys = Object.keys(PAR_MODEL).sort();
  for (const t of TILING_TYPES) {
    assert.deepEqual(Object.keys(PAR_MODEL_SHAPES[t]).sort(), baseKeys,
      `${t}: a shape block is a FULL equation — same keys as PAR_MODEL, always`);
  }
});

test('LAB SEED: every shape block = PAR_MODEL + its frozen lab deviation centers', () => {
  // The seeding ruling's safety property, replacing launch parity: composed
  // = base + deviation, where a deviation is the lab center for the 18
  // seeded core terms (>= LAB_SEED_MIN_ROWS lab rows) and exactly zero for
  // everything else. Pinning block minus base against the frozen JSON keeps
  // the emitted difficulty.js and the lab artifact in lockstep — a nightly
  // that silently lost the seeding (missing file, renamed term) reverts a
  // block toward parity and fails here on its own commit.
  //
  // Seeded terms compare within emission rounding (base and block round at
  // 4-5 decimals, the JSON at 5); unseeded coefficients must equal the base
  // EXACTLY, because both sides are the same float through the same
  // formatter. Once live tiling rows accumulate and a fitted posterior
  // replaces a lab center, relax the seeded tolerance for that term, having
  // looked at the fit that moved it.
  const TOL = 2e-4;
  for (const t of TILING_TYPES) {
    const block = PAR_MODEL_SHAPES[t];
    const devs = seededDevsFor(`shape${SHAPE_KEY[t]}`);
    assert.equal(block.scale, 'log', `${t}: shape blocks are log-scale`);
    for (const key of Object.keys(PAR_MODEL)) {
      if (key === 'scale') continue;
      const dev = devs[key] ?? 0;
      const gap = block[key] - PAR_MODEL[key];
      if (dev === 0) {
        assert.equal(block[key], PAR_MODEL[key],
          `${t}.${key}: unseeded coefficient must equal the base exactly`);
      } else {
        assert.ok(Math.abs(gap - dev) <= TOL,
          `${t}.${key}: block - base = ${gap}, lab center = ${dev} (off by ${gap - dev})`);
      }
    }
  }
  // The seeding floor really is doing work: the lab file must carry both
  // sides of it (core terms above, n=1 gimmick observation cells below), or
  // this whole pin is vacuous.
  const rows = Object.values(LAB.deviations).map((d) => d.nRows);
  assert.ok(rows.some((n) => n >= LAB_SEED_MIN_ROWS), 'no seeded terms in the lab file');
  assert.ok(rows.some((n) => n < LAB_SEED_MIN_ROWS), 'no observation cells in the lab file');
});

test('the retired secPerShape* offsets are GONE from both flat blocks and from COEF_TERMS', () => {
  for (const coef of RETIRED_SHAPE_COEFS) {
    assert.equal(PAR_MODEL[coef], undefined, `${coef} must not return to PAR_MODEL`);
    assert.equal(PAR_MODEL_TIMED[coef], undefined, `${coef} must not return to PAR_MODEL_TIMED`);
  }
  // COEF_TERMS is module-private, so pin it two ways: the source must not
  // mention the keys, and behaviorally a model carrying one must not move par
  // on its shape (the term no longer exists to read it).
  assert.ok(!DF_SRC.includes('secPerShape'),
    'dailyFeatures.js must not carry shape indicator terms — shape now selects the MODEL');
  const doped = { ...PAR_MODEL, secPerShape488: 0.5 };
  const f = { ...FEATS[0], tilingType: '4.8.8' };
  assert.equal(applyParModel(f, doped), applyParModel(f, PAR_MODEL),
    'a secPerShape* key on a model must be inert — the indicator term is retired');
});

test('the shapes block lives INSIDE its refit-owned markers', () => {
  const start = JS_SRC.indexOf('// PAR_MODEL_SHAPES:START');
  const end = JS_SRC.indexOf('// PAR_MODEL_SHAPES:END');
  assert.ok(start > 0 && end > start, 'PAR_MODEL_SHAPES markers not found');
  const block = JS_SRC.slice(start, end);
  assert.ok(block.includes('export const PAR_MODEL_SHAPES'),
    'the export must sit inside the markers, or the refit’s rewrite would strand it');
  for (const t of TILING_TYPES) {
    const lit = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(t) ? `${t}:` : `'${t}':`;
    assert.ok(block.includes(lit), `${t} entry must sit inside the markers`);
  }
});

// ── Dispatch ─────────────────────────────────────────────────────────

test('modelFor: tilingType dispatches to its block, unknown falls back, modeTimed wins', () => {
  for (const t of TILING_TYPES) {
    assert.equal(modelFor({ tilingType: t }), PAR_MODEL_SHAPES[t],
      `${t} must price on its own block`);
  }
  // Unknown / absent shape -> the base model. Same documented hazard as
  // buildTiling's fallback: a tiling that ships its feature before its block
  // prices as a plain board, never borrows another lattice's equation.
  assert.equal(modelFor({ tilingType: '3.12.12' }), PAR_MODEL);
  assert.equal(modelFor({}), PAR_MODEL);
  assert.equal(modelFor(null), PAR_MODEL);
  // Quick play is rectangles-only and win-censored; it wins outright even if
  // a tilingType somehow rides along.
  assert.equal(modelFor({ modeTimed: 1, tilingType: 'hex' }), PAR_MODEL_TIMED);
});

test('the 6.6.6 alias resolves to the hex block via modelFor normalization', () => {
  // Decision, documented in dailyFeatures.js: PAR_MODEL_SHAPES carries ONLY
  // canonical TILING_TYPES keys (so the covers-exactly test above stays
  // exact) and modelFor normalizes the deep-link alias. A stored tilingType
  // can never be '6.6.6' (builders stamp canonical names); this is defense
  // for callers holding a raw link token.
  assert.equal(modelFor({ tilingType: '6.6.6' }), PAR_MODEL_SHAPES.hex);
  assert.equal(PAR_MODEL_SHAPES['6.6.6'], undefined, 'the alias must not be a block key');
});

test('predictPar dispatch: rectangles price on PAR_MODEL, tilings on their seeded blocks', () => {
  // Structural relationships, not absolute numbers — every block's values
  // are refit-owned and move nightly with the base.
  for (const base of FEATS) {
    const rectPar = predictPar(base);
    assert.equal(rectPar, applyParModel(base, PAR_MODEL),
      'rectangles price on PAR_MODEL, byte-identical to the pre-shape model');
    for (const t of TILING_TYPES) {
      const tPar = predictPar({ ...base, tilingType: t });
      assert.equal(tPar, applyParModel({ ...base, tilingType: t }, PAR_MODEL_SHAPES[t]),
        `${t} must price on its own block`);
      // Every shape carries a nonzero seeded intercept deviation, so a
      // tiling par that EQUALS the rectangle par means the dispatch or the
      // seeding silently died (the pre-seeding parity reading of this test).
      assert.notEqual(tPar, rectPar,
        `${t}: a seeded block must actually move par off the rectangle price`);
    }
    // One semantic anchor from the lab findings: deltoidal composed is
    // dearer than hex composed at every test vector (its intercept, per-cell
    // and per-mine deviations all sit above hex's).
    assert.ok(predictPar({ ...base, tilingType: 'deltoidal' })
              > predictPar({ ...base, tilingType: 'hex' }),
      'deltoidal must price above hex under the seeded deviations');
    // The deep-link alias still resolves to the hex block.
    assert.equal(predictPar({ ...base, tilingType: '6.6.6' }),
                 predictPar({ ...base, tilingType: 'hex' }));
  }
});

test('breakdownPar resolves the shape block by default and yields a sane breakdown', () => {
  const f = { ...FEATS[1], tilingType: 'hex' };
  const chips = breakdownPar(f);
  assert.ok(Array.isArray(chips) && chips.length > 0, 'expected breakdown chips');
  for (const c of chips) {
    assert.equal(typeof c.label, 'string');
    assert.ok(Number.isFinite(c.seconds) && c.seconds > 0, `${c.label}: ${c.seconds}`);
  }
  // The chips (groups + baseline) still sum to par under the log allocation,
  // within the 0.1s rounding each chip carries.
  const par = predictPar(f);
  const sum = chips.reduce((s, c) => s + c.seconds, 0);
  assert.ok(Math.abs(sum - par) <= 0.05 * (chips.length + 1),
    `chips sum ${sum} should reconstruct par ${par}`);
  // The seeded hex block's negative per-cell coefficient lives on a
  // baseline-flagged term, so it folds into the exp() baseline chip rather
  // than surfacing as a negative chip — which is why the all-positive
  // assertion above can hold on a seeded shape at all. Pin that the
  // baseline chip exists and that the shape breakdown genuinely diverged
  // from the rectangle one (the pre-seeding version of this test asserted
  // they were deepEqual).
  assert.ok(chips.some((c) => c.label === 'baseline'), 'baseline chip must exist');
  assert.notDeepEqual(chips, breakdownPar({ ...FEATS[1] }),
    'a seeded shape breakdown must differ from the rectangle breakdown');
});

// ── The R side ───────────────────────────────────────────────────────

test('REGRESSION: both hand sprintf templates are dead; the generator exists', () => {
  // The hand templates' fingerprint was literal %.5f/%.4f slots whose count
  // had to match a parallel argument list by eye — the drift class this
  // architecture removes. The generator formats per key (formatC), so ANY
  // %.Nf literal reappearing in the R source means a hand template is back.
  assert.equal((R_SRC.match(/%\.[45]f/g) || []).length, 0,
    'no %.4f/%.5f template slots may exist — blocks are emitted per key');
  assert.ok(!R_SRC.includes("'export const PAR_MODEL"),
    'no inline JS template literals — emit_model_block builds the block');
  for (const fn of ['emit_model_block', 'emit_shape_models_block',
    'patch_js_markers', 'ordered_model_fields', 'fmt_js_number']) {
    assert.ok(new RegExp(`${fn} <- function`).test(R_SRC), `generator ${fn} missing`);
  }
  // The harness contract: the emitter region is extractable by its markers.
  assert.ok(R_SRC.includes('# EMITTER:START') && R_SRC.includes('# EMITTER:END'),
    'EMITTER markers are load-bearing — the parity harness evals that region');
  // All three artifacts are emitted through the marker patcher.
  for (const marker of ['// PAR_MODEL:START', '// TIMED_PAR_MODEL:START',
    '// PAR_MODEL_SHAPES:START']) {
    assert.ok(R_SRC.includes(`"${marker}"`), `patch_js_markers must target ${marker}`);
  }
});

test('R derives the indicator AND every shape-by-feature interaction from the registry', () => {
  // SHAPE_TABLE must map every TILING_TYPES string to its predictor stem —
  // the R-side half of the registry lockstep.
  const tbl = R_SRC.match(/SHAPE_TABLE <- c\(([\s\S]*?)\)/);
  assert.ok(tbl, 'SHAPE_TABLE missing from the R refit');
  for (let i = 0; i < TILING_TYPES.length; i++) {
    assert.ok(tbl[1].includes(`"${TILING_TYPES[i]}"`), `SHAPE_TABLE lacks ${TILING_TYPES[i]}`);
    assert.ok(tbl[1].includes(`"${SHAPE_PREDICTORS[i]}"`), `SHAPE_TABLE lacks ${SHAPE_PREDICTORS[i]}`);
  }
  // Interaction columns are an outer product over the registry, not a hand
  // list — one line covers every shape x every base feature.
  assert.ok(/SHAPE_INTERACTION_COLS <- as\.vector\(t\(outer\(SHAPE_PREDICTORS, BASE_MODEL_FEATURES/.test(R_SRC),
    'interaction columns must be derived by outer product over the registry');
  assert.ok(R_SRC.includes('paste0(.s, "_x_", .f)'),
    'df must gain the shape<S>_x_<F> columns');
  // Per-COLUMN zero-variance gate (collapses to nothing with no tiling rows).
  assert.ok(/active_shape_cols <- SHAPE_DEV_NAMES\[/.test(R_SRC),
    'every deviation column must gate on having nonzero rows');
});

test('two-path priors: the flat path keeps the class-wide lb blanket; the nl path bounds base and frees dev', () => {
  const body = R_SRC.slice(R_SRC.indexOf('build_priors <- function'),
    R_SRC.indexOf('strip_nlpar_prefix <- function'));
  assert.ok(body.length > 100, 'build_priors not found');
  // FLAT path (every night until tiling scores exist): the pre-#203 blanket
  // literal, RESTORED after the 2026-08-01 incident. Support-only geometry
  // was rejected live — divergent 14/4000 against a gate of 10, 2950/4000
  // max-treedepth exceedances, min ESS 464 — on the SAME data the bounded
  // setup had fit twelve hours earlier (Rhat 1.007, ESS 1060, 0 divergent).
  // lb is a TRANSFORM statement, support only a density statement; HMC needs
  // the transform.
  assert.ok(body.includes('set_prior("", class = "b", lb = 0)'),
    'the flat path must keep the class-wide lb = 0 blanket — removing it re-runs the 2026-08-01 divergence incident');
  // NL path: bounds attach per parameter class, and a non-linear formula
  // gives each nlpar its own class b — the sanctioned way to bound one group
  // of fixed effects and not another.
  assert.ok(body.includes('set_prior("", class = "b", nlpar = "base", lb = 0)'),
    'the nl path must restore the constrained transform on the base nlpar');
  // The dev nlpar is signed and UNBOUNDED: the only lb literals in the body
  // are the two base blankets.
  assert.equal((body.match(/lb = 0/g) || []).length, 2,
    'exactly two lb blankets (flat class b, nl base nlpar) — a bound reaching the dev nlpar would forbid negative deviations');
  assert.ok(body.includes('class = "b", coef = nm, nlpar = "dev"'),
    'deviations must live on the dev nlpar');
  assert.ok(body.includes('normal(0, %f)') && body.includes('INTERACTION_PRIOR_SD'),
    'deviations must get the zero-centered signed normal');
  assert.ok(body.includes('deviation_names'), 'build_priors must take deviation_names');
  assert.ok(/INTERACTION_PRIOR_SD <- /.test(R_SRC), 'INTERACTION_PRIOR_SD must be a documented constant');
  // With nl = TRUE there is no global Intercept class: the base intercept is
  // an ordinary class-b coef under the base nlpar, and the (1|uid) sd prior
  // carries the same tag.
  assert.ok(body.includes('class = "b", coef = "Intercept", nlpar = "base"'),
    'the base intercept prior must relocate to coef = "Intercept", nlpar = "base"');
  assert.ok(body.includes('class = "sd", group = "uid", nlpar = "base"'),
    'the uid random intercept must ride the base nlpar');
  // stop()-on-missing discipline survives for non-deviation names.
  assert.ok(body.includes('stop("Missing prior sigma for '), 'sigma stop() discipline lost');
});

test('path selection is ONE boolean at formula construction; the nl split has the right shapes', () => {
  const i = R_SRC.indexOf('use_nl_split <- length(active_shape_cols) > 0');
  assert.ok(i > 0, 'the one path-selection boolean is missing');
  const block = R_SRC.slice(i, R_SRC.indexOf('message("Fitting brms model'));
  assert.ok(block.length > 100 && block.length < 4000, 'path-selection region not found');
  // Path B: the brms non-linear split (per-nlpar class b is what lets base
  // stay bounded while dev is signed).
  assert.ok(block.includes('bf(log(pure_time) ~ base + dev'),
    'the nl branch must exist (bf main formula: base + dev)');
  assert.ok(block.includes('nl = TRUE'), 'the split must be a non-linear formula');
  assert.ok(block.includes('"base ~"') && block.includes('"(1 | uid)"'),
    'the base nlpar must carry the intercept and (1 | uid)');
  assert.ok(block.includes('"dev ~ 0 +"'),
    'the dev nlpar must be intercept-free (0 +) — base owns the one intercept');
  // Path A: the flat pre-incident formula, selected whenever no deviation
  // column is active.
  assert.ok(block.includes('update(fit_formula_fixed_active, ~ . + (1 | uid))'),
    'the flat path formula must survive verbatim');
  // Both paths hand build_priors the same base names; only deviation_names
  // differs (empty selects the flat prior construction — same boolean fact).
  assert.ok(block.includes('deviation_names = active_shape_cols'),
    'the prior construction must key off the same condition as the formula');
});

test('make_positive_init is GONE and no fit passes a custom init', () => {
  // The init only patched initialization, never the boundary geometry — the
  // 2026-08-01 run initialized fine and then diverged. With the bound
  // restored on both paths (flat class b / the base nlpar), Stan samples the
  // bounded block through its log transform and default inits are valid.
  assert.ok(!/make_positive_init <- function/.test(R_SRC),
    'make_positive_init must stay removed — reintroducing it means the bound went missing again');
  assert.ok(!/\binit\s*=/.test(R_SRC), 'no brm() call may pass a custom init');
  // The timed fit keeps its own lb blanket (no deviations on that path), so
  // its default inits remain valid.
  const timedBlock = R_SRC.slice(R_SRC.indexOf('timed_priors_parts <- list('));
  assert.ok(timedBlock.slice(0, 200).includes('lb = 0'),
    'the timed prior blanket is intentionally retained');
  // The digit fit is always FLAT (lognormal controls + the four lognormal
  // digit shares, no signed term), so build_priors' flat path restores its
  // class-wide blanket; it must never pass deviation_names. Capture to the
  // END OF THE LINE, not to the first `)` — the call's own `c("Intercept",
  // digit_fixed)` closes a paren mid-argument, so a first-paren capture reads
  // only the inner arguments and a `deviation_names = ...` appended AFTER them
  // sailed straight past the old pin. That exact edit puts nlpar-tagged priors
  // on a flat formula, brms errors at fit time, the digit tryCatch swallows
  // it, and the digit studies silently stop — the failure this pin exists for.
  const digitLine = R_SRC.match(/digit_priors <- build_priors\(.*$/m);
  assert.ok(digitLine, 'digit build_priors call missing');
  assert.ok(!digitLine[0].includes('deviation_names'),
    'the digit fit must use the flat path — its priors are all lognormal');
});

test('nl-path names are normalized at ONE extraction boundary', () => {
  // On the nl path brms prefixes every population-level name with its nlpar
  // (b_base_cellCount, b_dev_shape488_x_...). One normalization strips the
  // prefixes back to the flat names, so new_coefs, shape_dev_summary,
  // earned_shape_devs, apply_par_model and the emitter see exactly the names
  // they see today — never scattered renames.
  for (const fn of ['strip_nlpar_prefix', 'flat_fixef', 'flat_ranef_uid']) {
    assert.ok(new RegExp(`${fn} <- function`).test(R_SRC), `${fn} missing`);
  }
  assert.ok(R_SRC.includes('sub("^(base|dev)_", "", x)'),
    'the strip must target exactly the two nlpar prefixes, anchored');
  // Every primary-fit read goes through the normalization — a bare
  // fixef(fit)/ranef(fit) would miss every coefficient on path B SOFTLY
  // (through %||% 0 and %in% lookups), not loudly.
  // \b: underscore is a word char, so flat_fixef(fit)/flat_ranef_uid(fit)
  // do not match — only a BARE read does.
  assert.equal((R_SRC.match(/\bfixef\(fit\)/g) || []).length, 0,
    'primary fixef reads must go through flat_fixef');
  assert.equal((R_SRC.match(/\branef\(fit\)/g) || []).length, 0,
    'primary ranef reads must go through flat_ranef_uid');
  assert.ok(R_SRC.includes('flat_fixef(fit)'), 'flat_fixef must actually be used on the primary fit');
  assert.ok(R_SRC.includes('flat_ranef_uid(fit)'), 'flat_ranef_uid must actually be used on the primary fit');
});

test('apply_par_model stays ONE equation: defaults every deviation column and adds them to the lp', () => {
  const fn = R_SRC.slice(R_SRC.indexOf('apply_par_model <- function('),
    R_SRC.indexOf('parse_par_model_shapes_devs <- function'));
  assert.ok(fn.includes('shape_devs'), 'apply_par_model must take the deviation list');
  assert.ok(fn.includes('SHAPE_DEV_NAMES'),
    'every indicator and interaction column must be defaulted (a rectangles-only frame carries none)');
  assert.ok(fn.includes('COEF_TO_PREDICTOR'),
    'the base terms must be data-driven off the same table the emitter reads');
  // And the screens actually pass the shipped deviations through.
  assert.ok(R_SRC.includes('prev_is_log, current_shape_devs'),
    'the outlier screen and residual fallback must price tiling rows on the shipped shape equations');
});

test('deviation earn guard + composition: threshold per column, composed blocks, history record', () => {
  // Two-layer guard, same shape as wormLoad's: fitted posterior recorded,
  // shipped value zeroed until NEW_FEATURE_DATA_THRESHOLD nonzero rows.
  assert.ok(R_SRC.includes('earned_shape_devs'), 'earned deviation set missing');
  const guard = R_SRC.slice(R_SRC.indexOf('shape_dev_summary <- list()'),
    R_SRC.indexOf('shape_dev_summary <- list()') + 1600);
  assert.ok(guard.includes('NEW_FEATURE_DATA_THRESHOLD'),
    'each deviation must earn out at the shared threshold');
  // Composition: shape block = final shipped base + earned deviation.
  assert.ok(R_SRC.includes('shape_models[[js_key]] <- blk'), 'per-shape composition missing');
  // modelHistory carries the fitted deviations additively; the target chooser
  // must never see them (not force-injectable).
  assert.ok(R_SRC.includes('new_row$shapeDeviations'),
    'fitted deviations must ride modelHistory as shapeDeviations');
  const whitelist = R_SRC.match(/target_whitelist <- c\(([\s\S]*?)\)/);
  assert.ok(whitelist, 'target_whitelist missing');
  assert.ok(!/shape/i.test(whitelist[1]),
    'no shape term may enter target_candidates via the whitelist');
});

test('the R refit carries the lab-seed machinery (2026-08-03 seeding ruling)', () => {
  // The constants, mirrored by this test's own LAB_SEED_MIN_ROWS above — the
  // floor is what routes the core grid terms in and the n=1 gimmick cells
  // out, so JS and R must agree on it.
  assert.ok(R_SRC.includes('scripts/data/parlab-prior-centers.json'),
    'the nightly must read the frozen lab posteriors');
  const floor = R_SRC.match(/LAB_SEED_MIN_ROWS\s*<-\s*(\d+)/);
  assert.ok(floor, 'LAB_SEED_MIN_ROWS missing');
  assert.equal(Number(floor[1]), LAB_SEED_MIN_ROWS,
    'the seeding floor must match this test’s mirror');
  assert.ok(/LAB_PRIOR_WIDTH_MULT\s*<-\s*2\b/.test(R_SRC),
    'doubled lab widths (his prior-width ruling)');
  // build_priors: a seeded deviation gets normal(lab mean, 2 x lab sd) on
  // the dev nlpar; unseeded terms keep the zero-centered INTERACTION_PRIOR_SD
  // (asserted by the two-path priors test above).
  assert.ok(R_SRC.includes('sprintf("normal(%f, %f)", seed$mean, seed$sd)'),
    'seeded deviations must center on the lab posterior');
  // The earn guard: a lab-seeded term ships its fitted posterior WITHOUT the
  // 20-row guard (the guard stops bare prior medians; a lab center is data),
  // and a seeded term whose column never entered the formula ships its lab
  // center directly — that second branch is what makes the blocks lab-seeded
  // on nights with zero live tiling rows.
  assert.ok(R_SRC.includes('lab-seeded prior'),
    'the earn guard must carry the lab-seeded bypass branch');
  assert.ok(R_SRC.includes('setdiff(names(lab_seed_devs), rownames(fe_all))'),
    'seeded terms outside the fit must still ship their lab centers');
  // Fail-soft loader: a lost file degrades to zero-centered deviations (the
  // pre-seeding behavior) instead of killing the nightly; THIS test is what
  // then fails loudly on the refit’s own commit.
  assert.ok(R_SRC.includes('lab priors unavailable'),
    'the lab-priors loader must fail soft with a message');
});

test('the digit frame is rectangles-only', () => {
  // At fixed density the digit shares differ BY LATTICE (rhombille 5plus
  // 4.4x the 4.8.8's, 15x the hex's); tiling rows would turn the digit
  // coefficients into part-shape indicators, and the pairwise decorrelation
  // mission cannot see a third axis.
  const frame = R_SRC.slice(R_SRC.indexOf('digit_df <- df |>'),
    R_SRC.indexOf('inner_join(digit_shares, by = "date")'));
  assert.ok(frame.includes('filter(is.na(tilingType))'),
    'digit_df must drop tiling rows before the shares join');
});
