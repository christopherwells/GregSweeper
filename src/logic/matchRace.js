// The live race, the pure half (his rulings 2026-08-17): while a shared
// match is being played, a quiet chip on the game info bar tracks the
// opponent furthest along (position only, never a time), the between-boards
// card compares totals through the boards both players have banked, and a
// presence heartbeat says who is inside the match right now. The
// synchronized start the arc once sketched is DROPPED by the same rulings
// ("It's synchronized enough"), so nothing here coordinates clocks; the
// node's posted results are the whole feed.
//
// Everything a surface renders is decided here, where a test can reach it
// (test/matchRace.test.mjs). The DOM half (ui/matchRace.js) subscribes,
// paints, and keeps the heartbeat.

import { matchBoardCountOf, matchTotals } from './matchRules.js';

/** How often a playing client re-stamps players/{uid}/activeAt. */
export const PRESENCE_BEAT_MS = 45000;

/**
 * How stale an activeAt can be and still count as "playing right now".
 * Generous against the beat (two missed beats), because a throttled
 * background tab writes late before it stops writing at all; a client clock
 * BEHIND the server makes the difference negative, which reads as fresh.
 */
export const PRESENCE_FRESH_MS = 120000;

/** Is this activeAt stamp recent enough to call the player present? */
export function isPresenceFresh(activeAt, now) {
  return Number.isFinite(activeAt) && activeAt > 0 && (now - activeAt) < PRESENCE_FRESH_MS;
}

// One opponent row, everything the surfaces read per rival. The name here is
// the NODE's stored snapshot with the 'Player' sentinel read as absent
// (matchRecord's own rule); callers resolve uids through playerNames first
// (join-at-read) and fall back to this.
function _rivals(node, myUid) {
  const players = (node && node.players && typeof node.players === 'object')
    ? node.players : {};
  const of = matchBoardCountOf(node);
  return Object.entries(players)
    .filter(([uid]) => uid !== myUid)
    .map(([uid, p]) => {
      const results = Array.isArray(p && p.results) ? p.results : [];
      const done = results.filter(Boolean).length;
      return {
        uid,
        name: (p && typeof p.name === 'string' && p.name && p.name !== 'Player') ? p.name : null,
        results,
        done,
        of,
        finished: !!(p && p.finishedAt) || (of > 0 && done >= of),
        activeAt: (p && Number.isFinite(p.activeAt)) ? p.activeAt : null,
      };
    });
}

/**
 * What the in-play chip shows: the opponent furthest along, position only
 * (his ruling: no times during a board). Null means no chip at all, which
 * covers a solo run (no rivals) exactly as "nothing new shows".
 *
 * @param {object|null} node the fetched matches/{id} value
 * @param {{myUid: string|null, now: number}} opts
 * @returns {{uid, name, done, of, finished, playingNow, others}|null}
 */
export function raceChipModel(node, { myUid, now }) {
  const rivals = _rivals(node, myUid);
  if (rivals.length === 0) return null;
  // Furthest along leads the chip; a finished rival outranks an unfinished
  // one at the same count; uid order settles the rest so the pick is stable
  // between paints.
  rivals.sort((a, b) => (b.done - a.done)
    || (Number(b.finished) - Number(a.finished))
    || (a.uid < b.uid ? -1 : 1));
  const lead = rivals[0];
  return {
    uid: lead.uid,
    name: lead.name,
    done: lead.done,
    of: lead.of,
    finished: lead.finished,
    playingNow: isPresenceFresh(lead.activeAt, now),
    others: rivals.length - 1,
  };
}

/**
 * A snapshot of everyone else's progress, taken when a board starts, so the
 * between-boards card can say what happened while the player was solving.
 * Keyed by uid; the indices are the result slots that held a result.
 */
export function raceBaseline(node, myUid) {
  const base = {};
  for (const r of _rivals(node, myUid)) {
    base[r.uid] = {
      indices: r.results.map((res, i) => (res ? i : -1)).filter((i) => i >= 0),
      finished: r.finished,
    };
  }
  return base;
}

/**
 * What changed since the baseline: which rivals banked which boards, and who
 * finished their run. Held to the board gap by his ruling; nothing about
 * this is shown mid-solve.
 *
 * @returns {Array<{uid, name, boards: number[], finishedRun: boolean}>}
 */
export function raceEvents(baseline, node, { myUid }) {
  const events = [];
  for (const r of _rivals(node, myUid)) {
    const before = (baseline && baseline[r.uid]) || { indices: [], finished: false };
    const had = new Set(before.indices);
    const boards = r.results
      .map((res, i) => (res ? i : -1))
      .filter((i) => i >= 0 && !had.has(i));
    const finishedRun = r.finished && !before.finished;
    if (boards.length > 0 || finishedRun) {
      events.push({ uid: r.uid, name: r.name, boards, finishedRun });
    }
  }
  return events;
}

/**
 * The gap comparison: me against ONE rival, over the boards we have BOTH
 * banked. A three-board total against a five-board total is the
 * partial-versus-partial trap the standings rule already forbids, so the
 * comparable set is the result indices we share; the totals over it come
 * from matchTotals, the panel's own arithmetic.
 *
 * The rival is the nearest one AHEAD of me on that comparison, because the
 * race reads from the front; with nobody ahead it is the closest chaser.
 * Adjusted where a player is rated, raw where not (rankAdjusted's own
 * convention); `bothRated` lets the copy say "adjusted" only when it is
 * true of both sides.
 *
 * @param {object|null} node
 * @param {{myUid: string|null, handicaps: Map|object|null}} opts
 * @returns {{uid, name, boards, delta, rivalAhead, tied, bothRated}|null}
 */
export function gapComparison(node, { myUid, handicaps }) {
  const players = (node && node.players && typeof node.players === 'object')
    ? node.players : {};
  const mine = players[myUid];
  const myResults = Array.isArray(mine && mine.results) ? mine.results : [];
  if (myResults.filter(Boolean).length === 0) return null;

  const kOf = (uid) => {
    if (!handicaps) return null;
    const k = typeof handicaps.get === 'function' ? handicaps.get(uid) : handicaps[uid];
    return (Number.isFinite(k) && k > 0) ? k : null;
  };
  const myK = kOf(myUid);

  const pairs = [];
  for (const r of _rivals(node, myUid)) {
    const shared = myResults
      .map((res, i) => (res && r.results[i] ? i : -1))
      .filter((i) => i >= 0);
    if (shared.length === 0) continue;
    const rivalK = kOf(r.uid);
    const meTotals = matchTotals(shared.map((i) => myResults[i]), myK);
    const themTotals = matchTotals(shared.map((i) => r.results[i]), rivalK);
    const meVal = meTotals.adjusted != null ? meTotals.adjusted : meTotals.raw;
    const themVal = themTotals.adjusted != null ? themTotals.adjusted : themTotals.raw;
    pairs.push({
      uid: r.uid,
      name: r.name,
      boards: shared.length,
      // Positive: the rival's clock is smaller, so they are ahead of me.
      delta: Math.round((meVal - themVal) * 10) / 10,
      bothRated: myK != null && rivalK != null,
    });
  }
  if (pairs.length === 0) return null;

  const ahead = pairs.filter((p) => p.delta > 0);
  const pick = ahead.length > 0
    ? ahead.reduce((a, b) => (b.delta < a.delta ? b : a))
    : pairs.reduce((a, b) => (b.delta > a.delta ? b : a));
  return { ...pick, rivalAhead: pick.delta > 0, tied: pick.delta === 0 };
}

/** A margin in speech: tenths under ten seconds, whole seconds past it. */
export function fmtGap(gap) {
  const g = Math.abs(gap);
  return g < 10 ? `${Math.round(g * 10) / 10}s` : `${Math.round(g)}s`;
}

/**
 * The gap line's copy, from a gapComparison and the display name the DOM
 * layer resolved (join-at-read first, node snapshot second).
 */
export function gapLineText(cmp, displayName) {
  if (!cmp) return '';
  const who = displayName || 'the other player';
  const boards = `Through ${cmp.boards} board${cmp.boards === 1 ? '' : 's'}`;
  const suffix = cmp.bothRated ? ', adjusted' : '';
  if (cmp.tied) return `${boards}: level with ${who}${suffix}.`;
  return cmp.rivalAhead
    ? `${boards}: ${fmtGap(cmp.delta)} behind ${who}${suffix}.`
    : `${boards}: ${fmtGap(cmp.delta)} ahead of ${who}${suffix}.`;
}

/** "Kate", "Kate and Sebas", "Kate, Sebas, and MJP". */
export function nameList(names) {
  const list = (names || []).filter(Boolean);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`;
}

/**
 * The board-gap news line: what rivals did while the player solved, then who
 * is present now. One string, complete sentences, no times; the numbers are
 * in the standing line above it.
 *
 * @param {Array} events raceEvents' output with `name` already resolved
 * @param {string[]} playingNames display names with a fresh activeAt
 * @returns {string}
 */
export function gapNewsText(events, playingNames) {
  const parts = [];
  const evs = (events || []).filter(Boolean);
  if (evs.length > 0) {
    const bits = evs.map((e) => {
      const who = e.name || 'A friend';
      if (e.finishedRun) return `${who} finished the run`;
      const b = e.boards;
      const label = b.length === 1
        ? `board ${b[0] + 1}`
        : `boards ${nameList(b.map((i) => String(i + 1)))}`;
      return `${who} finished ${label}`;
    });
    parts.push(`While you played: ${bits.join('; ')}.`);
  }
  const playing = (playingNames || []).filter(Boolean);
  if (playing.length > 0) {
    parts.push(`${nameList(playing)} ${playing.length === 1 ? 'is' : 'are'} playing right now.`);
  }
  return parts.join(' ');
}
