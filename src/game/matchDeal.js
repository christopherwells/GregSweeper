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
// Seen-tracking is his cycle rule at match scale (matchRules.pickMatchBoards):
// keys are `page:idx`, stable across the nightly reprice (numbers rewrite in
// place; boards never move between pages), reset only when the eligible
// space exhausts. Pinned e2e/practice deals (?matchboard=) never mark.

import { state } from '../state/gameState.js';
import { fetchLibraryJson } from './climbDeal.js';
import { parseMatchIndex, eligibleRows, pickMatchBoards } from '../logic/matchRules.js';
import { getMatchSeen, setMatchSeen } from '../storage/statsStorage.js';
import { reportCaughtError } from '../diagnostics/errorReporter.js';

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

  const eligible = eligibleRows(rows, rules);
  const seen = state.isLevelPractice ? [] : getMatchSeen();
  const { picks, cycled } = pickMatchBoards(eligible, rules.count, Math.random, seen);

  const byPage = new Map();
  for (const p of picks) {
    if (!byPage.has(p.page)) byPage.set(p.page, fetchPage(p.page));
  }
  const entries = [];
  for (const pick of picks) {
    const boards = await byPage.get(pick.page);
    const entry = boards && boards[pick.idx];
    if (!entry || !entry.payload || !entry.seed) {
      reportCaughtError('match-deal',
        new Error(`match p${pick.page}#${pick.idx}: entry missing or malformed`));
      continue;
    }
    entries.push(entry);
  }

  if (!state.isLevelPractice && entries.length > 0) {
    const dealtKeys = picks.slice(0, entries.length).map((p) => p.key);
    setMatchSeen(cycled ? dealtKeys : [...seen, ...dealtKeys]);
  }
  return { entries, eligible: eligible.length };
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
