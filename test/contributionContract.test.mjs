// JS ↔ R ↔ backfill lockstep for the contribution study (2026-07-30).
//
// The feature names exist in three places that cannot import each other: the
// JS producer (boardSolver.CONTRIBUTION_FEATURE_KEYS + the locked split in
// computeDailyFeatures), the R refit's CONTRIB_FEATURES vector, and the
// committed backfill file's row shape. A rename or addition on one side would
// otherwise fail SILENTLY: R's coalesce would read NA, the filter would drop
// every row, and the study would report "inactive" forever while looking
// wired (the wormholeCellCount/mirrorCellCount lesson from issue #180 —
// dead names match nothing and no alarm fires).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { CONTRIBUTION_FEATURE_KEYS } from '../src/logic/boardSolver.js';

const R_SRC = readFileSync(new URL('../scripts/refit-par-model.R', import.meta.url), 'utf8');
const ALL_STUDY_KEYS = [...CONTRIBUTION_FEATURE_KEYS, 'lockedMineCount', 'lockedNumberCount'];

test('every JS contribution key is named in the R CONTRIB_FEATURES vector', () => {
  const block = R_SRC.match(/CONTRIB_FEATURES <- c\(([\s\S]*?)\)/);
  assert.ok(block, 'CONTRIB_FEATURES vector must exist in refit-par-model.R');
  for (const key of ALL_STUDY_KEYS) {
    assert.ok(block[1].includes(`"${key}"`),
      `R's CONTRIB_FEATURES must name "${key}" — a missing name reads NA and silently drops every row`);
  }
  // And nothing extra: an R-only name coalesces from a column that never
  // exists, which poisons the NA-filter the same way.
  const rNames = [...block[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(rNames.sort(), [...ALL_STUDY_KEYS].sort(),
    'R and JS must agree on the exact key set');
});

test('the R join reads the same backfill path the Node script writes', () => {
  const bf = readFileSync(new URL('../scripts/backfill-gimmick-contribution.mjs', import.meta.url), 'utf8');
  assert.match(bf, /join\(__dirname,\s*'data',\s*'gimmick-contribution\.json'\)/,
    'backfill must write scripts/data/gimmick-contribution.json');
  assert.ok(R_SRC.includes('"scripts/data/gimmick-contribution.json"'),
    'R must read the same path');
});

test('the committed backfill file exists and carries every study key', () => {
  const path = new URL('../scripts/data/gimmick-contribution.json', import.meta.url);
  assert.ok(existsSync(path), 'scripts/data/gimmick-contribution.json must be committed');
  const data = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(Array.isArray(data.rows) && data.rows.length > 50,
    `backfill must cover the canonical era (got ${data.rows?.length ?? 0} rows)`);
  const row = data.rows[0];
  for (const key of ALL_STUDY_KEYS) {
    assert.ok(key in row, `backfill rows must carry "${key}"`);
  }
  // Weekly boards are in scope — they are the modifier-dense rows.
  assert.ok(data.rows.some((r) => r.date.endsWith('_weekly_first')),
    'backfill must include the weekly-first join keys');
});

test('contribution keys never leak into PAR_MODEL or the candidate scorer', () => {
  const difficulty = readFileSync(new URL('../src/logic/difficulty.js', import.meta.url), 'utf8');
  const scorer = readFileSync(new URL('../src/logic/selectDailyRngSeed.js', import.meta.url), 'utf8');
  for (const key of ALL_STUDY_KEYS) {
    assert.ok(!difficulty.includes(key),
      `${key} must not appear in difficulty.js — instrument-first, never a shipped term until it earns out`);
    assert.ok(!scorer.includes(key),
      `${key} must not appear in the candidate scorer — no mission maximizes a contribution feature`);
  }
  // And R must never merge them into target_candidates (they are not
  // force-injectable, so a mission targeting one could never win a day).
  assert.ok(!/target_candidates <- rbind\(target_candidates,\s*contribution_candidates\)/.test(R_SRC),
    'contribution posteriors must not enter target_candidates');
});
