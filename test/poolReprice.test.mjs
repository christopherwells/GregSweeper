// The nightly pool RE-PRICE — the contract that lets a refit relabel the
// challenge ladder without regenerating a single board.
//
// WHAT IT RESTS ON. Measuring a spec (generate, certify, check strict
// load-bearing, time it) is model-INDEPENDENT; only its price is not. So
// scripts/data/pool-features.json stores the feature vector of the draw that
// set each entry's median par, and `predictPar` re-answers instantly under new
// coefficients. That claim has three failure modes worth a test:
//
//   1. the store drifts out of step with the pool it describes, so a re-price
//      silently prices the wrong boards, or skips entries;
//   2. the re-price is not faithful — re-pricing under TODAY's model does not
//      reproduce today's shipped prices, which would mean tonight's refit
//      moves every number for no reason;
//   3. the guards do not fire, so a pool that has left the rulings ships
//      anyway. That is the one that matters most: the whole point of running
//      this nightly is that nothing else is watching.
//
// The third is why several cases below construct a BROKEN pool deliberately.
// A guard nobody has watched fail is a guard nobody knows works.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LADDER_POOL, ENDLESS_POOL, CHALLENGE_POOL } from '../src/logic/challengePool.js';
import { predictPar, applyParModel } from '../src/logic/dailyFeatures.js';
import { PAR_MODEL } from '../src/logic/difficulty.js';
import {
  specFace, PAR_CEILING_SECONDS, endlessParCeiling, endlessPpcFloor,
  GEN_CAP_MS, ENDLESS_GEN_HEADROOM,
} from '../src/logic/challengeRules.js';
import { challengeSpecForLevel, CHALLENGE_MAX_LEVEL } from '../src/logic/challenge250.js';
import { referenceScale } from '../scripts/ladder-reference-cohort.mjs';
import { modelFingerprint } from '../src/logic/parModelFingerprint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(__dirname, '..', 'scripts', 'data', 'pool-features.json');
const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
// Every pool the file ships. The re-price writer asserts it patched all of
// them, so a pool missing from this list is one the nightly stops maintaining.
const shipped = [...LADDER_POOL, ...ENDLESS_POOL, ...CHALLENGE_POOL];

// The ladder-seconds scale, taken from the same place the pricing takes it.
// An EARLIER version inferred it by dividing a shipped price by a predicted
// one, which cannot work: the shipped price is rounded to two decimals, so the
// inferred scale carried up to half a percent of error and the faithfulness
// check below failed on it rather than on anything real.
const scale = referenceScale();

// ── 1. The store describes the pool that ships ─────────────────────────

test('every shipped pool entry has a captured feature vector', () => {
  // A shipped entry with no stored features cannot be re-priced, and a pool
  // where some entries moved and others did not is worse than one that did not
  // move at all — which is why the script treats this as fatal rather than a
  // warning. Regenerate with `--capture` whenever the pool composition changes.
  const missing = shipped.filter((e) => !store.entries[specFace(e)]).map(specFace);
  assert.deepEqual(missing, [], `${missing.length} entries have no captured features`);
});

test('the store carries nothing the pool no longer ships', () => {
  // Stale entries are harmless to a re-price but they mean the store was not
  // regenerated with the pool, and the next thing that reads it will be
  // reasoning about boards nobody can play.
  const live = new Set(shipped.map(specFace));
  const stale = Object.keys(store.entries).filter((f) => !live.has(f));
  assert.deepEqual(stale, [], `${stale.length} stored entries are not in the pool`);
});

test('a stored feature vector is a real one predictPar can price', () => {
  for (const [face, rec] of Object.entries(store.entries)) {
    assert.ok(rec.features && typeof rec.features === 'object', `${face} has no features`);
    const par = predictPar(rec.features);
    assert.ok(Number.isFinite(par) && par > 0, `${face} prices to ${par}`);
    assert.equal(rec.features.cellCount, rec.cells,
      `${face} stored a vector for a board of a different size`);
  }
});

// ── 2. The re-price is faithful ────────────────────────────────────────

test('re-pricing under TODAY\'s model reproduces the shipped prices', () => {
  // The idempotence check. If this fails, tonight's refit will move every
  // price in the pool without the model having moved, and the ladder will
  // reshuffle for no reason.
  //
  // Exact rather than approximate, and that is a property of the CAPTURE: par
  // is exp() of the linear predictor and so monotone in it, which makes the
  // median-par draw the median-linear-predictor draw. Re-pricing that one
  // board reproduces the median par under ANY coefficients. Storing an
  // averaged feature vector instead would describe a board that was never
  // generated and would only ever be approximately right.
  // CONDITIONAL, for a reason that bit within hours of this landing. A PR's
  // checks run against the branch MERGED INTO MAIN, the refit lands nightly at
  // 00:17 UTC, and a branch cut before that is therefore priced by newer
  // coefficients than its pool was captured under. That is not a defect — it
  // is a branch wanting a re-price before it merges, a different message and a
  // different remedy — so the store records WHICH model it was captured with
  // and this asks the question that is actually decidable. What must hold
  // either way is the ruling check below.
  if (store.model !== modelFingerprint()) return;

  for (const e of shipped) {
    const rec = store.entries[specFace(e)];
    const ppc = (predictPar(rec.features) * scale) / e.cells;
    assert.ok(Math.abs(ppc / rec.ppc - 1) < 1e-6,
      `${specFace(e)}: re-prices to ${ppc.toFixed(4)}, stored as ${rec.ppc.toFixed(4)}`);
  }
});

test('the store records which model it was captured under', () => {
  // Without it, "the prices disagree with the model" cannot be told apart from
  // "the prices are older than the model", and those want opposite responses.
  assert.match(store.model || '', /^[0-9a-f]{8}$/,
    'the feature store carries no model fingerprint — re-capture it');
});

test('a pool priced under an older model still respects every ruling', () => {
  // The half that must hold WHETHER OR NOT the pool is fresh. A branch may
  // legitimately carry yesterday's prices; it may never carry prices that
  // break a ceiling or a floor under TODAY's model, because that is what would
  // ship if it merged before the nightly re-price ran.
  const entries = [
    ...LADDER_POOL.map((e) => ({ e, pool: 'ladder' })),
    ...ENDLESS_POOL.map((e) => ({ e, pool: 'endless' })),
    ...CHALLENGE_POOL.map((e) => ({ e, pool: 'challenge' })),
  ].map(({ e, pool }) => {
    const rec = store.entries[specFace(e)];
    const ppc = (predictPar(rec.features) * scale) / e.cells;
    return { e: { ...e, ppc }, pool };
  });
  const found = violations(entries);
  assert.deepEqual(found, [],
    `${found.length} entries would break a ruling once re-priced — run `
    + 'node scripts/reprice-challenge-pool.mjs --check');
});

test('the re-price is NOT vacuous: a moved coefficient moves every price', () => {
  // Everything above compares a number to itself unless re-pricing can be
  // shown to RESPOND to the model. So this runs the stored vectors through a
  // deliberately perturbed model — the same thing a refit does — and requires
  // the prices to move, in the direction the perturbation implies.
  //
  // An earlier version of this test perturbed nothing: it multiplied by
  // `Math.exp(0.05 * cellCount / cellCount)`, which is a constant, so the
  // assertion held no matter what predictPar did. A non-vacuity check that is
  // itself vacuous is worse than none, because it reads as coverage.
  const dearer = { ...PAR_MODEL, intercept: PAR_MODEL.intercept + Math.log(1.2) };
  // Coefficients sit TOP-LEVEL on the model object, not under a
  // `coefficients` key — applyParModel reads `model[coef]` directly.
  //
  // The cheaper perturbation halves the MINE RATE, not the size elasticity:
  // secPerLogCell is the one term the whole size question rides on and it
  // stays on the SIGNED dev nlpar, so its sign is not guaranteed and halving
  // it could raise prices, inverting the direction assertion. secPerMineRate
  // rides the lognormal-bounded base block, whose lb = 0 blanket keeps it
  // structurally non-negative, and every stored board has mines, so halving
  // it lowers every price by construction.
  const cheaper = { ...PAR_MODEL, secPerMineRate: PAR_MODEL.secPerMineRate * 0.5 };

  let rose = 0, fell = 0;
  for (const e of shipped.slice(0, 60)) {
    const f = store.entries[specFace(e)].features;
    const base = applyParModel(f, PAR_MODEL);
    assert.ok(applyParModel(f, dearer) > base * 1.15, `${specFace(e)} ignored a 20% intercept move`);
    if (applyParModel(f, cheaper) < base) fell++;
    if (applyParModel(f, dearer) > base) rose++;
  }
  assert.equal(rose, 60, 'a dearer model did not raise every price');
  assert.ok(fell >= 55, `halving the per-cell rate lowered only ${fell} of 60 prices`);

  // And two different boards must price differently, or the store could be
  // handing back one constant vector under many names.
  const prices = new Set(shipped.slice(0, 60)
    .map((e) => predictPar(store.entries[specFace(e)].features).toFixed(4)));
  assert.ok(prices.size > 30,
    'the stored vectors price to too few distinct values to be describing distinct boards');
});

// ── 3. The guards fire ─────────────────────────────────────────────────

/** The guard the script runs, lifted so a broken pool can be constructed. */
function violations(entries) {
  const out = [];
  for (const { e, pool } of entries) {
    const par = e.ppc * e.cells;
    const ceiling = pool === 'endless' ? endlessParCeiling(e.shape) : PAR_CEILING_SECONDS;
    if (par > ceiling) out.push(`${specFace(e)} prices ${par.toFixed(0)}s against ${ceiling}s`);
    if (pool === 'endless' && e.ppc < endlessPpcFloor(e.shape)) {
      out.push(`${specFace(e)} is under the ${endlessPpcFloor(e.shape)} endless floor`);
    }
  }
  return out;
}

test('the shipped pool passes its own guards', () => {
  const all = [
    ...LADDER_POOL.map((e) => ({ e, pool: 'ladder' })),
    ...ENDLESS_POOL.map((e) => ({ e, pool: 'endless' })),
    ...CHALLENGE_POOL.map((e) => ({ e, pool: 'challenge' })),
  ];
  assert.deepEqual(violations(all), []);
});

test('REGRESSION: the par-ceiling guard fires on an over-priced entry', () => {
  // This is the case that actually happened. One entry carried a price from a
  // low-seed pass and really cost 550s against the ladder's 480s ceiling; the
  // guard caught it on the first real run, and the pool was rebuilt rather
  // than the entry waved through.
  const e = { ...LADDER_POOL[0], ppc: (PAR_CEILING_SECONDS / LADDER_POOL[0].cells) * 1.2 };
  const found = violations([{ e, pool: 'ladder' }]);
  assert.equal(found.length, 1, 'an over-ceiling ladder entry was not caught');
  assert.match(found[0], /against 480s/);
});

test('REGRESSION: the endless floor guard fires on an under-priced entry', () => {
  const base = ENDLESS_POOL[0];
  const e = { ...base, ppc: endlessPpcFloor(base.shape) * 0.5 };
  const found = violations([{ e, pool: 'endless' }]);
  assert.equal(found.length, 1, 'an under-floor endless entry was not caught');
  assert.match(found[0], /endless floor/);
});

test('the per-shape ceilings and floors are respected, not the shared ones', () => {
  // A guard that used the shared numbers everywhere would reject Classic and
  // Paving Stones (720s ceilings) wholesale — his per-shape rulings exist
  // precisely so those shapes can be in the zone. The floor ordering is a
  // MEASURED FACT (p90/1.03 of current-model cache prices), so it re-pins
  // whenever the floors re-measure: as of the 2026-08-17 correction fit,
  // rhombille (2.05) prices dearer per cell than hex (1.3) — the old model
  // had them the other way around.
  assert.ok(endlessParCeiling('rect') > endlessParCeiling('hex'));
  assert.ok(endlessPpcFloor('rhombille') > endlessPpcFloor('hex'));
  for (const e of ENDLESS_POOL) {
    assert.ok(e.ppc >= endlessPpcFloor(e.shape),
      `${specFace(e)} sits under its own shape's floor`);
  }
});

// ── The generation-time headroom, which the guards do NOT cover ────────

test('the generation headroom is wide enough for a heavy tail', () => {
  // Generation time is model-independent, so a re-price can never fix it and
  // no guard above looks at it. It earns a test because it was the thing that
  // kept the emit/validate loop from converging: entries admitted at
  // ~1000-1500ms measured 2207ms and 2327ms on the validator's own seeds, and
  // removing them one at a time surfaced a fresh one every round. The headroom
  // was widened from 75% to 35% of the cap to cover roughly 3x that tail.
  assert.ok(ENDLESS_GEN_HEADROOM <= 0.4,
    'the admission budget is back above the measured 2.3x generation-time tail');
  assert.ok(GEN_CAP_MS * ENDLESS_GEN_HEADROOM >= 500,
    'the budget is so tight it would starve the pool');
});

// ── The ladder is stable under a no-op re-price ────────────────────────

test('a no-op re-price leaves all 250 level assignments untouched', () => {
  // The assignment is computed from the pool's prices at module load, so a
  // re-price that changes no price must change no level. This is what makes
  // the nightly job safe to run unattended: it can only move the ladder as far
  // as the model genuinely moved.
  const before = Array.from({ length: CHALLENGE_MAX_LEVEL },
    (_, i) => specFace(challengeSpecForLevel(i + 1)));
  const again = Array.from({ length: CHALLENGE_MAX_LEVEL },
    (_, i) => specFace(challengeSpecForLevel(i + 1)));
  assert.deepEqual(again, before);
  assert.equal(new Set(before).size, CHALLENGE_MAX_LEVEL, 'the ladder repeats a board');
});

// ── The workflow actually runs it ──────────────────────────────────────

test('the nightly refit re-prices the pool and commits it', () => {
  // A re-price nothing runs is worse than none, because the pool then looks
  // maintained. Source-scanned rather than executed: the workflow is the only
  // place this is wired, and a rename or a dropped step is exactly the silent
  // failure this guards.
  const wf = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'refit-par-model.yml'), 'utf8');
  assert.match(wf, /node scripts\/reprice-challenge-pool\.mjs/,
    'the refit no longer re-prices the pool');
  assert.match(wf, /git add [^\n]*src\/logic\/challengePool\.js/,
    'the refit re-prices the pool but never commits it');
  assert.ok(wf.indexOf('setup-node') < wf.indexOf('reprice-challenge-pool'),
    'the re-price step has no node runtime before it');
  assert.ok(wf.indexOf('reprice-challenge-pool') < wf.indexOf('Commit and push'),
    'the re-price runs after the commit step, so its result is never committed');
  // The dirty-check gates the commit; if challengePool is not in it, a run
  // where only prices moved would report "nothing to commit" and throw the
  // re-price away.
  assert.match(wf, /git diff --quiet [^\n]*src\/logic\/challengePool\.js/,
    'a price-only change would be seen as nothing to commit');
});

test('a failed re-price does not cost the night its model fit', () => {
  // The re-price can legitimately fail: a boundary violation means the pool
  // needs a re-SEARCH, which is a human's call. But the same run also fits
  // par, the handicaps and the experiment target, and the next night's board
  // precompute reads all three — losing them because two ladder entries
  // crossed a ceiling is the wrong trade. So the step is allowed to fail, the
  // commit still happens, and the run is failed AFTERWARDS with the remedy
  // named. Without the continue-on-error the whole night is lost to a ladder
  // problem, which is the failure this pins.
  const wf = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'refit-par-model.yml'), 'utf8');
  assert.match(wf, /id: reprice\s+continue-on-error: true/,
    'a failed re-price would abort the workflow before the model is committed');
  assert.match(wf, /steps\.reprice\.outcome == 'failure'/,
    'nothing checks the re-price outcome, so a failure would pass silently');
  assert.ok(wf.indexOf('steps.reprice.outcome') > wf.indexOf('Commit and push'),
    'the failure check runs before the commit, which is what it exists to protect');
});

// ── The search cache follows the model too ─────────────────────────────

test('the search cache stores what it needs to be re-priced', () => {
  // The pool got feature storage first and the CACHE did not, which meant a
  // re-search after a refit selected — and applied its ceilings and floors —
  // on yesterday's prices. It went wrong once, on 2026-08-09, and was worked
  // around by hand.
  //
  // SOURCE-SCANNED, and honestly so: the cache is gitignored (~4 MB of local,
  // resumable state), so CI has no cache file to inspect and there is nothing
  // to assert against but the code that writes it. That is enough to catch the
  // failure this guards — someone editing `record` or `measure` and dropping
  // the features again — which is the only way it comes back.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'search-endless-specs.mjs'), 'utf8');

  assert.match(src, /features: r\.medFeatures/,
    'the cache no longer stores the median draw\'s features, so it cannot be re-priced');
  assert.match(src, /model: MODEL/,
    'the cache no longer records which equations priced it, so stale and fresh are indistinguishable');
  assert.match(src, /const MODEL = modelFingerprint\(\)/,
    'the fingerprint is not read, so `model:` is recording something else');

  // The median DRAW, not an average of draws. Par is monotone in the linear
  // predictor, so only the median draw's own vector re-prices exactly.
  assert.match(src, /draws\[Math\.floor\(draws\.length \/ 2\)\]\.features/,
    'the stored vector is no longer the median draw\'s, so re-pricing is only approximate');

  assert.match(src, /--reprice-cache/, 'the re-price mode is gone');
  assert.match(src, /e\.model !== MODEL/,
    'the emit no longer notices that it is choosing from stale prices');
});

test('REGRESSION: the search acceptance carries the Climb deduction floor (issue #286)', () => {
  // The braid stamps minDeductions on every level it assigns, and the pool
  // search never did, so it admitted faces whose certified boards are too
  // short a quarter of the time or worse: the validator refused draws on 16
  // assigned braid levels (2026-08-12; four of them were issue #286's own).
  // The fix has two halves and each can regress alone. Measurement: every
  // spec the search builds must carry the floor, or a face that cannot hold
  // five decisions earns an ok verdict again. Emission: entries measured
  // BEFORE the floor keep pre-floor verdicts in the resumable cache, so the
  // emitters must consult clearsDeductionFloor or a stale cache re-admits
  // the same class on the next re-emit.
  //
  // Source-scanned for the same reason the cache test above is: the cache is
  // gitignored local state and real generation cannot run in CI (the
  // validator owns that proof, by hand). This pins the code that enforces
  // the acceptance, which is the only way the defect comes back.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'search-endless-specs.mjs'), 'utf8');

  assert.match(src, /base\.minDeductions = CLIMB_MIN_DEDUCTIONS/,
    'makeSpec no longer stamps the floor, so the pool is measured under a different acceptance than the ladder applies');
  assert.match(src, /floor: CLIMB_MIN_DEDUCTIONS/,
    'the cache no longer records which acceptance a verdict was measured under');
  const emits = [...src.matchAll(/\.filter\(clearsDeductionFloor\)/g)];
  assert.ok(emits.length >= 2,
    'the emitters no longer screen pre-floor cache entries (emitPool and admissible must both consult clearsDeductionFloor)');
});

test('the refit cron stays ahead of the precompute it feeds', () => {
  // The whole point of the refit's schedule is that a night's board is
  // generated under the model fit that same night. MEASURED, and this is why
  // the cron moved twice: GitHub queued the 00:17 slot by a consistent ~2h10m,
  // which left about 25 minutes before the 03:00 precompute instead of the
  // 2h43m the move was made for.
  const refit = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'refit-par-model.yml'), 'utf8');
  const pre = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'precompute-daily-board.yml'), 'utf8');

  const at = (src) => {
    const m = /cron: '(\d+) (\d+) \* \* \*'/.exec(src);
    assert.ok(m, 'no daily cron found');
    return Number(m[2]) * 60 + Number(m[1]);
  };
  const refitAt = at(refit);
  const preAt = at(pre);

  // Minutes from the refit's slot forward to the precompute's, wrapping the
  // day — the refit fires the previous evening, so a plain subtraction is
  // negative and means nothing.
  const lead = ((preAt - refitAt) + 1440) % 1440;
  assert.ok(lead >= 180,
    `the refit fires only ${lead} minutes before the precompute; GitHub's queue `
    + 'has measured ~130 minutes, which would leave almost no margin');
  assert.ok(lead <= 720,
    `the refit fires ${lead} minutes before the precompute, far enough ahead that `
    + 'it is fitting on materially older play than it needs to');
});
