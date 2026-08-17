// Calibrate + prove the tiling daily band-config tables (Phase 2 of the par
// bands: banded per-date configs replacing the fixed COASTLINE_BOARDS on
// tiling days — see src/logic/tilingBandConfigs.js).
//
// Two jobs, one run:
//
// 1. MEASURE a built-in candidate grid per shape (lattice sizes x densities
//    inside each lattice's PROVEN range): generate PROBES_PLAIN plain boards
//    per candidate on deterministic seeds, price each through the SHIPPED
//    per-shape equation (computeDailyFeatures + predictPar, exactly the
//    production pricing path), and report median par, spread, and the median
//    feature vector. The printed entry literal is what gets frozen into
//    TILING_BAND_CONFIGS.
//
// 2. PROVE any candidate that is in the COMMITTED table: on top of the plain
//    probes, every tiling-safe gimmick singly plus one stacked pair must
//    generate CERTIFIED (the COASTLINE_BOARDS proof pattern — production
//    boards carry a mission gimmick, so a config that only generates plain is
//    not proven). Also re-derives the frozen feature medians and reports
//    drift, and re-checks the frozen pricing against the live band.
//
// Generation is deterministic (seeded), so like validate-parlab-battery.mjs a
// config that passes here passes forever ON THESE SEEDS; arbitrary date seeds
// carry the residual risk the probe breadth exists to bound. Not in CI — the
// Laves lattices cost ~0.2-2.4 s per board and the full run is minutes.
//
//   node scripts/calibrate-tiling-band-configs.mjs             # full run
//   node scripts/calibrate-tiling-band-configs.mjs --shape=hex # one shape
//
// Re-run whenever the table changes, and after any refit that moves a shape
// equation enough to push a frozen entry near the band edge (the pricing
// test in test/tilingBandConfigs.test.mjs going red is the loud signal).
//
// Exit 1 on any committed-entry failure (null/uncertified probe, storability,
// out-of-band frozen pricing). Candidate-grid rows that are not in the table
// are informational only.

import { generateTilingBoard, TILING_SAFE_GIMMICKS, CONSTRUCTIVE_DENSITY_THRESHOLD } from '../src/logic/tilingGenerator.js';
import { buildTiling, containerIsStorable, TILING_TYPES } from '../src/logic/tilingGeometry.js';
import { computeDailyFeatures, predictPar } from '../src/logic/dailyFeatures.js';
import { DAILY_PAR_BAND } from '../src/logic/parBand.js';
import { TILING_BAND_CONFIGS, priceBandEntry } from '../src/logic/tilingBandConfigs.js';

const PROBES_PLAIN = 12;   // plain probes per candidate (feature medians + spread)
const STACK_PROBE = ['liar', 'mystery'];  // the stacked-pair proof, per committed entry

// The candidate grid. Sizes are (M, N) LATTICE dims whose cell totals are
// canonical-storable (a prime total forces a 1xN container and is refused —
// the 4.8.8's own S lattice from the Par Lab, 41 cells, is prime and absent
// here for exactly that reason, as is its 127/113-cell large end). Densities
// stay inside each lattice's proven range: open lattices measured down to
// 0.14 (the Par Lab grid floor), the Laves lattices to 0.18, rhombille to
// its own constructive floor 0.23 (sparse no-guess rhombille is unfindable
// — 0/12 at 0.211, reproduced at 0.18); everything caps at the lab's 0.28
// ceiling. Rhombille sizes cap at 72 cells (Christopher's ruling: the
// 90-cell fixture measured 13.7 s worst-case generation).
// Every size here must also clear boardFit's phone cap (2026-08-06), which is
// what retired the landscape entries this grid used to carry — a lattice board
// wider than the cap draws cells under the tap floor on a phone. Several are
// simply the old size TURNED: an M x N and an N x M patch of these lattices
// hold the same number of cells, and on a portrait phone only one of the two
// is playable. test/boardFit.test.mjs holds the committed table to the cap;
// this grid is kept in step by hand so the calibrator can actually PROVE the
// sizes the table ships (a committed entry absent from the grid is measured
// but never proven, which is how the first pass after the cap landed came back
// clean without having touched the changed entries).
const CANDIDATES = {
  '4.8.8': {
    sizes: [[5, 6], [6, 7], [7, 7], [8, 7], [12, 7]],
    densities: [0.14, 0.18, 0.187, 0.22, 0.25, 0.28],
  },
  hex: {
    sizes: [[7, 7], [9, 7], [9, 9], [11, 10]],
    densities: [0.14, 0.18, 0.22, 0.25, 0.28],
  },
  cairo: {
    // 10x4 (66 cells) was dropped 2026-08-07: it is the tall ribbon
    // MIN_WIDTH_USE was added to reject (204px of a 314px width budget), so
    // boardFitsPhone refuses it and it can never be committed. Cairo's totals
    // that are BOTH storable and phone-legal are 40, 45, 49, 60, 84, 110, 112;
    // 110 and 112 price past the 240s ceiling at any density under the current
    // equation, which is why the table tops out at 84.
    sizes: [[5, 6], [6, 6], [7, 7]],
    densities: [0.18, 0.21, 0.24, 0.28],
  },
  floret: {
    sizes: [[2, 3], [2, 4], [3, 4], [4, 4]],
    densities: [0.18, 0.21, 0.24, 0.28],
  },
  rhombille: {
    // The grid ends at 72 cells BY RULING (his 90-cell fixture measured
    // 13.7s worst-case generation: "rotation rhombille never exceeds the
    // proven 72-cell scale"). Under the 2026-08-17 correction fit that
    // caps the shape's daily par window at ~53-91s, under the x2 span the
    // band prefers; rhombille therefore carries a documented reach limit
    // in the band test, the deltoidal pattern, rather than a bigger grid.
    sizes: [[4, 4], [4, 5], [6, 4]],
    densities: [0.23, 0.255, 0.28],
  },
  deltoidal: {
    sizes: [[2, 3], [4, 2], [4, 3]],
    densities: [0.18, 0.21, 0.24, 0.28],
  },
};

const LAVES = ['cairo', 'floret', 'rhombille', 'deltoidal'];
const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const q = (xs, p) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))];
};

const shapeFilter = process.argv.find((a) => a.startsWith('--shape='))?.slice(8) || null;
const failures = [];

function probeOnce(type, M, N, mines, seed, gimmicks, forceConstructive) {
  const t0 = Date.now();
  const res = generateTilingBoard({ type, M, N, mines, seed, gimmicks, forceConstructive });
  const ms = Date.now() - t0;
  if (!res) return { ok: false, ms, why: 'null' };
  const certified = res.check.solvable && res.check.remainingUnknowns === 0;
  if (!certified) return { ok: false, ms, why: 'uncertified' };
  const features = computeDailyFeatures(
    {
      board: res.board, rows: res.rows, cols: res.cols,
      totalMines: mines, activeGimmicks: res.activeGimmicks, rngSeed: seed,
    },
    res.check,
  );
  return { ok: true, ms, features, par: predictPar(features) };
}

function measureCandidate(type, M, N, mines) {
  const total = buildTiling(type, M, N).total;
  const density = mines / total;
  // The committed entry's routing wins when one exists (an entry may carry
  // the flag outside the Laves default — e.g. a 4.8.8 sitting just under the
  // threshold, where sampling has a real per-seed failure rate); otherwise
  // the default rule: sub-threshold Laves lattices construct.
  const entry = committedEntry(type, M, N, mines);
  const constructive = entry
    ? entry.constructive === true
    : LAVES.includes(type) && density <= CONSTRUCTIVE_DENSITY_THRESHOLD;
  const probes = [];
  let worstMs = 0;
  for (let k = 0; k < PROBES_PLAIN; k++) {
    const p = probeOnce(type, M, N, mines, `bandcal:${type}:${M}x${N}m${mines}:p${k}`, [], constructive);
    worstMs = Math.max(worstMs, p.ms);
    probes.push(p);
  }
  const good = probes.filter((p) => p.ok);
  const pars = good.map((p) => p.par);
  const med = (key) => median(good.map((p) => p.features[key] || 0));
  return {
    type, M, N, mines, total, density, constructive,
    okCount: good.length, worstMs,
    parMedian: pars.length ? median(pars) : NaN,
    parP10: pars.length ? q(pars, 0.1) : NaN,
    parP90: pars.length ? q(pars, 0.9) : NaN,
    features: pars.length ? {
      cellCount: total,
      totalMines: mines,
      canonicalSubsetMoves: med('canonicalSubsetMoves'),
      genericSubsetMoves: med('genericSubsetMoves'),
      advancedLogicMoves: med('advancedLogicMoves'),
      zeroClusterCount: med('zeroClusterCount'),
    } : null,
  };
}

function committedEntry(type, M, N, mines) {
  return (TILING_BAND_CONFIGS[type] || []).find(
    (e) => e.M === M && e.N === N && e.mines === mines,
  ) || null;
}

function proveCommitted(type, entry, measured) {
  const label = `${type} ${entry.id}`;
  const total = buildTiling(type, entry.M, entry.N).total;
  if (!containerIsStorable(total)) failures.push(`${label}: ${total} cells is not canonical-storable`);
  if (measured.okCount < PROBES_PLAIN) {
    failures.push(`${label}: ${PROBES_PLAIN - measured.okCount}/${PROBES_PLAIN} plain probes failed`);
  }
  // Gimmick proof: every tiling-safe gimmick singly, one seed each, plus one
  // stacked pair — production boards carry a mission gimmick.
  const gimmickSets = [...TILING_SAFE_GIMMICKS.map((g) => [g]), STACK_PROBE];
  for (const gs of gimmickSets) {
    const p = probeOnce(type, entry.M, entry.N, entry.mines,
      `bandcal:${type}:${entry.M}x${entry.N}m${entry.mines}:g-${gs.join('+')}`,
      gs, entry.constructive === true);
    if (!p.ok) failures.push(`${label}: gimmick probe [${gs.join('+')}] ${p.why}`);
  }
  // Frozen pricing must sit inside the live band; medians should not have
  // drifted far from the frozen features (a refit moving the equation is the
  // expected cause — retune the entry, not the tolerance).
  const frozenPar = priceBandEntry(type, entry);
  if (!(frozenPar >= DAILY_PAR_BAND.lo && frozenPar <= DAILY_PAR_BAND.hi)) {
    failures.push(`${label}: frozen pricing ${frozenPar.toFixed(1)}s is outside the daily band`);
  }
  const drift = Math.abs(Math.log(measured.parMedian / frozenPar));
  return { frozenPar, drift };
}

const shapes = shapeFilter ? [shapeFilter] : TILING_TYPES;
let grandMs = 0;
for (const type of shapes) {
  const grid = CANDIDATES[type];
  if (!grid) { console.error(`unknown shape '${shapeFilter}'`); process.exit(1); }
  console.log(`\n== ${type} ==`);
  console.log('   M x N  cells  mines  dens   gen        par (p10..med..p90)   committed');
  const rows = [];
  for (const [M, N] of grid.sizes) {
    const total = buildTiling(type, M, N).total;
    if (!containerIsStorable(total)) {
      console.log(`   ${M}x${N}  ${String(total).padStart(4)}  — not canonical-storable, skipped`);
      continue;
    }
    for (const density of grid.densities) {
      const mines = Math.max(5, Math.round(total * density));
      const t0 = Date.now();
      const m = measureCandidate(type, M, N, mines);
      grandMs += Date.now() - t0;
      rows.push(m);
      const entry = committedEntry(type, M, N, mines);
      let note = '';
      if (entry) {
        const { frozenPar, drift } = proveCommitted(type, entry, m);
        note = `<= ${entry.id} frozen ${frozenPar.toFixed(0)}s drift x${Math.exp(drift).toFixed(2)}`;
      }
      const inBand = m.parMedian >= DAILY_PAR_BAND.lo && m.parMedian <= DAILY_PAR_BAND.hi;
      console.log(`   ${M}x${N}  ${String(m.total).padStart(4)}  ${String(mines).padStart(4)}  ${m.density.toFixed(3)}`
        + `  ${String(m.okCount).padStart(2)}/${PROBES_PLAIN} ${String(m.worstMs).padStart(5)}ms`
        + `  ${m.parP10.toFixed(0).padStart(4)}..${m.parMedian.toFixed(0).padStart(4)}..${m.parP90.toFixed(0).padStart(4)}s`
        + ` ${inBand ? ' ' : '!'} ${m.constructive ? 'C' : ' '} ${note}`);
    }
  }
  // Paste-ready literals for the in-band rows, the raw material for the table.
  console.log(`   -- in-band entry literals (${type}) --`);
  for (const m of rows) {
    if (!m.features || m.okCount < PROBES_PLAIN) continue;
    if (!(m.parMedian >= DAILY_PAR_BAND.lo && m.parMedian <= DAILY_PAR_BAND.hi)) continue;
    const f = m.features;
    console.log(`   { id: '${type[0]}${m.total}d${Math.round(m.density * 100)}', M: ${m.M}, N: ${m.N}, mines: ${m.mines},${m.constructive ? ' constructive: true,' : ''}`
      + ` features: { cellCount: ${f.cellCount}, totalMines: ${f.totalMines}, canonicalSubsetMoves: ${f.canonicalSubsetMoves}, genericSubsetMoves: ${f.genericSubsetMoves}, advancedLogicMoves: ${f.advancedLogicMoves}, zeroClusterCount: ${f.zeroClusterCount} } }, // ~${m.parMedian.toFixed(0)}s`);
  }
}

console.log(`\nTotal generation time: ${(grandMs / 1000).toFixed(1)} s`);
if (failures.length) {
  console.error(`\n*** ${failures.length} COMMITTED-ENTRY FAILURE(S) ***`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('Committed entries (if any) all prove clean.');
