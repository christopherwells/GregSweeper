// Challenge 250 progression reset (the epoch marker) + tier-scaled earns.
//
// The reset ships EVERYONE back to L1 with no memento of the old 120
// climb (his ruling), and the epoch is what keeps a stale device's
// pre-reset progress from resurrecting through the cloud max-merge — the
// moltDay date-anchored-snapshot lesson: challenge progression adopts
// ONLY from the atomic `challenge250` cloud node (epoch + maxCheckpoint +
// challenge power-up pool), which pre-reset clients cannot write. The
// legacy top-level maxCheckpoint field is history by definition and is
// never adopted, on either merge path.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const stats = await import('../src/storage/statsStorage.js');
const {
  applyChallenge250Reset, applyCloudProgress, loadStats, loadCheckpoint,
  loadModePowerUps, invalidateStatsCache, saveCheckpoint,
} = stats;
const { CHALLENGE_250_EPOCH, powerUpAwardCount } = await import('../src/logic/challenge250.js');

const STATS_KEY = 'minesweeper_stats';
const POWERUPS_KEY = 'minesweeper_powerups';
const SEEN_KEY = 'minesweeper_seen_gimmicks';

function seedPreResetState() {
  localStorage.clear();
  invalidateStatsCache?.();
  const s = loadStats();
  s.maxLevelReached = 120;
  s.bestTimes = { level37: 88.2, level120: 300 };
  s.wins = 400; s.losses = 90;
  s.modeStats.challenge.maxLevelReached = 120;
  s.modeStats.challenge.bestTimes = { level37: 88.2 };
  s.modeStats.challenge.wins = 400;
  localStorage.setItem(STATS_KEY, JSON.stringify(s));
  localStorage.setItem(POWERUPS_KEY, JSON.stringify({ challenge: { lifeline: 7, shield: 3 }, chaos: { shield: 2 } }));
  localStorage.setItem(SEEN_KEY, JSON.stringify(['walls', 'liar', 'mystery']));
  saveCheckpoint('challenge', 116);
  invalidateStatsCache?.();
}

test('the reset wipes progression, keeps career counters, and stamps the epoch', () => {
  seedPreResetState();
  assert.equal(applyChallenge250Reset(), true, 'first run resets');

  const s = loadStats();
  assert.equal(s.maxLevelReached, 1);
  assert.equal(s.modeStats.challenge.maxLevelReached, 1);
  assert.deepEqual(s.bestTimes, {}, 'old per-level bests name different boards now');
  assert.deepEqual(s.modeStats.challenge.bestTimes, {});
  assert.equal(s.challengeEpoch, CHALLENGE_250_EPOCH);
  assert.equal(s.wins, 400, 'career counters are history, not position');
  assert.equal(s.modeStats.challenge.wins, 400);
  assert.equal(loadCheckpoint('challenge'), 1, 'checkpoint ladder back to the start');

  const pu = loadModePowerUps('normal');
  for (const v of Object.values(pu)) assert.equal(v, 0, 'challenge inventory wiped to zero');
  const all = JSON.parse(localStorage.getItem(POWERUPS_KEY));
  assert.deepEqual(all.chaos, { shield: 2 }, 'non-challenge pools untouched');

  // First-encounter popups do NOT re-show: the seen-set survives verbatim.
  assert.deepEqual(JSON.parse(localStorage.getItem(SEEN_KEY)), ['walls', 'liar', 'mystery']);
});

test('the reset is one-time: a second boot is a no-op', () => {
  seedPreResetState();
  applyChallenge250Reset();
  // Post-reset progress must survive later boots.
  const s = loadStats();
  s.maxLevelReached = 40;
  s.modeStats.challenge.maxLevelReached = 40;
  localStorage.setItem(STATS_KEY, JSON.stringify(s));
  invalidateStatsCache?.();
  assert.equal(applyChallenge250Reset(), false);
  assert.equal(loadStats().maxLevelReached, 40, 'epoch-stamped stats never reset again');
});

test('cloud checkpoint adoption: only the epoch-matched challenge250 node counts, on BOTH merge paths', () => {
  seedPreResetState();
  applyChallenge250Reset();

  // Legacy top-level maxCheckpoint (a stale device's 120 climb): ignored.
  applyCloudProgress({ maxCheckpoint: 120 });
  assert.equal(loadStats().maxLevelReached, 1, 'legacy field ignored on initial load');
  applyCloudProgress({ maxCheckpoint: 120 }, { overwrite: true });
  assert.equal(loadStats().maxLevelReached, 1, 'legacy field ignored on the listener path');

  // Wrong-epoch node (a future reset's gate): ignored.
  applyCloudProgress({ challenge250: { epoch: CHALLENGE_250_EPOCH + 1, maxCheckpoint: 90 } }, { overwrite: true });
  assert.equal(loadStats().maxLevelReached, 1);

  // Epoch-matched node: adopted (max-merge on initial load...).
  applyCloudProgress({ challenge250: { epoch: CHALLENGE_250_EPOCH, maxCheckpoint: 35 } });
  assert.equal(loadStats().maxLevelReached, 35);
  assert.equal(loadCheckpoint('challenge'), 35);
  applyCloudProgress({ challenge250: { epoch: CHALLENGE_250_EPOCH, maxCheckpoint: 20 } });
  assert.equal(loadStats().maxLevelReached, 35, 'initial load never downgrades');
  // (...verbatim on the listener path, so an admin correction sticks.)
  applyCloudProgress({ challenge250: { epoch: CHALLENGE_250_EPOCH, maxCheckpoint: 20 } }, { overwrite: true });
  assert.equal(loadStats().maxLevelReached, 20);
});

test('tier-scaled power-up earns: floor(tier/6) plus a Bernoulli fraction', () => {
  // Deterministic rng ladders: rng below the fraction earns the extra.
  const lo = () => 0.0;   // always wins the fractional roll
  const hi = () => 0.999; // never wins it
  assert.equal(powerUpAwardCount(12, hi), 2, 'the summit keeps the old two-per-win');
  assert.equal(powerUpAwardCount(12, lo), 2, 'T12 is exactly 2 — no fraction');
  assert.equal(powerUpAwardCount(6, hi), 1, 'T6 is exactly one per win');
  assert.equal(powerUpAwardCount(1, hi), 0, 'T1 usually earns nothing');
  assert.equal(powerUpAwardCount(1, lo), 1, 'T1 sometimes earns one');
  // Expectation check: mean over the Bernoulli grid equals tier/6.
  for (const tier of [1, 3, 5, 7, 9, 11]) {
    let total = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) total += powerUpAwardCount(tier, () => (i + 0.5) / N);
    assert.ok(Math.abs(total / N - tier / 6) < 0.01, `E[awards|T${tier}] = tier/6`);
  }
});
