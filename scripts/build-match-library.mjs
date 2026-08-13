// Build the Challenge match library: pre-generated boards over the proven
// CHALLENGE_POOL specs, stored in the climb library's bin format and dealt
// through the same fetch + verify machinery (fetchLibraryJson /
// certifyStoredBoard in src/game/climbDeal.js).
//
// WHY A SEPARATE LIBRARY. The climb library is the CLIMB's: its easiest bin
// is L26's par window, plain boards are nearly absent (19 rectangles in
// 3,409, all priced 340s+), and every density sits above 0.22. The match
// config sheet's player-selectable corners — quick boards, plain boards,
// sparse boards — are exactly the space PR #288 widened CHALLENGE_POOL to
// cover (460 proven specs, est-par ~21-431s, densities 0.10-0.42), so the
// match deals from boards generated over THOSE specs. Pre-generating rather
// than drawing under the click is the same call the Climb made (issue #286's
// class): a dealt board certifies offline, and a match's boards must be
// storable payloads anyway, because the async match node ships the host's
// dealt boards to every guest byte for byte.
//
// THE DEDUCTION FLOOR APPLIES. buildChallenge250Board enforces no floor of
// its own (the Climb's lives in its search acceptance), and the pool's
// easiest corner can produce boards that are over on the opening click
// (probed: a 25-cell rect certified at work 1). His ruling against
// immediately-done boards is CLIMB_MIN_DEDUCTIONS = 5; every match board
// clears it or the draw retries, and a spec that cannot clear it inside its
// budget is skipped and logged rather than shipped soft.
//
// STORAGE. Pages of MATCH_PAGE_SIZE boards, grouped by SHAPE and sorted by
// par within a shape (a single-shape match fetches one or two pages instead
// of N), plus match-index.json carrying a compact per-board filter row
// [page, idx, shape, cells, mines, par, mods], the one fetch that answers
// the config sheet's live counts and the deal's eligibility exactly. The
// nightly refit re-prices par per board from the stored features
// (reprice-match-library.mjs) and rewrites pages + index in place; boards
// never move between pages, so the (page:idx) seen-cycle keys stay stable.
// A full REBUILD rewrites everything and resets the seen cycle, which is
// self-healing and worth no bookkeeping (the endless library's own note).
//
// Usage:
//   node scripts/build-match-library.mjs             # full build
//   node scripts/build-match-library.mjs --dry-run   # generate, write nothing
//   node scripts/build-match-library.mjs --per-spec 2

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { buildChallenge250Board } from '../src/logic/challenge250Builder.js';
import { serializeBoard } from '../src/firebase/dailyBoardSync.js';
import { CHALLENGE_POOL } from '../src/logic/challengePool.js';
import { specFace, CLIMB_MIN_DEDUCTIONS } from '../src/logic/challenge250.js';
import { TILING_TYPES } from '../src/logic/tilingGeometry.js';
import { modelFingerprint } from '../src/logic/parModelFingerprint.js';
import {
  OUT_DIR, matchPageFile as pageFile, writeMatchIndexFiles,
} from './match-index-files.mjs';

export { OUT_DIR };
const CACHE_FILE = new URL('./data/match-build-cache.json', import.meta.url);

export const MATCH_PAGE_SIZE = 16;
// Two boards per spec: the seen-cycle repeats a board only after exhausting
// the eligible set, and a narrow filter (one shape, one band) may hold only
// a dozen specs, so doubling per-spec depth is what keeps short cycles rare.
const PER_SPEC_DEFAULT = 2;
// Draw budget per kept board. Pool specs are pre-proven (probed first-try
// certification across all seven shapes), so most of this budget exists for
// the deduction floor: a tiny easy spec may need several draws to land a
// board with five real decisions.
const TRIES_PER_KEEP = 8;

// Fixed shape order for page grouping: rect first, then the registry's own
// order, so page numbering is stable across rebuilds.
const SHAPE_ORDER = ['rect', ...TILING_TYPES];

const hardOf = (c) => c.canonicalSubsetMoves + c.genericSubsetMoves
  + c.advancedLogicMoves + c.disjunctiveMoves;

/** One accepted board for a spec, or null when the budget exhausts. */
function generateFor(spec, k) {
  const face = specFace(spec);
  for (let t = 0; t < TRIES_PER_KEEP; t++) {
    const seed = `match:${face}:${k}:${t}`;
    const t0 = Date.now();
    const r = buildChallenge250Board({ ...spec }, seed);
    if (!r || !r.check || !r.par || !r.features) continue;
    const work = r.check.totalClicks - 1;
    if (work < CLIMB_MIN_DEDUCTIONS) continue;
    return {
      par: Math.round(r.par * 10) / 10,
      work,
      hard: hardOf(r.check),
      tier: r.check.techniqueLevel,
      genMs: Date.now() - t0,
      seed,
      features: r.features,
      payload: serializeBoard({
        board: r.board, rows: r.rows, cols: r.cols, totalMines: r.totalMines,
        rngSeed: seed, activeGimmicks: r.activeGimmicks, firstClick: r.firstClick,
      }),
      face,
      spec: {
        shape: spec.shape, rows: spec.rows, cols: spec.cols, M: spec.M, N: spec.N,
        cells: spec.cells, mines: spec.mines, gimmicks: (spec.gimmicks || []).slice(),
        gimmickLevel: spec.gimmickLevel, constructive: spec.constructive,
        wallSegments: spec.wallSegments,
      },
    };
  }
  return null;
}

function loadJsonMaybe(url) {
  try { return JSON.parse(readFileSync(url, 'utf8')); } catch { return null; }
}

export function emitMatchLibrary(boards, { dry = false } = {}) {
  // Group by shape in fixed order, par-ascending within a shape, then cut
  // into pages. A one-shape match's picks cluster into adjacent pages.
  const pages = [];
  for (const shape of SHAPE_ORDER) {
    const of = boards.filter((b) => b.spec.shape === shape)
      .sort((a, b) => a.par - b.par || (a.seed < b.seed ? -1 : 1));
    for (let i = 0; i < of.length; i += MATCH_PAGE_SIZE) {
      pages.push(of.slice(i, i + MATCH_PAGE_SIZE));
    }
  }
  const fp = modelFingerprint();
  if (!dry) {
    mkdirSync(OUT_DIR, { recursive: true });
    pages.forEach((boards_, p) => {
      writeFileSync(pageFile(p), JSON.stringify({ page: p, parModel: fp, boards: boards_ }));
    });
  }
  const written = writeMatchIndexFiles(pages, fp, { dry });
  return { pages: written.pages, boards: written.boards };
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const perSpecArg = args.indexOf('--per-spec');
  const perSpec = perSpecArg >= 0 ? Number(args[perSpecArg + 1]) : PER_SPEC_DEFAULT;

  // Resumable: the cache keys on (face, k), so an interrupted run redraws
  // nothing it already kept.
  const cache = loadJsonMaybe(CACHE_FILE) || {};

  // Shape-minor interleave so an interrupted build is balanced across
  // shapes rather than complete-rect-and-nothing-else.
  const byShape = new Map(SHAPE_ORDER.map((s) => [s, []]));
  for (const spec of CHALLENGE_POOL) byShape.get(spec.shape)?.push(spec);
  const queue = [];
  for (let i = 0; ; i++) {
    let any = false;
    for (const s of SHAPE_ORDER) {
      const specs = byShape.get(s);
      if (i < specs.length) { queue.push(specs[i]); any = true; }
    }
    if (!any) break;
  }

  const boards = [];
  const skips = [];
  let generated = 0;
  const t0 = Date.now();
  for (const spec of queue) {
    const face = specFace(spec);
    for (let k = 0; k < perSpec; k++) {
      const key = `${face}#${k}`;
      let entry = cache[key];
      if (!entry) {
        entry = generateFor(spec, k);
        generated++;
        if (entry) {
          cache[key] = entry;
          if (!dry && generated % 25 === 0) {
            writeFileSync(CACHE_FILE, JSON.stringify(cache));
          }
        } else {
          skips.push(`${key} (no board cleared work>=${CLIMB_MIN_DEDUCTIONS} in ${TRIES_PER_KEEP} tries)`);
          continue;
        }
      }
      boards.push(entry);
    }
  }
  if (!dry) writeFileSync(CACHE_FILE, JSON.stringify(cache));

  const out = emitMatchLibrary(boards, { dry });
  const byShapeCount = {};
  for (const b of boards) byShapeCount[b.spec.shape] = (byShapeCount[b.spec.shape] || 0) + 1;
  console.log(`match library: ${out.boards} boards over ${out.pages} pages`
    + ` (${generated} generated fresh, ${Math.round((Date.now() - t0) / 1000)}s)`);
  console.log('by shape:', JSON.stringify(byShapeCount));
  const pars = boards.map((b) => b.par).sort((a, b) => a - b);
  console.log('par min/med/max:', pars[0], pars[Math.floor(pars.length / 2)], pars[pars.length - 1]);
  if (skips.length) {
    console.log(`skipped ${skips.length} draws:`);
    for (const s of skips) console.log('  ' + s);
  }
  if (dry) console.log('(dry run: nothing written)');
}

// Import-safe for tests (emitMatchLibrary, MATCH_PAGE_SIZE); run as a script
// to build.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  await main();
}
