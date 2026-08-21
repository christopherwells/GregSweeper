// What a match's standings panel shows, and what its finished boards file.
//
// Pure and node-tested (test/matchStandings.test.mjs): the standings are the
// mode's whole comparison surface, and a comparison computed inside a Firebase
// callback is a comparison nobody can test.
//
// Two jobs that share the match node and nothing else:
//   matchStandings  turns a fetched node into ranked rows for the panel
//   matchFitRows    turns this player's finished boards into par-fit rows

import { matchTotals, matchBoardCountOf } from './matchRules.js';
import { rankAdjusted } from './leaderboardViews.js';
import { matchRowKey } from './matchCodes.js';

/**
 * The daily row family's own floor (MIN_VALID_TIME in firebaseLeaderboard,
 * `time >= 5` in the daily/$entry rule). Match rows land in that family, so
 * they inherit it: a board cleared in under five seconds files no row.
 *
 * That is a left-censoring, and it is the SAME censoring every daily row has
 * always carried rather than a new one this mode introduces. It can only bite
 * on the library's smallest quick-band boards, and only for a player running
 * at roughly a quarter of Greg's time on one. The caller counts what it drops
 * so a change in that frequency is visible rather than silent.
 */
export const MATCH_FIT_MIN_TIME = 5;
const MATCH_FIT_MAX_TIME = 3600;

/**
 * Rank a match's players for the live standings panel.
 *
 * His ruling, 2026-08-12: everything is live. A time appears the moment it is
 * posted, whether or not the viewer has finished, so this never withholds.
 *
 * Ranking is ADJUSTED (his standing ruling for the mode), which is
 * `time / k` on the shipped handicaps, the leaderboard's own Adjusted-view
 * convention. An unrated player ranks on their raw total and says so, exactly
 * as rankAdjusted does everywhere else, rather than being handed a pretend
 * k = 1 the row does not admit to.
 *
 * FINISHED PLAYERS SORT ABOVE UNFINISHED ONES, because a running total over
 * two boards is not a smaller version of a total over five, it is a different
 * quantity. Sorting them together would put whoever has played least on top.
 * Within the unfinished group the further-along player leads, and every row
 * carries `done`/`of` so a partial total reads as partial.
 *
 * @param {object|null} node   the fetched matches/{id} value
 * @param {object} [opts]
 * @param {object|Map} [opts.handicaps] uid -> k, the SHIPPED fit
 * @param {string|null} [opts.myUid]
 * @returns {Array<object>} ranked rows
 */
export function matchStandings(node, opts = {}) {
  const { handicaps = null, myUid = null } = opts;
  const players = (node && node.players && typeof node.players === 'object')
    ? node.players : {};
  const of = matchBoardCountOf(node);
  const host = (node && node.host) || null;

  const base = Object.entries(players).map(([uid, p]) => {
    const results = Array.isArray(p && p.results) ? p.results.filter(Boolean) : [];
    const totals = matchTotals(results, null);   // k applied by rankAdjusted below
    return {
      uid,
      name: (p && typeof p.name === 'string' && p.name) ? p.name : 'Player',
      time: totals.raw,
      penalty: totals.penalty,
      done: results.length,
      of,
      // A player is finished when they say so, or when they have banked every
      // board. Both, because finishedAt is written after the last result and a
      // write can fail between the two.
      finished: !!(p && p.finishedAt) || (of > 0 && results.length >= of),
      isHost: uid === host,
      isMe: myUid != null && uid === myUid,
    };
  });

  const ranked = rankAdjusted(base, handicaps);
  // rankAdjusted has already ordered by adjusted; a stable partition by
  // `finished` keeps that order inside each group.
  return [...ranked.filter((r) => r.finished), ...ranked.filter((r) => !r.finished)
    .sort((a, b) => (b.done - a.done) || (a.adjusted - b.adjusted))];
}

/** How many players have banked every board. */
export function matchFinishedCount(rows) {
  return (rows || []).filter((r) => r && r.finished).length;
}

/**
 * Who leads a totals row (his ask 2026-08-16: the best Total and Adjusted
 * read green, "so you can easily see who won").
 *
 * Only FINISHED players compete: a partial total is a different quantity, the
 * standings' own sorting rule. Fewer than two finished returns null, because
 * a green on the only posted total would claim a win over nobody; the same
 * rule applies to a solo row in the per-board grid. A tie is flagged rather
 * than resolved; the tie leads nobody, matchRecord's own rule.
 *
 * @param {Array<object>} rows standings rows ({uid, finished} plus `key`)
 * @param {string} key 'time' or 'adjusted'
 * @returns {{value: number, uids: string[], tied: boolean}|null}
 */
export function columnLeader(rows, key) {
  const fin = (rows || []).filter((r) => r && r.finished && Number.isFinite(r[key]));
  if (fin.length < 2) return null;
  let best = Infinity;
  for (const r of fin) { if (r[key] < best) best = r[key]; }
  const uids = fin.filter((r) => r[key] === best).map((r) => r.uid);
  return { value: best, uids, tied: uids.length > 1 };
}

/**
 * Build this player's par-fit rows from a finished match.
 *
 * Match rows go into the same `daily/*` + `dailyMeta/*` tables the refit reads,
 * because match strikes ride the daily's own response frame (his ruling: match
 * rows are to feed the daily fit). Each board gets one `dailyMeta/{key}` node
 * holding its features, and many `daily/{key}/` rows under it, one per player
 * who cleared it.
 *
 * The features come from the library ENTRY rather than from live state: the
 * entry is what the board was priced under and what every player of that board
 * shares, so two people filing the same board file the same meta.
 *
 * @param {Array<object>} entries the dealt library entries, in play order
 * @param {Array<object>} results the banked per-board results, index-aligned
 * @returns {{rows: Array<object>, tooFast: number, unplayed: number,
 *   eventless: number}} `eventless` counts boards refused because they took
 *   strikes whose per-hit events this device does not hold (issue #372).
 */
export function matchFitRows(entries, results) {
  const rows = [];
  let tooFast = 0;
  let unplayed = 0;
  let eventless = 0;
  const list = Array.isArray(entries) ? entries : [];
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    const res = Array.isArray(results) ? results[i] : null;
    if (!entry || !entry.seed || !entry.features || !res) { unplayed++; continue; }
    const time = Math.round((Number(res.time) || 0) * 10) / 10;
    if (!(time >= MATCH_FIT_MIN_TIME && time <= MATCH_FIT_MAX_TIME)) { tooFast++; continue; }
    // A ROW THAT TOOK STRIKES BUT CARRIES NO EVENTS IS REFUSED, NOT FILED
    // (issue #372). The payload writes `totalBombPenalty` only alongside
    // events, and on the R side `bombHits > 0 && totalBombPenalty == 0` is
    // the signature of the RETIRED +10s/re-fog cohort, so such a row is
    // charged LEGACY_BOMB_RATE (15s a hit) against a true ramped cost of
    // 3n + 0.75n(n-1): 45s removed from a three-strike board that cost 13.5s.
    // The events are missing exactly when this device did not play the board
    // (a cross-device resume rebuilt it from the node, which whitelists only
    // time, penalty and strikes), so the honest answer is to file nothing
    // rather than a row the fit will misread. A clean board needs no events
    // and files normally.
    const strikes = Number(res.strikes) || 0;
    const events = Array.isArray(res.bombHitEvents) ? res.bombHitEvents : [];
    if (strikes > 0 && events.length === 0) { eventless++; continue; }
    rows.push({
      key: matchRowKey(entry.seed),
      time,
      bombHits: Number(res.strikes) || 0,
      // The anti-cheat guard's denominator (isBombHitCheat): a run that found
      // most of a board's mines by stepping on them was probing it.
      totalMines: Number(entry.spec && entry.spec.mines) || Number(entry.features.totalMines) || 0,
      // THE ENTRY IS THE FALLBACK, because the node never stores par: the
      // results block whitelists time, penalty and strikes and ends
      // $other: false. A cross-device resume rebuilds results from the node,
      // so `res.par` is simply absent and the row filed a par of 0 (measured
      // 2026-08-20: one of the ten marathon rows, on a board whose other
      // player filed 1263.5). The dealt entry carries the board's own stored
      // par and rides the node whole under `boards`, which is where
      // state.matchPar came from at install, so this recovers the same number
      // rather than inventing one.
      par: Number(res.par) || Number(entry.par) || 0,
      // Banked per board at finish (winLossHandler): a match run can mix a
      // fit-legal board with a marathon one, so this is a property of the
      // BOARD as played, never of the run.
      // THE ENTRY IS THE FALLBACK, exactly as it is for par above, and for the
      // same structural reason: the match node's results block stores only
      // time, penalty and strikes, so a guest's measurement has nowhere to
      // live and a cross-device resume loses it. His ruling 2026-08-20: a
      // board larger than one screen that is not a daily IS scrolling, and
      // `oversized` is a STORED per-row fact rather than a guess from
      // container dims, so asserting from it is grounded.
      //
      // TRUE only, never false: an ordinary board scrolls whenever the player
      // has raised their own cell-size preference, so a fit-legal board with
      // no measurement stays honestly absent rather than being called flat.
      scrolled: res.scrolled === true || entry.oversized === true,
      features: entry.features,
      bombHitEvents: events,
      wormEvents: Array.isArray(res.wormEvents) ? res.wormEvents : [],
      seed: entry.seed,
    });
  }
  return { rows, tooFast, unplayed, eventless };
}
