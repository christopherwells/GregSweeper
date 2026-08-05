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
  saveGameState, loadGameState,
} = stats;
const { CHALLENGE_250_EPOCH, powerUpAwardCount } = await import('../src/logic/challenge250.js');
const gimmicks = await import('../src/logic/gimmicks.js');

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

  // First-encounter popups DO re-show. This assertion used to demand the
  // opposite — that the seen-set survive verbatim — on the reasoning that a
  // returning player should not be re-taught walls. His report killed that
  // reasoning within a day of shipping: the ladder was rebuilt from level 1
  // for everyone, walls now debut at L6 and liar at L11, and meeting both
  // with no card reads as broken rather than as familiar.
  assert.deepEqual(JSON.parse(localStorage.getItem(SEEN_KEY)), {},
    'the new ladder teaches its modifiers again');
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

test('REGRESSION: power-up earns are GUARANTEED and banded by level, never a probability', () => {
  // His report 2026-08-04: played to L8 and earned nothing. The cause was
  // a tier-scaled EXPECTATION (tier/6 per win) — at T1 that paid about
  // one power-up every six wins, so eight honest levels could easily
  // produce zero. Every level now earns at least one, always.
  for (const lv of [1, 2, 8, 25, 50, 99, 100]) {
    assert.equal(powerUpAwardCount(lv), 1, `L${lv} earns exactly one`);
  }
  for (const lv of [101, 150, 200, 249, 250]) {
    assert.equal(powerUpAwardCount(lv), 2, `L${lv} earns two`);
  }
  for (const lv of [251, 300, 1000]) {
    assert.equal(powerUpAwardCount(lv), 3, `L${lv} (endless) earns three`);
  }
  // No level anywhere on the ladder earns nothing — the defect's shape.
  for (let lv = 1; lv <= 400; lv++) {
    assert.ok(powerUpAwardCount(lv) >= 1, `L${lv} must always earn something`);
  }
  // Junk clamps to the first band rather than earning zero.
  assert.equal(powerUpAwardCount(0), 1);
  assert.equal(powerUpAwardCount(undefined), 1);
});

test('the bonus lifeline rides at his 33% rate, on top of the banded award', async () => {
  const { LIFELINE_BONUS_CHANCE } = await import('../src/logic/challenge250.js');
  assert.equal(LIFELINE_BONUS_CHANCE, 0.33);
});

// ── The modifier cards come back with the new ladder ─────────────────────

test('REGRESSION: the epoch migration clears the first-encounter modifier cards', async () => {
  // His report (2026-08-04): no popup on the first walls or the first liar.
  // The reset wiped progression but left `minesweeper_seen_gimmicks` alone, so
  // a player who met walls on the old 120-level ladder met them again at L6 on
  // the new one with no card. The ladder was rebuilt from level 1 for
  // everyone and the cards ARE its teaching moments, so a stale seen-set makes
  // the opener read as broken.
  localStorage.clear();
  stats.invalidateStatsCache?.();
  gimmicks.markGimmickSeen('walls');
  gimmicks.markGimmickSeen('liar');
  assert.ok(gimmicks.hasSeenGimmick('walls') && gimmicks.hasSeenGimmick('liar'));

  stats.applyChallenge250Reset();
  assert.equal(gimmicks.hasSeenGimmick('walls'), false, 'walls must teach again');
  assert.equal(gimmicks.hasSeenGimmick('liar'), false, 'liar must teach again');
});

test('the card clear reaches a player whose progression reset ALREADY ran', () => {
  // The whole reason it has its own marker. Folding it into the epoch guard
  // would miss everyone who reset before this shipped, and bumping the epoch
  // to catch them would wipe the climb they have built since.
  localStorage.clear();
  stats.invalidateStatsCache?.();
  const s = stats.loadStats();
  s.challengeEpoch = CHALLENGE_250_EPOCH;      // already reset
  s.maxLevelReached = 8;
  s.modeStats = { ...(s.modeStats || {}), challenge: { ...(s.modeStats?.challenge || {}), maxLevelReached: 8 } };
  delete s.challengeSeenEpoch;
  localStorage.setItem('minesweeper_stats', JSON.stringify(s));
  stats.invalidateStatsCache?.();
  gimmicks.markGimmickSeen('walls');

  stats.applyChallenge250Reset();

  const after = stats.loadStats();
  assert.equal(gimmicks.hasSeenGimmick('walls'), false, 'the card must come back');
  assert.equal(after.modeStats.challenge.maxLevelReached, 8,
    'their climb must survive — this migration costs progression nothing');
  assert.equal(after.challengeEpoch, CHALLENGE_250_EPOCH, 'the progression epoch must not move');
});

test('the card clear runs exactly once', () => {
  // A player who legitimately meets walls after the migration must keep that.
  localStorage.clear();
  stats.invalidateStatsCache?.();
  stats.applyChallenge250Reset();
  gimmicks.markGimmickSeen('walls');
  stats.applyChallenge250Reset();
  assert.equal(gimmicks.hasSeenGimmick('walls'), true,
    're-running the migration must not forget a card seen on the NEW ladder');
});

test('REGRESSION: a card that CHANGES is marked unseen (his rule)', () => {
  // "Anytime a card is changed, it should be marked as not seen." A player who
  // learned the old sonar card — "a 5x5 area centered on the cell" — has not
  // seen the card that replaced it, and the correction has to reach exactly
  // the people carrying the wrong idea.
  //
  // The revision is DERIVED from the card's content, so this cannot be
  // forgotten during a copy edit. A declared version number can.
  localStorage.clear();
  stats.invalidateStatsCache?.();
  const defs = gimmicks.getGimmickDefs();

  gimmicks.markGimmickSeen('sonar');
  assert.equal(gimmicks.hasSeenGimmick('sonar'), true);
  const before = gimmicks.cardRevision('sonar');

  const original = defs.sonar.longDesc;
  try {
    defs.sonar.longDesc = `${original} One more sentence.`;
    assert.notEqual(gimmicks.cardRevision('sonar'), before, 'the revision must track the copy');
    assert.equal(gimmicks.hasSeenGimmick('sonar'), false, 'an edited card must teach again');
  } finally {
    defs.sonar.longDesc = original;
  }
  assert.equal(gimmicks.hasSeenGimmick('sonar'), true, 'restoring the copy restores the mark');

  // The example diagram counts as part of the card too.
  const ex = defs.sonar.exampleHtml;
  try {
    defs.sonar.exampleHtml = `${ex}<!-- x -->`;
    assert.equal(gimmicks.hasSeenGimmick('sonar'), false, 'an edited diagram must teach again');
  } finally {
    defs.sonar.exampleHtml = ex;
  }

  // Marking one card must not disturb another.
  gimmicks.markGimmickSeen('liar');
  assert.equal(gimmicks.hasSeenGimmick('liar'), true);
  assert.equal(gimmicks.hasSeenGimmick('walls'), false, 'an unmet card stays unmet');
});

test('the legacy flat-array seen-set reads as unseen exactly once', () => {
  // The old shape recorded names with no revision, so it genuinely does not
  // say WHICH version was read. Re-showing once is the honest reading; the
  // next mark migrates the entry to the new shape.
  localStorage.clear();
  stats.invalidateStatsCache?.();
  localStorage.setItem(SEEN_KEY, JSON.stringify(['walls', 'liar']));
  assert.equal(gimmicks.hasSeenGimmick('walls'), false);

  gimmicks.markGimmickSeen('walls');
  const stored = JSON.parse(localStorage.getItem(SEEN_KEY));
  assert.ok(!Array.isArray(stored), 'the store migrates to the revision map');
  assert.equal(gimmicks.hasSeenGimmick('walls'), true);
});

// ── What the reset never reached (issue #239) ────────────────────────────
// The epoch migration wiped the stats object, the checkpoint and the power-up
// pool, but the in-progress challenge SAVE is a separate storage family keyed
// by mode rather than by epoch, and the level-advance handler had been writing
// its checkpoint under a second key ('normal') that the reset never cleared.
// So a returning player was back at Level 1 while the game still offered to
// continue from their old-ladder level — and finishing that board re-stamped
// maxLevelReached into the epoch-matched cloud node, out of the reset's reach
// forever.

test('REGRESSION #239: a pre-reset challenge save is refused and cleared', async () => {
  const { challengeSaveIsCurrent } = await import('../src/logic/resumeEligibility.js');
  seedPreResetState();
  // The old ladder's leftovers: an in-progress L100 game and the checkpoint
  // under the key the level-advance handler actually wrote.
  saveGameState({
    gameMode: 'normal', currentLevel: 100, checkpoint: 96,
    board: [[{ row: 0, col: 0, isMine: false }]], rows: 1, cols: 1,
    totalMines: 0, savedStatus: 'playing',
  });
  const cps = JSON.parse(localStorage.getItem('minesweeper_checkpoints') || '{}');
  cps.normal = 96;
  localStorage.setItem('minesweeper_checkpoints', JSON.stringify(cps));

  assert.equal(applyChallenge250Reset(), true);
  invalidateStatsCache?.();

  assert.equal(loadStats().maxLevelReached, 1);
  assert.equal(loadGameState('normal'), null,
    'the old-ladder save is gone, not merely un-resumable');
  assert.equal(loadCheckpoint('challenge'), 1);
  assert.equal(loadCheckpoint('normal'), 1,
    "both spellings resolve to one number — 'normal' can no longer hold a second copy");
  const raw = JSON.parse(localStorage.getItem('minesweeper_checkpoints') || '{}');
  assert.equal(raw.normal, undefined, 'the orphaned legacy entry is dropped');

  // And the gate that keeps it from coming back: the position a save claims
  // must be one this progression can hold.
  assert.equal(challengeSaveIsCurrent({ currentLevel: 100 }, 1), false);
  assert.equal(challengeSaveIsCurrent({ currentLevel: 100 }, 62), false,
    'the new-ladder climb does not license the old ladder to resume');
  assert.equal(challengeSaveIsCurrent({ currentLevel: 63 }, 62), true,
    'playing the level above your best is the ordinary in-progress case');
  assert.equal(challengeSaveIsCurrent({ currentLevel: 1 }, 1), true);
});

test('the artifact cleanup reaches a player whose progression reset ALREADY ran', () => {
  seedPreResetState();
  assert.equal(applyChallenge250Reset(), true);       // the original migration
  // Their old save survived that first pass, exactly as it did in the wild.
  saveGameState({
    gameMode: 'normal', currentLevel: 100, checkpoint: 96,
    board: [[{ row: 0, col: 0, isMine: false }]], rows: 1, cols: 1,
    totalMines: 0, savedStatus: 'playing',
  });
  const s = loadStats();
  delete s.challengeArtifactEpoch;                    // pre-fix build
  localStorage.setItem('minesweeper_stats', JSON.stringify(s));
  invalidateStatsCache?.();

  assert.equal(applyChallenge250Reset(), true, 'the artifact marker runs on its own');
  assert.equal(loadGameState('normal'), null);
  assert.equal(loadStats().maxLevelReached, 1, 'the climb they built since is untouched');
});

test('a legitimate in-progress challenge game survives every pass', () => {
  seedPreResetState();
  applyChallenge250Reset();
  // Post-reset play: won up to L62, now part-way through L63.
  const s = loadStats();
  s.maxLevelReached = 62;
  s.modeStats.challenge.maxLevelReached = 62;
  localStorage.setItem('minesweeper_stats', JSON.stringify(s));
  invalidateStatsCache?.();
  saveGameState({
    gameMode: 'normal', currentLevel: 63, checkpoint: 61,
    board: [[{ row: 0, col: 0, isMine: false }]], rows: 1, cols: 1,
    totalMines: 0, savedStatus: 'playing',
  });
  // Re-arm the artifact pass so it gets a chance to take this save.
  const s2 = loadStats();
  delete s2.challengeArtifactEpoch;
  localStorage.setItem('minesweeper_stats', JSON.stringify(s2));
  invalidateStatsCache?.();

  applyChallenge250Reset();
  const kept = loadGameState('normal');
  assert.ok(kept && kept.currentLevel === 63, 'a real in-progress game is never dropped');
  assert.equal(loadStats().maxLevelReached, 62);
});
