// boardHeatmap/{date} rules structure contract. The heatmap is rolled up
// server-side (write-once) and world-readable so the journal exhibit can
// read it without extra auth. The payload shape must stay pinned: a
// plain daily date key, the required aggregate fields, per-cell values
// that are counts and nothing else, the server-sentinel timestamp, and a
// strict $other catch-all so no unvalidated field rides in.
//
// The stakes: the root $other is {".read": false, ".write": false}, so a
// missing block here does not fail loudly, it drops every write
// silently (the 866683d class of bug). Companion to
// test/heatmapAggregate.test.mjs.
//
// Run: node --test test/heatmapRules.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rules = JSON.parse(readFileSync(new URL('../firebase-rules.json', import.meta.url), 'utf8')).rules;

test('REGRESSION: boardHeatmap is world-readable and writable by NOBODY', () => {
  const node = rules.boardHeatmap;
  assert.ok(node, 'boardHeatmap block missing — the root $other:false would drop every read path');
  assert.equal(node['.read'], true, 'the journal exhibit reads it directly — must be public');
  // The ONLY writer is scripts/rollup-board-heatmap.mjs, which holds the
  // service account and so bypasses rules entirely. No client writes
  // this node, ever. The sibling blocks this was cloned from (cruxes,
  // dailyBoard) grant `auth != null && !data.exists()` because they have
  // a legitimate first-client fallback writer; copying that grant here
  // would let any anonymous visitor pre-claim a date and permanently
  // publish a fabricated per-cell mine map under Greg's byline, with a
  // forged n_players sailing past the honesty gate. There is no
  // signature layer on this node and the nightly canonical sweep does
  // not cover it, so the write rule IS the defense.
  assert.equal(node.$date?.['.write'], false,
    'no client may write a heatmap — the rollup uses the service account');
  const dateRe = node.$date?.['.validate'];
  assert.ok(dateRe.includes('\\d{4}-\\d{2}-\\d{2}'), 'must validate a YYYY-MM-DD key');
  assert.ok(!dateRe.includes('weekly_first'),
    'heatmap dates are daily-only (weekly boards have no dailyBoard anchor)');
});

test('boardHeatmap.$date: required aggregate fields are pinned', () => {
  const v = rules.boardHeatmap?.$date?.['.validate'];
  for (const field of ['rows', 'cols', 'totals', 'n_players', 'writtenAt']) {
    assert.ok(v.includes(`'${field}'`), `${field} must be a required child`);
  }
});

test('boardHeatmap.$date: cells stays OPTIONAL so a clean board can publish', () => {
  // A board nobody detonated aggregates to an empty cells map, and
  // Firebase treats an empty object as a delete — requiring `cells`
  // would reject exactly the boards with the happiest story.
  const v = rules.boardHeatmap?.$date?.['.validate'];
  assert.ok(!v.includes("'cells'"), 'cells must not be in the required-children list');
  const cells = rules.boardHeatmap?.$date?.cells;
  assert.ok(cells, 'cells must still be whitelisted — strict $other:false would reject it otherwise');
  assert.ok(cells['.validate'].includes('newData.val() === null'),
    'an absent cells map must validate');
});

test('boardHeatmap.$date: per-cell entries are r_c keys holding positive counts', () => {
  const cell = rules.boardHeatmap?.$date?.cells?.$cell?.['.validate'];
  assert.ok(cell, 'per-cell validate missing');
  assert.ok(cell.includes('\\d{1,2}_\\d{1,2}'), 'cell keys must be the r_c coordinate form');
  assert.ok(cell.includes('newData.isNumber()'), 'a cell holds a count, never a nested object');
  assert.ok(cell.includes('>= 1'), 'a zero-count cell is simply absent, never written');
});

test('boardHeatmap.$date: counts are bounded and non-negative', () => {
  const node = rules.boardHeatmap?.$date;
  for (const field of ['totals', 'n_players']) {
    const v = node[field]?.['.validate'];
    assert.ok(v?.includes('newData.isNumber()'), `${field} must be a number`);
    assert.ok(v?.includes('>= 0'), `${field} must be non-negative`);
  }
  for (const field of ['rows', 'cols']) {
    assert.ok(node[field]?.['.validate']?.includes('<= 16'),
      `${field} must stay inside the board-size ceiling`);
  }
});

test('boardHeatmap.$date: server-sentinel timestamp + strict whitelist', () => {
  const node = rules.boardHeatmap?.$date;
  assert.equal(node.writtenAt?.['.validate'], 'newData.val() === now',
    'writtenAt must be the ServerValue.TIMESTAMP sentinel only');
  assert.equal(node.$other?.['.validate'], false,
    'strict $other catch-all must survive so no unvalidated field rides in');
});
