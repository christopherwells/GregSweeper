// Build the Climb's pre-generated board library.
//
// WHY THIS EXISTS. Until now a Climb level was a SPEC and the board was
// generated under the player's click, which forced two things: a 2-second
// budget, and taking the first board that certified. The second is what made
// the ladder soft. Measured over 60 draws of one spec, the count of decisions
// needing real reasoning ranges from a median of 0 to a maximum of 11 on the
// SAME spec, so the online path was reliably handing out the median while the
// hard boards sat in the same distribution unreached.
//
// Generating offline changes two things at once:
//   - SELECTION. Generate many, keep the hardest. That is the difficulty fix,
//     and it needs no new spec space at all.
//   - REACH. The spec no longer has to certify in 2 seconds, so it is not
//     limited to the pre-proven pool. Every shape clears his two-minute floor
//     at its largest phone-legal patch (measured 116-770s), which the pool
//     could not do: filtering it at 120s exhausted the ladder at L44.
//
// THE LIBRARY IS APPEND-ONLY (his ruling 2026-08-10). A refit re-prices every
// board, so boards drift out of the level they were generated for. They are
// not deleted; the ASSIGNMENT is recomputed and levels that fall below the
// minimum are topped up by a later run. That is what makes the library deepen
// as the par model settles rather than churn.
//
// Usage:
//   node scripts/build-climb-library.mjs --levels 26-40      # a slice
//   node scripts/build-climb-library.mjs --all               # ladder + endless
//   node scripts/build-climb-library.mjs --endless           # endless only
//   node scripts/build-climb-library.mjs --dry-run --levels 26-30

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { buildChallenge250Board } from '../src/logic/challenge250Builder.js';
import { buildTiling, containerIsStorable, containerFor, TILING_TYPES } from '../src/logic/tilingGeometry.js';
import { boardFitsPhone } from '../src/logic/boardFit.js';
import { serializeBoard } from '../src/firebase/dailyBoardSync.js';
import { TILING_SAFE_GIMMICKS } from '../src/logic/tilingGenerator.js';
import {
  CHALLENGE_MAX_LEVEL, CHALLENGE_BLOCK_SIZE, CLIMB_MIN_PAR_SECONDS, specFace,
} from '../src/logic/challenge250.js';
import { modelFingerprint } from '../src/logic/parModelFingerprint.js';

const OUT_DIR = new URL('./data/climb-library/', import.meta.url);

// ── His rulings, as numbers ────────────────────────────────────────────
// "longer than 2 minutes each", "the board can go 20 minutes of work, if
// needed. There's no max", "minimum of 10 boards but I don't care if there's
// a ton of good boards in one level", "I like the 20 vs 10 at the high end".
const MIN_PAR = CLIMB_MIN_PAR_SECONDS;              // 120s
const MIN_BOARDS = 10;
const MIN_BOARDS_HIGH = 20;                          // from HIGH_BAND_FROM up
const HIGH_BAND_FROM = 200;
// Where the TIME ramp stops, set by the most constrained shape rather than
// the most capable, because shapes must not become discontinued (his ruling
// 2026-08-10: "Shapes should not become discontinued. They don't need to all
// be above 900s. Drop the par time some if that's the case. The idea is to
// have variety stay similar but difficulty ramp.").
//
// The binding shape is Paving Stones. The phone-width cap holds it to 112
// cells, and with a full modifier stack at density 0.36 it reaches a median
// 419s and a maximum 546s. Every other shape clears that comfortably, so 500
// is the highest top that keeps all seven in play. Reading the price map's
// plain-board maxima instead would have put the ceiling at 243s, because
// modifiers add par and the map prices bare boards.
//
// Past this point the ladder gets HARDER rather than LONGER, which is the
// ruling's second half. Kites reaches 25 hard decisions at 90 cells, so the
// top of the climb has plenty of room on that axis with none on this one.
const PAR_TARGET_TOP = 500;

// The hardness ramp, which is what carries difficulty once time stops. Levels
// select the hardest boards available in their par band regardless; this is
// the floor that makes the top of the ladder refuse a merely-long board.
const HARD_FLOOR_START = 3;
const HARD_FLOOR_TOP = 14;

// How many candidates to generate per kept board. Selection is the whole
// point, so this is the knob that buys hardness.
//
// It is 28 rather than 12 because of the interaction between his two rulings.
// Shape spread means a level must take boards from Honeycomb and 3D Cubes,
// which are soft on plain layouts (7/200 and 2/60 with any hard content) and
// only become hard with reach modifiers. The modifier set is rotated blindly,
// so a soft shape needs enough draws to land on one of those sets. At 12 a
// third of each level's boards sat under the hardness floor; the extra
// candidates are what let every shape contribute a HARD board rather than
// merely a board.
const CANDIDATES_PER_KEEP = 28;

// ── The two floors a board must clear ──────────────────────────────────
const MIN_WORK = 8;   // decisions. Offline the specs are big, so this is easy.

function parTarget(level) {
  if (level < 26) return null;                       // openers keep their own rule
  const t = (level - 26) / (CHALLENGE_MAX_LEVEL - 26);
  return MIN_PAR * Math.pow(PAR_TARGET_TOP / MIN_PAR, t);
}
function hardFloor(level) {
  if (level < 26) return 0;
  const t = (level - 26) / (CHALLENGE_MAX_LEVEL - 26);
  return Math.round(HARD_FLOOR_START + t * (HARD_FLOOR_TOP - HARD_FLOOR_START));
}
function minBoardsFor(level) {
  return level >= HIGH_BAND_FROM ? MIN_BOARDS_HIGH : MIN_BOARDS;
}

// ── The spec space, no longer the pool ─────────────────────────────────
// Every phone-legal, storable patch of every shape, at a spread of densities.
// Priced once by probe so level assignment does not re-measure.
function legalPatches() {
  const out = [];
  for (const shape of TILING_TYPES) {
    for (let M = 2; M <= 16; M++) {
      for (let N = 2; N <= 16; N++) {
        let T;
        try { T = buildTiling(shape, M, N); } catch { continue; }
        if (!containerIsStorable(T.total)) continue;
        if (!boardFitsPhone(shape, M, N)) continue;
        if (T.total < 40) continue;
        out.push({ shape, M, N, cells: T.total, ...containerFor(T.total) });
      }
    }
  }
  // Classic: the width cap is 13 columns; height is free until the board stops
  // fitting, which the probe finds by pricing.
  for (let rows = 8; rows <= 20; rows++) {
    for (const cols of [10, 11, 12, 13]) {
      out.push({ shape: 'rect', rows, cols, cells: rows * cols });
    }
  }
  return out;
}

const GIMMICK_SETS = (() => {
  const g = TILING_SAFE_GIMMICKS.slice();
  const sets = [[]];
  for (const a of g) sets.push([a]);
  for (let i = 0; i < g.length; i++) {
    for (let j = i + 1; j < g.length; j++) sets.push([g[i], g[j]]);
  }
  for (let i = 0; i < g.length; i += 2) {
    const trio = [g[i], g[(i + 3) % g.length], g[(i + 5) % g.length]];
    if (new Set(trio).size === 3) sets.push(trio);
  }
  return sets;
})();

const hardOf = (c) => c.canonicalSubsetMoves + c.genericSubsetMoves
  + c.advancedLogicMoves + c.disjunctiveMoves;

/** Generate one candidate; null when it fails a floor. */
function candidate(spec, seed) {
  const t0 = Date.now();
  const r = buildChallenge250Board(spec, seed);
  if (!r || !r.check || !r.par) return null;
  const work = r.check.totalClicks - 1;
  if (work < MIN_WORK) return null;
  if (r.par < MIN_PAR) return null;
  return {
    par: r.par, work, hard: hardOf(r.check), tier: r.check.techniqueLevel,
    genMs: Date.now() - t0, seed,
    payload: serializeBoard({
      board: r.board, rows: r.rows, cols: r.cols, totalMines: r.totalMines,
      rngSeed: seed, activeGimmicks: r.activeGimmicks, firstClick: r.firstClick,
    }),
    face: specFace(spec),
    spec: {
      shape: spec.shape, rows: spec.rows, cols: spec.cols, M: spec.M, N: spec.N,
      cells: spec.cells, mines: spec.mines, gimmicks: (spec.gimmicks || []).slice(),
      gimmickLevel: spec.gimmickLevel, constructive: spec.constructive,
    },
  };
}

export { parTarget, hardFloor, minBoardsFor, legalPatches, GIMMICK_SETS, candidate, hardOf,
  MIN_PAR, MIN_WORK, CANDIDATES_PER_KEEP, OUT_DIR };

// ── CLI ────────────────────────────────────────────────────────────────
// Guarded so the module can be IMPORTED for its helpers without running the
// build, and without throwing when argv[1] is absent (node -e, a test).
if ((process.argv[1] || '').endsWith('build-climb-library.mjs')) {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const range = (() => {
    const i = args.indexOf('--levels');
    if (i < 0) return null;
    const [a, b] = args[i + 1].split('-').map(Number);
    return { from: a, to: b || a };
  })();

  if (!range) {
    console.error('usage: --levels A-B [--dry-run]   (--all / --endless land next)');
    process.exit(1);
  }

  // The price map is required, not optional: without it the generator has no
  // way to aim and every level lands off-band (measured, first run).
  const mapFile = new URL('./data/climb-price-map.json', import.meta.url);
  const fastFile = new URL('./data/climb-price-map-fast.json', import.meta.url);
  const which = existsSync(mapFile) ? mapFile : (existsSync(fastFile) ? fastFile : null);
  if (!which) {
    console.error('no price map. Run: node scripts/build-climb-price-map.mjs [--fast]');
    process.exit(1);
  }
  const priced = JSON.parse(readFileSync(which, 'utf8')).entries;
  console.log(`price map: ${priced.length} priced specs`
    + `${which === fastFile ? ' (FAST map: rhombille and deltoidal missing)' : ''}`);
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  for (let level = range.from; level <= range.to; level++) {
    const target = parTarget(level);
    if (target == null) { console.log(`L${level}: authored opener, skipped`); continue; }
    const want = minBoardsFor(level);

    // Candidate specs come from the PRICE MAP, not from the raw patch list.
    // Sampling patches blindly is what put the first run's L26 at 375s against
    // a 120s target: the specs that cleared the floor at all were simply the
    // biggest ones. The map says what each (shape, size, density) is worth, so
    // a level can ask for the sizes that land near its target and let its own
    // par measurement do the accepting.
    //
    // Modifiers still shift par, which is why the map prices PLAIN boards and
    // the band is applied to the real measured candidate further down. A
    // generous multiplier here keeps modifier-bearing specs in the running
    // rather than pre-filtering them out on their plain price.
    const pool = priced
      .filter((e) => e.par >= target * 0.45 && e.par <= target * 1.6)
      .map((e) => ({
        shape: e.shape, rows: e.rows, cols: e.cols, M: e.M, N: e.N,
        cells: e.cells, mines: e.mines, gimmicks: [], constructive: true,
      }));
    if (!pool.length) { console.log(`L${level}: price map has nothing near ${Math.round(target)}s`); continue; }

    const kept = [];
    const seenFace = new Map();
    let tried = 0;
    const budget = want * CANDIDATES_PER_KEEP;
    // The KEPT cap, not the budget, is what bounds this loop in practice, and
    // setting it to want*3 quietly made CANDIDATES_PER_KEEP inert: the loop
    // stopped at 30 kept having spent 90 of its 280 draws. It is want*8 so the
    // soft shapes get enough attempts to land a reach-modifier set.
    for (let i = 0; i < budget && kept.length < want * 8; i++) {
      const base = pool[(level * 7919 + i * 104729) % pool.length];
      const gset = GIMMICK_SETS[(level * 31 + i * 17) % GIMMICK_SETS.length];
      const spec = { ...base, gimmicks: gset, gimmickLevel: 40 + (level % 60) };
      tried++;
      const c = candidate(spec, `climb:L${level}:${i}`);
      if (!c) continue;
      // Face diversity: at most two boards per face in a level.
      const n = seenFace.get(c.face) || 0;
      if (n >= 2) continue;
      seenFace.set(c.face, n + 1);
      kept.push(c);
    }

    // The par target is a BAND, not a tiebreak. Sorting by hardness first put
    // L26 at 375s against a 120s target, because the hardest boards are simply
    // the biggest ones and nothing held them back. So: keep only what lands in
    // the band, THEN maximise hardness inside it. The band widens with the
    // climb, per his "decently wide but ever increasing width".
    const t = (level - 26) / (CHALLENGE_MAX_LEVEL - 26);
    const half = 0.25 + t * 0.35;
    const lo = target * (1 - half);
    const hi = target * (1 + half);
    const inBand = kept.filter((c) => c.par >= Math.max(MIN_PAR, lo) && c.par <= hi);
    // Falling back to the whole set is the honest failure mode: a level short
    // of in-band boards gets off-target ones and the log says so, rather than
    // shipping fewer than the minimum.
    const from = inBand.length >= want ? inBand : kept;
    from.sort((a, b) => (b.hard - a.hard) || (Math.abs(a.par - target) - Math.abs(b.par - target)));

    // SHAPE SPREAD, his ruling: "shapes should not become discontinued... the
    // idea is to have variety stay similar but difficulty ramp". Taking the
    // top N by hardness alone collapses a level onto whichever shape happens
    // to be hardest at that par, which at the summit was a single shape. So
    // deal round-robin across shapes, hardest first within each, and only
    // fall back to a straight hardness take once every shape present is
    // exhausted. Variety is a constraint on the selection, not a hope about
    // its output, which is the same lesson the pool search learned.
    const byShape = new Map();
    for (const c of from) {
      if (!byShape.has(c.spec.shape)) byShape.set(c.spec.shape, []);
      byShape.get(c.spec.shape).push(c);
    }
    const queues = [...byShape.values()];
    const chosen = [];
    for (let round = 0; chosen.length < want && queues.some((q) => q.length); round++) {
      for (const q of queues) {
        if (chosen.length >= want) break;
        if (q.length) chosen.push(q.shift());
      }
    }
    const banded = inBand.length >= want;
    const floor = hardFloor(level);
    const belowFloor = chosen.filter((c) => c.hard < floor).length;
    const softShapes = [...new Set(chosen.filter((c) => c.hard < floor).map((c) => c.spec.shape))];
    const med = (a, k) => a.length ? [...a].map((x) => x[k]).sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0;
    console.log(`L${String(level).padStart(3)} target ${String(Math.round(target)).padStart(3)}s  `
      + `tried ${String(tried).padStart(4)}  kept ${String(chosen.length).padStart(2)}/${want}  `
      + `par med ${String(Math.round(med(chosen, 'par'))).padStart(4)}s  work med ${String(med(chosen, 'work')).padStart(3)}  `
      + `hard med ${String(med(chosen, 'hard')).padStart(2)} max ${chosen.length ? Math.max(...chosen.map((c) => c.hard)) : 0}  `
      + `shapes ${new Set(chosen.map((c) => c.spec.shape)).size}`
      + `  hardFloor ${floor}${belowFloor ? ` (${belowFloor} under: ${softShapes.join(',')})` : ''}`
      + `${banded ? '' : '   OFF-BAND'}`);

    if (!dry && chosen.length) {
      const block = Math.floor((level - 1) / CHALLENGE_BLOCK_SIZE) + 1;
      const file = new URL(`level-${String(level).padStart(3, '0')}.json`, OUT_DIR);
      writeFileSync(file, JSON.stringify({
        level, block, target: Math.round(target),
        parModel: modelFingerprint(),
        boards: chosen,
      }));
    }
  }
}
