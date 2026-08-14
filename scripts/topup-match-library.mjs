// Top up the match library where a corner runs thin, and spend the effort
// where it buys the most.
//
//   node scripts/topup-match-library.mjs [--minutes 20] [--buffer 20]
//     [--dry-run] [--no-network]
//
// WHY THIS EXISTS. Nothing has ever grown this library. The nightly refit
// re-prices it (reprice-match-library.mjs) and generates nothing, while the
// 20-minute generation budget belongs to the Climb ladder's own top-up. So
// depth has only ever fallen, as boards get played. Measured 2026-08-14: 356
// occupied corners, 17 with 20 or more unplayed boards, a median of six.
//
// WHAT A CORNER IS. Exactly the four things boardMatchesRules tests, via
// matchCornerKey: shape, modifier SET, time band, density band. The config
// sheet filters on those, so a thin corner is a selection a player can make
// and be handed almost nothing.
//
// TWO OBJECTIVES, MULTIPLIED (his ruling). A candidate scores
// `supplyNeed(corner) x leverage(board)`, so the board that fills a starved
// corner AND sits somewhere the par model has never seen wins outright, and
// neither objective can be satisfied by ignoring the other. A fixed split
// between them would be a ratio nobody can justify; a product needs no tuning.
//
// LEVERAGE IS DURABLE, MISSION FIT IS NOT (his ruling). What gets STORED is
// how far a board sits from the rest of the library in standardized feature
// space, which stays true for as long as the board exists. Tonight's actual
// experiment mission is deliberately NOT baked in: the refit emits a different
// target most nights, so a stored mission score would be wrong by morning, and
// the deal already scores the live mission from the feature vector every index
// row carries.
//
// HARD CORNERS BACK OFF, THEY ARE NEVER ABANDONED (his ruling). Some corners
// may be unreachable: no deltoidal board may exist that prices Quick at Packed
// density. A corner that resists gets tried less often rather than struck off,
// and the record persists in topup-state.json so tonight's run knows what last
// night learned. Striking one off permanently would mean a generation
// improvement or a re-price could make it reachable with nothing to notice.
//
// APPEND ONLY, AND NEVER THROUGH THE BUILD'S EMITTER. emitMatchLibrary sorts
// every board by shape and par and re-cuts the pages, which is right for a
// build from nothing and catastrophic here: `page:idx` is the seen-cycle key
// on every player's device, so a board that moves silently resets somebody's
// no-repeat record. New boards go on NEW pages at the end and no existing page
// is rewritten. The index shards ARE rebuilt, from every page in order, which
// is safe because a row carries its own page and index.
//
// Interrupting is safe: work already written stays written, and the state file
// records what was tried.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildChallenge250Board } from '../src/logic/challenge250Builder.js';
import { CHALLENGE_POOL } from '../src/logic/challengePool.js';
import { serializeBoard } from '../src/firebase/dailyBoardSync.js';
import { matchRowKey } from '../src/logic/matchCodes.js';
import { packPayload } from '../src/logic/boardPack.js';
import { modelFingerprint } from '../src/logic/parModelFingerprint.js';
import { specFace, CLIMB_MIN_DEDUCTIONS } from '../src/logic/challengeRules.js';
import {
  timeBandOf, densityBandOf, matchCornerKey,
  MATCH_TIME_BANDS, MATCH_DENSITY_BANDS,
} from '../src/logic/matchRules.js';
import { OUT_DIR, writeMatchIndexFiles, matchPageFile, matchPageNames } from './match-index-files.mjs';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';
const STATE_FILE = new URL('topup-state.json', OUT_DIR);
const PAGE_SIZE = 16;
// One draw per candidate before any corner gets a second, so a single
// stubborn corner cannot eat the run before the cheap wins are taken.
const CENSUS_FRACTION = 0.4;
const TRIES_PER_DRAW = 3;
// Backoff: a corner that failed its last N consecutive attempts is skipped
// on all but every 2^N-th run, capped so it always comes back eventually.
const BACKOFF_CAP = 5;

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const DRY = args.includes('--dry-run');
const NO_NET = args.includes('--no-network');
const BUDGET_MS = Number(argVal('--minutes', 20)) * 60000;
// HOW MANY BOARDS A CORNER SHOULD HOLD, given how many of them somebody has
// already played (his ruling 2026-08-14). The GOAL is a buffer of 20 unplayed
// boards; the 100 is a CEILING, not a target, and it stops the search dead in
// a corner that has already been dug deep enough.
//
// The buffer SHRINKS as a corner gets played out rather than growing with it,
// which is the whole point: by the time somebody has played a hundred boards
// of one corner they cannot remember the early ones, so depth past that buys
// nothing except not repeating tomorrow. Ten ahead past a hundred played, five
// past two hundred and fifty.
//
// TODAY THIS MEANS 20, essentially everywhere: 70 boards have been played
// across every corner in the library's life, so `played` is 0 or 1 nearly
// always and the ceiling will not bind for a very long time. Storage is why
// the distinction matters. A board costs ~6.6 KB on disk unpacked, so a
// literal 100 per corner is a 572 MB library where 20 is 114 MB.
export const CORNER_CEILING = 100;
// The dial: --buffer overrides it, which is how a run can be told to dig
// deeper without editing the rule.
export const BUFFER = Number(argVal('--buffer', 20));
export const DEEP_PLAY = 100;
export const VERY_DEEP_PLAY = 250;

/**
 * Total boards a corner should hold. Subtract what has been played to get
 * what still needs generating.
 *
 * @param {number} played  boards in this corner somebody has finished
 */
export function cornerTotalTarget(played) {
  if (played > VERY_DEEP_PLAY) return played + 5;
  if (played > DEEP_PLAY) return played + 10;
  return Math.min(CORNER_CEILING, played + BUFFER);
}

/** Every page in order. The array index IS the page number. */
function loadPages() {
  const names = matchPageNames();
  return names.map((n) => JSON.parse(readFileSync(new URL(n, OUT_DIR), 'utf8')).boards);
}

/**
 * Which boards somebody has already finished. Read from the world-readable
 * dailyMeta, keyed the way a match fit row is keyed.
 *
 * FAILS SOFT AND SAYS SO. Without it every board counts as unplayed, which
 * OVERSTATES supply and understates need, so the run does less rather than
 * more. A silent failure here would look like a healthy library.
 */
async function fetchPlayed() {
  if (NO_NET) return { set: new Set(), ok: false, why: '--no-network' };
  try {
    const r = await fetch(`${DB_BASE}/dailyMeta.json?shallow=true`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const keys = Object.keys((await r.json()) || {});
    return { set: new Set(keys.filter((k) => k.startsWith('match_'))), ok: true, why: '' };
  } catch (err) {
    return { set: new Set(), ok: false, why: err.message };
  }
}

/**
 * Standardize the numeric features every board carries, so a distance means
 * the same thing on a 40-cell board as on a 200-cell one.
 *
 * The key set is DERIVED from the library rather than hardcoded: any numeric
 * feature present on nearly every board counts. A feature added to the vector
 * next month therefore joins the measure with no edit here, and one that only
 * appears on a handful of boards cannot dominate a distance through its
 * absence.
 */
export function featureSpace(boards) {
  const counts = new Map();
  for (const b of boards) {
    for (const [k, v] of Object.entries(b.features || {})) {
      if (typeof v === 'number' && Number.isFinite(v)) counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  const keys = [...counts.entries()]
    .filter(([, n]) => n >= boards.length * 0.95).map(([k]) => k).sort();
  const mean = {}; const sd = {};
  for (const k of keys) {
    const vals = boards.map((b) => Number((b.features || {})[k]) || 0);
    const m = vals.reduce((a, x) => a + x, 0) / (vals.length || 1);
    const v = vals.reduce((a, x) => a + (x - m) ** 2, 0) / (vals.length || 1);
    mean[k] = m;
    // A zero-variance feature would divide by nothing; it also carries no
    // information about novelty, so it is neutralized rather than dropped
    // (dropping would change the vector length between runs).
    sd[k] = Math.sqrt(v) || 1;
  }
  return { keys, mean, sd };
}

const vecOf = (space, features) => space.keys.map((k) => (((Number((features || {})[k]) || 0) - space.mean[k]) / space.sd[k]));

/**
 * How far this board sits from the nearest board already stored, in
 * standardized feature space. High means the model has never seen a board
 * quite like it, which is the whole reason to prefer generating it.
 *
 * Nearest-neighbour rather than distance-from-centroid deliberately: a board
 * far from the middle but sitting on top of fifty others teaches nothing new,
 * and a centroid measure would rank it highly.
 */
export function leverageOf(vec, corpus) {
  let best = Infinity;
  for (const other of corpus) {
    let d = 0;
    for (let i = 0; i < vec.length; i++) { const t = vec[i] - other[i]; d += t * t; if (d >= best) break; }
    if (d < best) best = d;
  }
  return Number.isFinite(best) ? Math.sqrt(best) : 0;
}

/** Read the backoff record, or start one. */
function loadState() {
  if (!existsSync(STATE_FILE)) return { runs: 0, corners: {} };
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return { runs: Number(s.runs) || 0, corners: s.corners || {} };
  } catch { return { runs: 0, corners: {} }; }
}

/**
 * Is this corner due tonight? A corner with `fails` consecutive misses is
 * tried every 2^fails runs, capped. Never permanently skipped.
 */
export function corner_isDue(rec, runNo) {
  const fails = Math.min(BACKOFF_CAP, Number(rec && rec.fails) || 0);
  if (fails === 0) return true;
  return runNo % (2 ** fails) === 0;
}

/**
 * Candidate specs for one corner. The pool's specs fix `cells` and `mines`, so
 * hitting a density band means SYNTHESIZING variants: take every pool spec of
 * the right shape and modifier set, then re-mine it across the band. Par is
 * emergent and cannot be dialled at all, which is why reaching a time band is
 * a search rather than a construction.
 */
export function specsForCorner(pool, shape, mods) {
  const want = mods === '(none)' ? '' : mods;
  const base = pool.filter((s) => s.shape === shape
    && ((s.gimmicks || []).slice().sort().join('+') || '') === want);
  const out = [];
  for (const s of base) {
    for (const band of MATCH_DENSITY_BANDS) {
      const lo = band === MATCH_DENSITY_BANDS[0] ? 0.06 : (MATCH_DENSITY_BANDS[MATCH_DENSITY_BANDS.indexOf(band) - 1].max);
      const hi = Number.isFinite(band.max) ? band.max : 0.34;
      for (const f of [0.25, 0.5, 0.75]) {
        const d = lo + (hi - lo) * f;
        const mines = Math.max(1, Math.round(s.cells * d));
        if (mines === s.mines) { out.push({ ...s }); continue; }
        out.push({ ...s, mines });
      }
    }
  }
  // Dedupe on the face a player could tell apart.
  const seen = new Set();
  return out.filter((s) => { const k = specFace(s); if (seen.has(k)) return false; seen.add(k); return true; });
}

function drawBoard(spec, salt) {
  const seed = `topup:${specFace(spec)}:${salt}`;
  for (let t = 0; t < TRIES_PER_DRAW; t++) {
    const r = buildChallenge250Board({ ...spec }, `${seed}:${t}`, { contribution: true });
    if (!r || !r.check || !r.par || !r.features) continue;
    const work = r.check.totalClicks - 1;
    if (work < CLIMB_MIN_DEDUCTIONS) continue;
    return {
      par: Math.round(r.par * 10) / 10,
      work,
      seed: `${seed}:${t}`,
      features: r.features,
      payload: serializeBoard({
        board: r.board, rows: r.rows, cols: r.cols, totalMines: r.totalMines,
        rngSeed: `${seed}:${t}`, activeGimmicks: r.activeGimmicks, firstClick: r.firstClick,
      }),
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

const cornerOf = (b) => matchCornerKey({
  shape: b.spec.shape, mods: (b.spec.gimmicks || []),
  par: b.par, mines: b.spec.mines, cells: b.spec.cells,
}).join('|');

async function main() {
  const t0 = Date.now();
  const pages = loadPages();
  const existing = pages.flat();
  const played = await fetchPlayed();
  if (!played.ok) {
    console.log(`  WARNING: played set unavailable (${played.why}); every board counts as unplayed,`
      + ' so this run UNDERSTATES need and will do less, not more.');
  }

  // Depth per corner, counting only what nobody has finished.
  // TOTAL and PLAYED per corner, because the target is a function of both: the
  // buffer is 20 unplayed, and the ceiling is on the TOTAL, so a corner that
  // has been dug through stops earning new boards rather than earning more.
  const total = new Map();
  const playedIn = new Map();
  for (const b of existing) {
    const k = cornerOf(b);
    total.set(k, (total.get(k) || 0) + 1);
    if (played.set.has(matchRowKey(b.seed))) playedIn.set(k, (playedIn.get(k) || 0) + 1);
  }
  /** Boards still owed in this corner: its target total, less what it holds. */
  const needOf = (k) => cornerTotalTarget(playedIn.get(k) || 0) - (total.get(k) || 0);

  const space = featureSpace(existing);
  const corpus = existing.map((b) => vecOf(space, b.features));

  // The addressable corner space: every (shape, modifier set) the proven pool
  // can build, crossed with the nine bands. A corner outside this is not a gap
  // in the library, it is a board nothing knows how to make.
  const pairs = new Map();
  for (const s of CHALLENGE_POOL) {
    const mods = (s.gimmicks || []).slice().sort().join('+') || '(none)';
    pairs.set(`${s.shape}|${mods}`, { shape: s.shape, mods });
  }
  const wanted = [];
  for (const { shape, mods } of pairs.values()) {
    for (const d of MATCH_DENSITY_BANDS) {
      for (const t of MATCH_TIME_BANDS) {
        const key = [shape, mods === '(none)' ? '' : mods, t.key, d.key].join('|');
        const need = needOf(key);
        if (need > 0) wanted.push({ key, shape, mods, dens: d.key, time: t.key, have: total.get(key) || 0, need });
      }
    }
  }

  const state = loadState();
  const runNo = state.runs + 1;
  const due = wanted.filter((w) => corner_isDue(state.corners[w.key], runNo));

  console.log(`topup-match-library: ${existing.length} boards on ${pages.length} pages;`
    + ` ${total.size} corners occupied, ${wanted.length} below target (buffer ${BUFFER}, ceiling ${CORNER_CEILING}),`
    + ` ${due.length} due this run (run #${runNo}); budget ${BUDGET_MS / 60000} min`);
  if (due.length === 0) {
    console.log('  nothing due; library is at target or every gap is backing off.');
    if (!DRY) writeFileSync(STATE_FILE, JSON.stringify({ runs: runNo, corners: state.corners }, null, 1));
    return;
  }

  // ── Census: one draw per corner, cheapest-first, to learn what is even
  // reachable before any corner gets a second attempt. Deliberately ordered by
  // NEED so the emptiest corners are probed first if the budget is short.
  const censusEnd = t0 + BUDGET_MS * CENSUS_FRACTION;
  const kept = [];
  const reachable = [];
  let draws = 0;
  // PROVEN CORNERS FIRST, then by need. Sorting by need alone puts the EMPTY
  // corners at the front, and empty is exactly what IMPOSSIBLE looks like:
  // a shape and modifier set at a given density produces a narrow par range,
  // so most of the nine time-by-density cells for a pair cannot be reached at
  // all. Measured on the first 15-minute run under that ordering: 816 corners
  // probed, 13 reachable, and the 367 occupied-but-thin corners, every one of
  // them provably fillable, sorted last and were never reached before the
  // census clock ran out. A corner that already holds a board is proof that
  // its combination exists, which is the cheapest evidence available and
  // costs nothing to consult.
  due.sort((a, b) => (a.have > 0 ? 0 : 1) - (b.have > 0 ? 0 : 1) || b.need - a.need);
  let probed = 0;
  let unbuildable = 0;
  for (const w of due) {
    if (Date.now() > censusEnd) break;
    const specs = specsForCorner(CHALLENGE_POOL, w.shape, w.mods);
    // No spec of that shape and modifier set exists, so this is not a gap in
    // the library at all: nothing knows how to build the board. Not a failure,
    // and deliberately NOT counted as one, or the backoff record would fill
    // with corners that were never attempted.
    if (specs.length === 0) { unbuildable++; continue; }
    probed++;
    let hit = null;
    for (const spec of specs) {
      if (Date.now() > censusEnd) break;
      const b = drawBoard(spec, `${runNo}c`);
      draws++;
      if (!b) continue;
      if (cornerOf(b) !== w.key) continue;   // landed elsewhere; still a real board, but not this gap
      hit = { spec, board: b };
      break;
    }
    if (hit) {
      kept.push(hit.board);
      reachable.push({ ...w, spec: hit.spec });
    } else {
      const rec = state.corners[w.key] || { fails: 0, attempts: 0 };
      state.corners[w.key] = { fails: (rec.fails || 0) + 1, attempts: (rec.attempts || 0) + 1, lastRun: runNo };
    }
  }
  // Reported as three separate numbers on purpose. "Missed" must mean a
  // corner this run actually tried and could not reach, because that is the
  // only one the backoff record is allowed to punish. Lumping the un-probed
  // remainder in with it would read as a far more hostile search space than
  // the one that was measured, and the number nobody would question is the one
  // covering 2,000 corners the clock simply never reached.
  console.log(`  census: ${draws} draws over ${probed} corner(s) probed;`
    + ` ${reachable.length} reachable, ${probed - reachable.length} missed (backing off),`
    + ` ${unbuildable} unbuildable (no spec of that shape and modifier set),`
    + ` ${due.length - probed - unbuildable} not reached before the census clock ran out`);

  // ── Mine: spend what is left on the reachable corners, ranked by
  // need x leverage. Leverage is recomputed against the corpus AS IT GROWS, so
  // the second board into a corner is worth less than the first was.
  const deadline = t0 + BUDGET_MS;
  let round = 0;
  while (Date.now() < deadline && reachable.length > 0) {
    round++;
    const ranked = reachable
      .map((w) => ({ w, score: Math.max(0, needOf(w.key)) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    if (ranked.length === 0) break;
    let progressed = false;
    for (const { w } of ranked) {
      if (Date.now() >= deadline) break;
      const b = drawBoard(w.spec, `${runNo}m${round}`);
      draws++;
      if (!b || cornerOf(b) !== w.key) continue;
      const lev = leverageOf(vecOf(space, b.features), corpus);
      b.lev = Math.round(lev * 1000) / 1000;
      kept.push(b);
      corpus.push(vecOf(space, b.features));
      total.set(w.key, (total.get(w.key) || 0) + 1);
      const rec = state.corners[w.key] || { fails: 0, attempts: 0 };
      state.corners[w.key] = { fails: 0, attempts: (rec.attempts || 0) + 1, lastRun: runNo };
      progressed = true;
    }
    if (!progressed) break;
  }

  // Leverage for the census boards too, against the corpus they joined.
  for (const b of kept) {
    if (typeof b.lev !== 'number') b.lev = Math.round(leverageOf(vecOf(space, b.features), corpus) * 1000) / 1000;
  }

  // ── Append. New pages only; every existing page keeps its bytes and every
  // board keeps its `page:idx`.
  const newPages = [];
  for (let i = 0; i < kept.length; i += PAGE_SIZE) newPages.push(kept.slice(i, i + PAGE_SIZE));
  const fp = modelFingerprint();
  if (!DRY && newPages.length) {
    newPages.forEach((boards, i) => {
      const p = pages.length + i;
      // Packed at the SOURCE, not left for the next re-price to heal: the
      // nightly runs the re-price BEFORE this step, so a page written plain
      // here would sit at full size for a whole day.
      const packedBoards = boards.map((b) => ({ ...b, payload: packPayload(b.payload) }));
      writeFileSync(matchPageFile(p), JSON.stringify({ page: p, parModel: fp, boards: packedBoards }));
    });
  }
  const all = [...pages, ...newPages];
  const written = newPages.length ? writeMatchIndexFiles(all, fp, { dry: DRY }) : { corners: total.size, shards: {} };
  if (!DRY) writeFileSync(STATE_FILE, JSON.stringify({ runs: runNo, corners: state.corners }, null, 1));

  const atTarget = [...total.keys()].filter((k) => needOf(k) <= 0).length;
  console.log(`  added ${kept.length} board(s) on ${newPages.length} new page(s) in`
    + ` ${Math.round((Date.now() - t0) / 1000)}s from ${draws} draws;`
    + ` ${atTarget} corners now at target, ${written.corners || total.size} corners indexed`
    + (DRY ? ' (dry run: nothing written)' : ''));
}

const _isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (_isMain) {
  main().catch((err) => { console.error('topup-match-library failed:', err.message); process.exit(1); });
}
