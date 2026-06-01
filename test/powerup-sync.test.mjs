// Power-up cross-device sync. This ships straight to production (the sync
// is gated off on the test build via isTestEnvironment), so it can't be
// staged — these unit tests are the pre-ship safety net for the merge
// logic AND for the code/rules contract that nearly shipped broken.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const stats = await import('../src/storage/statsStorage.js');
const { applyCloudProgress } = stats;
const POWERUPS_KEY = 'minesweeper_powerups';

function reset(localPowerUps) {
  localStorage.clear();
  if (localPowerUps) localStorage.setItem(POWERUPS_KEY, JSON.stringify(localPowerUps));
  stats.invalidateStatsCache?.();
}
function readPU() {
  const raw = localStorage.getItem(POWERUPS_KEY);
  return raw ? JSON.parse(raw) : null;
}

// Feature-detect: only meaningful where applyCloudProgress actually
// handles powerUps (skips cleanly on a branch without the sync).
function syncsPowerUps() {
  reset(null);
  applyCloudProgress({ powerUps: { challenge: { shield: 1 } } }, { overwrite: true });
  return readPU() !== null;
}
const HAS = syncsPowerUps();

test('existing user with NO cloud power-ups keeps their local counts (no wipe)', { skip: !HAS }, () => {
  reset({ challenge: { revealSafe: 3, shield: 2 } });
  // Cloud progress with streak but NO powerUps field — the typical
  // existing-user load. Power-ups must NOT be touched.
  applyCloudProgress({ dailyStreak: 5, lastDailyDate: '2026-06-01' });
  assert.deepEqual(readPU(), { challenge: { revealSafe: 3, shield: 2 } });
});

test('real-time listener (overwrite) adopts cloud power-ups verbatim', { skip: !HAS }, () => {
  reset({ challenge: { revealSafe: 9, shield: 9 } });
  applyCloudProgress({ powerUps: { challenge: { revealSafe: 1, shield: 0 } } }, { overwrite: true });
  assert.deepEqual(readPU(), { challenge: { revealSafe: 1, shield: 0 } });
});

test('initial load max-merges per type (never silently loses an earned power-up)', { skip: !HAS }, () => {
  reset({ challenge: { revealSafe: 1, shield: 5, magnet: 0 } });
  // Cloud (from another device) has more revealSafe, fewer shields.
  applyCloudProgress({ powerUps: { challenge: { revealSafe: 4, shield: 2, xray: 3 } } });
  const pu = readPU();
  assert.equal(pu.challenge.revealSafe, 4, 'cloud-higher type adopted');
  assert.equal(pu.challenge.shield, 5, 'local-higher type kept');
  assert.equal(pu.challenge.magnet, 0, 'local-only type preserved');
  assert.equal(pu.challenge.xray, 3, 'cloud-only type added');
});

test('initial load with no local power-ups adopts the cloud copy', { skip: !HAS }, () => {
  reset(null);
  applyCloudProgress({ powerUps: { challenge: { lifeline: 2 } } });
  assert.deepEqual(readPU(), { challenge: { lifeline: 2 } });
});

test('malformed cloud power-ups do not throw', { skip: !HAS }, () => {
  reset({ challenge: { shield: 1 } });
  assert.doesNotThrow(() => applyCloudProgress({ powerUps: { challenge: 'oops', timed: 7 } }));
});

// ── Code↔rules contract ──────────────────────────────
// The sync nearly shipped broken because users/{uid} has a
// `$other: {.validate:false}` catch-all and `powerUps` wasn't
// whitelisted, so every write was silently rejected. Lock that in: any
// field the client writes under users/{uid} must have a matching rule.
test('firebase-rules.json whitelists powerUps under users/$uid', () => {
  const rules = JSON.parse(readFileSync(new URL('../firebase-rules.json', import.meta.url), 'utf8'));
  const u = rules.rules.users.$uid;
  // The catch-all that makes this a real contract (not just "allow all").
  assert.equal(u.$other['.validate'], false, 'expected a strict $other catch-all under users/$uid');
  // Every field the client writes to users/{uid} must be named here.
  for (const field of ['maxCheckpoint', 'dailyStreak', 'bestDailyStreak', 'lastDailyDate',
                       'dailyHistory', 'weeklyAttempts', 'pushSubscription', 'notificationPrefs', 'powerUps']) {
    assert.ok(field in u, `users/$uid is missing a rule for "${field}" — writes to it will be rejected`);
  }
  // powerUps leaves validate as non-negative numbers.
  assert.match(u.powerUps.$mode.$type['.validate'], /isNumber\(\)/);
});
