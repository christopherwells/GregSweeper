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
import { DAILY_PAR_BAND } from '../src/logic/parBand.js';

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

// ── Par banding (Christopher's ruling 2026-08-02, parBand.js) ─────────
// The optional third argument multiplies each NON-decorrelation entry's
// score by its band weight before the draw. These pins are the composition
// rules: the band must never touch the decorrelation contest, must
// disengage cleanly on par-less pools, and must be a provable no-op when
// every candidate prices identically.

const BAND = { targetPar: 70, band: DAILY_PAR_BAND };
const withPars = pars => LIVE_SHAPE.map((e, i) => ({ ...e, par: pars[i] }));

test('bandCtx with a par-less pool disengages — winner identical to the legacy draw', () => {
  for (let i = 0; i < 30; i++) {
    const date = `2026-08-${String((i % 28) + 1).padStart(2, '0')}b${i}`;
    assert.equal(
      selectMissionWinner(LIVE_SHAPE, date, BAND).seed,
      selectMissionWinner(LIVE_SHAPE, date).seed,
      'no entry carries par → the band step must not exist',
    );
  }
});

test('equal pars make the band a no-op — same winner, same rng stream position', () => {
  // With every candidate at the same par the kernel is a shared constant, so
  // the weighted draw must resolve to EXACTLY the legacy winner on the same
  // single rng() call. This is the one-draw-per-date contract: a banded
  // client and a pre-band client walk the same stream.
  const flat = withPars(LIVE_SHAPE.map(() => 70));
  for (let i = 0; i < 40; i++) {
    const date = `2026-08-${String((i % 28) + 1).padStart(2, '0')}c${i}`;
    assert.equal(
      selectMissionWinner(flat, date, BAND).seed,
      selectMissionWinner(LIVE_SHAPE, date).seed,
    );
  }
});

test('REGRESSION: an out-of-band candidate never wins while an in-band one exists', () => {
  // 300s is past the 240s daily ceiling — the hard clamp, the rule that ends
  // the 5% of past dailies that shipped above the (then-180s) line.
  const pars = [300, 70, 300, 300, 300, 300, 300, 300];
  const entries = withPars(pars);
  for (let i = 0; i < 40; i++) {
    const date = `2026-08-${String((i % 28) + 1).padStart(2, '0')}d${i}`;
    assert.equal(selectMissionWinner(entries, date, BAND).seed, 't1',
      'only the in-band candidate may win, regardless of scores');
  }
});

test('decorrelation supremacy is checked on RAW scores — the band never touches it', () => {
  // The decorrelation entry prices far outside the band; it still wins
  // outright at depth, because its R-derived weight is calibrated against
  // the un-banded contest and those rare days chase a residual corner.
  const entries = [
    ...withPars(LIVE_SHAPE.map(() => 70)),
    { score: 0.72, mission: { target: 'clueShare3', type: 'decorrelation' }, seed: 'd0', par: 500 },
  ];
  for (let i = 0; i < 30; i++) {
    const date = `2026-08-${String((i % 28) + 1).padStart(2, '0')}e${i}`;
    assert.equal(selectMissionWinner(entries, date, BAND).seed, 'd0');
  }
});

test('an all-zero-score pool draws by band weight, not uniformly', () => {
  // No mission signal → the band alone decides. The out-of-band entry
  // weighs 0, so the in-band one must win every date.
  const zeros = [
    { score: 0, mission: { target: 'a' }, seed: 'z0', par: 300 },
    { score: 0, mission: { target: 'b' }, seed: 'z1', par: 70 },
  ];
  for (let i = 0; i < 30; i++) {
    const date = `2026-08-${String((i % 28) + 1).padStart(2, '0')}f${i}`;
    assert.equal(selectMissionWinner(zeros, date, BAND).seed, 'z1');
  }
});

test('an all-out-of-band pool still resolves — nearest-in-log by the unclamped kernel', () => {
  const entries = [
    { score: 1, mission: { target: 'a' }, seed: 'o0', par: 700 },
    { score: 1, mission: { target: 'b' }, seed: 'o1', par: 280 },
  ];
  // 280 is nearer the 70s target than 700 in log-ratio; with equal scores it
  // must dominate the draw overwhelmingly (kernel ratio ~ e^17), so every
  // frozen date resolves to it.
  for (let i = 0; i < 30; i++) {
    const date = `2026-08-${String((i % 28) + 1).padStart(2, '0')}g${i}`;
    assert.equal(selectMissionWinner(entries, date, BAND).seed, 'o1');
  }
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
