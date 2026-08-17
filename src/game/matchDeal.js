// Deal a Challenge match's boards from the pre-generated match library.
//
// Same trust posture as the Climb's deal (climbDeal.js), whose fetch core
// this consumes: the library was generated and certified offline over the
// proven CHALLENGE_POOL specs, one small index answers eligibility exactly,
// and every board re-certifies from its stored opener at the point of play
// (certifyStoredBoard's ground-truth audit), so a corrupt file degrades
// rather than shipping an unverified board. The deal happens ONCE per match
// and returns the raw library ENTRIES: the entries ride state and the save
// (a match must survive a mid-match resume), and each board is re-certified
// when it is installed, which also re-audits anything a storage round-trip
// could have bent. The async head-to-head build ships these same entries
// through the match node, which is why they stay verbatim payloads here.
//
// Which boards get dealt is decided by the pure planMatchDeal
// (src/logic/matchSteering.js), which applies the host's filter, spends at most
// floor(N/5) slots on mission steering, and fills the rest through
// matchRules.pickMatchBoards. Everything below the plan is I/O.
//
// Seen-tracking is his cycle rule at match scale (matchRules.pickMatchBoards):
// keys are `page:idx`, stable across the nightly reprice (numbers rewrite in
// place; boards never move between pages), reset only when the eligible
// space exhausts. Pinned e2e/practice deals (?matchboard=) never mark.

import { state } from '../state/gameState.js';
import { fetchLibraryJson } from './climbDeal.js';
import {
  parseMatchIndex, parseMatchSummary, matchShardFilesFor, resolveMatchPicks,
  parseClimbMatchIndex, CLIMB_SHARD_PREFIX, nextMatchSeen,
} from '../logic/matchRules.js';
import { planMatchDeal, currentSteerMissions } from '../logic/matchSteering.js';
import { loadExperimentTarget } from '../logic/experimentDesign.js';
import { getMatchSeen, setMatchSeen } from '../storage/statsStorage.js';
import { reportCaughtError } from '../diagnostics/errorReporter.js';
import { unpackPayload } from '../logic/boardPack.js';

// How long the deal will wait for the experiment file before dealing without
// steering. main.js warms that cache at startup and the service worker
// pre-caches the file, so in practice the await is already resolved; the bound
// is here because an unbounded await on a half-open socket would hold a match
// behind a study, and a match matters more than a study.
const STEER_LOAD_TIMEOUT_MS = 1500;

// RELATIVE on purpose: the app serves at / in production and /test/ on the
// test branch, and a root-anchored path would cross the two.
const LIB = 'scripts/data/match-library';
// THE HARVEST'S shelf (his 'Do this first', 2026-08-16): the Climb library,
// read here as certified boards and nothing else. The Climb's own deal and
// seen-sets are never touched from this module; the no-transfer contract is
// pinned by test/matchHarvest.test.mjs.
const CLIMB_LIB = 'scripts/data/climb-library';

export function matchSummaryUrl() {
  return `${LIB}/match-summary.json`;
}

export function matchShardUrl(file) {
  return `${LIB}/${file}`;
}

export function matchPageUrl(page) {
  return `${LIB}/match-${String(page).padStart(3, '0')}.json`;
}

export function climbMatchSummaryUrl() {
  return `${CLIMB_LIB}/climb-match-summary.json`;
}

export function climbShardUrl(file) {
  return `${CLIMB_LIB}/${file}`;
}

export function climbBoardsUrl(stem) {
  return `${CLIMB_LIB}/${stem}.json`;
}

// TWO FETCHES, SIZED TO THE TWO QUESTIONS (see the split's note in
// matchRules.js). The sheet asks how many boards fit and takes the SUMMARY,
// which is a few KB and does not grow with the library's depth. The deal asks
// for rows and takes one SHARD per shape in the host's filter, so a two-shape
// run never pays for the other five.
//
// Both are cached per session: the sheet reads the summary on open and the
// deal reads it again moments later, and a host who tweaks their rules
// re-counts without a second fetch. The SW runtime-caches the files too, so
// this is a courtesy rather than the offline story.
let _corners = null;
let _climbCorners = null;
const _shardRows = new Map();

/** The summary's corner counts, or null when it cannot be fetched or parsed. */
export async function fetchMatchCorners() {
  if (_corners) return _corners;
  const corners = parseMatchSummary(await fetchLibraryJson(matchSummaryUrl()));
  if (!corners || corners.length === 0) return null;
  _corners = corners;
  return corners;
}

/**
 * The harvest shelf's corner counts. Null-soft TWICE over: a client on a
 * deploy that predates the harvest index, or one whose fetch fails, deals
 * from the match library alone exactly as before, and the supply line
 * counts less. The harvest may only ever ADD.
 */
export async function fetchClimbMatchCorners() {
  if (_climbCorners) return _climbCorners;
  let corners = null;
  try {
    corners = parseMatchSummary(await fetchLibraryJson(climbMatchSummaryUrl()));
  } catch { /* the match shelf stands alone */ }
  if (!corners || corners.length === 0) return null;
  _climbCorners = corners;
  return corners;
}

/**
 * The filter rows for `shapes`, fetched one shard at a time and concatenated.
 *
 * A shard that is missing or malformed contributes NOTHING rather than
 * failing the deal: the other shapes in the filter are still dealable, and a
 * short deal says so through the supply line it already has. Null comes back
 * only when nothing at all could be read, which is the same signal the whole
 * index used to give.
 */
export async function fetchMatchIndexRows(rules) {
  // The corner files this selection can actually reach, and no others. The
  // summary says which corners exist, so an empty one costs no round trip;
  // without it the full cross product is requested and the misses come back
  // as nothing, which is the same outcome one step slower.
  const corners = await fetchMatchCorners();
  const want = matchShardFilesFor(rules, corners);
  await Promise.all(want
    .filter((f) => !_shardRows.has(f))
    .map(async (file) => {
      const rows = parseMatchIndex(await fetchLibraryJson(matchShardUrl(file)));
      _shardRows.set(file, rows || []);
    }));
  // The harvest shelf, in parallel form: same derivation over its own
  // summary, its own prefix, its own parser. A missing summary means no
  // shard is requested at all, so the union is exactly the match rows.
  const climbCorners = await fetchClimbMatchCorners();
  const wantClimb = climbCorners
    ? matchShardFilesFor(rules, climbCorners, CLIMB_SHARD_PREFIX) : [];
  await Promise.all(wantClimb
    .filter((f) => !_shardRows.has(f))
    .map(async (file) => {
      const rows = parseClimbMatchIndex(await fetchLibraryJson(climbShardUrl(file)));
      _shardRows.set(file, rows || []);
    }));
  const rows = [...want, ...wantClimb].flatMap((f) => _shardRows.get(f) || []);
  return rows.length ? rows : null;
}

/**
 * Fetch one page's board list, keyed by page number. Null on any failure.
 *
 * UNPACKED HERE, at the edge. A page stores its cells columnar to keep the
 * file down (boardPack.js), and everything downstream of this line expects the
 * classic array of objects: the entry rides state and the save, and the host
 * writes it VERBATIM into the match node, whose rules and whose guest both
 * describe the classic shape. Unpacking at the boundary means the packing is a
 * storage detail of these files and reaches nothing else.
 */
async function fetchPage(page) {
  const data = await fetchLibraryJson(matchPageUrl(page));
  if (!data || data.page !== page || !Array.isArray(data.boards)) return null;
  return data.boards.map((b) => (b && b.payload ? { ...b, payload: unpackPayload(b.payload) } : b));
}

/**
 * Fetch one Climb file's board list for a harvest pick, keyed by the file
 * stem the index row carries. Climb payloads are plain today; the unpack is
 * conditional so a future packing of that library cannot silently hand the
 * installer columnar cells.
 */
async function fetchClimbBoards(stem) {
  const data = await fetchLibraryJson(climbBoardsUrl(stem));
  const boards = Array.isArray(data) ? data : (data && data.boards);
  if (!Array.isArray(boards)) return null;
  return boards.map((b) => (b && b.payload && b.payload.cells && b.payload.cells.f
    ? { ...b, payload: unpackPayload(b.payload) } : b));
}

/**
 * Deal a match's boards under `rules` (a sanitized matchRules object).
 * Returns { entries, eligible } with `entries` the raw library entries in
 * play order, or null when the library is unreachable. `entries` can come
 * back shorter than rules.count when the eligible space is smaller than
 * the match or a page fetch fails mid-deal; the caller owns saying so.
 */
export async function dealMatchEntries(rules) {
  // Only the shapes the rules can reach: everything else is payload the deal
  // would filter straight back out (planMatchDeal applies eligibleRows itself,
  // and its shape test is the same one).
  const rows = await fetchMatchIndexRows(rules);
  if (!rows) return null;

  // Mission steering (matchSteering.js) prefers, for at most floor(N/5) of the
  // slots, a board that also advances whatever study the nightly refit is
  // starved of. It only ever prefers WITHIN the host's filter, and a file that
  // never arrives leaves an empty mission list, which deals exactly as before.
  await Promise.race([
    loadExperimentTarget(),
    new Promise((resolve) => { setTimeout(resolve, STEER_LOAD_TIMEOUT_MS); }),
  ]);

  const seen = state.isLevelPractice ? [] : getMatchSeen();
  const { picks, cycled, eligible } = planMatchDeal(rows, rules, {
    rand: Math.random,
    seenKeys: seen,
    missions: currentSteerMissions(),
  });

  // A pick's `page` is a NUMBER for the match shelf and the Climb file's
  // STRING stem for the harvest shelf; the resolver downstream is shelf-blind
  // because both fetches land in one map under the pick's own key.
  const pending = new Map();
  for (const p of picks) {
    if (!pending.has(p.page)) {
      pending.set(p.page, typeof p.page === 'string'
        ? fetchClimbBoards(p.page) : fetchPage(p.page));
    }
  }
  const byPage = new Map();
  for (const [page, promise] of pending) byPage.set(page, await promise);

  // The pairing itself is pure (resolveMatchPicks), so the seen keys come back
  // in lockstep with the entries rather than being sliced off the picks.
  const { entries, keys, missing } = resolveMatchPicks(picks, byPage);
  for (const pick of missing) {
    reportCaughtError('match-deal',
      new Error(`match p${pick.page}#${pick.idx}: entry missing or malformed`));
  }

  if (!state.isLevelPractice && entries.length > 0) {
    // Cycle PER ELIGIBLE SPACE (issue #305): exhausting a narrow filter
    // resets only that space's keys, never the library-wide record.
    setMatchSeen(nextMatchSeen(seen, eligible.map((r) => r.key), keys, cycled));
  }
  return { entries, eligible };
}

/**
 * The deterministic e2e/practice deal: `?matchboard=P:I` resolves one exact
 * stored board into a one-board match. Practice-lane-only by construction,
 * main.js stamps it beside isLevelPractice and nothing else sets it.
 */
export async function dealPinnedMatchEntry(page, idx) {
  const boards = await fetchPage(page);
  const entry = boards && boards[idx];
  if (!entry || !entry.payload || !entry.seed) return null;
  return entry;
}
