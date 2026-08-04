// Search for ENDLESS-ZONE specs: certified, strictly load-bearing boards at
// or above the T12 summit (3.6 s/cell), under the endless par ceiling
// (10 minutes) and the standing 2-second generation cap.
//
// The endless zone cannot be authored level by level, and it cannot be a
// free-parameter generator either: every ladder spec has to be PROVEN to
// certify inside the cap, and a generator producing arbitrary (shape, size,
// density, stack) combinations at level 1,000 has proven nothing. So the
// zone is a POOL of proven specs plus a deterministic per-level draw, the
// same shape as TILING_BAND_CONFIGS. This script finds the pool.
//
// It sweeps candidate specs per shape, measures each over K seeds through the
// ONE builder the play path uses, and prints the survivors as a table ready
// to paste into ENDLESS_SPECS. Not CI: a search, run when the pool needs
// building or rebuilding after a refit moves a shape's equation.
//
//   node scripts/search-endless-specs.mjs                  # every shape
//   node scripts/search-endless-specs.mjs --shape hex      # one shape
//   node scripts/search-endless-specs.mjs --seeds 5        # quicker sweep

import { buildChallenge250Board, challengeBoardSeed } from '../src/logic/challenge250Builder.js';
import {
  endlessParCeiling, endlessGenCap, ENDLESS_PPC_FLOOR,
} from '../src/logic/challenge250.js';
import { buildTiling } from '../src/logic/tilingGeometry.js';

const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };
const K = Number(argVal('--seeds') || 8);
const ONLY = argVal('--shape');

const FLOOR_PPC = ENDLESS_PPC_FLOOR;

// Candidate grids per shape. Sizes are the ones the ladder already proves
// generation-viable; densities reach past the ladder's own top because that
// is exactly what the endless zone is for. Stacks come from the shapes'
// proven summit sets.
const STACKS = {
  rect: [[], ['liar'], ['walls', 'liar'], ['locked', 'liar'], ['walls', 'locked', 'liar']],
  hex: [[], ['walls'], ['worm', 'walls'], ['compass', 'walls'], ['worm', 'compass', 'walls']],
  '4.8.8': [[], ['locked'], ['wormhole', 'locked'], ['compass', 'locked'], ['wormhole', 'compass', 'locked']],
  cairo: [[], ['locked'], ['sonar', 'walls'], ['locked', 'sonar'], ['locked', 'sonar', 'walls']],
  rhombille: [[], ['locked'], ['mirror', 'walls'], ['sonar', 'walls'], ['locked', 'sonar', 'walls']],
  floret: [[], ['walls'], ['liar', 'walls'], ['sonar', 'liar'], ['sonar', 'liar', 'walls']],
  deltoidal: [[], ['locked'], ['mystery', 'locked'], ['sonar', 'walls'], ['locked', 'sonar', 'walls']],
};

const RECT_SIZES = [[9, 9], [10, 10], [11, 11], [11, 12], [12, 12]];
const TILING_SIZES = {
  hex: [[7, 7], [9, 8], [11, 10]],
  '4.8.8': [[5, 6], [6, 7], [7, 8]],
  cairo: [[4, 10], [6, 8], [8, 8]],
  rhombille: [[3, 4], [4, 5], [5, 5]],
  floret: [[2, 3], [3, 3], [3, 4]],
  deltoidal: [[2, 3], [2, 4], [3, 3]],
};
const DENSITIES = [0.28, 0.31, 0.34, 0.37, 0.40, 0.43];
const GIMMICK_LEVELS = [100, 120];

function cellsOf(shape, a, b) {
  return shape === 'rect' ? a * b : buildTiling(shape, a, b).total;
}

function makeSpec(shape, a, b, density, gimmicks, gl) {
  const cells = cellsOf(shape, a, b);
  const mines = Math.max(5, Math.round(cells * density));
  const base = shape === 'rect'
    ? { shape: 'rect', rows: a, cols: b, cells, mines, gimmicks }
    : { shape, M: a, N: b, cells, mines, gimmicks };
  return gimmicks.length ? { ...base, gimmickLevel: gl } : base;
}

/** Measure a spec over K seeds: every draw must certify, strict, in budget. */
function measure(spec, level = 300) {
  const pars = [];
  let worstMs = 0;
  for (let k = 0; k < K; k++) {
    const t0 = Date.now();
    const built = buildChallenge250Board(spec, challengeBoardSeed(level, k, 'endless-search'));
    const ms = Date.now() - t0;
    if (ms > worstMs) worstMs = ms;
    if (!built) return { ok: false, why: `draw ${k} failed (uncertified or decorative)`, worstMs };
    pars.push(built.par);
    if (worstMs > endlessGenCap(spec.shape) * 3) return { ok: false, why: `generation blew past the cap (${worstMs}ms)`, worstMs };
  }
  pars.sort((x, y) => x - y);
  const medPar = pars[Math.floor(pars.length / 2)];
  const ppc = medPar / spec.cells;
  return { ok: true, medPar, ppc, worstMs, minPar: pars[0], maxPar: pars[pars.length - 1] };
}

const shapes = ONLY ? [ONLY] : ['rect', 'hex', '4.8.8', 'cairo', 'rhombille', 'floret', 'deltoidal'];
const survivors = [];

for (const shape of shapes) {
  const sizes = shape === 'rect' ? RECT_SIZES : TILING_SIZES[shape];
  console.log(`\n=== ${shape} ===`);
  for (const [a, b] of sizes) {
    for (const density of DENSITIES) {
      for (const gimmicks of STACKS[shape]) {
        for (const gl of (gimmicks.length ? GIMMICK_LEVELS : [null])) {
          const spec = makeSpec(shape, a, b, density, gimmicks, gl);
          const r = measure(spec);
          const tag = `${shape} ${a}x${b} (${spec.cells}c) d${density.toFixed(2)} m${spec.mines} [${gimmicks.join('+') || 'plain'}]${gl ? ` gl${gl}` : ''}`;
          if (!r.ok) {
            if (process.env.VERBOSE) console.log(`  skip  ${tag}: ${r.why}`);
            continue;
          }
          const ceiling = endlessParCeiling(shape);
          const genCap = endlessGenCap(shape);
          const overCeiling = r.medPar > ceiling;
          const overCap = r.worstMs > genCap;
          const belowFloor = r.ppc < FLOOR_PPC;
          const verdict = overCeiling ? `PAR>${ceiling}` : overCap ? `GEN ${r.worstMs}ms`
            : belowFloor ? `below ${FLOOR_PPC}` : 'KEEP';
          if (verdict !== 'KEEP') {
            if (process.env.VERBOSE) console.log(`  ${verdict.padEnd(10)} ${tag}  ppc ${r.ppc.toFixed(2)} par ${r.medPar.toFixed(0)}s`);
            continue;
          }
          console.log(`  KEEP  ${tag}  ppc ${r.ppc.toFixed(2)}  par ${r.medPar.toFixed(0)}s (${r.minPar.toFixed(0)}-${r.maxPar.toFixed(0)})  worst ${r.worstMs}ms`);
          survivors.push({ shape, a, b, cells: spec.cells, mines: spec.mines, density, gimmicks, gl, ...r });
        }
      }
    }
  }
}

console.log(`\n\n=== ${survivors.length} survivors, by ppc ===`);
survivors.sort((x, y) => x.ppc - y.ppc);
for (const s of survivors) {
  const dims = s.shape === 'rect' ? `${s.a}, ${s.b}` : `'${s.shape}', ${s.a}, ${s.b}, ${s.cells}`;
  const g = s.gimmicks.length ? `, [${s.gimmicks.map((x) => `'${x}'`).join(', ')}]${s.gl ? `, { gimmickLevel: ${s.gl} }` : ''}` : '';
  const ctor = s.shape === 'rect' ? 'R' : 'T';
  console.log(`  ${ctor}(${dims}, ${s.mines}${g}),  // ppc ${s.ppc.toFixed(2)}  par ${s.medPar.toFixed(0)}s  gen ${s.worstMs}ms`);
}
