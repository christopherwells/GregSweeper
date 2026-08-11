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
  endlessParCeiling,
} from '../src/logic/challenge250.js';
import { BOARD_WIDTH_CAP } from '../src/logic/difficulty.js';
import {
  LIB_SHAPE_INTROS, LIB_MOD_INTROS, intakeRules, boardAllowedAtLevel,
} from '../src/logic/climbLibrary.js';
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
// The runtime deals from the library since 2026-08-11: these tables (now
// in src/logic/climbLibrary.js, re-exported here) are the one source, and
// the checkpoint labels read them. The braid's derived tables describe
// only the drawn fallback path.
// LIB_SHAPE_INTROS / LIB_MOD_INTROS moved to src/logic/climbLibrary.js
// (the runtime deals under the same schedule; scripts re-export below).

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
// almost anything on the ladder. The one WINDOW bound the endless library
// has: there are no per-level windows past the crown, so a board belongs to
// the endless bins exactly while its par sits at or above this. Each
// shape's own par CEILING (endlessParCeiling) is honored at BUILD time as
// an admission rule — the room above the floor is where variety lives, and
// a ceiling is not a membership bound a refit can evict a board over.
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

// Where the targeted pass may NOT push density, and the bounds that keep an
// infeasible corner cheap. Rhombille no-guess boards effectively stop
// existing past ~0.30 (0/12 by sampling at 0.211; the production range is
// 0.23-0.28), so asking for 0.32-0.36 there is not hard, it is impossible,
// and before these bounds one such candidate cost 600 attempts times 3
// salts of full Pass-C certification on a 135-cell patch. The pass now runs
// 80 attempts, one salt, and gives up on a shape after a minute of wall
// clock, logging the bail rather than absorbing it.
const REP_DENSITY_CAP = { rhombille: 0.28 };
const REP_GEN_ATTEMPTS = 80;
const REP_SHAPE_BUDGET_MS = 60000;

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
    // The builder already computed the feature vector that priced this
    // board, and features are model-independent where par is not: storing
    // them is what lets a refit re-price the whole library in seconds
    // instead of re-solving 2,900 boards (the pool-features lesson).
    features: r.features,
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


// ── THE ENDLESS LIBRARY (L251+, his rulings 2026-08-10/11) ─────────────
//
// ~1,000 pre-generated boards for the endless zone: par floor 400s
// (ENDLESS_PAR_FLOOR) with each shape's own ceiling honored, EVEN COVERAGE
// across all seven shapes and the modifier arities with the heavy 4-5
// stacks included, dealt randomly under a global seen-cycle. Pre-generating
// is also what restores Classic to the zone: runtime generation could not
// clear both the price floor and the admission budget (his 2026-08-10
// parking ruling was explicitly out-until-pre-gen), and a dealt board pays
// its generation cost offline where the budget is minutes, not milliseconds.
//
// THE FOUR REPRESENTATION LESSONS APPLY VERBATIM (see the search script's
// header): visits interleave SHAPE-MINOR; modifier sets are grouped into
// ARITY LANES that rotate evenly rather than by set count (84 triples would
// otherwise eat the budget); the EMITTER deals pages round-robin over
// shapes so any prefix of the page set — and any interrupted build — is
// balanced; and the per-shape quota is the SEARCH's constraint, never a
// hope about its output.
//
// Storage is SHARDED: endless-NNN.json pages of ENDLESS_PAGE_SIZE boards
// plus endless-index.json carrying per-page counts, so a level past 250
// fetches one small index and one page, never a thousand boards. The page a
// board lives in carries no meaning — the deal is uniform over unseen
// boards across the whole library (weighted by each page's unseen count),
// so page composition cannot bias what a player meets.
// 500 AT LAUNCH, his ruling 2026-08-11: "Maybe we start with 500. No one is
// going to get to lvl 750 in the near future." Five hundred boards is five
// hundred deals before the global cycle can repeat one, and the library is
// append-only by design, so growing it later is a --endless run, not a
// project.
const ENDLESS_TARGET_BOARDS = 500;
const ENDLESS_PAGE_SIZE = 16;          // ~150-250KB per page at endless payload sizes
const ENDLESS_FACE_CAP = 2;            // dims/mines/stack variety, the ladder's own bar
const ENDLESS_GL = [70, 100, 120];     // the hard end of the intensity dial
const ENDLESS_DENSITIES = [0.24, 0.28, 0.32, 0.36];
// Best-of-N hardness selection, the library's whole reason to exist. Sized
// per shape because a rhombille candidate costs seconds where a rect one
// costs a fraction of one, and an even N would spend most of the wall clock
// proving the dearest shapes' soft draws.
const ENDLESS_BEST_OF = { rhombille: 4, deltoidal: 4, cairo: 5 };
const endlessBestOf = (shape) => ENDLESS_BEST_OF[shape] ?? 6;
// Bounds, the L91-freeze lessons: every spec carries genAttempts /
// strictRetries so an infeasible corner costs attempts rather than salts of
// full certification; a (shape, lane) visit is wall-clocked; and a lane
// that came back empty twice RESTS rather than re-burning its budget every
// round (plain rhombille cannot reach 400s at all — its plain boards top
// out near 193s — and without the rest that lane re-fails forever).
const ENDLESS_GEN_ATTEMPTS = 80;
const ENDLESS_STRICT_RETRIES = 1;
const ENDLESS_VISIT_BUDGET_MS = 75_000;
// FOUR consecutive empty visits before a lane rests, not two: a lane with a
// narrow-but-real corridor (4.8.8's whole window is one) misses twice in a
// row CONSTANTLY, and at two the rest machinery treated every low-yield
// lane as a dead one — the first 4.8.8 shard retired itself at 6 of 143
// with its corridor proven to exist. Misses are cheap since the aimless-
// visit abandon; the rests only need to starve the truly infeasible lanes.
const ENDLESS_LANE_BAILS = 4;
const ENDLESS_LANE_REST_ROUNDS = 12;   // rounds a bailed lane sits out (escalates per bail)
const ENDLESS_LANE_BAILS_CAP = 5;      // escalation ceiling, so every rest expires in-horizon
// Per-shape cell bounds for the endless draws, each one MEASURED. Ceilings:
// rhombille's certification cost is superlinear in cells (the 72-cell
// practice-board lesson), and at 135 cells a single strict draw measured 48
// SECONDS — one visit of those eats three minutes for one board, while 120
// cells measures ~5s a draw; deltoidal's pricing is the dearest per cell of
// any lattice, so its 108-126-cell patches blow past the 600s ceiling on
// every draw (126 cells prices ~1665s at daily density). Floors: the same
// two shapes from the other side — rhombille below ~100 cells cannot reach
// the 400s floor at all (plain tops near 193s, pairs near 350), and
// deltoidal's 48-54-cell patches sit under it at every legal density. A
// draw outside the corridor is not unlucky, it is impossible, and the first
// shard runs spent 97% of their visits proving that over and over.
const ENDLESS_MAX_CELLS = { rhombille: 120, deltoidal: 90 };
const ENDLESS_MIN_CELLS = { rhombille: 100, deltoidal: 66 };
const ENDLESS_CACHE = new URL('./data/endless-build-cache.json', import.meta.url);
// A --shape run gets its OWN cache file, which is what makes the seven
// shapes safely PARALLEL: specFace is shape-prefixed and the draw seeds are
// shape-namespaced, so seven processes share no state at all, and a
// 16-core box builds the library in the wall clock of its dearest shape
// instead of the sum of all seven. --emit-only merges the caches.
const endlessCacheFile = (shape) => (shape
  ? new URL(`./data/endless-build-cache-${shape}.json`, import.meta.url)
  : ENDLESS_CACHE);
const ENDLESS_INDEX = new URL('endless-index.json', OUT_DIR);
const endlessPageFile = (page) => new URL(`endless-${String(page).padStart(3, '0')}.json`, OUT_DIR);

const ENDLESS_SHAPES = ['rect', ...TILING_TYPES];

/**
 * The modifier-set LANES a shape's visits rotate through: plain, singles,
 * pairs, triples, heavy. One lane per arity class so each gets an even
 * fifth of the visits — counting sets instead would hand the triples 65%
 * of everything (the arity-balance lesson). Triples are sub-sampled on a
 * per-shape offset so their union across the seven shapes still covers all
 * 84; the heavy lane is the authored HEAVY_SETS (4-5 stacks), which the
 * blind arity enumeration cannot produce and his ruling names explicitly.
 */
function endlessLanes(shapeIndex) {
  const g = TILING_SAFE_GIMMICKS.slice();
  const singles = g.map((x) => [x]);
  const pairs = [];
  const triples = [];
  for (let i = 0; i < g.length; i++) {
    for (let j = i + 1; j < g.length; j++) {
      pairs.push([g[i], g[j]]);
      for (let k = j + 1; k < g.length; k++) triples.push([g[i], g[j], g[k]]);
    }
  }
  const step = shapeIndex * 12;
  return [
    [[]],
    singles,
    pairs,
    Array.from({ length: 36 }, (_, i) => triples[(step + i) % triples.length]),
    HEAVY_SETS,
  ];
}

// FNV-1a, the repo's standing deterministic pick (a resumed build must
// re-draw the identical candidate sequence or the resume cache is fiction).
function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** Rect legality reads the SHIPPED width cap (the emit-legality lesson). */
function endlessDimsLegal(shape, a, b) {
  if (shape === 'rect') return b <= BOARD_WIDTH_CAP && a <= 20 && a >= 5 && b >= 5;
  try { return boardFitsPhone(shape, a, b) && containerIsStorable(buildTiling(shape, a, b).total); } catch { return false; }
}

/**
 * The DIMS a shape's endless draws sample, price-map-informed: patches
 * whose PLAIN price sits between a quarter of the floor (heavy stacks
 * multiply par — Octagons runs 243s plain and 597-637s under a 4-stack, so
 * a plain-price filter at the floor itself would empty the very shapes the
 * stacks exist to carry) and the shape's ceiling. Where the map is thin the
 * largest legal patches stand in: par scales with cells, and 400s+ lives on
 * the big end of every shape's range.
 */
function endlessDims(shape, priced) {
  const ceil = endlessParCeiling(shape);
  const cellCap = ENDLESS_MAX_CELLS[shape] ?? Infinity;
  const cellMin = ENDLESS_MIN_CELLS[shape] ?? 0;
  const seen = new Set();
  const out = [];
  for (const e of priced) {
    if (e.shape !== shape) continue;
    if (e.par < ENDLESS_PAR_FLOOR / 4 || e.par > ceil) continue;
    if (e.genMs != null && e.genMs > 2500) continue;
    if (e.cells > cellCap || e.cells < cellMin) continue;
    // LATTICE dims first: price-map tiling entries carry BOTH the lattice
    // M/N and the storage container's rows/cols, and reading the container
    // first hands boardFitsPhone garbage (an 8x9 CONTAINER for a 72-cell
    // Kites patch is not a legal 8x9 Kites lattice). This emptied three
    // shapes' dims lists entirely, which is why the first run starved them.
    const a = e.M ?? e.rows, b = e.N ?? e.cols;
    if (!endlessDimsLegal(shape, a, b)) continue;
    const k = `${a}x${b}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ a, b, cells: e.cells });
  }
  // ALWAYS top up with the largest legal patches the map does not name: the
  // price map was built for the LADDER's needs and its coverage thins out
  // exactly where the endless window lives (4.8.8's map dims stop at 98
  // cells while its 128-cell patches are the ones that price mid-window).
  const patches = legalPatches().filter((p) => p.shape === shape && p.cells <= cellCap && p.cells >= cellMin)
    .map((p) => ({ a: p.M ?? p.rows, b: p.N ?? p.cols, cells: p.cells }))
    .filter((p) => endlessDimsLegal(shape, p.a, p.b))
    .filter((p) => !seen.has(`${p.a}x${p.b}`))
    .sort((x, y) => y.cells - x.cells);
  const topUp = Math.max(3, 7 - out.length);
  // Ascending by cells ALWAYS — the heavy lane's top-half slice reads this
  // order, and a mixed-order list would quietly hand it small boards.
  return out.concat(patches.slice(0, topUp)).sort((x, y) => x.cells - y.cells);
}

/**
 * Cache-informed spec options for one (shape, set) stratum: the spec search
 * has measured tens of thousands of faces, and where it already knows a
 * (dims, mines) that prices near the endless window, drawing there first
 * saves the acceptance gate most of its misses. Generously banded — the
 * cache's prices may be a model behind — because the measured accept is
 * what admits, never the cache.
 */
function endlessCacheSpecs(specCache, shape, set) {
  if (!specCache) return [];
  const setKey = [...set].sort().join('+');
  const ceil = endlessParCeiling(shape);
  const out = [];
  for (const e of Object.values(specCache)) {
    if (!e.ok || e.shape !== shape) continue;
    if ([...e.gimmicks].sort().join('+') !== setKey) continue;
    if ((e.medPar || 0) < ENDLESS_PAR_FLOOR * 0.75 || e.medPar > ceil * 1.15) continue;
    if (e.cells > (ENDLESS_MAX_CELLS[shape] ?? Infinity)) continue;
    if (e.cells < (ENDLESS_MIN_CELLS[shape] ?? 0)) continue;
    if (!endlessDimsLegal(shape, e.a, e.b)) continue;
    out.push({ a: e.a, b: e.b, cells: e.cells, mines: e.mines, gl: e.gl });
  }
  return out.sort((x, y) => x.cells - y.cells);
}

/** One visit's spec, deterministic from (shape, setKey, visit). */
function drawEndlessSpec(shape, set, visit, cacheSpecs, dims) {
  const setKey = [...set].sort().join('+');
  const key = `endless|${shape}|${setKey}|${visit}`;
  let a, b, cells, mines, gl;
  // Alternate cache-informed and fresh draws so a stratum with cache
  // coverage still explores past what the sweep happened to measure.
  const fromCache = cacheSpecs.length && (visit % 2 === 0 || !dims.length);
  if (fromCache) {
    const e = cacheSpecs[fnv(key) % cacheSpecs.length];
    ({ a, b, cells, mines } = e);
    gl = e.gl || ENDLESS_GL[fnv(`${key}|g`) % ENDLESS_GL.length];
  } else {
    if (!dims.length) return null;
    // THE HEAVY LANE AIMS HIGH: 4-5 stacks clear strict load-bearing on
    // big, dense boards and almost nowhere else (the REP pass's lesson —
    // Octagons runs 597-637s under a 4-stack at density 0.36 on its largest
    // patches, against a 243s plain maximum; probed here: rect 156c 4-stack
    // 5/6 certified, hex 88c 6/6). A uniform draw spends most heavy visits
    // under the par floor, so arity 4+ takes the top half of the dims list
    // and the top densities.
    const pool = set.length >= 4 ? dims.slice(Math.floor(dims.length / 2)) : dims;
    const d = pool[fnv(key) % pool.length];
    ({ a, b, cells } = d);
    const densCap = shape === 'rect' ? 0.42 : Math.min(REP_DENSITY_CAP[shape] ?? 0.38, 0.38);
    let options = ENDLESS_DENSITIES.filter((x) => x <= densCap);
    if (set.length >= 4 && options.length > 2) options = options.slice(-2);
    const dens = options[fnv(`${key}|d`) % options.length];
    mines = Math.round(cells * dens);
    if (mines < 4) return null;
    gl = ENDLESS_GL[fnv(`${key}|g`) % ENDLESS_GL.length];
  }
  const spec = shape === 'rect'
    ? { shape: 'rect', rows: a, cols: b, cells, mines, gimmicks: [...set] }
    : { shape, M: a, N: b, cells, mines, gimmicks: [...set], constructive: true };
  if (set.length) spec.gimmickLevel = gl;
  if (shape === 'rect' && set.includes('walls')) spec.wallSegments = cells >= 100 ? 3 : 2;
  spec.genAttempts = ENDLESS_GEN_ATTEMPTS;
  spec.strictRetries = ENDLESS_STRICT_RETRIES;
  return spec;
}

function loadJsonMaybe(url) {
  try { return JSON.parse(readFileSync(url, 'utf8')); } catch { return null; }
}

/**
 * Emit pages. Fresh build: deal the keeps round-robin over shapes (each
 * shape's boards in generation order), then cut the sequence into pages —
 * round-robin so any PREFIX of the page set is shape-balanced, the same
 * budget-cut-lands-uniformly property the visits themselves keep. Append:
 * the existing pages are FROZEN (re-dealing them would move boards between
 * pages and quietly desync every player's page-keyed seen map); new keeps
 * become NEW pages after them, and only the index is rewritten.
 */
function emitEndlessPages(existingPages, keeps, dry) {
  const byShape = new Map();
  for (const c of keeps) {
    if (!byShape.has(c.spec.shape)) byShape.set(c.spec.shape, []);
    byShape.get(c.spec.shape).push(c);
  }
  const queues = [...byShape.values()];
  const sequence = [];
  while (queues.some((q) => q.length)) {
    for (const q of queues) if (q.length) sequence.push(q.shift());
  }
  const newPages = [];
  for (let i = 0; i < sequence.length; i += ENDLESS_PAGE_SIZE) {
    newPages.push(sequence.slice(i, i + ENDLESS_PAGE_SIZE));
  }
  const fp = modelFingerprint();
  const counts = existingPages.map((p) => p.boards.length)
    .concat(newPages.map((p) => p.length));
  const total = counts.reduce((a, b) => a + b, 0);
  if (!dry) {
    newPages.forEach((boards, i) => {
      const k = existingPages.length + i;
      writeFileSync(endlessPageFile(k), JSON.stringify({ page: k, parModel: fp, boards }));
    });
    writeFileSync(ENDLESS_INDEX, JSON.stringify({
      parModel: fp,
      parFloor: ENDLESS_PAR_FLOOR,
      boards: total,
      pages: counts.length,
      counts,
    }));
  }
  return { pages: counts.length, boards: total };
}

/**
 * The endless build. Fresh (no index yet): generate the full target and
 * emit the sharded pages. Append (--shape, or an index already present):
 * the existing pages are FROZEN HISTORY (the library's append-only rule);
 * new boards land in new pages after them, deduped against the whole
 * standing set, and the reprice pass rebalances later if it wants to.
 */
function runEndlessBuild({ dry, minutes, onlyShape, target }) {
  const existingIndex = loadJsonMaybe(ENDLESS_INDEX);
  const existing = [];
  if (existingIndex) {
    for (let k = 0; k < existingIndex.pages; k++) {
      const page = loadJsonMaybe(endlessPageFile(k));
      if (page) existing.push(...page.boards);
    }
    // An append against a stale-priced library would dedupe and quota
    // against numbers the model no longer stands behind.
    if (existingIndex.parModel !== modelFingerprint()) {
      console.error(`endless index is priced under ${existingIndex.parModel}, the model is ${modelFingerprint()}.`);
      console.error('Run: node scripts/reprice-climb-library.mjs   before appending.');
      process.exit(1);
    }
  }

  const shapes = onlyShape ? [onlyShape] : ENDLESS_SHAPES;
  if (onlyShape && !ENDLESS_SHAPES.includes(onlyShape)) {
    console.error(`--shape must be one of ${ENDLESS_SHAPES.join(', ')}`);
    process.exit(1);
  }
  const wanted = target ?? (onlyShape ? 60 : Math.max(0, ENDLESS_TARGET_BOARDS - existing.length));
  if (!wanted) { console.log(`endless library already holds ${existing.length} boards`); return; }

  const specCache = loadJsonMaybe(new URL('./data/spec-search-cache.json', import.meta.url));
  const mapFile = new URL('./data/climb-price-map.json', import.meta.url);
  const priced = (loadJsonMaybe(mapFile) || { entries: [] }).entries;
  console.log(`endless build: target ${wanted} boards over ${shapes.join(', ')}`
    + ` (${existing.length} already in the library${specCache ? `, spec cache ${Object.keys(specCache).length} faces` : ', NO spec cache'})`);

  // Resume state: every completed visit's verdict, keyed deterministically,
  // so an interrupted run replays its keeps for free and continues the
  // sequence. The cache stores the KEPT board (payload included); misses
  // store null and are never re-run.
  const cacheUrl = endlessCacheFile(onlyShape);
  const progress = loadJsonMaybe(cacheUrl) || { visits: {} };
  let lastSave = Date.now();
  const saveProgress = (force) => {
    if (!force && Date.now() - lastSave < 60_000) return;
    writeFileSync(cacheUrl, JSON.stringify(progress));
    lastSave = Date.now();
  };

  const lanes = shapes.map((_, i) => endlessLanes(ENDLESS_SHAPES.indexOf(shapes[i])));
  const dimsByShape = new Map(shapes.map((s) => [s, endlessDims(s, priced)]));
  const cacheSpecMemo = new Map();
  const faceCount = new Map();
  const existingSeeds = new Set(existing.map((b) => b.seed));
  for (const b of existing) faceCount.set(b.face, (faceCount.get(b.face) || 0) + 1);

  const keeps = [];
  const keptByShape = new Map(shapes.map((s) => [s, 0]));
  const perShapeTarget = Math.ceil(wanted / shapes.length);
  const laneEmpty = new Map();   // `${shape}|${lane}` -> consecutive empty visits
  const laneRest = new Map();    // `${shape}|${lane}` -> round it may run again
  const laneBails = new Map();   // `${shape}|${lane}` -> times it has rested
  const visitN = new Map();      // `${shape}|${lane}` -> visits taken
  const LANE_COUNT = 5;
  const t0 = Date.now();
  const budgetMs = minutes * 60_000;
  let built = 0, replayed = 0;

  const accept = (shape, c) => {
    if (!c) return false;
    if (c.par < ENDLESS_PAR_FLOOR || c.par > endlessParCeiling(shape)) return false;
    if ((faceCount.get(c.face) || 0) >= ENDLESS_FACE_CAP) return false;
    return true;
  };

  // The exit conditions, in order: target met; wall clock spent; every shape
  // at quota; or a long idle spin with every lane at its escalation ceiling.
  // Idle rounds cost nothing (no visit runs), so the horizon is sized to
  // outlast the LONGEST possible rest rather than to feel proportionate —
  // the first cut broke at 65 idle rounds, before a third-bail rest could
  // even expire, and read a resting shard as an exhausted one.
  const HARD_ROUND_CAP = 40_000;
  const IDLE_HORIZON = ENDLESS_LANE_REST_ROUNDS * ENDLESS_LANE_BAILS_CAP * LANE_COUNT * 2;
  let inactiveRounds = 0;
  outer:
  for (let round = 0; round < HARD_ROUND_CAP; round++) {
    if (keeps.length >= wanted) break;
    if (shapes.every((s) => keptByShape.get(s) >= perShapeTarget)) break;
    if (inactiveRounds > IDLE_HORIZON) {
      console.log('every lane sat at its escalation ceiling through a full horizon; stopping short of target');
      break;
    }
    if (round > 0 && round % 5 === 0 && inactiveRounds === 0) {
      const shapeLine = shapes.map((s) => `${s} ${keptByShape.get(s)}`).join('  ');
      console.log(`round ${round}: kept ${keeps.length}/${wanted}  built ${built}  ${((Date.now() - t0) / 60000).toFixed(1)}m  [${shapeLine}]`);
    }
    // One visit of one (shape, lane) stratum. Returns true when it RAN
    // (found a runnable lane), whatever the outcome.
    const runVisit = (si, shape, laneIdx) => {
      const laneKey = `${shape}|${laneIdx}`;
      if ((laneRest.get(laneKey) || 0) > round) return false;
      const lane = lanes[si][laneIdx];
      const set = lane[Math.floor(round / LANE_COUNT) % lane.length];

      const v = visitN.get(laneKey) || 0;
      visitN.set(laneKey, v + 1);
      const setKey = [...set].sort().join('+');
      const visitKey = `${shape}|${setKey}|${v}`;

      let kept = null;
      let alreadyBanked = false;
      if (visitKey in progress.visits) {
        kept = progress.visits[visitKey];
        replayed++;
        // A cached keep that already made it into the EMITTED pages must not
        // land twice: it is counted with `existing`, not with this run's.
        if (kept && existingSeeds.has(kept.seed)) alreadyBanked = true;
        else if (kept && !accept(shape, kept)) kept = null;  // face filled meanwhile, or floor moved
      } else {
        const memoKey = `${shape}|${setKey}`;
        if (!cacheSpecMemo.has(memoKey)) cacheSpecMemo.set(memoKey, endlessCacheSpecs(specCache, shape, set));
        const spec = drawEndlessSpec(shape, set, v, cacheSpecMemo.get(memoKey), dimsByShape.get(shape));
        const visitT0 = Date.now();
        // The face gate runs BEFORE generation: a visit's K draws all share
        // one face, so a full face means K boards built to reject K boards.
        if (spec && (faceCount.get(specFace(spec)) || 0) < ENDLESS_FACE_CAP) {
          let best = null;
          let under = 0, over = 0;
          const ceiling = endlessParCeiling(shape);
          for (let k = 0; k < endlessBestOf(shape); k++) {
            if (Date.now() - visitT0 > ENDLESS_VISIT_BUDGET_MS) break;
            let c = null;
            // candidate() can THROW (serializeBoard refuses an unstorable
            // container), and an hours-long run must treat one bad spec as
            // a miss, never as its own death.
            try { c = candidate(spec, `climb:endless:${shape}:${setKey}:${v}:${k}`); }
            catch (err) { console.log(`  ${shape} ${setKey} v${v}: ${err.message}`); break; }
            built++;
            if (c && c.par < ENDLESS_PAR_FLOOR) under++;
            if (c && c.par > ceiling) over++;
            if (!c || !accept(shape, c)) {
              // ABANDON AN AIMLESS VISIT: par varies maybe 20% between draws
              // of one spec, so two misses on the SAME side of the window
              // mean the spec is aimed off, not unlucky, and the remaining
              // draws are the single biggest waste in the whole run (a miss
              // visit used to cost its full best-of-K).
              if (!best && (under >= 2 || over >= 2)) break;
              continue;
            }
            if (!best || c.hard > best.hard) best = c;
          }
          kept = best;
        }
        progress.visits[visitKey] = kept;
        saveProgress(false);
      }

      if (alreadyBanked) return true;
      if (kept) {
        keeps.push(kept);
        faceCount.set(kept.face, (faceCount.get(kept.face) || 0) + 1);
        keptByShape.set(shape, keptByShape.get(shape) + 1);
        laneEmpty.set(laneKey, 0);
        // A keep clears the lane's whole escalation: a producing lane is
        // low-yield, never infeasible, and the escalation exists only for
        // the lanes that have NEVER produced (plain rhombille cannot price
        // at 400s on any board).
        laneBails.delete(laneKey);
      } else {
        const n = (laneEmpty.get(laneKey) || 0) + 1;
        laneEmpty.set(laneKey, n);
        if (n >= ENDLESS_LANE_BAILS) {
          const bails = Math.min(ENDLESS_LANE_BAILS_CAP, (laneBails.get(laneKey) || 0) + 1);
          laneBails.set(laneKey, bails);
          laneRest.set(laneKey, round + ENDLESS_LANE_REST_ROUNDS * bails);
          laneEmpty.set(laneKey, 0);
        }
      }
      return true;
    };

    let anyActive = false;
    const leader = Math.max(1, ...shapes.map((s) => keptByShape.get(s)));
    for (let si = 0; si < shapes.length; si++) {
      const shape = shapes[si];
      if (keeps.length >= wanted) break outer;
      if (Date.now() - t0 > budgetMs) { console.log('wall-clock budget reached'); break outer; }
      if (keptByShape.get(shape) >= perShapeTarget) continue;
      const laneIdx = round % LANE_COUNT;
      if (runVisit(si, shape, laneIdx)) anyActive = true;
      // CATCH-UP: a shape far behind the leader takes a second visit on the
      // NEXT lane in its rotation, so even coverage is pursued by the loop
      // rather than hoped for at the end. The dear shapes (rhombille,
      // deltoidal, 4.8.8's narrow par corridor) fall behind at equal visit
      // counts — measured 50 rounds in: floret 24, 4.8.8 and rhombille 0.
      // Deterministic under resume: keptByShape replays from the cache.
      if (keptByShape.get(shape) < leader * 0.6
        && keptByShape.get(shape) < perShapeTarget
        && Date.now() - t0 <= budgetMs) {
        if (runVisit(si, shape, (laneIdx + 1) % LANE_COUNT)) anyActive = true;
      }
    }
    inactiveRounds = anyActive ? 0 : inactiveRounds + 1;
  }
  saveProgress(true);

  const med = (a, k) => (a.length ? [...a].map((x) => x[k]).sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
  const shapeLine = shapes.map((s) => `${s} ${keptByShape.get(s)}`).join('  ');
  const heavies = keeps.filter((c) => (c.spec.gimmicks || []).length >= 4).length;
  console.log(`\nendless build kept ${keeps.length} (${replayed} replayed from the resume cache), built ${built} candidates in ${((Date.now() - t0) / 60000).toFixed(1)}m`);
  console.log(`  par med ${Math.round(med(keeps, 'par'))}s  hard med ${med(keeps, 'hard')}  4-5 stacks ${heavies}  [${shapeLine}]`);

  // A --shape run only writes its cache: the pages are emitted ONCE, by
  // --emit-only, after every parallel shard has finished, so two shards can
  // never interleave partial page sets.
  if (onlyShape) {
    console.log(`shard cache written; emit the merged pages with: node scripts/build-climb-library.mjs --endless --emit-only`);
    return;
  }
  const out = emitEndlessPages(existingIndex ? endlessExistingPages() : [], keeps, dry);
  console.log(`${dry ? '[dry-run] would write' : 'wrote'} ${out.pages} pages, ${out.boards} boards, index at ${ENDLESS_INDEX.pathname.split('/').pop()}`);
}

/** The existing endless pages, structure intact (for append-mode emits). */
function endlessExistingPages() {
  const idx = loadJsonMaybe(ENDLESS_INDEX);
  if (!idx) return [];
  const out = [];
  for (let k = 0; k < idx.pages; k++) {
    const page = loadJsonMaybe(endlessPageFile(k));
    if (page) out.push(page);
  }
  return out;
}

/**
 * Merge every shard cache (and the shared single-process cache, if one
 * exists) into the sharded pages. The accept rules are the build's own:
 * inside the par window, the library-wide face cap, never a seed the pages
 * already hold. Keeps stay in per-shape generation order and the emitter
 * interleaves shapes, so a truncated merge is still balanced.
 */
function runEndlessEmitOnly({ dry, target }) {
  const existingPages = endlessExistingPages();
  const existing = existingPages.flatMap((p) => p.boards);
  const existingSeeds = new Set(existing.map((b) => b.seed));
  const faceCount = new Map();
  for (const b of existing) faceCount.set(b.face, (faceCount.get(b.face) || 0) + 1);

  const keeps = [];
  const perShape = new Map();
  for (const shape of ENDLESS_SHAPES) {
    const caches = [loadJsonMaybe(endlessCacheFile(shape)), loadJsonMaybe(ENDLESS_CACHE)];
    let n = 0;
    for (const cache of caches) {
      if (!cache || !cache.visits) continue;
      for (const [key, kept] of Object.entries(cache.visits)) {
        if (!kept || !key.startsWith(`${shape}|`)) continue;
        if (existingSeeds.has(kept.seed)) continue;
        if (kept.par < ENDLESS_PAR_FLOOR || kept.par > endlessParCeiling(shape)) continue;
        if ((faceCount.get(kept.face) || 0) >= ENDLESS_FACE_CAP) continue;
        existingSeeds.add(kept.seed);
        faceCount.set(kept.face, (faceCount.get(kept.face) || 0) + 1);
        keeps.push(kept);
        n++;
      }
    }
    perShape.set(shape, n);
  }
  const wanted = (target ?? ENDLESS_TARGET_BOARDS) - existing.length;
  // Trim OVER-target balanced: round-robin over shapes, exactly the
  // emitter's own deal, so the cut lands evenly rather than on whichever
  // shape happened to be gathered last.
  let final = keeps;
  if (keeps.length > wanted && wanted > 0) {
    const byShape = new Map();
    for (const c of keeps) {
      if (!byShape.has(c.spec.shape)) byShape.set(c.spec.shape, []);
      byShape.get(c.spec.shape).push(c);
    }
    const queues = [...byShape.values()];
    final = [];
    while (final.length < wanted && queues.some((q) => q.length)) {
      for (const q of queues) {
        if (final.length >= wanted) break;
        if (q.length) final.push(q.shift());
      }
    }
  }
  const heavies = final.filter((c) => (c.spec.gimmicks || []).length >= 4).length;
  console.log(`emit-only: ${final.length} boards from the shard caches (${existing.length} already paged, ${heavies} heavy stacks)`
    + ` [${[...perShape].map(([s, n]) => `${s} ${n}`).join('  ')}]`);
  const out = emitEndlessPages(existingPages, final, dry);
  console.log(`${dry ? '[dry-run] would write' : 'wrote'} ${out.pages} pages, ${out.boards} boards`);
}

export { parFloor, parWindowTop, hardFloor, minBoardsFor, legalPatches, GIMMICK_SETS, candidate, hardOf,
  MIN_PAR, MIN_WORK, CANDIDATES_PER_KEEP, OUT_DIR,
  LIB_SHAPE_INTROS, LIB_MOD_INTROS, intakeRules, boardAllowedAtLevel, PAR_FLOOR_SHAPE_RELIEF,
  ENDLESS_PAGE_SIZE, ENDLESS_FACE_CAP, ENDLESS_INDEX, endlessPageFile,
  endlessLanes, endlessDims, endlessCacheSpecs, drawEndlessSpec };

// ── CLI ────────────────────────────────────────────────────────────────
// Guarded so the module can be IMPORTED for its helpers without running the
// build, and without throwing when argv[1] is absent (node -e, a test).
if ((process.argv[1] || '').endsWith('build-climb-library.mjs')) {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
  const range = (() => {
    const i = args.indexOf('--levels');
    if (i < 0) return null;
    const [a, b] = args[i + 1].split('-').map(Number);
    return { from: a, to: b || a };
  })();

  if (args.includes('--endless')) {
    if (args.includes('--emit-only')) {
      runEndlessEmitOnly({ dry, target: argOf('--target') ? Number(argOf('--target')) : null });
    } else {
      runEndlessBuild({
        dry,
        minutes: Number(argOf('--minutes', 300)),
        onlyShape: argOf('--shape'),
        target: argOf('--target') ? Number(argOf('--target')) : null,
      });
    }
    process.exit(0);
  }

  if (!range) {
    console.error('usage: --levels A-B [--dry-run]   |   --endless [--minutes N] [--shape s] [--target N] [--dry-run]');
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
  // BAIL MEMORY. A shape that spent its full wall-clock budget failing to
  // reach a level's floor cannot reach the next level's either: floors move
  // by about a second per level while the shape's supply gap spans tens of
  // seconds. Without this, rhombille and Kites re-burned 60s EACH on level
  // after level through the sparse mid-ladder, about two hours of certain
  // failure over the run. Five levels later the window has moved enough to
  // be worth asking again.
  const bailSkip = new Map();
  console.log(`price map: ${priced.length} priced specs`
    + `${which === fastFile ? ' (FAST map: rhombille and deltoidal missing)' : ''}`);
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const force = args.includes('--force');
  for (let level = range.from; level <= range.to; level++) {
    const floorPar = parFloor(level);
    if (floorPar == null) { console.log(`L${level}: authored opener, skipped`); continue; }
    // RESUME BY DEFAULT: the library is append-only and the seeds are
    // deterministic, so an existing file is the same file a rebuild would
    // write. Skipping it is what makes recovery from an interrupted run
    // cost nothing. --force regenerates (a refit that moves the par model
    // is the reason to).
    const outFile = new URL(`level-${String(level).padStart(3, '0')}.json`, OUT_DIR);
    if (!dry && !force && existsSync(outFile)) {
      console.log(`L${String(level).padStart(3)} exists, resumed past`);
      continue;
    }
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
      // Plain generation at seconds per draw means gimmicked builds at
      // multiples of that; one such spec in the rotation turns a level into
      // minutes. The 120-135 cell rhombille patches are the whole class.
      // Their SMALLER siblings stay in, so the shape itself does not thin.
      .filter((e) => e.genMs == null || e.genMs <= 2500)
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
        if ((bailSkip.get(sh) || 0) > level) continue;
        const nearFloor = priced
          .filter((e) => e.shape === sh && e.par >= floorPar * 0.45 && e.par <= floorPar * 1.05)
          .filter((e) => e.genMs == null || e.genMs <= 2500)
          .sort((a, b) => Math.abs(a.par - floorPar * 0.8) - Math.abs(b.par - floorPar * 0.8))
          .slice(0, 3)
          .map((e) => ({ shape: e.shape, rows: e.rows, cols: e.cols, M: e.M, N: e.N, cells: e.cells }));
        const tops = nearFloor.length ? nearFloor : allPatches.filter((q) => q.shape === sh)
          .sort((a, b) => b.cells - a.cells).slice(0, 3);
        const heavy = HEAVY_SETS.map((g) => g.filter((m) => modsIn.has(m)))
          .filter((g) => g.length >= 2);
        let tries = 0;
        const shapeT0 = Date.now();
        let bailed = false;
        const densCap = REP_DENSITY_CAP[sh] ?? 0.36;
        for (const q of tops) {
          for (const dens of [0.28, 0.32, 0.36]) {
            if (dens > densCap) continue;
            for (const g of heavy) {
              if (tries >= REP_TRIES_PER_SHAPE) break;
              if (Date.now() - shapeT0 > REP_SHAPE_BUDGET_MS) { bailed = true; break; }
              const mines = Math.round(q.cells * dens);
              if (mines < 4 || mines > q.cells * 0.42) continue;
              tries++;
              const c = candidate(
                { shape: q.shape, rows: q.rows, cols: q.cols, M: q.M, N: q.N,
                  cells: q.cells, mines, gimmicks: g, gimmickLevel: 110, constructive: true,
                  genAttempts: REP_GEN_ATTEMPTS, strictRetries: 1 },
                `climb:L${level}:rep:${sh}:${dens}:${g.join('.')}`);
              if (!c) continue;
              const n = seenFace.get(c.face) || 0;
              if (n >= 2) continue;
              seenFace.set(c.face, n + 1);
              kept.push(c);
            }
            if (bailed) break;
          }
          if (bailed) break;
        }
        if (bailed) {
          bailSkip.set(sh, level + 5);
          console.log(`  L${level}: rep pass for ${sh} bailed at ${REP_SHAPE_BUDGET_MS}ms, skipping it until L${level + 5}`);
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
      writeFileSync(outFile, JSON.stringify({
        level, block, parFloor: Math.round(floorPar), parWindowTop: Math.round(topPar),
        intro: debutShape || debutMod || null,
        parModel: modelFingerprint(),
        boards: chosen,
      }));
    }
  }
}
