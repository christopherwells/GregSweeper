// Per-date daily key pruning. These keys (par / moves / features per
// played date) accumulate forever without a sweep — a daily-habit player
// banks ~1 MB/year of feature JSON, and the eventual quota failure
// silently downgrades storage to the in-memory fallback.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { safeSet, safeGet, safeKeys } = await import('../src/storage/storageAdapter.js');
const { pruneOldDailyKeys } = await import('../src/storage/statsStorage.js');
const { getLocalDateString } = await import('../src/logic/seededRandom.js');

function dateNDaysAgo(n) {
  const today = getLocalDateString();
  const [y, m, d] = today.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) - n * 24 * 3600 * 1000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

test('pruneOldDailyKeys removes per-date keys older than the window, keeps recent + non-date keys', () => {
  const oldDate = dateNDaysAgo(90);
  const recentDate = dateNDaysAgo(5);
  for (const prefix of ['minesweeper_daily_par_', 'minesweeper_daily_moves_', 'minesweeper_daily_features_']) {
    safeSet(prefix + oldDate, 'old');
    safeSet(prefix + recentDate, 'recent');
  }
  // A non-date suffix must survive (unknown shape — never guess-delete).
  safeSet('minesweeper_daily_par_weird-key', 'keep');

  const removed = pruneOldDailyKeys(60);

  assert.equal(removed, 3, `expected 3 removals, got ${removed}`);
  assert.equal(safeGet('minesweeper_daily_par_' + oldDate), null);
  assert.equal(safeGet('minesweeper_daily_features_' + oldDate), null);
  assert.equal(safeGet('minesweeper_daily_par_' + recentDate), 'recent');
  assert.equal(safeGet('minesweeper_daily_par_weird-key'), 'keep');
});

test('safeKeys enumerates by prefix on the active backend', () => {
  safeSet('gs_test_enum_a', '1');
  safeSet('gs_test_enum_b', '2');
  safeSet('gs_other_key', '3');
  const keys = safeKeys('gs_test_enum_');
  assert.deepEqual(keys.sort(), ['gs_test_enum_a', 'gs_test_enum_b']);
});
