// TRIPWIRE for the coming Challenge -> The Climb rename.
//
// The ladder's runtime mode value is 'normal'; 'challenge' is only its STORAGE
// name. Nine stored things carry that name and none of them may move, because
// renaming any one of them wipes a player's ladder position, re-fires the L1
// progression reset, or (for the Firebase node, whose parent block ends in
// "$other": {".validate": false}) makes the WHOLE progress write fail
// validation and drop silently -- the 866683d class.
//
// This file exists so a find-and-replace across the repo turns red here rather
// than in production. If you are renaming the mode and a test below fails, the
// answer is to leave the storage key alone, not to update the expectation.

import './domShim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const statsStorage = await import('../src/storage/statsStorage.js');
const {
  saveCheckpoint, loadCheckpoint, saveModePowerUps, loadModePowerUps,
  saveGameState, loadGameState, clearGameState, saveGameResult, loadStats,
  invalidateStatsCache,
} = statsStorage;

const readRaw = (k) => JSON.parse(localStorage.getItem(k) || 'null');
const srcOf = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the ladder checkpoint stores under minesweeper_checkpoints.challenge', () => {
  localStorage.clear();
  invalidateStatsCache();
  saveCheckpoint('normal', 7);

  assert.deepEqual(readRaw('minesweeper_checkpoints'), { challenge: 7 },
    'the checkpoint key and its "challenge" child are a stored contract');
  // Both spellings must resolve to the same number. Issue #239 was the ladder
  // advance writing its checkpoint under a second, un-normalized key.
  assert.equal(loadCheckpoint('normal'), 7);
  assert.equal(loadCheckpoint('challenge'), 7);
});

test('the ladder power-up pool stores under minesweeper_powerups.challenge', () => {
  localStorage.clear();
  invalidateStatsCache();
  saveModePowerUps('normal', { revealSafe: 2, shield: 1, lifeline: 3, scanRowCol: 0, magnet: 0, xray: 0 });

  const raw = readRaw('minesweeper_powerups');
  assert.ok(raw && raw.challenge, 'the pool lives under the "challenge" child');
  assert.equal(raw.challenge.lifeline, 3);
  assert.equal(loadModePowerUps('challenge').lifeline, 3);
});

test('the in-progress ladder game stores under minesweeper_game_state_challenge', () => {
  localStorage.clear();
  invalidateStatsCache();
  saveGameState({ gameMode: 'normal', currentLevel: 12, board: [], status: 'playing' });

  assert.ok(localStorage.getItem('minesweeper_game_state_challenge'),
    'the save slot name is a stored contract: renaming it orphans every in-progress ladder game');
  assert.equal(loadGameState('normal').currentLevel, 12);
  assert.equal(loadGameState('challenge').currentLevel, 12, 'both spellings reach one slot');

  clearGameState('normal');
  assert.equal(localStorage.getItem('minesweeper_game_state_challenge'), null);
});

test('ladder career stats store under modeStats.challenge', () => {
  localStorage.clear();
  invalidateStatsCache();
  saveGameResult(true, 42, 3, { gameMode: 'normal' });

  const stats = readRaw('minesweeper_stats');
  assert.ok(stats.modeStats.challenge, 'per-mode stats live under "challenge"');
  assert.equal(stats.modeStats.challenge.wins, 1);
});

test('the three migration epoch markers keep their names', () => {
  // Each guards a one-time destructive migration. Rename one and it re-fires:
  // challengeEpoch re-wipes the ladder, challengeSeenEpoch re-shows every
  // first-encounter card, challengeArtifactEpoch re-runs the stale-save sweep.
  const src = srcOf('../src/storage/statsStorage.js');
  for (const marker of ['challengeEpoch', 'challengeSeenEpoch', 'challengeArtifactEpoch']) {
    assert.match(src, new RegExp(`\\b${marker}\\b`), `${marker} must keep its stored name`);
  }
});

test('the ladder save carries challengeBoardSeed and challengePar', () => {
  // Both ride the persisted snapshot: the seed because worm traits key on it
  // (the hatch identity chain), the par because the pace bar reads it on resume.
  const src = srcOf('../src/game/gamePersistence.js');
  assert.match(src, /\bchallengeBoardSeed\b/, 'the drawn board seed persists by that name');
  assert.match(src, /\bchallengePar\b/, 'the drawn par persists by that name');
});

test('mode lives keep their "challenge" key', () => {
  const src = srcOf('../src/storage/statsStorage.js');
  assert.match(src, /DEFAULT_LIVES[\s\S]{0,80}challenge/,
    'the lives pool is keyed "challenge" even though the ladder defaults to zero');
});

test('users/{uid}/challenge250 keeps its name and whitelisted children', () => {
  // The users/$uid block ends with "$other": {".validate": false}, so an
  // un-whitelisted child makes the WHOLE progress update fail validation and
  // drop silently. Renaming the node without shipping rules first does the same.
  const rules = JSON.parse(srcOf('../firebase-rules.json'));
  const node = rules.rules.users.$uid.challenge250;
  assert.ok(node, 'users/{uid}/challenge250 must exist in the deployed ruleset');
  for (const child of ['epoch', 'maxCheckpoint', 'powerUps']) {
    assert.ok(node[child], `challenge250.${child} must stay whitelisted`);
  }
  assert.equal(node.$other['.validate'], false, 'the node still rejects unknown children');
  assert.equal(rules.rules.users.$uid.$other['.validate'], false,
    'the parent still rejects unknown children, which is what makes this a silent-drop risk');

  // The writer and the ruleset must agree on the node name.
  assert.match(srcOf('../src/firebase/firebaseProgress.js'), /challenge250/,
    'firebaseProgress writes the node the rules whitelist');
});

test('the normal -> challenge mapping is written in exactly ONE place', () => {
  // getModeKey is the definition. A second copy is not a style problem, it is
  // issue #239: two copies means one number in two keys, and a rename that
  // touches one and misses the other fails silently rather than loudly. This
  // was demonstrable here -- with getModeKey renamed, the save-slot test above
  // still passed, because gameStateKey held its own copy.
  const root = new URL('../src/', import.meta.url);
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.js'));

  const hits = [];
  for (const rel of files) {
    const src = readFileSync(new URL(rel, root), 'utf8');
    src.split('\n').forEach((line, i) => {
      // Prose describing the mapping is fine and this file is full of it, so
      // comment lines are skipped. A hand-rolled mapping states both strings
      // close together, as `mode === 'normal' ? 'challenge' : mode` or an
      // if-return pair.
      const code = line.trim();
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
      if (/'normal'[^\n]{0,40}'challenge'/.test(code)) {
        hits.push(`src/${rel.replace(/\\/g, '/')}:${i + 1}`);
      }
    });
  }

  assert.equal(hits.length, 1,
    `the mapping must live only in getModeKey; found ${hits.length} copies:\n  ${hits.join('\n  ')}`);
  assert.match(hits[0], /^src\/storage\/statsStorage\.js:/,
    `the one copy must be getModeKey in statsStorage, not ${hits[0]}`);
});

test('maxCheckpoint carries NO upper bound', () => {
  // The endless zone banks checkpoints past level 250 forever. An upper bound
  // would re-create the silent-drop class at whatever boundary it named.
  const rules = JSON.parse(srcOf('../firebase-rules.json'));
  const v = rules.rules.users.$uid.challenge250.maxCheckpoint['.validate'];
  assert.ok(/>=\s*1/.test(v), 'a floor is fine');
  assert.ok(!/<=/.test(v), 'but a ceiling would drop endless-zone progress silently');
});
