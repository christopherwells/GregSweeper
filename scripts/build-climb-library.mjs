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

// ── THE LIBRARY'S OWN INTRODUCTION SCHEDULE ────────────────────────────
// A three-cycle against the shipped braid's derived schedule (his ruling
// 2026-08-10: "Swap sonar forward"): sonar 13 -> 6, hex 6 -> 7, locked
// 7 -> 13. Sonar leads the braid on Classic so that hex, the first lattice
// a player ever meets, debuts WITH its rescuer already known: hex is soft
// on plain boards (best of 200 draws reached 3 hard decisions) and
// liar+sonar on hex measures median 4 to 5, max 9 to 10. Hex keeps the
// first-lattice slot because it is the gentlest introduction to new
// adjacency; what moves is the modifier that makes it testable.
//
// The shipped challenge250.js schedule keeps running the live pool ladder
// until the runtime is wired to the library; from that day this table is
// the one source and the checkpoint labels read from the manifest.
const LIB_SHAPE_INTROS = {
  7: 'hex', 8: '4.8.8', 10: 'cairo', 12: 'rhombille', 14: 'floret', 16: 'deltoidal',
};
const LIB_MOD_INTROS = {
  2: 'walls', 3: 'liar', 4: 'mystery', 6: 'sonar', 9: 'wormhole',
  11: 'mirror', 13: 'locked', 15: 'compass', 17: 'worm',
};

// ── His rulings, as numbers ────────────────────────────────────────────
// "longer than 2 minutes each", "the board can go 20 minutes of work, if
// needed. There's no max", "minimum of 10 boards but I don't care if there's
// a ton of good boards in one level", "I like the 20 vs 10 at the high end".
const MIN_PAR = CLIMB_MIN_PAR_SECONDS;              // 120s
const MIN_BOARDS = 10;
const MIN_BOARDS_HIGH = 20;                          // from HIGH_BAND_FROM up
const HIGH_BAND_FROM = 200;
// THE RAMP IS A RISING FLOOR, not a target with a band around it (his
// correction, 2026-08-10: "I thought it was a 420s floor for ladder top and
// a 400s endless floor, right?". The first cut centered a band on 420,
// which admitted 168s boards at L250). An L26 board is at least two minutes;
// an L250 board is at least 420 seconds. The room ABOVE the floor is where
// variety lives, and there is no hard max ("there's no max").
//
// Why 420 is feasible for every shape, so none is discontinued: the binding
// shape is Paving Stones, held to 112 cells by the phone-width cap, and with
// a full modifier stack at density 0.36 it measures median 419s, max 546s.
// So each shape has real supply above 420, thin for Paving Stones and
// Octagons, wide for the rest. Reading the price map's plain-board maxima
// instead would have said 243s, because modifiers add par and the map prices
// bare boards. Past where time stops climbing, difficulty keeps ramping on
// HARDNESS, which is the axis with room left (Kites reaches 25 hard
// decisions at 90 cells).
const PAR_FLOOR_TOP = 420;

// The endless pool's own FLOOR, a step below the ladder top's ("for endless
// I'd even drop it to 400 for lots of room"): the room is the range above
// the floor, and 400 widens it so the thousand-board pool can hold even
// shape and modifier coverage while every board still runs longer than
// almost anything on the ladder. Consumed by the endless build when it
// lands; recorded now so the ruling is not re-derived.
export const ENDLESS_PAR_FLOOR = 400;

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

// Per-shape floor relief (his ruling 2026-08-10: "I want all shapes in the
// upper levels too so if that means dropping those shapes particular floors
// some, that's fine"). A shape whose best candidate at a level sits under
// the floor is admitted at this fraction of it rather than dropped from the
// level; the log names every use. Never applied below the global two-minute
// floor, and never applied to a shape that CAN reach the level's floor.
const PAR_FLOOR_SHAPE_RELIEF = 0.85;

// The heavy stacks the targeted pass draws from, and why they are authored
// here rather than derived: GIMMICK_SETS tops out at three modifiers, and
// the boards that put the constrained shapes over the high floors are the
// FOUR and FIVE stacks (measured at density 0.36 on the largest legal
// patches: Octagons 597 to 637s median where its plain maximum is 243s).
// The blind rotation could never land on a set it does not contain, which
// is why the first L250 run came back without Octagons or Paving Stones.
const HEAVY_SETS = [
  ['sonar', 'compass', 'locked', 'wormhole'],
  ['liar', 'sonar', 'compass', 'mirror'],
  ['liar', 'sonar', 'compass', 'locked', 'wormhole'],
  ['sonar', 'compass', 'mirror', 'wormhole'],
];
const REP_TRIES_PER_SHAPE = 36;

// ── The two floors a board must clear ──────────────────────────────────
const MIN_WORK = 8;   // decisions. Offline the specs are big, so this is easy.

function parFloor(level) {
  if (level < 26) return null;                       // openers keep their own rule
  const t = (level - 26) / (CHALLENGE_MAX_LEVEL - 26);
  return MIN_PAR * Math.pow(PAR_FLOOR_TOP / MIN_PAR, t);
}
// The admission window's top. Not a ruling, a selection width: without one,
// L26 could deal a 600s board and the ramp would stop being one. It widens
// with the climb, per "decently wide but ever increased width", and at L250
// it sits above every constrained shape's reach, so up there it is
// effectively open.
function parWindowTop(level) {
  const t = (level - 26) / (CHALLENGE_MAX_LEVEL - 26);
  return parFloor(level) * (1.45 + t * 0.25);        // L26 [120,174] -> L250 [420,714]
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

export { parFloor, parWindowTop, hardFloor, minBoardsFor, legalPatches, GIMMICK_SETS, candidate, hardOf,
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
  const allPatches = legalPatches();
  console.log(`price map: ${priced.length} priced specs`
    + `${which === fastFile ? ' (FAST map: rhombille and deltoidal missing)' : ''}`);
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  for (let level = range.from; level <= range.to; level++) {
    const floorPar = parFloor(level);
    if (floorPar == null) { console.log(`L${level}: authored opener, skipped`); continue; }
    const topPar = parWindowTop(level);
    const want = minBoardsFor(level);

    // THE INTRODUCTION SCHEDULE (his catch, 2026-08-10: "I don't think all
    // shapes will have been introduced by L26... once it was introduced, it
    // was then in the mix so that needs to not be forgotten"). The first cut
    // of this generator ignored it and proudly reported seven shapes at L26,
    // which breaks the five-level onboarding the ladder teaches with: at L26
    // a player has met Classic, walls, liar, mystery and exactly one debut.
    //
    // A debut block's levels ALL carry the new thing; after its block, it
    // joins the general mix. The schedule is read from the shipped ladder so
    // the checkpoint-selector labels stay true; when the runtime switches to
    // the library, the manifest this writes becomes the one source.
    const block = Math.floor((level - 1) / CHALLENGE_BLOCK_SIZE) + 1;
    const shapesIn = new Set(['rect']);
    for (const [b, sh] of Object.entries(LIB_SHAPE_INTROS)) {
      if (Number(b) <= block) shapesIn.add(sh);
    }
    const modsIn = new Set();
    for (const [b, g] of Object.entries(LIB_MOD_INTROS)) {
      if (Number(b) <= block) modsIn.add(g);
    }
    const debutShape = LIB_SHAPE_INTROS[block] || null;
    const debutMod = LIB_MOD_INTROS[block] || null;
    const allowedSets = GIMMICK_SETS.filter((set) =>
      set.every((g) => modsIn.has(g)) && (!debutMod || set.includes(debutMod)));

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
      .filter((e) => (debutShape ? e.shape === debutShape : shapesIn.has(e.shape)))
      .filter((e) => e.par >= floorPar * 0.5 && e.par <= topPar * 1.1)
      .map((e) => ({
        shape: e.shape, rows: e.rows, cols: e.cols, M: e.M, N: e.N,
        cells: e.cells, mines: e.mines, gimmicks: [], constructive: true,
      }));
    if (!pool.length) { console.log(`L${level}: price map has nothing near [${Math.round(floorPar)}, ${Math.round(topPar)}]s`); continue; }

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
      const gset = allowedSets[(level * 31 + i * 17) % allowedSets.length];
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

    // THE REPRESENTATION PASS (his ruling: all shapes in the upper levels
    // too). The blind draw misses a shape whenever the boards that put it
    // over the floor live in a narrow corner, which for the constrained
    // shapes is the largest patch at high density under a heavy stack. So
    // any introduced shape with no candidate at the floor gets targeted
    // draws aimed at exactly that corner. Skipped on debut blocks, whose
    // single-shape lesson outranks spread.
    if (!debutShape && !debutMod) {
      const missing = [...shapesIn].filter((sh) =>
        !kept.some((c) => c.spec.shape === sh && c.par >= floorPar));
      for (const sh of missing) {
        const tops = allPatches.filter((q) => q.shape === sh)
          .sort((a, b) => b.cells - a.cells).slice(0, 3);
        const heavy = HEAVY_SETS.map((g) => g.filter((m) => modsIn.has(m)))
          .filter((g) => g.length >= 2);
        let tries = 0;
        for (const q of tops) {
          for (const dens of [0.28, 0.32, 0.36]) {
            for (const g of heavy) {
              if (tries >= REP_TRIES_PER_SHAPE) break;
              const mines = Math.round(q.cells * dens);
              if (mines < 4 || mines > q.cells * 0.42) continue;
              tries++;
              const c = candidate(
                { shape: q.shape, rows: q.rows, cols: q.cols, M: q.M, N: q.N,
                  cells: q.cells, mines, gimmicks: g, gimmickLevel: 110, constructive: true },
                `climb:L${level}:rep:${sh}:${dens}:${g.join('.')}`);
              if (!c) continue;
              const n = seenFace.get(c.face) || 0;
              if (n >= 2) continue;
              seenFace.set(c.face, n + 1);
              kept.push(c);
            }
          }
        }
      }
    }

    // Per-shape floor relief: only for a shape whose BEST candidate is still
    // under the floor after the targeted pass, and never below the global
    // two-minute floor.
    const bestByShape = new Map();
    for (const c of kept) {
      bestByShape.set(c.spec.shape, Math.max(bestByShape.get(c.spec.shape) || 0, c.par));
    }
    const effFloor = (sh) => ((bestByShape.get(sh) || 0) >= floorPar
      ? floorPar
      : Math.max(MIN_PAR, floorPar * PAR_FLOOR_SHAPE_RELIEF));
    const relieved = [...bestByShape.keys()]
      .filter((sh) => effFloor(sh) < floorPar
        && kept.some((c) => c.spec.shape === sh && c.par >= effFloor(sh)));

    // The FLOOR is absolute (per shape, after relief) and the window top is
    // the selection width: land inside the window first, THEN maximize
    // hardness. Sorting by hardness before banding is what put the very
    // first run's L26 at 375s, because the hardest boards are simply the
    // biggest and nothing held them back.
    const inBand = kept.filter((c) => c.par >= effFloor(c.spec.shape) && c.par <= topPar);
    // Falling back to the whole set is the honest failure mode: a level short
    // of in-band boards gets off-target ones and the log says so, rather than
    // shipping fewer than the minimum.
    // The fallback still respects the FLOOR: a short level may only err
    // LONG, never under the floor, or the ramp's own promise breaks.
    const overFloor = kept.filter((c) => c.par >= effFloor(c.spec.shape));
    const from = inBand.length >= want ? inBand : (overFloor.length >= want ? overFloor : kept);
    from.sort((a, b) => (b.hard - a.hard) || (Math.abs(a.par - floorPar * 1.2) - Math.abs(b.par - floorPar * 1.2)));

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
    console.log(`L${String(level).padStart(3)} floor ${String(Math.round(floorPar)).padStart(3)}s`
      + `${debutShape || debutMod ? ` INTRO ${debutShape || debutMod}` : ''}  `
      + `tried ${String(tried).padStart(4)}  kept ${String(chosen.length).padStart(2)}/${want}  `
      + `par min ${String(chosen.length ? Math.round(Math.min(...chosen.map((c) => c.par))) : 0).padStart(4)}s `
      + `med ${String(Math.round(med(chosen, 'par'))).padStart(4)}s  work med ${String(med(chosen, 'work')).padStart(3)}  `
      + `hard med ${String(med(chosen, 'hard')).padStart(2)} max ${chosen.length ? Math.max(...chosen.map((c) => c.hard)) : 0}  `
      + `shapes ${new Set(chosen.map((c) => c.spec.shape)).size}`
      + `  hardFloor ${floor}${belowFloor ? ` (${belowFloor} under: ${softShapes.join(',')})` : ''}`
      + `${relieved.length ? `  relief ${relieved.join(',')}` : ''}${banded ? '' : '   OFF-BAND'}`);

    if (!dry && chosen.length) {
      const block = Math.floor((level - 1) / CHALLENGE_BLOCK_SIZE) + 1;
      const file = new URL(`level-${String(level).padStart(3, '0')}.json`, OUT_DIR);
      writeFileSync(file, JSON.stringify({
        level, block, parFloor: Math.round(floorPar), parWindowTop: Math.round(topPar),
        intro: debutShape || debutMod || null,
        parModel: modelFingerprint(),
        boards: chosen,
      }));
    }
  }
}
