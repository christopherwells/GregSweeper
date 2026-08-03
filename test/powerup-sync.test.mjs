// Power-up cross-device sync. This ships straight to production (the sync
// is gated off on the test build via isTestEnvironment), so it can't be
// staged — these unit tests are the pre-ship safety net for the merge
// logic AND for the code/rules contract that nearly shipped broken.
//
// CONTRACT CHANGE (Challenge 250 reset): the CHALLENGE pool now syncs
// exclusively through the epoch-gated `challenge250` cloud node — the
// legacy `powerUps.challenge` field is pre-reset history and is dropped
// on adoption, so a stale device can never resurrect the wiped hoard.
// Non-challenge pools (chaos) still ride the legacy `powerUps` node.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const stats = await import('../src/storage/statsStorage.js');
const { CHALLENGE_250_EPOCH } = await import('../src/logic/challenge250.js');
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

test('existing user with NO cloud power-ups keeps their local counts (no wipe)', () => {
  reset({ challenge: { revealSafe: 3, shield: 2 } });
  // Cloud progress with streak but NO powerUps field — the typical
  // existing-user load. Power-ups must NOT be touched.
  applyCloudProgress({ dailyStreak: 5, lastDailyDate: '2026-06-01' });
  assert.deepEqual(readPU(), { challenge: { revealSafe: 3, shield: 2 } });
});

test('real-time listener (overwrite) adopts the challenge250 pool verbatim', () => {
  reset({ challenge: { revealSafe: 9, shield: 9 } });
  applyCloudProgress({
    challenge250: { epoch: CHALLENGE_250_EPOCH, powerUps: { revealSafe: 1, shield: 0 } },
  }, { overwrite: true });
  assert.deepEqual(readPU(), { challenge: { revealSafe: 1, shield: 0 } });
});

test('initial load max-merges the challenge250 pool per type (never silently loses an earned power-up)', () => {
  reset({ challenge: { revealSafe: 1, shield: 5, magnet: 0 } });
  // Cloud (from another device) has more revealSafe, fewer shields.
  applyCloudProgress({
    challenge250: { epoch: CHALLENGE_250_EPOCH, powerUps: { revealSafe: 4, shield: 2, xray: 3 } },
  });
  const pu = readPU();
  assert.equal(pu.challenge.revealSafe, 4, 'cloud-higher type adopted');
  assert.equal(pu.challenge.shield, 5, 'local-higher type kept');
  assert.equal(pu.challenge.magnet, 0, 'local-only type preserved');
  assert.equal(pu.challenge.xray, 3, 'cloud-only type added');
});

test('initial load with no local power-ups adopts the cloud challenge250 pool', () => {
  reset(null);
  applyCloudProgress({ challenge250: { epoch: CHALLENGE_250_EPOCH, powerUps: { lifeline: 2 } } });
  assert.deepEqual(readPU(), { challenge: { lifeline: 2 } });
});

test('REGRESSION: the legacy powerUps.challenge field never resurrects a pre-reset hoard', () => {
  // A stale device still on pre-reset code writes {powerUps: {challenge:
  // hoard}} with no challenge250 node. Post-reset clients must drop the
  // challenge half on EVERY merge path — the overwrite listener re-applies
  // the cloud on each snapshot, so one adoption would undo the wipe.
  reset({ challenge: { lifeline: 0 } });
  applyCloudProgress({ powerUps: { challenge: { lifeline: 9, shield: 9 } } });
  assert.deepEqual(readPU(), { challenge: { lifeline: 0 } }, 'initial-load path must drop it');
  applyCloudProgress({ powerUps: { challenge: { lifeline: 9, shield: 9 } } }, { overwrite: true });
  assert.deepEqual(readPU(), { challenge: { lifeline: 0 } }, 'listener path must drop it');
});

test('a challenge250 node from a DIFFERENT epoch is ignored (the next reset reuses the gate)', () => {
  reset({ challenge: { shield: 1 } });
  applyCloudProgress({
    challenge250: { epoch: CHALLENGE_250_EPOCH + 1, powerUps: { shield: 9 } },
  }, { overwrite: true });
  assert.deepEqual(readPU(), { challenge: { shield: 1 } });
});

test('non-challenge pools still ride the legacy powerUps node', () => {
  reset({ chaos: { shield: 1 } });
  applyCloudProgress({ powerUps: { chaos: { shield: 4 }, challenge: { shield: 9 } } });
  const pu = readPU();
  assert.equal(pu.chaos.shield, 4, 'chaos pool max-merged from legacy node');
  assert.equal(pu.challenge, undefined, 'challenge half of the legacy node dropped');
});

test('malformed cloud power-ups do not throw', () => {
  reset({ challenge: { shield: 1 } });
  assert.doesNotThrow(() => applyCloudProgress({ powerUps: { challenge: 'oops', timed: 7 } }));
  assert.doesNotThrow(() => applyCloudProgress({ challenge250: 'oops' }));
  assert.doesNotThrow(() => applyCloudProgress({ challenge250: { epoch: 'x', powerUps: 3 } }));
});

// ── Code↔rules contract ──────────────────────────────
// The sync nearly shipped broken because users/{uid} has a
// `$other: {.validate:false}` catch-all and `powerUps` wasn't
// whitelisted, so every write was silently rejected. Lock that in: any
// field the client writes under users/{uid} must have a matching rule.
test('firebase-rules.json whitelists powerUps AND challenge250 under users/$uid', () => {
  const rules = JSON.parse(readFileSync(new URL('../firebase-rules.json', import.meta.url), 'utf8'));
  const u = rules.rules.users.$uid;
  // The catch-all that makes this a real contract (not just "allow all").
  assert.equal(u.$other['.validate'], false, 'expected a strict $other catch-all under users/$uid');
  // Every field the client writes to users/{uid} must be named here.
  for (const field of ['maxCheckpoint', 'dailyStreak', 'bestDailyStreak', 'lastDailyDate',
                       'dailyHistory', 'weeklyAttempts', 'pushSubscription', 'notificationPrefs',
                       'powerUps', 'challenge250']) {
    assert.ok(field in u, `users/$uid is missing a rule for "${field}" — writes to it will be rejected`);
  }
  // powerUps leaves validate as non-negative numbers.
  assert.match(u.powerUps.$mode.$type['.validate'], /isNumber\(\)/);
  // challenge250: epoch + maxCheckpoint numeric, maxCheckpoint UNBOUNDED
  // above (the endless zone banks checkpoints past 250 by design — an
  // upper bound here would re-create the silent-drop class the moment a
  // player crossed it), power-up pool numeric, strict $other.
  assert.match(u.challenge250.epoch['.validate'], /isNumber\(\)/);
  assert.match(u.challenge250.maxCheckpoint['.validate'], /isNumber\(\)/);
  assert.ok(!/<=/.test(u.challenge250.maxCheckpoint['.validate']),
    'challenge250/maxCheckpoint must have no upper bound (endless zone)');
  assert.match(u.challenge250.powerUps.$type['.validate'], /isNumber\(\)/);
  assert.equal(u.challenge250.$other['.validate'], false);
});
