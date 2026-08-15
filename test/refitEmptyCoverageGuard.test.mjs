// The refit's empty-coverage guard, pinned by source scan, and the smoke
// workflow's couplings, pinned by lockstep.
//
// REGRESSION: on 2026-08-14 the nightly refit crashed the moment its
// coverage question was fully answered. The match-library top-up had taken
// every modifier past the 20-board saturation line together, the throttle
// filtered coverage_targets to an empty list for the first time ever, and
// `order(-sapply(...))` halted: sapply over an empty list returns list(),
// and unary minus on a list is an error. The fix (c8d456a3) reads both
// coverage sorts through vapply with an explicit numeric(1), which returns
// numeric(0) on empty where sapply returns a list.
//
// WHY A SOURCE SCAN and not a data fixture: full saturation is a TRANSIENT
// state. Measured 2026-08-15 over the whole canonical era, wormLoad sits at
// 18 nonzero fit dates, under the line, so the committed refit fixture
// cannot promise an empty list and a pin that rode the data would silently
// stop covering the incident as counts drift. The text does not age.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const R = readFileSync(new URL('../scripts/refit-par-model.R', import.meta.url), 'utf8');
const SMOKE = readFileSync(new URL('../.github/workflows/pipeline-smoke.yml', import.meta.url), 'utf8');
const REFIT = readFileSync(new URL('../.github/workflows/refit-par-model.yml', import.meta.url), 'utf8');

test('REGRESSION: both coverage sorts read through vapply, never sapply', () => {
  const vapplySorts = R.match(/order\(\s*\n?\s*-vapply\(/g) || [];
  assert.ok(vapplySorts.length >= 2,
    `expected both coverage_targets and shape_coverage to sort via order(-vapply(...)); found ${vapplySorts.length}`);
  assert.doesNotMatch(R, /order\(\s*-sapply\(/,
    'a coverage sort reads through sapply again; on an empty list that is the 2026-08-14 crash verbatim');
  // Both sorts must also be length-guarded: sorting nothing is a success
  // state, never an error, and the guard is what makes it one.
  assert.match(R, /length\(coverage_targets\) > 0/,
    'the coverage_targets sort lost its empty-list guard');
  assert.match(R, /length\(shape_coverage\) > 0/,
    'the shape_coverage sort lost its empty-list guard');
});

test('the smoke workflow runs the R script in smoke mode over the committed fixture', () => {
  assert.match(SMOKE, /REFIT_SMOKE: '1'/);
  assert.match(SMOKE, /REFIT_DB_URL: 'test\/fixtures\/refit-db'/);
  assert.match(SMOKE, /Rscript scripts\/refit-par-model\.R/);
  assert.match(SMOKE, /scripts\/refit-par-model\.R/, 'the path filter must include the R script');
  // The seams the smoke depends on must exist in the R script itself.
  assert.match(R, /REFIT_SMOKE/, 'the R script lost its smoke seam');
  assert.match(R, /Sys\.getenv\("REFIT_DB_URL"/, 'the R script lost its fixture-database seam');
});

test('LOCKSTEP: the smoke restores the refit workflow\'s own R package cache', () => {
  // The smoke stays fast by restoring the nightly's warm cache; two keys
  // drifting apart means the smoke silently rebuilds packages every run
  // until somebody deletes it for being slow. Bump BOTH or neither.
  const keyOf = (yml, label) => {
    const m = yml.match(/key:\s*(r-pkgs-\S+)/);
    assert.ok(m, `${label} has no R package cache key`);
    return m[1];
  };
  assert.equal(keyOf(SMOKE, 'pipeline-smoke.yml'), keyOf(REFIT, 'refit-par-model.yml'),
    'the two workflows cache R packages under different keys; bump both together');
});
