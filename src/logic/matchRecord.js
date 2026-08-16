// A player's head-to-head record across Challenge matches, and the splits
// that answer "what am I good at".
//
// His ask: win percentage, raw and adjusted, and which shapes, densities and
// modifiers you are most likely to win on.
//
// THE UNIT IS THE BOARD, not the match, and that is the decision everything
// else follows from. A match holds up to ten boards of mixed shapes, so a
// match-level record can never answer "which shapes do you win"; a board has
// exactly one shape, one density and one modifier set. Counting boards also
// gives the splits ten times the sample a five-board match would, which
// matters a great deal when the whole population is a handful of friends.
//
// WHAT "WIN" MEANS HERE, because the mode has no loss. A match board's mines
// are STRIKES on the daily's frame: you always clear the board, just slower.
// So the stats panel's old `wins / totalGames` was structurally 100%, a number
// that could not move. The only thing a Challenge win CAN mean is the
// head-to-head: on this board, were you the fastest of the people who played
// it. That is also exactly the per-board comparison the match breakdown shows,
// which is why one module serves both.
//
// THREE HONESTY RULES, each of which changes the number:
//
//  - CONTESTED IS THE DENOMINATOR. A board only counts if at least one OTHER
//    player posted a time on it. A solo run is not a 100% win rate, and a
//    board your opponent never reached is not a board you beat them on;
//    neither one is inside the question at all.
//  - ADJUSTED AND RAW ARE BOTH REPORTED. Adjusted is `time / k` on the shipped
//    handicaps, the convention rankAdjusted uses everywhere else, and it is
//    the fair comparison. Raw is who actually finished first. They disagree,
//    and hiding either one would be picking the flattering answer for the
//    player.
//  - A TIE COUNTS FOR NOBODY. Strictly fastest wins. Exact ties are almost
//    impossible at a tenth of a second through a handicap divide, and
//    resolving them toward the player would inflate his own numbers, which is
//    the wrong direction for a stat you show someone about themselves.
//
// Pure, so every one of those decisions is testable without a Firebase.

import { densityBandOf } from './matchRules.js';

/** k for a uid, on rankAdjusted's own terms: unrated ranks raw (k = 1). */
function ratioFor(handicaps, uid) {
  if (!handicaps || uid == null) return 1;
  const raw = typeof handicaps.get === 'function'
    ? handicaps.get(uid)
    : (Object.prototype.hasOwnProperty.call(handicaps, uid) ? handicaps[uid] : undefined);
  return (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) ? raw : 1;
}

const finiteTime = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * One match, board by board: who was fastest, raw and adjusted.
 *
 * This IS the head-to-head breakdown the match summary shows, and the same
 * rows the aggregate record counts.
 *
 * @param {object|null} node   a fetched matches/{id} value
 * @param {object} [opts]
 * @param {string|null} [opts.myUid]
 * @param {object|Map} [opts.handicaps] uid -> k, the SHIPPED fit
 * @returns {Array<object>} one row per board, in play order
 */
export function matchBoardBreakdown(node, opts = {}) {
  const { myUid = null, handicaps = null } = opts;
  const boards = Array.isArray(node && node.boards) ? node.boards : [];
  const players = (node && node.players && typeof node.players === 'object')
    ? node.players : {};

  return boards.map((board, index) => {
    const entries = [];
    for (const [uid, p] of Object.entries(players)) {
      const result = Array.isArray(p && p.results) ? p.results[index] : null;
      const time = finiteTime(result && result.time);
      if (time === null) continue;
      const ratio = ratioFor(handicaps, uid);
      entries.push({
        uid,
        name: (p && typeof p.name === 'string' && p.name) ? p.name : 'Player',
        time,
        penalty: finiteTime(result.penalty) || 0,
        adjusted: Math.round((time / ratio) * 10) / 10,
        isMe: myUid != null && uid === myUid,
      });
    }

    const mine = entries.find((e) => e.isMe) || null;
    // Contested means somebody ELSE played it. A board only you reached is
    // not one you won; it is one nobody has raced you on yet.
    const contested = entries.length > 1 && !!mine;

    const bestBy = (key) => {
      if (entries.length === 0) return null;
      let best = entries[0];
      for (const e of entries) { if (e[key] < best[key]) best = e; }
      // A tie has no winner: two entries share the minimum.
      const tied = entries.filter((e) => e[key] === best[key]).length > 1;
      return tied ? { ...best, tied: true } : best;
    };
    const fastestAdjusted = bestBy('adjusted');
    const fastestRaw = bestBy('time');

    return {
      index,
      spec: (board && board.spec) || null,
      par: finiteTime(board && board.par),
      entries,
      mine,
      contested,
      fastestAdjusted,
      fastestRaw,
      // Undefined rather than false when the board is not contested, so a
      // caller cannot quietly count an unraced board as a loss.
      wonAdjusted: contested ? (!!fastestAdjusted && !fastestAdjusted.tied && fastestAdjusted.isMe) : null,
      wonRaw: contested ? (!!fastestRaw && !fastestRaw.tied && fastestRaw.isMe) : null,
    };
  });
}

const emptyTally = () => ({ contested: 0, wonAdjusted: 0, wonRaw: 0 });

function bump(bucket, key, row) {
  if (!key) return;
  if (!bucket[key]) bucket[key] = emptyTally();
  bucket[key].contested++;
  if (row.wonAdjusted) bucket[key].wonAdjusted++;
  if (row.wonRaw) bucket[key].wonRaw++;
}

/**
 * A player's record over many matches, with the splits his question needs.
 *
 * `splits.modifier` counts a board once per modifier ON it, so a board with
 * two modifiers lands in two buckets. That is the right shape for "which
 * modifiers do you win on" and it means the modifier tallies do NOT sum to
 * the total, which the caller must not present as if they did. A board with
 * no modifiers appears in no modifier bucket at all.
 *
 * @param {Array<object>} nodes  fetched match nodes
 * @param {object} [opts] same as matchBoardBreakdown
 * @returns {object} totals plus per-shape, per-density and per-modifier tallies
 */
export function matchRecord(nodes, opts = {}) {
  const totals = emptyTally();
  const splits = { shape: {}, density: {}, modifier: {} };
  let boardsPlayed = 0;
  let matchesPlayed = 0;

  for (const node of nodes || []) {
    const rows = matchBoardBreakdown(node, opts);
    let touched = false;
    for (const row of rows) {
      if (row.mine) { boardsPlayed++; touched = true; }
      if (!row.contested) continue;
      totals.contested++;
      if (row.wonAdjusted) totals.wonAdjusted++;
      if (row.wonRaw) totals.wonRaw++;

      const spec = row.spec || {};
      bump(splits.shape, spec.shape, row);
      if (Number.isFinite(spec.mines) && Number.isFinite(spec.cells) && spec.cells > 0) {
        bump(splits.density, densityBandOf(spec.mines, spec.cells), row);
      }
      for (const mod of Array.isArray(spec.gimmicks) ? spec.gimmicks : []) {
        bump(splits.modifier, mod, row);
      }
    }
    if (touched) matchesPlayed++;
  }

  return { ...totals, boardsPlayed, matchesPlayed, splits };
}

/**
 * Rivalry rows (his ask 2026-08-16): your record and typical margin against
 * each opponent, plus the FIELD row, "vs anyone", which is every contested
 * board scored against the best rival on it. Counts, never percentages: a
 * record over a dozen boards is a tally, not a rate.
 *
 * The margin is the MEDIAN adjusted gap, signed: negative means you were
 * ahead. Median rather than mean because one blown board should not move
 * "usually 6s ahead" to "usually 9s behind". Every rule mirrors
 * matchRecord's own: contested boards only, adjusted times decide, a tie
 * counts for nobody and is tallied separately (`ties`), and being strictly
 * fastest against the best rival is exactly matchBoardBreakdown's
 * `wonAdjusted`, so the field row can never disagree with the aggregate.
 */
export function rivalries(nodes, opts = {}) {
  const byUid = new Map();
  const field = { won: 0, lost: 0, ties: 0, margins: [] };
  const tally = (rec, gap) => {
    rec.margins.push(gap);
    if (gap < 0) rec.won++;
    else if (gap > 0) rec.lost++;
    else rec.ties++;
  };
  for (const node of nodes || []) {
    for (const row of matchBoardBreakdown(node, opts)) {
      if (!row.contested || !row.mine) continue;
      const rivals = row.entries.filter((e) => !e.isMe);
      let best = rivals[0];
      for (const r of rivals) { if (r.adjusted < best.adjusted) best = r; }
      tally(field, Math.round((row.mine.adjusted - best.adjusted) * 10) / 10);
      for (const r of rivals) {
        const rec = byUid.get(r.uid)
          || { uid: r.uid, name: r.name, won: 0, lost: 0, ties: 0, margins: [] };
        if (r.name) rec.name = r.name;
        tally(rec, Math.round((row.mine.adjusted - r.adjusted) * 10) / 10);
        byUid.set(r.uid, rec);
      }
    }
  }
  const median = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
  };
  const finish = ({ margins, ...rec }) => ({
    ...rec,
    boards: rec.won + rec.lost + rec.ties,
    medianMargin: median(margins),
  });
  return {
    field: finish(field),
    rivals: [...byUid.values()].map(finish)
      .sort((a, b) => (b.boards - a.boards) || (a.name < b.name ? -1 : 1)),
  };
}

/** Win percentage, or null when nothing has been contested. */
export function winPct(won, contested) {
  if (!Number.isFinite(contested) || contested <= 0) return null;
  return Math.round((won / contested) * 100);
}

/**
 * The split buckets worth SHOWING, best first.
 *
 * A bucket needs `minContested` boards before it says anything: with three
 * active players and a handful of matches, a single contested board reads as
 * "100% on Kites" and means nothing at all. The threshold is the caller's,
 * because the honest one depends on how much data exists, and every returned
 * row carries its own `contested` so the sample is always on screen beside
 * the number rather than implied.
 */
export function rankedSplits(bucket, { minContested = 3, key = 'wonAdjusted' } = {}) {
  return Object.entries(bucket || {})
    .filter(([, t]) => t.contested >= minContested)
    .map(([name, t]) => ({ name, ...t, pct: winPct(t[key], t.contested) }))
    .sort((a, b) => (b.pct - a.pct) || (b.contested - a.contested)
      || (a.name < b.name ? -1 : 1));
}
