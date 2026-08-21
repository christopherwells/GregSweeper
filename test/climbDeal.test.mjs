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

const {
  pickFromBin, levelHasLibrary, levelFileUrl,
  pickEndlessPage, pickEndlessLane, endlessGlobalIndex, endlessIndexUrl, endlessPageUrl,
} = await import('../src/logic/climbLibrary.js');
const { dealClimbBoard } = await import('../src/game/climbDeal.js');
const { state } = await import('../src/state/gameState.js');
const {
  getClimbSeen, setClimbSeen, getEndlessSeen, setEndlessSeen,
} = await import('../src/storage/statsStorage.js');

const LEVEL = 30;
const binRaw = readFileSync(new URL(`../scripts/data/climb-library/level-0${LEVEL}.json`, import.meta.url), 'utf8');
const bin = JSON.parse(binRaw);

// A synthetic two-page endless library built from the REAL committed L30
// boards: the payloads are genuine certified boards, so the deal's
// re-certification runs for real, while the fixture stays four boards
// small (loading the actual thousand-board library into a unit test buys
// nothing the four cannot).
const endlessFixture = (() => {
  const boards = bin.boards.slice(0, 4);
  return {
    index: { parModel: 'test', parFloor: 400, boards: 4, pages: 2, counts: [2, 2] },
    pages: [
      { page: 0, parModel: 'test', boards: boards.slice(0, 2) },
      { page: 1, parModel: 'test', boards: boards.slice(2, 4) },
    ],
  };
})();

function stubEndlessFetch(fx = endlessFixture) {
  globalThis.fetch = async (url) => {
    let body = null;
    if (url === endlessIndexUrl()) body = fx.index;
    else if (url === endlessPageUrl(0)) body = fx.pages[0];
    else if (url === endlessPageUrl(1)) body = fx.pages[1];
    if (body == null) return { ok: false, status: 404, json: async () => null };
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
  };
}

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

test('the authored openers never fetch; the endless zone now deals (the 2026-08-11 flip)', async () => {
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; return { ok: false }; };
  assert.equal(await dealClimbBoard(25), null, 'the authored openers stay drawn');
  assert.equal(fetched, 0, 'an opener attempted a fetch');
  // L251+ used to be the drawn pool's territory; with the pre-generated
  // endless library it deals like the ladder does, and a dead fetch
  // degrades to the drawn fallback exactly like a ladder level's would.
  assert.equal(await dealClimbBoard(251), null, 'a dead fetch still degrades to the drawn fallback');
  assert.ok(fetched > 0, 'the endless zone fetched its index');
  assert.ok(levelHasLibrary(26) && levelHasLibrary(250));
});

// ── The endless deal ────────────────────────────────────────────────────

test('pickEndlessPage weighs pages by their unseen count and cycles at exhaustion', () => {
  // Page 1 fully seen: only page 0 is drawable at any roll.
  const seen = { 1: ['x', 'y'] };
  assert.deepEqual(pickEndlessPage([2, 2], seen, () => 0.99), { page: 0, cycled: false });
  // Nothing seen: the roll splits proportionally (counts 1 vs 3).
  assert.deepEqual(pickEndlessPage([1, 3], {}, () => 0.2), { page: 0, cycled: false });
  assert.deepEqual(pickEndlessPage([1, 3], {}, () => 0.3), { page: 1, cycled: false });
  // Everything seen: his rule, back to 1 — the cycle resets over the FULL counts.
  const all = { 0: ['a', 'b'], 1: ['x', 'y'] };
  assert.deepEqual(pickEndlessPage([2, 2], all, () => 0), { page: 0, cycled: true });
  // Degenerate inputs stay null rather than throwing under a click.
  assert.equal(pickEndlessPage([], {}, () => 0).page, null);
  assert.equal(pickEndlessPage([0, 0], {}, () => 0).page, null);
});

test('pickEndlessLane unions the scrolling lane into ONE cycle, and reduces to the fit deal without it', () => {
  // The scrolling lane (his ruling 2026-08-18). Absent or empty overCounts
  // must reproduce pickEndlessPage EXACTLY, which is what keeps a
  // lane-less library (and the moment before the first supply run) dealing
  // byte-identically.
  for (const rolls of [0, 0.2, 0.3, 0.7, 0.99]) {
    const a = pickEndlessPage([1, 3], { 0: ['s'] }, () => rolls);
    const b = pickEndlessLane([1, 3], undefined, { 0: ['s'] }, () => rolls);
    assert.deepEqual({ page: b.page, cycled: b.cycled }, a,
      `no lane: must reduce to the fit-only pick at roll ${rolls}`);
    assert.equal(b.over, false);
  }
  // With a lane, the draw is uniform over unseen across BOTH classes:
  // counts [1] + overCounts [3], nothing seen, so rolls past 1/4 land in
  // the lane.
  assert.deepEqual(pickEndlessLane([1], [3], {}, () => 0.2),
    { page: 0, over: false, cycled: false });
  assert.deepEqual(pickEndlessLane([1], [3], {}, () => 0.3),
    { page: 0, over: true, cycled: false });
  // Over pages key as o<n>, so fit page 0 and over page 0 hold separate
  // seen lists and can never collide.
  const seen = { 0: ['a'], o0: ['x', 'y'] };
  assert.deepEqual(pickEndlessLane([1], [3], seen, () => 0.99),
    { page: 0, over: true, cycled: false },
    'one over board left unseen; the fit page is exhausted');
  // ONE shared cycle: only when BOTH classes are fully seen does it reset,
  // over the full union.
  assert.equal(pickEndlessLane([1], [3], { 0: ['a'], o0: ['x', 'y', 'z'] }, () => 0).cycled, true);
  assert.equal(pickEndlessLane([], [], {}, () => 0).page, null);
});

test('endlessGlobalIndex resolves a flat board index across page boundaries', () => {
  assert.deepEqual(endlessGlobalIndex([2, 3], 0), { page: 0, idx: 0 });
  assert.deepEqual(endlessGlobalIndex([2, 3], 2), { page: 1, idx: 0 });
  assert.deepEqual(endlessGlobalIndex([2, 3], 4), { page: 1, idx: 2 });
  assert.deepEqual(endlessGlobalIndex([2, 3], 5), { page: 0, idx: 0 }, 'wraps modulo the total');
  assert.equal(endlessGlobalIndex([], 0), null);
});

test('an endless deal re-certifies, marks the GLOBAL seen-cycle, and practice never does', async () => {
  resetLane();
  setEndlessSeen({});
  stubEndlessFetch();
  const res = await dealClimbBoard(251);
  assert.ok(res, 'the endless deal succeeds on a healthy library');
  assert.ok(res.check.solvable && res.check.remainingUnknowns === 0,
    'the dealt board re-certifies at the point of play');
  assert.ok(res.spec && res.features, 'spec and features ride along like a ladder deal');
  const seenMap = getEndlessSeen();
  const marked = Object.values(seenMap).flat();
  assert.deepEqual(marked, [res.seed], 'dealt means seen, his rule, in the one global map');

  setEndlessSeen({});
  state.isLevelPractice = true;
  await dealClimbBoard(300);
  assert.deepEqual(getEndlessSeen(), {},
    'practice shares this localStorage with production and must not advance the cycle');
  state.isLevelPractice = false;
});

test('a board cannot come up again until every other board has been served', async () => {
  // His rule verbatim, at library scale: seed the seen map with three of the
  // four boards; the deal MUST produce the unserved one, whatever the rolls.
  resetLane();
  stubEndlessFetch();
  const all = endlessFixture.pages.flatMap((p) => p.boards.map((b) => b.seed));
  const unserved = all[3];
  setEndlessSeen({ 0: [all[0], all[1]], 1: [all[2]] });
  const res = await dealClimbBoard(999);
  assert.equal(res.seed, unserved, 'the last unserved board is the only legal deal');

  // And with everything served, the cycle resets to a fresh single-entry map.
  setEndlessSeen({ 0: [all[0], all[1]], 1: [all[2], all[3]] });
  const res2 = await dealClimbBoard(999);
  assert.ok(res2, 'a fully-served library still deals');
  const seenMap = getEndlessSeen();
  assert.deepEqual(Object.values(seenMap).flat(), [res2.seed], 'the cycle restarted at one');
  setEndlessSeen({});
});

test('the ?level=&board= override resolves a deterministic endless venue', async () => {
  resetLane({ practice: true, forced: 3 });
  stubEndlessFetch();
  const res = await dealClimbBoard(251);
  assert.equal(res.seed, endlessFixture.pages[1].boards[1].seed,
    'global index 3 is page 1, board 1');
  state.isLevelPractice = false;
  state.climbBoardIndex = null;
});

test('every endless failure degrades to null for the drawn fallback', async () => {
  resetLane();
  setEndlessSeen({});
  globalThis.fetch = async () => { throw new Error('network down'); };
  assert.equal(await dealClimbBoard(251), null);

  // A dead page behind a healthy index.
  globalThis.fetch = async (url) => (url === endlessIndexUrl()
    ? { ok: true, json: async () => endlessFixture.index }
    : { ok: false, status: 404, json: async () => null });
  assert.equal(await dealClimbBoard(251), null);

  // A tampered payload fails the point-of-play certification.
  const poisoned = JSON.parse(JSON.stringify(endlessFixture));
  for (const p of poisoned.pages) {
    for (const b of p.boards) {
      for (const cell of b.payload.cells) {
        if (!cell.isMine) { cell.isMine = true; break; }
      }
    }
  }
  stubEndlessFetch(poisoned);
  assert.equal(await dealClimbBoard(251), null,
    'a tampered endless board falls back to drawing');
  setEndlessSeen({});
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
