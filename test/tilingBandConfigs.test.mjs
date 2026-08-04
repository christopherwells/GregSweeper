// Banded tiling daily configs (Par Bands, Phase 2) — the table contract,
// the date-seeded draw, and the dark-default control.
//
// The heavyweight generation PROOF for every entry lives in
// scripts/calibrate-tiling-band-configs.mjs (plain + per-gimmick + stacked
// probes; minutes, not CI). What CI pins here is everything cheap that can
// rot silently: table structural validity (storability, proven density
// ranges, constructive routing), the frozen features pricing INSIDE the
// daily band at the SHIPPED equations (the designed alarm — a nightly refit
// that moves a shape's equation far enough to push an entry out of the band
// reddens this test on the refit's own commit, and the fix is re-running
// the calibrator, never widening the band), draw determinism, band
// tracking, and the fallback semantics buildTilingDailyBoard's retry loop
// leans on.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TILING_BAND_CONFIGS, priceBandEntry, bandEntryFeatures,
  pickBandedEntry, tilingConfigAttempts, drawDailyTilingConfig,
} from '../src/logic/tilingBandConfigs.js';
import { DAILY_PAR_BAND, drawDailyTargetPar } from '../src/logic/parBand.js';
import { TILING_TYPES, buildTiling, containerIsStorable } from '../src/logic/tilingGeometry.js';
import { CONSTRUCTIVE_DENSITY_THRESHOLD } from '../src/logic/tilingGenerator.js';
import { createDailyRNG } from '../src/logic/seededRandom.js';

// Proven density ranges per lattice (the Par Lab grid + the constructive
// floor findings): entries outside these have no generation evidence.
const DENSITY_FLOOR = {
  '4.8.8': 0.14, hex: 0.14, cairo: 0.18, floret: 0.18, deltoidal: 0.18,
  rhombille: 0.23, // sparse no-guess rhombille is unfindable (0/12 at 0.211)
};
const DENSITY_CAP = 0.29; // the lab measured nothing above 0.28

const LAVES = ['cairo', 'floret', 'rhombille', 'deltoidal'];

function dates(n, from = '2027-01-01') {
  const out = [];
  const d = new Date(`${from}T12:00:00Z`);
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// ── Table structure ──────────────────────────────────────────────────────

test('the table covers exactly TILING_TYPES, with a designated fallback per shape', () => {
  assert.deepEqual(Object.keys(TILING_BAND_CONFIGS).sort(), TILING_TYPES.slice().sort());
  for (const type of TILING_TYPES) {
    const entries = TILING_BAND_CONFIGS[type];
    assert.ok(entries.length >= 4, `${type} needs enough entries for the kernel to choose among (got ${entries.length})`);
    assert.equal(entries.filter((e) => e.fallback === true).length, 1,
      `${type} needs exactly one designated generation-failure fallback entry`);
    const ids = new Set(entries.map((e) => e.id));
    assert.equal(ids.size, entries.length, `${type} entry ids must be unique`);
  }
});

test('every entry is storable, inside its lattice\'s proven density range, and honestly featured', () => {
  for (const type of TILING_TYPES) {
    for (const e of TILING_BAND_CONFIGS[type]) {
      const total = buildTiling(type, e.M, e.N).total;
      assert.ok(containerIsStorable(total),
        `${type}/${e.id}: ${total} cells must factor into a canonical-storable container`);
      const density = e.mines / total;
      // Half-a-mine tolerance below the floor: mine counts are integers, so
      // the floor is only reachable as Math.round(total x floor) — the lab's
      // own mineCountFor convention (72 cells x 0.14 rounds to 10 mines,
      // density 0.139, and that config IS the proven floor config).
      assert.ok(density >= DENSITY_FLOOR[type] - 0.5 / total && density <= DENSITY_CAP + 1e-9,
        `${type}/${e.id}: density ${density.toFixed(3)} outside the proven [${DENSITY_FLOOR[type]}, ${DENSITY_CAP}]`);
      assert.ok(e.mines >= 5, `${type}/${e.id}: below the 5-mine floor`);
      // The frozen vector's exact halves must be exact — a table typo here
      // prices a config that does not exist.
      assert.equal(e.features.cellCount, total, `${type}/${e.id}: features.cellCount must equal the real cell total`);
      assert.equal(e.features.totalMines, e.mines, `${type}/${e.id}: features.totalMines must equal mines`);
      // Sub-threshold Laves entries MUST route constructive (rejection
      // sampling is weak exactly there; the flag is the routing).
      if (LAVES.includes(type) && density <= CONSTRUCTIVE_DENSITY_THRESHOLD) {
        assert.equal(e.constructive, true,
          `${type}/${e.id}: density ${density.toFixed(3)} needs constructive: true`);
      }
    }
  }
});

test('rhombille entries respect the 72-cell generation-cost ceiling', () => {
  // Christopher's ruling (the 90-cell fixture measured 13.7 s worst-case):
  // rotation rhombille never exceeds the proven 72-cell scale.
  for (const e of TILING_BAND_CONFIGS.rhombille) {
    assert.ok(buildTiling('rhombille', e.M, e.N).total <= 72,
      `rhombille/${e.id} exceeds the 72-cell cost ceiling`);
  }
});

// ── Pricing (the refit-drift alarm) ──────────────────────────────────────

test('every entry prices INSIDE the daily band at the shipped equations, and each shape spans the band usefully', () => {
  for (const type of TILING_TYPES) {
    const prices = TILING_BAND_CONFIGS[type].map((e) => priceBandEntry(type, e));
    for (let i = 0; i < prices.length; i++) {
      const e = TILING_BAND_CONFIGS[type][i];
      assert.ok(prices[i] >= DAILY_PAR_BAND.lo && prices[i] <= DAILY_PAR_BAND.hi,
        `${type}/${e.id} prices ${prices[i]}s — outside the daily band [${DAILY_PAR_BAND.lo}, ${DAILY_PAR_BAND.hi}]. `
        + 'A refit moved this shape\'s equation past the entry\'s margin: re-run '
        + 'scripts/calibrate-tiling-band-configs.mjs and retune the table (never widen the band).');
    }
    const span = Math.max(...prices) / Math.min(...prices);
    assert.ok(span >= 2,
      `${type} table spans only x${span.toFixed(2)} of par — too narrow for the band to steer (need >= x2)`);
  }
});

test('bandEntryFeatures carries the shape key so pricing dispatches to the shape block', () => {
  const e = TILING_BAND_CONFIGS.hex[0];
  assert.equal(bandEntryFeatures('hex', e).tilingType, 'hex');
  // Dispatch is real: the same frozen features priced as a different shape
  // must move (the blocks differ), or the whole per-shape design is inert.
  const asHex = priceBandEntry('hex', e);
  const asDeltoidal = priceBandEntry('deltoidal', e);
  assert.notEqual(asHex, asDeltoidal, 'per-shape dispatch must be live in pricing');
});

// ── The draw ─────────────────────────────────────────────────────────────

test('pickBandedEntry consumes exactly one rng() call on every path', () => {
  const counting = (seq) => {
    let n = 0;
    return { rng: () => { n++; return seq; }, calls: () => n };
  };
  // Normal slate.
  let c = counting(0.5);
  pickBandedEntry(c.rng, [40, 80, 160], 60);
  assert.equal(c.calls(), 1);
  // All out-of-band (kernel fallback).
  c = counting(0.5);
  pickBandedEntry(c.rng, [500, 900], 60);
  assert.equal(c.calls(), 1);
  // Degenerate: no finite prices.
  c = counting(0.5);
  assert.equal(pickBandedEntry(c.rng, [NaN, NaN], 60), 0);
  assert.equal(c.calls(), 1);
});

test('pickBandedEntry weights by band closeness: near-target entries dominate, out-of-band never wins against in-band', () => {
  const prices = [40, 80, 300]; // 300 is outside [20, 240] — weight 0
  const picks = [0, 0, 0];
  for (let i = 0; i < 400; i++) {
    const rng = createDailyRNG(`bandpick:${i}`);
    picks[pickBandedEntry(rng, prices, 42)]++;
  }
  assert.equal(picks[2], 0, 'an out-of-band entry must never be drawn while in-band entries exist');
  assert.ok(picks[0] > picks[1] * 3,
    `the near-target entry must dominate a 2x-off one (got ${picks[0]} vs ${picks[1]})`);
});

test('an all-out-of-band slate falls back to the raw kernel (nearest wins most)', () => {
  const prices = [300, 500]; // both above the band
  const picks = [0, 0];
  for (let i = 0; i < 200; i++) {
    const rng = createDailyRNG(`bandpick-oob:${i}`);
    picks[pickBandedEntry(rng, prices, 240)]++;
  }
  assert.ok(picks[0] > picks[1] * 2, `nearest-the-band must dominate (got ${picks[0]} vs ${picks[1]})`);
});

test('the date draw is deterministic, and its attempts list is drawn-then-fallback', () => {
  for (const type of TILING_TYPES) {
    const a = tilingConfigAttempts(type, '2027-04-01');
    const b = tilingConfigAttempts(type, '2027-04-01');
    assert.deepEqual(a.map((e) => e.id), b.map((e) => e.id), `${type} attempts must be stable across calls`);
    assert.ok(a.length >= 1 && a.length <= 2);
    const fallback = TILING_BAND_CONFIGS[type].find((e) => e.fallback === true);
    if (a.length === 2) {
      assert.equal(a[1].id, fallback.id, `${type}: second attempt must be the designated fallback`);
      assert.notEqual(a[0].id, a[1].id, `${type}: attempts must be deduped`);
    } else {
      assert.equal(a[0].id, fallback.id, `${type}: a one-entry list means the draw landed on the fallback itself`);
    }
    assert.equal(drawDailyTilingConfig(type, '2027-04-01').id, a[0].id);
  }
});

test('a missing or malformed date yields the fallback entry, deterministically, never a throw', () => {
  for (const bad of [undefined, null, '', 'not-a-date', '2027-4-1']) {
    const got = tilingConfigAttempts('deltoidal', bad);
    assert.equal(got.length, 1);
    assert.equal(got[0].fallback, true);
  }
  assert.deepEqual(tilingConfigAttempts('no-such-shape', '2027-04-01'), []);
});

test('across dates, the draw tracks the target par and reaches the whole table', () => {
  const sample = dates(400, '2027-01-01');
  for (const type of TILING_TYPES) {
    const entries = TILING_BAND_CONFIGS[type];
    const prices = entries.map((e) => priceBandEntry(type, e));
    const seen = new Set();
    let bandedErr = 0;
    let uniformErr = 0;
    for (const d of sample) {
      const target = drawDailyTargetPar(d);
      const drawn = drawDailyTilingConfig(type, d);
      seen.add(drawn.id);
      const drawnPar = prices[entries.indexOf(drawn)];
      bandedErr += Math.abs(Math.log(drawnPar / target));
      // The uniform-draw baseline the banding must beat: the same dates'
      // targets against the table's mean log-distance.
      const mean = prices.reduce((a, p) => a + Math.abs(Math.log(p / target)), 0) / prices.length;
      uniformErr += mean;
    }
    // Variety: the lottery must exercise the whole table (the config
    // variation that keeps the per-shape size/density deviations
    // identifiable from live rows — the collinearity the fixed configs
    // could never break).
    assert.equal(seen.size, entries.length,
      `${type}: every table entry must be reachable over a year of dates (drew ${seen.size}/${entries.length})`);
    // Tracking: the banded draw must land meaningfully closer to targets
    // than a uniform table draw would.
    assert.ok(bandedErr < uniformErr * 0.72,
      `${type}: banded draw must track the target (banded ${bandedErr.toFixed(1)} vs uniform ${uniformErr.toFixed(1)})`);
  }
});

// The deterministic chain, pinned in the ONE place a refit cannot move it.
//
// This used to freeze the drawn entry id for a handful of (date, shape) pairs
// and assert on those. It looked like a strong pin and was actually a trap:
// the draw prices through the LIVE predictPar, so the nightly refit moves the
// picks legitimately, and the goldens reddened main on 2026-08-04 for no
// defect at all (hex's 2027-01-01 pick went h81d28 -> h110d25 when the fit
// updated). A guard that fires on routine, correct change is a guard people
// learn to re-baseline without reading, which is worse than not having it.
//
// So the pin is SPLIT. The lottery mechanism — namespace, kernel, index
// selection — is pinned against a FIXED price vector, where a refit has no
// say. The end-to-end draw is checked for the properties that must hold at
// ANY pricing: it is deterministic, it returns a real table entry, and its
// attempt list keeps the fallback contract.
test('MECHANISM: the banded lottery is frozen against a fixed price vector', () => {
  // Synthetic prices, so this asserts on the DRAW and nothing else. If the
  // namespace, the kernel width, or the index arithmetic changes, these move;
  // if a shape's equation moves, they cannot.
  const prices = [30, 60, 90, 120, 180, 240];
  const rngAt = (u) => () => u;

  // A target sitting on an entry picks it as the lottery's mass concentrates.
  assert.equal(pickBandedEntry(rngAt(0.0), prices, 90), 0);
  assert.equal(pickBandedEntry(rngAt(0.999), prices, 90), prices.length - 1);

  // The draw is monotone in the uniform: walking u from 0 to 1 never goes
  // backwards through the entries.
  let prev = -1;
  for (let u = 0; u < 1; u += 0.02) {
    const i = pickBandedEntry(rngAt(u), prices, 90);
    assert.ok(i >= prev, `u=${u.toFixed(2)} picked ${i} after ${prev}`);
    prev = i;
  }

  // Out-of-band entries take zero weight: with a target far below the whole
  // vector, the draw cannot land on the dearest entry.
  const picks = new Set();
  for (let u = 0; u < 1; u += 0.01) picks.add(pickBandedEntry(rngAt(u), prices, 30));
  assert.ok(!picks.has(prices.length - 1),
    'a 240s entry must take no weight against a 30s target');
});

test('the end-to-end draw holds at ANY pricing', () => {
  // Everything the frozen ids were really guarding, minus the pricing they
  // could not help depending on.
  for (const type of TILING_TYPES) {
    const table = TILING_BAND_CONFIGS[type];
    const fallback = table.find((e) => e.fallback === true) || table[0];
    for (const date of ['2027-01-01', '2027-01-05', '2027-01-07', '2027-06-30']) {
      const drawn = drawDailyTilingConfig(type, date);
      assert.ok(table.includes(drawn), `${type} ${date}: drew a non-table entry`);
      assert.equal(drawDailyTilingConfig(type, date), drawn,
        `${type} ${date}: the draw must be deterministic`);

      const attempts = tilingConfigAttempts(type, date);
      assert.equal(attempts[0], drawn, 'the first attempt is the drawn entry');
      assert.equal(attempts[attempts.length - 1], fallback,
        "the last attempt is the shape's designated fallback");
      assert.ok(attempts.length <= 2, 'at most drawn + fallback');
    }
  }
});
