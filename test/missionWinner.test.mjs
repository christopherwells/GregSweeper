// The daily mission winner-pick: a date-seeded weighted LOTTERY, not an
// argmax (selectMissionWinner in experimentDesign.js).
//
// Incident (2026-07-30, Christopher's report: "the model is serving almost
// exclusively worm puzzles"): coverage deficit weights move slowly
// (1/(n_boards+1), n_boards grows ~one per day), so the argmax handed the
// top-deficit mission every single daily until it saturated — worm won 10 of
// 12 shipped dates and every precomputed future board, because
// min(wormLoad, COUNT_CAP) × 0.143 ≈ 0.71 while every other slot's ceiling
// sat near 0.36. Same lesson as PR F1 from the other side: a weight sets who
// wins a contest, never how often a mission runs. The lottery makes score
// the mission's FREQUENCY (P ∝ score), so the most undersampled gimmick is
// the likeliest daily but never the only one.
//
// Determinism is load-bearing: the draw is seeded from the date alone, so
// every client and the precompute resolve the same winner for the same date
// and pool. Both selection paths (selectDailyRngSeed.js and
// scripts/daily-board-pipeline.mjs) must call THIS function — the winner-pick
// used to exist as two argmax copies, the mirror-pair shape whose slot
// arithmetic had already drifted once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectMissionWinner } from '../src/logic/experimentDesign.js';

// The live 2026-07-30 shape, reduced: worm's slot score dwarfs the rest but
// is nowhere near the total. Slot order matches the coverage list.
const LIVE_SHAPE = [
  { score: 0.30, mission: { target: 'compassCellCount', isPrimary: true }, seed: 't0' },
  { score: 0.71, mission: { target: 'wormLoad' }, seed: 't1' },
  { score: 0.17, mission: { target: 'wormholePairCount' }, seed: 't2' },
  { score: 0.36, mission: { target: 'mysteryCellCount' }, seed: 't3' },
  { score: 0.21, mission: { target: 'sonarCellCount' }, seed: 't4' },
  { score: 0.27, mission: { target: 'liarCellCount' }, seed: 't5' },
  { score: 0.13, mission: { target: 'mirrorPairCount' }, seed: 't6' },
  { score: 0.24, mission: { target: 'lockedCellCount' }, seed: 't7' },
];

function winnersOver(days, entries = LIVE_SHAPE) {
  const wins = {};
  for (let i = 0; i < days; i++) {
    const date = `2026-08-${String((i % 28) + 1).padStart(2, '0')}x${Math.floor(i / 28)}`;
    const w = selectMissionWinner(entries, date);
    wins[w.mission.target] = (wins[w.mission.target] || 0) + 1;
  }
  return wins;
}

test('REGRESSION: the top-scoring mission no longer owns every day (worm monoculture)', () => {
  const wins = winnersOver(60);
  const wormShare = (wins.wormLoad || 0) / 60;
  // Under the old argmax this was 100%. Expected share under the lottery is
  // 0.71/2.39 ≈ 30%; the bounds are loose so the pin survives any future
  // reseeding of the draw stream, but 60% would mean argmax is back.
  assert.ok(wormShare > 0.05 && wormShare < 0.6,
    `worm should win SOME days, not all or none (won ${Math.round(wormShare * 100)}%)`);
  // Rotation means the calendar is shared: most missions get days.
  assert.ok(Object.keys(wins).length >= 5,
    `at least 5 distinct missions should win across 60 days (got ${Object.keys(wins).join(', ')})`);
});

test('the draw is deterministic per date — every client resolves the same winner', () => {
  for (const date of ['2026-08-01', '2026-08-02', '2026-09-15']) {
    const a = selectMissionWinner(LIVE_SHAPE, date);
    const b = selectMissionWinner(LIVE_SHAPE, date);
    assert.equal(a.seed, b.seed, `same date must draw the same winner (${date})`);
  }
});

test('frequency tracks score: the heaviest mission wins the most days', () => {
  const wins = winnersOver(400);
  const worm = wins.wormLoad || 0;
  for (const [target, n] of Object.entries(wins)) {
    if (target === 'wormLoad') continue;
    assert.ok(worm >= n, `wormLoad (score 0.71) should out-win ${target} over 400 draws (${worm} vs ${n})`);
  }
  // And the lightest nonzero mission is not starved out entirely.
  assert.ok((wins.mirrorPairCount || 0) > 0, 'the lightest mission still gets days');
});

test('a decorrelation slot holding the top score wins outright — no draw', () => {
  // The F1 calibration derives the decorrelation weight to TIE the strongest
  // coverage mission at the target residual depth, under argmax semantics.
  // The lottery must not re-tune that: at depth, decorrelation takes the day.
  const entries = [
    ...LIVE_SHAPE,
    { score: 0.72, mission: { target: 'clueShare3', type: 'decorrelation' }, seed: 'd0' },
  ];
  for (let i = 0; i < 40; i++) {
    const w = selectMissionWinner(entries, `2026-08-${String((i % 28) + 1).padStart(2, '0')}y${i}`);
    assert.equal(w.seed, 'd0', 'top-scoring decorrelation must win every date');
  }
});

test('a decorrelation slot BELOW the top score never enters the draw', () => {
  // It wins at depth or not at all — its frequency mechanism is the 7-day
  // cadence, not the lottery.
  const entries = [
    ...LIVE_SHAPE,
    { score: 0.70, mission: { target: 'clueShare3', type: 'decorrelation' }, seed: 'd0' },
  ];
  for (let i = 0; i < 60; i++) {
    const w = selectMissionWinner(entries, `2026-08-${String((i % 28) + 1).padStart(2, '0')}z${i}`);
    assert.notEqual(w.seed, 'd0', 'a shallow decorrelation slot must not win by draw');
  }
});

test('an all-zero pool still rotates (uniform draw), and edge pools behave', () => {
  const zeros = [
    { score: 0, mission: { target: 'a' }, seed: 'z0' },
    { score: 0, mission: { target: 'b' }, seed: 'z1' },
    { score: 0, mission: { target: 'c' }, seed: 'z2' },
  ];
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    seen.add(selectMissionWinner(zeros, `2026-08-${String((i % 28) + 1).padStart(2, '0')}u${i}`).seed);
  }
  assert.ok(seen.size >= 2, `zero-score days must not freeze on the first slot (saw ${[...seen].join(', ')})`);
  assert.equal(selectMissionWinner([], '2026-08-01'), null, 'empty pool → null');
  assert.equal(selectMissionWinner(null, '2026-08-01'), null, 'no pool → null');
  const one = [{ score: 0.5, mission: { target: 'a' }, seed: 'only' }];
  assert.equal(selectMissionWinner(one, '2026-08-01').seed, 'only', 'singleton pool wins');
});

test('both selection paths delegate the winner-pick (no argmax copies)', () => {
  // The mirror-pair drift guard: each path must import and call
  // selectMissionWinner, and neither may keep a private best-score argmax.
  for (const path of ['../src/logic/selectDailyRngSeed.js', '../scripts/daily-board-pipeline.mjs']) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.ok(src.includes('selectMissionWinner('),
      `${path} must resolve its winner through selectMissionWinner`);
    assert.ok(!/bestScore\s*=\s*-Infinity/.test(src),
      `${path} must not keep a private argmax`);
  }
});
