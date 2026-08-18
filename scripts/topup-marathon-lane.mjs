// Grow the SCROLLING LANE: the match library's boards that a phone cannot
// hold, played through the camera and dealt only under the config sheet's
// scroll opt-in.
//
// TWO KINDS, and the second was missing until 2026-08-17 (his "I was musing
// about the merits of a 25x3 board myself"). A board can fail the fit rules
// by being too BIG for the screen (the marathon giants) or by being the
// wrong PROPORTION at an ordinary size: a 6x20, a 5x25, his 25x3. Both are
// what the toggle opts into, and the second is what his original ask named
// ("sparse long boards and other fills").
//
//   node scripts/topup-marathon-lane.mjs [--minutes 10] [--target N]
//     [--shapes rect,hex] [--dry-run] [--no-network]
//
// WHY A SEPARATE TOOL rather than a flag on topup-match-library. The two
// lanes answer different questions and must not share a census: the fit
// lane's corner targets are about depth a player can be dealt today, while
// this lane's job is breadth across the sizes the camera unlocked, and its
// boards are priced by a different rule (below). Mixing them would let
// oversized boards read a corner as full while every opted-out host, which
// is most of them, deals thin. They DO share everything structural: the same
// pages, the same append-only discipline, the same index writer, the same
// seen-cycle key.
//
// WHAT IT GENERATES. His ruling 2026-08-17: the ceiling is 2x the
// established fit-legal dims per shape, straight from boardFit's verdicts
// ("We've already figured out widths and lengths that work. Doubling that is
// all you need"), which src/logic/marathonFit.js turns into the union of
// doubled fit-legal pairs, clipped to the canonical container. Shapes: all
// seven (his "all"), with rhombille behind the same backoff every hard
// corner gets, since it probed 0/3 certified at ~2.5s an attempt while every
// other shape certified 3/3 in milliseconds.
//
// HOW IT PRICES, and it depends on which kind. A board inside the shape's
// own fit ceiling in CELLS is one the par model has data at, however odd its
// proportions, so it takes predictPar like any other board in the library
// (measured: a 25x3 prices 52s, a 6x20 65s, an 8x22 104s). Past that ceiling
// the model extrapolates badly in both directions (probed: hex at 600 cells
// priced 17s, cairo at 325 priced 4.9 hours), so those boards price from the
// model's own edge, extended linearly under a traversal floor
// (marathonProvisionalPar). Their ANCHOR is a real certified board at this
// shape's fit-ceiling dims wearing the same modifier set at the same
// density, and its features are STORED so the nightly re-price can re-anchor
// under each night's model. Only those boards carry `parProvisional`, so the
// flag keeps meaning "nobody has measured a board this size".
//
// APPEND ONLY, NEW PAGES AT THE END, exactly as the fit top-up: `page:idx`
// is the seen-cycle key on every device.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { buildChallenge250Board } from '../src/logic/challenge250Builder.js';
import { serializeBoard } from '../src/firebase/dailyBoardSync.js';
import { packPayload } from '../src/logic/boardPack.js';
import { modelFingerprint } from '../src/logic/parModelFingerprint.js';
import { specFace, CLIMB_MIN_DEDUCTIONS } from '../src/logic/challengeRules.js';
import {
  timeBandOf, densityBandOf,
  MATCH_DENSITY_BANDS, MARATHON_PAR_CEILING_SECONDS,
} from '../src/logic/matchRules.js';
import {
  marathonDims, marathonDimsSpread, marathonShapes, marathonProvisionalPar,
  fitLegalFrontier, inSupportCells,
} from '../src/logic/marathonFit.js';
import { buildTiling } from '../src/logic/tilingGeometry.js';
import { OUT_DIR, writeMatchIndexFiles, matchPageFile, matchPageNames } from './match-index-files.mjs';

const STATE_FILE = new URL('marathon-state.json', OUT_DIR);
const PAGE_SIZE = 16;
const TRIES_PER_DRAW = 3;
const BACKOFF_CAP = 5;
const FLUSH_EVERY_MS = 5 * 60000;

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const DRY = args.includes('--dry-run');
const BUDGET_MS = Number(argVal('--minutes', 10)) * 60000;
// Boards per (shape x modifier set x density) cell. Breadth first: the lane
// exists to open sizes, and depth in one cell buys nothing while other cells
// hold nothing at all.
const CELL_TARGET = Number(argVal('--target', 4));
const ONLY_SHAPES = (argVal('--shapes', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

// The modifier sets the lane offers. Plain first (the reopened sparse-long
// cells are mostly plain), then the singles that carry time without carrying
// mines, which is what a sparse marathon board is made of. Deliberately no
// heavy stacks in the first fill: cost and certification risk both rise with
// arity, and breadth is worth more here than a three-modifier monster.
const LANE_MOD_SETS = [[], ['sonar'], ['liar'], ['walls'], ['compass']];

/** Every page in order. The array index IS the page number. */
function loadPages() {
  return matchPageNames().map((n) => JSON.parse(readFileSync(new URL(n, OUT_DIR), 'utf8')).boards);
}

function loadState() {
  if (!existsSync(STATE_FILE)) return { runs: 0, cells: {} };
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return { runs: Number(s.runs) || 0, cells: s.cells || {} };
  } catch { return { runs: 0, cells: {} }; }
}

/** A cell with `fails` consecutive misses is tried every 2^fails runs. */
export function cell_isDue(rec, runNo) {
  const fails = Math.min(BACKOFF_CAP, Number(rec && rec.fails) || 0);
  return fails === 0 || runNo % (2 ** fails) === 0;
}

/**
 * The lane's two SIZE CLASSES, which is what the toggle actually unlocks:
 * 'wide' is an ordinary cell count in a shape no phone can hold (a 6x20, his
 * 25x3), 'big' is past the shape's fit ceiling in cells (the giants). They
 * are tracked separately because they are different boards to play and
 * because they price by different rules.
 */
export const laneSizeClass = (shape, cells) => (inSupportCells(shape, cells) ? 'wide' : 'big');

/**
 * The lane's cell key: shape, modifier set, density band, size class. Time is
 * an OUTCOME here (par is emergent), so it is not part of what the lane aims
 * at. The SIZE CLASS is, and it has to be: the first fill met every cell's
 * target with giants, so a menu spread alone would never have built a single
 * wide board. This key is internal to this tool and its state file, never a
 * corner key, so widening it moves no shard and resets no seen-cycle; the
 * only cost is that backoff records written under the old three-part keys
 * stop matching, which loses a night of history and nothing else.
 */
export function laneCellKey(shape, mods, density, sizeClass) {
  return [shape, (mods || []).slice().sort().join('+'), density, sizeClass]
    .filter((x) => x !== undefined).join('|');
}

/**
 * The anchor for a shape+mods+density: a certified board at the shape's
 * FIT-CEILING dims, whose par the model can actually speak to. Cached per
 * cell key; a shape whose anchor cannot be built is skipped rather than
 * priced by the floor alone, because an anchorless lane board would have no
 * way to re-price under a future model.
 */
const _anchorCache = new Map();
function anchorFor(shape, mods, densityMid, fitCeilingSpec) {
  const key = laneCellKey(shape, mods, String(densityMid));
  if (_anchorCache.has(key)) return _anchorCache.get(key);
  let out = null;
  for (let t = 0; t < TRIES_PER_DRAW && !out; t++) {
    const spec = {
      ...fitCeilingSpec,
      mines: Math.max(1, Math.round(fitCeilingSpec.cells * densityMid)),
      gimmicks: mods.slice(),
      ...(mods.includes('walls') ? { wallSegments: 4 } : {}),
    };
    let r = null;
    try {
      r = buildChallenge250Board(spec, `manchor:${specFace(spec)}:${t}`, {});
    } catch { r = null; }
    if (r && r.check && r.check.solvable && r.par > 0 && r.features) {
      out = { par: r.par, cells: fitCeilingSpec.cells, features: r.features };
    }
  }
  _anchorCache.set(key, out);
  return out;
}

/** The fit-ceiling spec for a shape: the largest fit-legal board it has.
 * Derived from marathonFit's own frontier so the anchor and the lane ceiling
 * come from one source. */
export function fitCeilingSpec(shape) {
  let best = null;
  for (const [M, N] of fitLegalFrontier(shape)) {
    const cells = shape === 'rect' ? M * N : (() => {
      try { return buildTiling(shape, M, N).total; } catch { return 0; }
    })();
    if (cells > 0 && (!best || cells > best.cells)) {
      best = shape === 'rect'
        ? { shape, rows: M, cols: N, cells }
        : { shape, M, N, cells };
    }
  }
  return best;
}

/** Draw one certified lane board, priced provisionally. */
function drawLaneBoard(dims, mods, mines, anchor, salt) {
  const spec = {
    ...dims, mines, gimmicks: mods.slice(),
    ...(mods.includes('walls') ? { wallSegments: 4 } : {}),
  };
  const seed = `marathon:${specFace(spec)}:${salt}`;
  for (let t = 0; t < TRIES_PER_DRAW; t++) {
    let r = null;
    try {
      r = buildChallenge250Board({ ...spec }, `${seed}:${t}`, { contribution: true });
    } catch { continue; }
    if (!r || !r.check || !r.check.solvable || !r.features) continue;
    const work = r.check.totalClicks - 1;
    if (work < CLIMB_MIN_DEDUCTIONS) continue;
    // PRICE FROM THE MODEL WHERE THE MODEL CAN SPEAK. A lane board is not
    // automatically out of the fit's support: the proportion half of the
    // lane (a 6x20, a 25x3) is an ordinary CELL COUNT in an extraordinary
    // shape, and predictPar has data at those sizes. Only past the shape's
    // fit ceiling does the anchor scheme take over, and only those boards
    // are flagged provisional, so the flag keeps meaning "nobody has
    // measured a board this size" instead of "this board scrolls".
    const inSupport = inSupportCells(spec.shape, spec.cells);
    const par = inSupport
      ? Math.round(r.par * 10) / 10
      : marathonProvisionalPar({
        cells: spec.cells, anchorPar: anchor.par, anchorCells: anchor.cells,
      });
    // His Marathon range tops out at 30 minutes; applied at ADMISSION, never
    // as a membership bound (the endless library's rule, same reasoning).
    if (!(par > 0) || par > MARATHON_PAR_CEILING_SECONDS) continue;
    let payload;
    try {
      payload = serializeBoard({
        board: r.board, rows: r.rows, cols: r.cols, totalMines: r.totalMines,
        rngSeed: `${seed}:${t}`, activeGimmicks: r.activeGimmicks, firstClick: r.firstClick,
      });
    } catch { continue; }
    return {
      par: Math.round(par * 10) / 10,
      work,
      seed: `${seed}:${t}`,
      features: r.features,
      payload,
      // The lane's own fields. `oversized` is what the deal filters on and
      // what the index row carries. The anchor pair and `parProvisional`
      // ride only the boards that actually needed the anchor scheme: an
      // in-support board is priced by the model like any other board in the
      // library, and the nightly re-prices it the ordinary way.
      oversized: true,
      ...(inSupport ? {} : {
        parProvisional: true,
        anchorCells: anchor.cells,
        anchorFeatures: anchor.features,
      }),
      spec: {
        shape: spec.shape, rows: spec.rows, cols: spec.cols, M: spec.M, N: spec.N,
        cells: spec.cells, mines: spec.mines, gimmicks: mods.slice(),
        wallSegments: spec.wallSegments,
      },
    };
  }
  return null;
}

async function main() {
  const t0 = Date.now();
  const pages = loadPages();
  if (pages.length === 0) {
    console.error('topup-marathon-lane: no pages found; run the build first');
    process.exit(1);
  }
  const existing = pages.flat().filter((b) => b && !b.evicted);
  const seedsHeld = new Set(existing.map((b) => b.seed));
  const lane = existing.filter((b) => b.oversized === true);

  // Depth per lane cell, counted per size class.
  const have = new Map();
  for (const b of lane) {
    const k = laneCellKey(b.spec.shape, b.spec.gimmicks || [],
      densityBandOf(b.spec.mines, b.spec.cells),
      laneSizeClass(b.spec.shape, b.spec.cells));
    have.set(k, (have.get(k) || 0) + 1);
  }

  const shapes = marathonShapes().filter((s) => !ONLY_SHAPES.length || ONLY_SHAPES.includes(s));
  const state = loadState();
  const runNo = state.runs + 1;

  // The work list: every (shape, mods, density) cell under target, ordered
  // by NEED so an interrupted run leaves the emptiest cells least starved.
  const wanted = [];
  for (const shape of shapes) {
    for (const mods of LANE_MOD_SETS) {
      for (const band of MATCH_DENSITY_BANDS) {
        for (const sizeClass of ['wide', 'big']) {
          const key = laneCellKey(shape, mods, band.key, sizeClass);
          const need = CELL_TARGET - (have.get(key) || 0);
          if (need > 0 && cell_isDue(state.cells[key], runNo)) {
            wanted.push({ key, shape, mods, band, sizeClass, need });
          }
        }
      }
    }
  }
  // WIDE FIRST while the lane is young: the giants arrived in the first fill
  // and the proportion half has nothing at all, so an interrupted run should
  // leave the emptier kind less empty. Need still breaks ties.
  wanted.sort((a, b) => (a.sizeClass === b.sizeClass ? b.need - a.need
    : (a.sizeClass === 'wide' ? -1 : 1)));

  console.log(`topup-marathon-lane: ${lane.length} lane boards on ${pages.length} pages;`
    + ` ${wanted.length} cells below target ${CELL_TARGET} (run #${runNo});`
    + ` budget ${BUDGET_MS / 60000} min, shapes ${shapes.join(',')}`);
  if (!wanted.length) {
    console.log('  nothing due; the lane is at target or every gap is backing off.');
    if (!DRY) writeFileSync(STATE_FILE, JSON.stringify({ runs: runNo, cells: state.cells }, null, 1));
    return;
  }

  const fp = modelFingerprint();
  const kept = [];
  const newPages = [];
  let flushed = 0;
  let lastFlush = Date.now();
  function flushKept(final = false) {
    while (kept.length - flushed >= PAGE_SIZE || (final && kept.length > flushed)) {
      const slice = kept.slice(flushed, flushed + PAGE_SIZE);
      const p = pages.length + newPages.length;
      newPages.push(slice);
      flushed += slice.length;
      if (!DRY) {
        const packed = slice.map((b) => ({ ...b, payload: packPayload(b.payload) }));
        writeFileSync(matchPageFile(p), JSON.stringify({ page: p, parModel: fp, boards: packed }));
      }
    }
    if (newPages.length === 0) return null;
    return writeMatchIndexFiles([...pages, ...newPages], fp, { dry: DRY });
  }

  const results = new Map(); // cell key -> made
  let draws = 0;
  outer:
  for (const w of wanted) {
    const ceiling = fitCeilingSpec(w.shape);
    if (!ceiling) continue;
    const lo = MATCH_DENSITY_BANDS.indexOf(w.band) === 0
      ? 0.06 : MATCH_DENSITY_BANDS[MATCH_DENSITY_BANDS.indexOf(w.band) - 1].max;
    const hi = Number.isFinite(w.band.max) ? w.band.max : 0.34;
    const mid = lo + (hi - lo) * 0.5;
    const anchor = anchorFor(w.shape, w.mods, mid, ceiling);
    if (!anchor) {
      console.log(`  ${w.key}: no certified anchor at fit-ceiling dims, skipped`);
      continue;
    }
    // Sizes SPREAD across this class's own range rather than the biggest
    // few: a walk from the top of the whole menu would only ever reach
    // giants. Ask for more than the cell needs so a run of failed draws
    // still has somewhere to go without collapsing onto the same few sizes.
    const inClass = marathonDims(w.shape)
      .filter((d) => laneSizeClass(w.shape, d.cells) === w.sizeClass);
    const step = Math.max(1, Math.floor(inClass.length / Math.max(6, w.need * 3)));
    const dimsList = inClass.filter((_, i) => i % step === 0);
    let made = 0;
    for (const dims of dimsList) {
      if (made >= w.need) break;
      if (Date.now() - t0 > BUDGET_MS) { console.log('  budget spent'); break outer; }
      const mines = Math.max(1, Math.round(dims.cells * mid));
      const b = drawLaneBoard(dims, w.mods, mines, anchor, `${runNo}:${draws++}`);
      if (!b || seedsHeld.has(b.seed)) continue;
      seedsHeld.add(b.seed);
      kept.push(b);
      made++;
      console.log(`  + ${w.key} ${dims.cells}c par ${b.par}s`
        + ` (${timeBandOf(b.par)}) work ${b.work}`);
      if (Date.now() - lastFlush > FLUSH_EVERY_MS) { flushKept(); lastFlush = Date.now(); }
    }
    results.set(w.key, made);
    const rec = state.cells[w.key] || { fails: 0 };
    state.cells[w.key] = made > 0 ? { fails: 0 } : { fails: Math.min(BACKOFF_CAP, (rec.fails || 0) + 1) };
  }

  const written = flushKept(true);
  if (!DRY) writeFileSync(STATE_FILE, JSON.stringify({ runs: runNo, cells: state.cells }, null, 1));

  const made = kept.length;
  const bands = new Map();
  for (const b of kept) bands.set(timeBandOf(b.par), (bands.get(timeBandOf(b.par)) || 0) + 1);
  console.log(`topup-marathon-lane: kept ${made} board(s) in ${(Date.now() - t0) / 1000 | 0}s`
    + (made ? `; bands ${[...bands].map(([k, n]) => `${k}:${n}`).join(' ')}` : '')
    + (written ? `; index now ${written.boards} boards, ${written.corners} corners` : '')
    + (DRY ? ' (dry run: nothing written)' : ''));
}

// Importable for tests without running the tool.
if (process.argv[1] && process.argv[1].endsWith('topup-marathon-lane.mjs')) {
  main();
}
