// The Climb's library deal (the wiring that retires issue #286's class):
// L26-250 boards come from the pre-generated bins, picked under his
// seen-cycle rule, re-certified from their stored opener at the point of
// play, with the drawn path surviving as the fallback behind the abort
// contract. The deal itself is call-tested here against the REAL committed
// level files with fetch stubbed; the call sites in gameActions hold by
// source scan (the saveSlotOwnership precedent).

import './domShim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { pickFromBin, levelHasLibrary, levelFileUrl } = await import('../src/logic/climbLibrary.js');
const { dealClimbBoard } = await import('../src/game/climbDeal.js');
const { state } = await import('../src/state/gameState.js');
const { getClimbSeen, setClimbSeen } = await import('../src/storage/statsStorage.js');

const LEVEL = 30;
const binRaw = readFileSync(new URL(`../scripts/data/climb-library/level-0${LEVEL}.json`, import.meta.url), 'utf8');
const bin = JSON.parse(binRaw);

function stubFetch(bodyFor) {
  globalThis.fetch = async (url) => {
    const body = bodyFor(url);
    if (body == null) return { ok: false, status: 404, json: async () => null };
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
  };
}

function resetLane({ practice = false, forced = null } = {}) {
  state.isLevelPractice = practice;
  state.climbBoardIndex = forced;
  setClimbSeen(LEVEL, []);
}

// ── The pick rule, pure ─────────────────────────────────────────────────

test('pickFromBin takes unseen boards first', () => {
  const boards = [{ seed: 'a' }, { seed: 'b' }, { seed: 'c' }];
  const { pick, cycled } = pickFromBin(boards, ['a', 'c'], () => 0);
  assert.equal(pick.seed, 'b');
  assert.equal(cycled, false);
});

test('REGRESSION: all seen resets the cycle instead of dealing nothing', () => {
  // His rule verbatim: "If all 10 end up being seen, then it goes back
  // to 1." A pick that returned null here would strand the level.
  const boards = [{ seed: 'a' }, { seed: 'b' }];
  const { pick, cycled } = pickFromBin(boards, ['a', 'b'], () => 0.99);
  assert.ok(pick, 'the cycle reset deals from the full bin');
  assert.equal(cycled, true);
});

test('pickFromBin is deterministic under a forced rand, and safe on an empty bin', () => {
  const boards = [{ seed: 'a' }, { seed: 'b' }, { seed: 'c' }];
  assert.equal(pickFromBin(boards, [], () => 0).pick.seed, 'a');
  assert.equal(pickFromBin(boards, [], () => 0.67).pick.seed, 'c');
  assert.equal(pickFromBin([], [], () => 0).pick, null);
});

// ── The deal, against the real committed level file ─────────────────────

test('a deal returns the install shape, re-certified from the stored opener', async () => {
  resetLane();
  stubFetch(() => bin);
  const res = await dealClimbBoard(LEVEL);
  assert.ok(res, 'the deal succeeds on a healthy bin');
  assert.ok(res.board.length === res.rows && res.board[0].length === res.cols);
  assert.ok(res.check.solvable && res.check.remainingUnknowns === 0,
    'the dealt board re-certifies at the point of play');
  assert.ok(bin.boards.some((b) => b.seed === res.seed), 'the seed is one of the bin');
  assert.equal(typeof res.firstClick, 'number');
  assert.ok(res.spec && res.spec.shape, 'the dealt spec rides along for the level card');
  assert.ok(res.features, 'stored features ride along so the client prices its own par');
});

test('a deal marks the board seen; practice never does', async () => {
  resetLane();
  stubFetch(() => bin);
  const res = await dealClimbBoard(LEVEL);
  assert.deepEqual(getClimbSeen(LEVEL), [res.seed], 'dealt means seen, his rule');

  resetLane({ practice: true });
  await dealClimbBoard(LEVEL);
  assert.deepEqual(getClimbSeen(LEVEL), [],
    'practice shares this localStorage with production and must not advance the cycle');
  state.isLevelPractice = false;
});

test('exhausting the bin resets the seen list to the fresh pick', async () => {
  resetLane();
  setClimbSeen(LEVEL, bin.boards.map((b) => b.seed));
  stubFetch(() => bin);
  const res = await dealClimbBoard(LEVEL);
  assert.ok(res, 'a fully-seen bin still deals');
  assert.deepEqual(getClimbSeen(LEVEL), [res.seed], 'the cycle restarted at one');
});

test('the practice board override picks the exact bin index', async () => {
  resetLane({ practice: true, forced: 2 });
  stubFetch(() => bin);
  const res = await dealClimbBoard(LEVEL);
  assert.equal(res.seed, bin.boards[2].seed, 'board=2 dealt bin index 2');
  state.isLevelPractice = false;
  state.climbBoardIndex = null;
});

test('every failure degrades to null for the drawn fallback, never a throw', async () => {
  resetLane();
  stubFetch(() => null); // 404
  assert.equal(await dealClimbBoard(LEVEL), null);

  globalThis.fetch = async () => { throw new Error('network down'); };
  assert.equal(await dealClimbBoard(LEVEL), null);

  stubFetch(() => ({ ...bin, level: LEVEL + 1 })); // wrong level in the body
  assert.equal(await dealClimbBoard(LEVEL), null);

  stubFetch(() => ({ ...bin, boards: [] })); // empty bin
  assert.equal(await dealClimbBoard(LEVEL), null);

  // A corrupt payload must fail the re-certification, not install: flip a
  // stored mine so the numbers lie about the layout.
  const poisoned = JSON.parse(binRaw);
  for (const cell of poisoned.boards[0].payload.cells) {
    if (!cell.isMine) { cell.isMine = true; break; }
  }
  resetLane({ practice: true, forced: 0 });
  stubFetch(() => poisoned);
  assert.equal(await dealClimbBoard(LEVEL), null,
    'a tampered board fails the point-of-play certification and falls back to drawing');
  state.isLevelPractice = false;
  state.climbBoardIndex = null;
});

test('levels outside the library never fetch', async () => {
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; return { ok: false }; };
  assert.equal(await dealClimbBoard(25), null, 'the authored openers stay drawn');
  assert.equal(await dealClimbBoard(251), null, 'the endless zone stays drawn');
  assert.equal(fetched, 0, 'no fetch was even attempted');
  assert.ok(levelHasLibrary(26) && levelHasLibrary(250));
});

// ── The call sites, by source scan ──────────────────────────────────────

test('REGRESSION: the challenge branch deals from the library before it draws', () => {
  const src = readFileSync(new URL('../src/game/gameActions.js', import.meta.url), 'utf8');
  const branch = src.slice(src.indexOf("state.gameMode === 'normal' && !state.coastlinePractice"));
  const dealAt = branch.indexOf('dealClimbBoard(');
  const drawAt = branch.indexOf('buildChallenge250Board(');
  assert.ok(dealAt >= 0, 'the deal call exists in the challenge branch');
  assert.ok(drawAt > dealAt, 'the drawn path runs only as the fallback AFTER the deal');
  const install = branch.slice(0, branch.indexOf('setDailySuggestedCell'));
  assert.match(install, /fromLibrary/, 'the install distinguishes a deal from a draw');
});

test('the level file path is relative, so the test branch serves its own copy', () => {
  assert.equal(levelFileUrl(30), 'scripts/data/climb-library/level-030.json');
  assert.ok(!levelFileUrl(30).startsWith('/'), 'a root-anchored path would cross / and /test/');
});
