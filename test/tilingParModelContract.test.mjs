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
  logCells: 'secPerLogCell', mineRate: 'secPerMineRate',
  patternRate: 'secPerPatternRate', searchRate: 'secPerSearchRate',
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
  // formatter.
  //
  // A LAB CENTER IS THE EXPECTATION UNTIL LIVE ROWS EARN THEIR POSTERIOR.
  // Once a deviation's own column carries NEW_FEATURE_DATA_THRESHOLD nonzero
  // fit rows, difficulty.js ships the FITTED posterior and the seed is
  // history — the seeding ruling working, not drift.
  //
  // The threshold is why this reads `nRows` rather than taking any recorded
  // posterior. The test used to accept a posterior the moment modelHistory
  // carried one, which mirrored the refit's own lab-seeded bypass, and both
  // were wrong in the same direction: on 2026-08-13 ONE live rhombille row
  // re-priced that shape 62% cheaper, this test agreed with it, and the
  // failures surfaced two layers downstream in the band configs and the
  // libraries instead of here. A pin that follows the fit wherever it goes
  // cannot notice the fit going somewhere it should not.
  //
  // A history row that records no `nRows` for a term predates the guard and
  // cannot demonstrate the threshold, so its seed stands. That is the
  // conservative direction (a lab center is 86 boards of designed data) and
  // it self-heals on the next fit night. (Do NOT read an early posterior as a
  // finding either way: shapeHex's sd is 0.8 on a handful of rows.)
  const TOL = 2e-4;
  const NEW_FEATURE_DATA_THRESHOLD = 20;
  const history = JSON.parse(readFileSync('src/logic/modelHistory.json', 'utf8'));
  const historyRows = Array.isArray(history) ? history : (history.rows || history.history || []);
  const recorded = historyRows.length
    ? (historyRows[historyRows.length - 1].shapeDeviations || {})
    : {};
  const fitted = Object.fromEntries(Object.entries(recorded)
    .filter(([, d]) => (d.nRows ?? 0) >= NEW_FEATURE_DATA_THRESHOLD));

  for (const t of TILING_TYPES) {
    const block = PAR_MODEL_SHAPES[t];
    const stem = `shape${SHAPE_KEY[t]}`;
    const devs = seededDevsFor(stem);
    // Fitted posteriors override their seeds, term by term — and `fitted`
    // is itself the earn guard: only terms whose recorded `nRows` clears
    // NEW_FEATURE_DATA_THRESHOLD are in it, so a one-row posterior (the
    // 2026-08-13 rhombille class) can never reach this override.
    //
    // The override deliberately covers UNSEEDED terms too. The R contract is
    // one rule for every deviation, seeded or not: below the threshold a
    // seeded term ships its lab center and an unseeded one ships zero; at
    // the threshold BOTH ship the fitted posterior. This override was once
    // scoped to seeded terms only, which encoded "an unseeded term ships
    // zero no matter what" — true below the threshold, wrong above it, and
    // the wrongness stayed invisible until 2026-08-16, when the first
    // match-row fit earned shapeHex_x_zeroClusterCount at nRows=25 and this
    // pin contradicted a difficulty.js that was following its own contract.
    // (The old comment's 2026-08-04 example, a hex posterior correctly held
    // at zero, was an UNDER-threshold posterior: today it would never enter
    // `fitted` at all.)
    for (const [term, post] of Object.entries(fitted)) {
      if (term === stem) {
        devs.intercept = post.mean;
      } else if (term.startsWith(`${stem}_x_`)) {
        // Fitted terms name the R PREDICTOR; the deviations map is keyed by
        // the JS coefficient. Same translation seededDevsFor does.
        const coef = PREDICTOR_TO_COEF[term.slice(stem.length + 3)];
        if (coef) devs[coef] = post.mean;
      }
    }
    assert.equal(block.scale, 'log', `${t}: shape blocks are log-scale`);
    for (const key of Object.keys(PAR_MODEL)) {
      if (key === 'scale') continue;
      const dev = devs[key] ?? 0;
      const gap = block[key] - PAR_MODEL[key];
      if (dev === 0) {
        assert.equal(block[key], PAR_MODEL[key],
          `${t}.${key}: unseeded coefficient must equal the base exactly`);
      } else if (key === 'secPerWormLoad') {
        // THE REALIZATION BRIDGE (2026-08-17): predictPar only knows the
        // SCHEDULED worm dose, so every shipped wormLoad coefficient is the
        // fitted per-realized-unit value times the play-weighted realization
        // ratio, deviations included. The center therefore ships SCALED, and
        // the honest pin is proportionality: the same shrinking ratio the
        // base wears, never a ratio above one, never a sign flip. The fit
        // does not yet record the ratio in modelHistory; when it does, this
        // becomes an equality against center x recorded ratio again.
        const r = gap / dev;
        assert.ok(r > 0 && r <= 1 + TOL,
          `${t}.${key}: bridged deviation ratio ${r} outside (0, 1]`);
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
  const i = R_SRC.indexOf('use_nl_split <- length(dev_cols) > 0');
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
  assert.ok(block.includes('deviation_names = dev_cols'),
    'the prior construction must key off the same condition as the formula');
  // The dev nlpar's occupants are the SIZE PAIR (unconditional, M1), the
  // shape deviations, and matchPlay, which is what makes the two sides of
  // the split one decision rather than two. With the pair leading
  // unconditionally, dev_cols can never be empty and Path B is permanent
  // for the primary fit; the flat branch survives as the specification
  // anchor.
  assert.ok(/dev_cols <- c\(SIZE_DEV_COLS, active_shape_cols,\s*\n?\s*if \(add_match_term\) "matchPlay"/.test(R_SRC),
    'dev_cols must lead with the size pair, then shape deviations, then the match offset');
});

test('the SIZE TERM is signed end to end: dev routing, sn() extraction, derived predictor', () => {
  // M1 shipped size as a PAIR (cellCount beside logCells) because the linear
  // half measured negative and the two jointly described a concave curve. The
  // rate form (2026-08-20) retired the linear half: every count that scales
  // with area now enters divided by the board, so log(cells) carries size
  // alone and its elasticity came out firmly positive (1.140 shipped, against
  // 1.164 [1.060, 1.267] measured in par-model-move-rates.qmd).
  //
  // It stays on the SIGNED dev nlpar even so. The class-wide lb = 0 is a claim
  // that par is monotonic non-decreasing in a feature, and leaving the one
  // term the whole size question rides on unbounded keeps the data able to say
  // otherwise. Keeping the column non-empty also keeps Path B permanent, which
  // the dev_cols construction relies on.
  const decl = R_SRC.match(/SIZE_DEV_COLS <- c\("logCells"\)/);
  assert.ok(decl, 'SIZE_DEV_COLS must declare the size elasticity');
  assert.ok(!/SIZE_DEV_COLS <- c\([^)]*"cellCount"/.test(R_SRC),
    'the linear cell term is retired; it must not return to the size routing');
  assert.ok(/SIZE_DEV_PRIOR_SD <- /.test(R_SRC),
    'the pair must carry its own documented prior width');
  // COEF_TO_PREDICTOR ships the elasticity; the R frame derives its column.
  const coefTable = R_SRC.match(/COEF_TO_PREDICTOR\s*<-\s*c\(([\s\S]*?)\n\)/);
  assert.match(coefTable[1], /secPerLogCell\s*=\s*"logCells"/,
    'the elasticity must be a shipped coefficient (secPerLogCell -> logCells)');
  assert.ok(/logCells\s*= log\(pmax\(1, cellCount\)\)/.test(R_SRC),
    'the frame must derive logCells from the stored cellCount (never a stored feature)');
  // The bounded formula is DERIVED from the coefficient table, not written
  // out beside it, replacing a hand-written predictor list. The failure that
  // closes was silent in the worst way: the list and the table were a mirror
  // pair nothing held in lockstep, so adding a coefficient to the table alone
  // meant the fit never estimated it, co[p] came back NA, and nn() shipped it
  // at ZERO with no error. Measured 2026-08-20: all three rate coefficients
  // emitted 0.00000 that way. Asserting the MECHANISM rather than the
  // resulting list is deliberate; only the derivation makes a stray term
  // impossible to add by accident.
  assert.ok(/BOUNDED_BASE_TERMS <- setdiff\(BASE_MODEL_FEATURES/.test(R_SRC),
    'the bounded formula must be derived from the coefficient table by exclusion');
  assert.ok(/fit_formula_fixed <- as\.formula\(/.test(R_SRC),
    'fit_formula_fixed must be built from BOUNDED_BASE_TERMS, never hand-written');
  assert.ok(/orphans <- setdiff\(BASE_MODEL_FEATURES, routed\)/.test(R_SRC),
    'an unrouted shipped coefficient must be caught before fitting');
  assert.ok(/would ship at 0 silently/.test(R_SRC),
    'the orphan guard must stop the run, not warn');
  const coefTableAll = R_SRC.match(/COEF_TO_PREDICTOR\s*<-\s*c\(([\s\S]*?)\n\)/);
  assert.ok(coefTableAll, 'COEF_TO_PREDICTOR literal not found; this scan is vacuous');
  assert.ok(!/=\s*"cellCount"/.test(coefTableAll[1]),
    'cellCount is retired and must not be a shipped predictor');
  // The extraction must not clamp the pair: nn() zeroes negatives, so the
  // size keys route through the signed sn() instead. A clamped linear half
  // ships the refuted replace-form at its worst (log term alone).
  assert.ok(/sn <- function\(x\) if \(is\.na\(x\)\) 0 else as\.numeric\(x\)/.test(R_SRC),
    'the signed extraction helper must exist');
  assert.ok(/if \(p %in% SIZE_DEV_COLS\) sn\(co\[p\]\) else nn\(co\[p\], k\)/.test(R_SRC),
    'the size pair must extract through sn(), everything else through nn()');
  // apply_par_model must DERIVE logCells rather than default it to 0: a
  // frame built before the mutate (timed_df, ad-hoc predict frames) still
  // carries cellCount, and a zero log term would misprice every board the
  // moment the coefficient is nonzero.
  const fn = R_SRC.slice(R_SRC.indexOf('apply_par_model <- function('),
    R_SRC.indexOf('parse_par_model_shapes_devs <- function'));
  assert.ok(/df\$logCells <- log\(pmax\(1, df\$cellCount\)\)/.test(fn),
    'apply_par_model must recompute logCells from the frame’s own cellCount');
  // PRIOR_SIGMAS must not regrow a cellCount entry: that list feeds the
  // bounded lognormal machinery the pair is routed around. (Same shape as
  // the matchPlay pin; archivePlay anchors non-vacuity there.)
  const sigmas = R_SRC.slice(R_SRC.indexOf('PRIOR_SIGMAS <- list('),
    R_SRC.indexOf('\n)', R_SRC.indexOf('PRIOR_SIGMAS <- list(')));
  assert.ok(!/^\s*cellCount\s*=/m.test(sigmas),
    'cellCount must have NO PRIOR_SIGMAS entry — it is signed now');
  assert.ok(/^\s*totalMines\s*=/m.test(sigmas),
    'the PRIOR_SIGMAS slice did not find totalMines — it is not reading the block');
});

test('the JS side derives the elasticity at predict time and every block carries the key', () => {
  // The landing pin (key at exactly 0 in every block) EXPIRED BY DESIGN on
  // 2026-08-18 when the first M1 refit emitted the fitted value the same
  // evening (secPerLogCell 0.68293 beside a negative secPerCell). What
  // remains pinned: the key exists as a number in every block, so the
  // emitter's table and the shipped artifact cannot drift apart, and the
  // TIMED block (whose own fit keeps the M0 formula over frozen rows)
  // carries the key as a number too, 0 whenever its fit ran without it.
  assert.equal(typeof PAR_MODEL.secPerLogCell, 'number', 'PAR_MODEL must carry the key');
  assert.equal(typeof PAR_MODEL_TIMED.secPerLogCell, 'number', 'PAR_MODEL_TIMED must carry the key');
  for (const t of TILING_TYPES) {
    assert.equal(typeof PAR_MODEL_SHAPES[t].secPerLogCell, 'number', `${t} must carry the key`);
  }
  // The predictor is DERIVED from cellCount, so SHIFTING the elasticity by
  // gamma moves par by exactly cells^gamma, whatever the shipped base value
  // is (a replacement-style dope only worked while the key was 0).
  const gamma = 0.5;
  const doped = { ...PAR_MODEL, secPerLogCell: PAR_MODEL.secPerLogCell + gamma };
  const f = { cellCount: 100, totalMines: 10 };
  const ratio = applyParModel(f, doped) / applyParModel(f, PAR_MODEL);
  assert.ok(Math.abs(ratio - Math.pow(100, gamma)) < 0.05 * Math.pow(100, gamma),
    `doping the elasticity must scale par by cells^gamma (got ${ratio}, want ~${Math.pow(100, gamma)})`);
  // The floor guard: cellCount 0/absent derives log(1) = 0, never -Infinity.
  assert.ok(Number.isFinite(applyParModel({ totalMines: 5 }, doped)),
    'a vector with no cellCount must still price finitely');
});

test('modelFingerprint ignores zero-valued keys, so a coefficient can land at 0 without invalidating library stamps', async () => {
  // The landing pattern for every new coefficient (wormLoad, then
  // secPerLogCell) ships the key at 0 in all blocks: predictively inert,
  // since applyParModel reads a missing key as 0 too. The fingerprint must
  // agree that nothing changed, or each landing would spuriously redden the
  // three library LOCKSTEP tests and demand a stamp-only re-price. A key
  // moving OFF zero is a real model change and must still move the hash.
  const { modelFingerprint } = await import('../src/logic/parModelFingerprint.js');
  const fp = modelFingerprint();
  assert.match(fp, /^[0-9a-f]{8}$/, 'fingerprint shape');
  // Behavioral pin of the property the skip encodes, on EXPLICIT
  // constructions rather than the shipped values (the launch state, every
  // block at 0, expired when the first M1 refit emitted the coefficient):
  // a real coefficient key at exactly 0 prices identically to the key being
  // absent, while a nonzero value moves par, so the fingerprint may skip
  // zeros and only zeros.
  const f = { cellCount: 80, totalMines: 12, zeroClusterCount: 1 };
  const withZero = { ...PAR_MODEL, secPerWallEdge: 0 };
  const { secPerWallEdge, ...withoutKey } = withZero;
  assert.equal(applyParModel({ ...f, wallEdgeCount: 4 }, withZero),
    applyParModel({ ...f, wallEdgeCount: 4 }, withoutKey),
    'a zero-valued key must be predictively inert (the property the fingerprint skip encodes)');
  assert.notEqual(applyParModel(f, { ...PAR_MODEL, secPerLogCell: PAR_MODEL.secPerLogCell + 0.5 }),
    applyParModel(f, PAR_MODEL),
    'a NONZERO shift must move par (so the fingerprint must move with it)');
});

test('REGRESSION: matchPlay is a SIGNED deviation, never a bounded slope', () => {
  // The class-wide lb = 0 on the base block is a real claim about BOARD
  // FEATURES: par is monotonic non-decreasing in every one, so a negative
  // slope would be nonsense. matchPlay is not a board feature, it is a group
  // indicator whose sign nobody knows, and a Challenge run is plausibly
  // FASTER than a daily. Under the bound the posterior would pile up at zero
  // and the speed-up would leak into the board coefficients, because the
  // (1|uid) intercept cannot absorb a WITHIN-player difference between a
  // player's daily rows and their match rows.
  // Scoped to the PRIOR blocks: the mutate() that derives the matchPlay
  // COLUMN is legitimate and must survive, so a whole-file scan would be
  // asserting the wrong thing.
  for (const blockName of ['PRIOR_MEANS', 'PRIOR_SIGMAS']) {
    const start = R_SRC.indexOf(`${blockName} <- list(`);
    assert.ok(start > 0, `${blockName} not found — this check is inert`);
    const block = R_SRC.slice(start, R_SRC.indexOf('\n)', start));
    assert.ok(!/^\s*matchPlay\s*=/m.test(block),
      `matchPlay must have NO ${blockName} entry — that list feeds the bounded lognormal block`);
    // Non-vacuity: the block must contain the sibling nuisance term, or the
    // slice missed its target and the check proves nothing.
    assert.ok(/^\s*archivePlay\s*=/m.test(block),
      `the ${blockName} slice did not find archivePlay — it is not reading the block`);
  }
  assert.ok(!/update\(fit_formula_fixed_active, ~ \. \+ matchPlay\)/.test(R_SRC),
    'matchPlay must NOT join the bounded fixed formula');
  assert.ok(/if \(add_match_term\) "matchPlay"/.test(R_SRC),
    'matchPlay must enter through dev_cols, the signed nlpar');
  // And it is still never shipped: new_coefs is built by iterating
  // COEF_TO_PREDICTOR and indexing the fit with each VALUE, so the only way
  // matchPlay reaches difficulty.js is an entry in that table pointing at it.
  // Scan the table's own literal rather than the whole file: the mutate()
  // that derives the matchPlay COLUMN is legitimate, so a file-wide scan
  // would assert the wrong thing. (The previous form looked for
  // `COEF_TO_PREDICTOR[["matchPlay"]]`, a string this file would never
  // contain under any edit, so it could not fail.)
  const coefTable = R_SRC.match(/COEF_TO_PREDICTOR\s*<-\s*c\(([\s\S]*?)\n\)/);
  assert.ok(coefTable, 'COEF_TO_PREDICTOR literal not found; this scan is vacuous');
  assert.match(coefTable[1], /secPerLogCell\s*=\s*"logCells"/,
    'the table scan must be reading the real mapping');
  // The RETIRED count predictors must be gone from the SHIPPED table, the way
  // secPerShape* went: they survive only as controls in the secondary fits,
  // and a shipped entry would put a count back in predictPar beside its rate.
  for (const dead of ['secPerCell', 'secPerMineFlag', 'secPerPatternMove', 'secPerSearchMove']) {
    assert.ok(!new RegExp(`${dead}\s*=`).test(coefTable[1]),
      `${dead} is retired and must not be a shipped predictor`);
  }
  assert.ok(!/=\s*"matchPlay"/.test(coefTable[1]),
    'matchPlay must never be a shipped predictor: no COEF_TO_PREDICTOR entry may map to it');
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
  // REGRESSION (2026-08-13): a lab-seeded term ships its LAB CENTER until its
  // own column earns the same NEW_FEATURE_DATA_THRESHOLD every other
  // deviation answers to. The branch used to ship the fitted posterior with
  // no row guard, and one live rhombille row then re-priced that shape 62%
  // cheaper, out of the daily band and under the weekly floor.
  //
  // Pinned on the ASSIGNMENT, not on a message string: the failure mode is a
  // branch that reads like the center and assigns the posterior, and only the
  // assignment decides what ships.
  const guard = R_SRC.slice(R_SRC.indexOf('for (nm in intersect(SHAPE_DEV_NAMES'),
    R_SRC.indexOf('# Lab-seeded terms with NO live rows'));
  assert.ok(guard.length > 100, 'the shape-deviation earn guard was not found');
  const seededBranch = guard.slice(guard.indexOf('!is.null(lab_seed_devs[[nm]])'));
  assert.ok(seededBranch.includes('earned_shape_devs[[nm]] <- lab_seed_devs[[nm]]$mean'),
    'a lab-seeded term below the threshold must ship its lab CENTER, never the fitted posterior');
  assert.ok(!seededBranch.includes('earned_shape_devs[[nm]] <- as.numeric(fe_all[nm, "Estimate"])'),
    'the lab-seeded bypass is gone: no unguarded posterior may ship');
  // And the row count must be RECORDED, or nothing downstream can tell an
  // earned posterior from a center the guard substituted (the LAB SEED test
  // above re-derives difficulty.js from exactly this field).
  assert.ok(/nRows\s*=\s*n_dev/.test(guard),
    'shape_dev_summary must record each deviation’s nonzero-row count');
  assert.ok(R_SRC.includes('setdiff(names(lab_seed_devs), rownames(fe_all))'),
    'seeded terms outside the fit must still ship their lab centers');
  // Fail-soft loader: a lost file degrades to zero-centered deviations (the
  // pre-seeding behavior) instead of killing the nightly; THIS test is what
  // then fails loudly on the refit’s own commit.
  assert.ok(R_SRC.includes('lab priors unavailable'),
    'the lab-priors loader must fail soft with a message');
});

// SUPERSEDES 'the digit frame is rectangles-only' (his ruling 2026-08-14).
// The old rule dropped every tiling row before the shares join, because at
// fixed density the digit shares differ BY LATTICE (rhombille's 5plus share
// 4.4x the 4.8.8's, 15x the hex's) and pooled rows with nothing to separate
// them turn the digit coefficients into part-shape indicators. That confound is
// real and the reasoning above still holds; what changed is the response to it.
// A named confound gets a TERM. The exclusion cost the study almost every board
// the game now produces: half of every daily under the shape rotation, and 47
// of the first 48 Challenge boards.
test('the digit study adjusts for shape with a term, rather than excluding shapes', () => {
  const frame = R_SRC.slice(R_SRC.indexOf('digit_df <- df |>'),
    R_SRC.indexOf('decor_df <- digit_df'));
  assert.ok(frame.length > 100, 'the digit frame was not found');
  assert.ok(!frame.includes('filter(is.na(tilingType))'),
    'the study frame must no longer drop tiling rows');
  assert.ok(!/filter\(!is_match\)/.test(frame),
    'nor Challenge rows, which are most of the tiling boards that exist');

  // The term that makes admitting them sound. Without the interactions this is
  // just pooling, which is what the old exclusion was right to refuse.
  const fitBlock = R_SRC.slice(R_SRC.indexOf('digit_shape_cols <- c('),
    R_SRC.indexOf('digit_fit <- brm('));
  assert.ok(fitBlock.length > 100, 'the digit fit block was not found');
  assert.ok(/outer\(SHAPE_PREDICTORS,\s*DIGIT_FEATURES/.test(R_SRC),
    'one shape-by-digit interaction per shape and digit must be built');
  assert.ok(fitBlock.includes('deviation_names = digit_dev_cols'),
    'the shape terms must reach build_priors as DEVIATIONS');

  // The lb=0 trap, the same one that collapsed the main fit into divergences
  // when the bound was removed (2026-08-01). A shape effect is SIGNED, so it
  // belongs in the dev nlpar; bounded, its posterior piles at zero and the
  // difference leaks into the digit coefficients this study exists to measure.
  assert.ok(/dev ~ 0 \+/.test(fitBlock) && /nl = TRUE/.test(fitBlock),
    'signed shape terms must ride the dev nlpar, never the bounded base block');
});

test('the DECORRELATION frame stays rectangles-only and day-of, and is its own object', () => {
  // The half of the old rule that survives, and the half that actually needed
  // an exclusion: this machinery takes exactly TWO features, so it has no way
  // to hold shape still the way the fit above does. It also selects tomorrow's
  // DAILY board, which a Challenge row is not evidence about.
  const decor = R_SRC.slice(R_SRC.indexOf('decor_df <- digit_df'));
  assert.ok(decor.length > 100, 'the decorrelation frame was not found');
  assert.match(decor.slice(0, 200), /filter\(is\.na\(tilingType\), matchPlay == 0\)/,
    'decor_df must keep both exclusions');
  // And the mission must actually be fed the narrow frame. Passing digit_df
  // here would reintroduce every row the narrowing exists to keep out, with
  // nothing failing loudly.
  assert.match(R_SRC, /choose_decorrelation_mission\(\s*(?:#[^\n]*\n\s*)*decor_df,/,
    'the decorrelation mission must be fitted from decor_df, not the study frame');
});
