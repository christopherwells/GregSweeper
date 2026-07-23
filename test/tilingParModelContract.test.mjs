// The refit contract for the board-shape terms (Project Coastline).
//
// PAR_MODEL lives between markers that the nightly R refit OVERWRITES in full
// from a hardcoded sprintf template. So a coefficient added to difficulty.js
// but not to that template survives exactly until 14:00 UTC and then silently
// vanishes — the block still parses, predictPar still runs, and the term is
// just gone. These tests are the tripwire for that, and for the corresponding
// R-side plumbing a shape offset needs in order to ever be fit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PAR_MODEL, PAR_MODEL_TIMED } from '../src/logic/difficulty.js';

const R_SRC = readFileSync(new URL('../scripts/refit-par-model.R', import.meta.url), 'utf8');
const JS_SRC = readFileSync(new URL('../src/logic/difficulty.js', import.meta.url), 'utf8');

const SHAPE_COEFS = ['secPerShape488', 'secPerShapeHex'];
const SHAPE_PREDICTORS = ['shape488', 'shapeHex'];

test('both models ship the shape coefficients, at zero until data earns them', () => {
  for (const coef of SHAPE_COEFS) {
    assert.equal(typeof PAR_MODEL[coef], 'number', `PAR_MODEL.${coef} missing`);
    assert.equal(typeof PAR_MODEL_TIMED[coef], 'number', `PAR_MODEL_TIMED.${coef} missing`);
    // Not a permanent assertion about the value — it is the instrument-first
    // contract. If a refit ever ships a NON-zero shape coefficient this test
    // should be updated deliberately, having looked at the fit that earned it.
    assert.equal(PAR_MODEL[coef], 0,
      `${coef} is non-zero — a tiling fit has landed; confirm it earned out before relaxing this`);
  }
});

test('REGRESSION: the R refit EMITS the shape coefficients (else the nightly wipes them)', () => {
  // Both marker blocks are rewritten wholesale, so both templates need them.
  for (const coef of SHAPE_COEFS) {
    assert.ok(R_SRC.includes(`${coef}:`),
      `the R sprintf template must contain a ${coef}: line or the refit drops it`);
    assert.ok(R_SRC.includes(`new_coefs$${coef}`),
      `the R template args must pass new_coefs$${coef}`);
    assert.ok(R_SRC.includes(`timed_coefs$${coef}`),
      `the timed template args must pass timed_coefs$${coef}`);
  }

  // The count of %.5f slots must match the count of supplied args, which is
  // the actual failure mode of a hand-maintained sprintf: a missed arg shifts
  // EVERY subsequent coefficient by one position, silently.
  for (const [startMarker, argPrefix] of [['export const PAR_MODEL = {', 'new_coefs$'],
    ['export const PAR_MODEL_TIMED = {', 'timed_coefs$']]) {
    const start = R_SRC.indexOf(startMarker);
    assert.ok(start > 0, `R template for ${startMarker} not found`);
    const end = R_SRC.indexOf('\n)', start);
    const chunk = R_SRC.slice(start, end);
    // The intercept is %.4f and every coefficient is %.5f; the remaining
    // slots (%s / %d in the header comment) are fed by non-coefficient args
    // and are correctly excluded from BOTH sides of this count.
    const slots = (chunk.match(/%\.[45]f/g) || []).length;
    // `$` is a regex metacharacter and the prefix ends in one, so escape it.
    const args = (chunk.match(new RegExp(argPrefix.replace('$', '\\$'), 'g')) || []).length;
    assert.equal(slots, args,
      `${startMarker}: ${slots} numeric slots but ${args} ${argPrefix} args — the emitted coefficients would shift`);
  }
});

test('R derives the shape indicators from tilingType and gates them on real rows', () => {
  // Derivation: computeDailyFeatures emits `tilingType` only on a tiling, so R
  // must expand it into the 0/1 columns rather than expect them pre-split.
  assert.ok(R_SRC.includes('tilingType'), 'R must read the stored tilingType feature');
  for (const p of SHAPE_PREDICTORS) {
    assert.ok(R_SRC.includes(`df$${p}`), `R must derive the ${p} indicator column`);
    // Zero-variance gate: the term enters the formula only once that shape has
    // rows, the same guard archivePlay and wormLoad use. Without it brms is
    // handed an all-zero column and rejects the fit.
    assert.ok(new RegExp(`add_${p}_term\\s*<-`).test(R_SRC),
      `R must gate the ${p} term on that shape actually having rows`);
  }
  // Priors: build_priors stop()s on a missing sigma, so an ungated name would
  // abort the whole nightly refit rather than degrade.
  for (const p of SHAPE_PREDICTORS) {
    assert.ok(new RegExp(`${p}\\s*=`).test(R_SRC), `PRIOR_SIGMAS/PRIOR_MEANS need a ${p} entry`);
  }
});

test('the shipped shape coefficient sits behind the new-feature zero-guard', () => {
  const guard = R_SRC.slice(R_SRC.indexOf('feature_data_counts <- list('));
  for (const coef of SHAPE_COEFS) {
    assert.ok(guard.slice(0, 1200).includes(coef),
      `${coef} must be in feature_data_counts so it ships as 0 below NEW_FEATURE_DATA_THRESHOLD`);
  }
});

test('apply_par_model mirrors predictPar, including the shape terms', () => {
  // The R-side predictor is used for the outlier screen and the residual
  // handicap fallback. If it drifts from predictPar, rows get screened against
  // a par the client never quoted.
  const fn = R_SRC.slice(R_SRC.indexOf('apply_par_model <- function('),
    R_SRC.indexOf('# Detect whether a parsed PAR_MODEL block'));
  for (const coef of SHAPE_COEFS) {
    assert.ok(fn.includes(coef), `apply_par_model must include ${coef}`);
  }
  // with(df, ...) errors on an absent column, and this function runs against
  // frames that legitimately have no tiling rows, so the columns must be
  // defaulted inside the function rather than assumed from the caller.
  for (const p of SHAPE_PREDICTORS) {
    assert.ok(fn.includes(`"${p}"`),
      `apply_par_model must default the ${p} column (with(df,...) throws on a missing name)`);
  }
});

test('the shape coefficients live INSIDE the refit-owned markers', () => {
  // Anchor on the full comment marker: bare 'PAR_MODEL:START' also matches the
  // prose above the block ("The block between PAR_MODEL:START and ...") and is
  // a substring of 'TIMED_PAR_MODEL:START', so either would slice the wrong
  // region and pass or fail for the wrong reason.
  const start = JS_SRC.indexOf('// PAR_MODEL:START');
  const end = JS_SRC.indexOf('// PAR_MODEL:END');
  assert.ok(start > 0 && end > start, 'daily PAR_MODEL markers not found');
  const block = JS_SRC.slice(start, end);
  assert.ok(!block.includes('PAR_MODEL_TIMED'), 'sliced the wrong block — timed leaked in');
  for (const coef of SHAPE_COEFS) {
    assert.ok(block.includes(coef),
      `${coef} must sit inside the markers, or the refit's rewrite would delete it`);
  }
});
