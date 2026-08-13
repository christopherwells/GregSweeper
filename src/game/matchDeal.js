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
import { parseMatchIndex, resolveMatchPicks } from '../logic/matchRules.js';
import { planMatchDeal, currentSteerMissions } from '../logic/matchSteering.js';
import { loadExperimentTarget } from '../logic/experimentDesign.js';
import { getMatchSeen, setMatchSeen } from '../storage/statsStorage.js';
import { reportCaughtError } from '../diagnostics/errorReporter.js';

// How long the deal will wait for the experiment file before dealing without
// steering. main.js warms that cache at startup and the service worker
// pre-caches the file, so in practice the await is already resolved; the bound
// is here because an unbounded await on a half-open socket would hold a match
// behind a study, and a match matters more than a study.
const STEER_LOAD_TIMEOUT_MS = 1500;

// RELATIVE on purpose: the app serves at / in production and /test/ on the
// test branch, and a root-anchored path would cross the two.
export function matchIndexUrl() {
  return 'scripts/data/match-library/match-index.json';
}

export function matchPageUrl(page) {
  return `scripts/data/match-library/match-${String(page).padStart(3, '0')}.json`;
}

// One index fetch per session: the setup sheet reads it for live counts and
// the deal reads it moments later. The SW runtime-caches the file too, so
// this is a courtesy, not the offline story.
let _indexRows = null;

/** The index's filter rows, or null when it cannot be fetched or parsed. */
export async function fetchMatchIndexRows() {
  if (_indexRows) return _indexRows;
  const index = await fetchLibraryJson(matchIndexUrl());
  const rows = parseMatchIndex(index);
  if (!rows || rows.length === 0) return null;
  _indexRows = rows;
  return rows;
}

/** Fetch one page's board list, keyed by page number. Null on any failure. */
async function fetchPage(page) {
  const data = await fetchLibraryJson(matchPageUrl(page));
  if (!data || data.page !== page || !Array.isArray(data.boards)) return null;
  return data.boards;
}

/**
 * Deal a match's boards under `rules` (a sanitized matchRules object).
 * Returns { entries, eligible } with `entries` the raw library entries in
 * play order, or null when the library is unreachable. `entries` can come
 * back shorter than rules.count when the eligible space is smaller than
 * the match or a page fetch fails mid-deal; the caller owns saying so.
 */
export async function dealMatchEntries(rules) {
  const rows = await fetchMatchIndexRows();
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

  const pending = new Map();
  for (const p of picks) {
    if (!pending.has(p.page)) pending.set(p.page, fetchPage(p.page));
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
    setMatchSeen(cycled ? keys : [...seen, ...keys]);
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
