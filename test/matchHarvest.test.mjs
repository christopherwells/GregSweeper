// The harvest: the Climb library dealt into Challenge (his 'Do this first',
// 2026-08-16), and above everything his inviolable: "The climb times do
// finish DO NOT TRANSFER!" Nothing crosses between the modes in either
// direction. These tests pin the row format, the stale-locator guard, the
// seen-key namespace, the no-transfer boundary, and the shipped index's
// lockstep with the files it was derived from.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  climbIndexRow, parseClimbMatchIndex, resolveMatchPicks, pickMatchBoards,
  matchCornerKey, matchShardFile, CLIMB_SHARD_PREFIX, countEligibleCorners,
  parseMatchSummary, eligibleRows,
} from '../src/logic/matchRules.js';

const LIB = fileURLToPath(new URL('../scripts/data/climb-library/', import.meta.url));

const entry = (seed, over = {}) => ({
  seed,
  par: 90,
  payload: { rows: 5, cols: 5 },
  features: { cellCount: 25, totalMines: 5 },
  spec: { shape: 'rect', cells: 25, mines: 5, gimmicks: ['sonar'], ...over },
});

// ── Row format round trip ───────────────────────────────────────────────

test('a harvest row round-trips with its seed and keys as c:<seed>', () => {
  const keys = ['cellCount', 'totalMines'];
  const row = climbIndexRow('level-042', 3, entry('s-abc'), keys);
  const parsed = parseClimbMatchIndex({ featureKeys: keys, rows: [row] });
  assert.equal(parsed.length, 1);
  const r = parsed[0];
  assert.equal(r.page, 'level-042');
  assert.equal(r.idx, 3);
  assert.equal(r.seed, 's-abc');
  assert.equal(r.key, 'c:s-abc', 'seen keys are seed-namespaced: re-bins renumber files');
  assert.deepEqual(r.mods, ['sonar']);
  assert.equal(r.features.cellCount, 25);
  // The corner derivation reads harvest rows exactly as match rows (par 90
  // is quick under his two-and-four-minute cutoffs).
  assert.deepEqual(matchCornerKey(r), ['rect', 'sonar', 'quick', 'standard']);
});

test('a malformed harvest shard parses to null, never to a partial deal', () => {
  assert.equal(parseClimbMatchIndex({ rows: [['level-1', 0, 'rect', 25]] }), null);
  assert.equal(parseClimbMatchIndex({ rows: [['level-1', 0, 'rect', 25, 5, 90, [], '', []]] }), null,
    'an empty seed is a row with no identity');
});

// ── The stale-locator guard ─────────────────────────────────────────────

test('REGRESSION: a re-binned file cannot hand the deal somebody else\'s board', () => {
  // The nightly re-bin moves Climb boards between files, so an index cached
  // across it can point a locator at a different board. The pick carries the
  // seed the index promised; a mismatch reads as missing, never substitutes.
  const byPage = new Map([['level-042', [entry('the-new-tenant')]]]);
  const picks = [{ page: 'level-042', idx: 0, seed: 'the-promised-one', key: 'c:the-promised-one' }];
  const { entries, keys, missing } = resolveMatchPicks(picks, byPage);
  assert.equal(entries.length, 0);
  assert.equal(keys.length, 0);
  assert.equal(missing.length, 1);
  // And the same locator with the right tenant resolves.
  const ok = resolveMatchPicks(
    [{ page: 'level-042', idx: 0, seed: 'the-new-tenant', key: 'c:the-new-tenant' }], byPage);
  assert.equal(ok.entries.length, 1);
  assert.deepEqual(ok.keys, ['c:the-new-tenant']);
});

// ── The seen-cycle stays inside the match store ─────────────────────────

test('harvest picks mark MATCH seen keys only, in the c: namespace', () => {
  const rows = parseClimbMatchIndex({
    featureKeys: [],
    rows: [
      climbIndexRow('level-1', 0, entry('a')),
      climbIndexRow('level-1', 1, entry('b')),
      climbIndexRow('endless-2', 0, entry('c')),
    ],
  });
  const { picks } = pickMatchBoards(rows, 3, () => 0.5, []);
  assert.equal(picks.length, 3);
  for (const p of picks) {
    assert.match(p.key, /^c:/, 'every harvest seen key is seed-namespaced');
  }
  // And the seen cycle honors them: a second pick with those keys seen
  // draws nothing new until the space cycles.
  const seen = picks.map((p) => p.key);
  const again = pickMatchBoards(rows, 3, () => 0.5, seen);
  assert.equal(again.cycled, true, 'all seen means the cycle restarts, the standing rule');
});

test('NO TRANSFER: the match deal never touches a Climb store or its progression', () => {
  // Source-scan on the boundary his ruling names. The match deal path may
  // fetch Climb FILES (the shelf) but may never read or write the Climb's
  // seen-sets, checkpoints, or stats; the Climb, in turn, never reads match
  // results. A new import here is a design conversation, not a refactor.
  const dealSrc = readFileSync(fileURLToPath(new URL('../src/game/matchDeal.js', import.meta.url)), 'utf8');
  for (const banned of ['EndlessSeen', 'ClimbSeen', 'climb_endless_seen', 'maxLevelReached',
    'challenge250', 'getCheckpoint', 'saveProgress']) {
    assert.ok(!dealSrc.includes(banned), `matchDeal.js references "${banned}"`);
  }
  const climbSrc = readFileSync(fileURLToPath(new URL('../src/game/climbDeal.js', import.meta.url)), 'utf8');
  for (const banned of ['getMatchSeen', 'setMatchSeen', 'matchRecord', 'matchStandings']) {
    assert.ok(!climbSrc.includes(banned), `climbDeal.js references "${banned}"`);
  }
});

// ── The shipped index against the files it came from ────────────────────

test('the shipped harvest index is in lockstep with the Climb library', () => {
  const sumPath = LIB + 'climb-match-summary.json';
  assert.ok(existsSync(sumPath), 'the harvest summary ships with the library');
  const summary = JSON.parse(readFileSync(sumPath, 'utf8'));
  const corners = parseMatchSummary(summary);
  assert.ok(corners && corners.length > 0);

  // Every cmx shard parses, and the rows agree with the summary's total.
  let rowTotal = 0;
  const allRows = [];
  for (const f of readdirSync(LIB)) {
    if (!f.startsWith(`${CLIMB_SHARD_PREFIX}-`) || !f.endsWith('.json')) continue;
    const rows = parseClimbMatchIndex(JSON.parse(readFileSync(LIB + f, 'utf8')));
    assert.ok(rows, `${f} failed to parse`);
    rowTotal += rows.length;
    allRows.push(...rows);
    // Every row is in the shard its own corner names: the writer and the
    // deal derive the file from matchCornerKey, so drift here is a wrong
    // fetch at deal time.
    for (const r of rows) {
      const [shape, mods, time, density] = matchCornerKey(r);
      assert.equal(matchShardFile(shape, time, density, mods, CLIMB_SHARD_PREFIX), f);
    }
  }
  assert.equal(rowTotal, summary.boards, 'shards and summary count the same boards');

  // The sheet's count and the deal's filter agree over the union rules, the
  // same equality the match library pins for itself.
  const rules = {
    shapes: ['rect', 'hex', '4.8.8', 'cairo', 'floret', 'rhombille', 'deltoidal'],
    mods: ['sonar', 'walls', 'liar', 'mystery', 'locked', 'wormhole', 'mirror', 'compass', 'worm'],
    time: 'any', density: 'any',
  };
  assert.equal(countEligibleCorners(corners, rules), eligibleRows(allRows, rules).length);

  // Locator spot-check: the first rows of three shards point at real boards
  // whose seed matches, which is what the deal verifies per pick.
  let checked = 0;
  for (const r of allRows) {
    if (checked >= 3) break;
    const data = JSON.parse(readFileSync(`${LIB}${r.page}.json`, 'utf8'));
    const boards = Array.isArray(data) ? data : data.boards;
    assert.equal(boards[r.idx].seed, r.seed, `${r.page}#${r.idx}`);
    checked++;
  }
  assert.equal(checked, 3);
});
