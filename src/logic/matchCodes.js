// A Challenge match's two identifiers: the invite CODE a player shares, and
// the fit-row KEY a finished board files its times under.
//
// Pure and a leaf (no DOM, no Firebase) so the regression suite can pin both,
// and so the rules-parity assertions in test/matchCodes.test.mjs have one
// source to compare firebase-rules.json against. The Firebase I/O lives in
// src/firebase/firebaseMatch.js.
//
// The code SHAPE is the friend code's, imported rather than re-declared: a
// player reads a match code off a phone screen exactly the way they read a
// friend code, so the unambiguous alphabet and the six-character length are
// the same question answered once. Only the LIFETIME differs, and it differs
// a lot.

import {
  CODE_ALPHABET, CODE_LENGTH, CODE_REGEX, generateCode, normalizeCode,
} from './friendCodes.js';

export { CODE_ALPHABET, CODE_LENGTH, CODE_REGEX, generateCode, normalizeCode };

/**
 * ONE lifetime for the code and the match alike (his ruling, 2026-08-12:
 * "The invite code lives as long as the match. Use 7 days for both").
 *
 * A friend code lives 15 minutes because both people are looking at the app
 * when it is read out. A match invite is a text message: the friend who opens
 * it an hour later, or the next morning, must still be able to join, so the
 * code cannot outlive the match and the match cannot outlive the code. Seven
 * days is long enough that a weekend match survives the week and short enough
 * that dead codes recycle.
 *
 * Mirrored in the firebase-rules.json read gate on matchCodes/$code and in the
 * expiresAt ceiling on matches/$matchId; test/matchCodes.test.mjs asserts all
 * three carry this number.
 */
export const MATCH_TTL_MS = 604800000; // 7 days

/**
 * Soft ceiling on players in one match.
 *
 * Matches are OPEN (his ruling): anyone holding the code joins, which is what
 * makes a five-board match among four friends twenty rows spread across
 * shapes. The cap is not a security boundary, and the rules say so: it rides a
 * playerCount child each join increments, so two simultaneous joins can land
 * on the same number and a match can end up one over. What it does buy is a
 * bound on accidental growth, and a stated intended scale. The real cost of
 * spamming a match is one Firebase account per fake player.
 */
export const MATCH_PLAYER_MAX = 16;

/**
 * When a match stops accepting writes, DERIVED from its own createdAt.
 *
 * THE ONE DEFINITION, and it has to be derived rather than stored. The match
 * node carries no `expiresAt` child: the rules compute the same deadline from
 * the server-stamped `createdAt`, because a client cannot know the server
 * clock and a stored expiry would need either exact equality (a phone running
 * five minutes fast then fails to create a match at all) or a slack window.
 *
 * Everything that asks "is this match still open" must come through here.
 * `planMatchJoin` once read `match.expiresAt` straight off the node, a field
 * nothing writes, so every guest got `undefined` and the join refused itself
 * as expired while the host, who is already in `players`, never reached the
 * check. A derived answer cannot go stale that way.
 *
 * A missing or malformed createdAt yields a deadline in 1970, which reads as
 * expired: a match whose lifetime cannot be established is one nothing should
 * be written into.
 */
export function matchExpiresAt(createdAt) {
  return (Number.isFinite(Number(createdAt)) ? Number(createdAt) : 0) + MATCH_TTL_MS;
}

/**
 * Has the match stopped accepting new joins and new results?
 *
 * His ruling: writes freeze, reads do not. An expired match is still fully
 * readable by everyone who has its id, forever; it takes nothing more.
 * A missing or malformed expiresAt reads as EXPIRED, because a match whose
 * lifetime cannot be established is one nothing should be written into.
 */
export function matchIsExpired(expiresAt, now) {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return true;
  return now >= expiresAt;
}

/** Whole days left, for the invite card's "expires in N days" line. */
export function matchDaysRemaining(expiresAt, now) {
  if (matchIsExpired(expiresAt, now)) return 0;
  return Math.ceil((expiresAt - now) / 86400000);
}

/**
 * What tapping a valid invite should do, decided from the fetched node alone.
 *
 *   'missing'   no such match (or a node without its boards, which is the same
 *               thing to a player)
 *   'expired'   past its seven days: readable, closed to new results
 *   'finished'  this uid already PLAYED it through: the standings, never the
 *               boards again
 *   'resume'    this uid has a slot and an unfinished run
 *   'full'      at MATCH_PLAYER_MAX and this uid is not in it
 *   'join'      a free slot in a live match
 *
 * Pure so the join path is testable without a Firebase; the UI renders one
 * message per verdict and the I/O layer refuses everything but 'join' and
 * 'resume'.
 *
 * THE DEADLINE IS DERIVED from the node's own createdAt (matchExpiresAt), the
 * same quantity the security rules compute, and never read off the node. The
 * node has no `expiresAt` child for it to be read from.
 *
 * FINISHED IS NOT RESUME. `finishedAt` is stamped once, after the last board's
 * result lands, so its presence means this player's run is over. Treating it
 * as a resume restarted the run at board 1 with an empty results array, and
 * every posted result then overwrote the real one at the same index, which is
 * a player's own record being destroyed by re-opening a link.
 */
export function planMatchJoin({ match, uid, now }) {
  if (!match || !Array.isArray(match.boards) || match.boards.length === 0) return 'missing';
  const players = (match.players && typeof match.players === 'object') ? match.players : {};
  const mine = uid ? players[uid] : null;
  // A POSITIVE number and nothing else. `Number(null)` is 0, so coercing here
  // would read an absent stamp as a finish and strand a live run in the
  // standings; a server TIMESTAMP is always a large positive number.
  if (mine) return (typeof mine.finishedAt === 'number'
    && Number.isFinite(mine.finishedAt) && mine.finishedAt > 0) ? 'finished' : 'resume';
  if (matchIsExpired(matchExpiresAt(match.createdAt), now)) return 'expired';
  if (Object.keys(players).length >= MATCH_PLAYER_MAX) return 'full';
  return 'join';
}

/**
 * Where a player left off in a match they have already started.
 *
 * A `resume` verdict means the player has a slot and an unfinished run, and
 * re-entering used to hand them a fresh `{current: 0, results: []}`. Every
 * board they then cleared posted under its index and OVERWROTE the result
 * already in the node, which is the same destruction the `finished` verdict
 * was added to stop, left in place for the unfinished case (issue #317). The
 * review list is documented as the only way back into a match, so the path
 * that loses the run was the only path there was.
 *
 * The node's own results are the truth, not the local save: a player resuming
 * on a second device has no save, and the whole point of the list is reaching
 * a match the save slot is not holding.
 *
 * `current` is the first index with no result rather than `results.length`,
 * so a run with a gap (a post that failed while the next one landed) resumes
 * INTO the gap and fills it, instead of appending past it forever.
 *
 * @returns {{results: Array, current: number}} safe defaults for an absent
 *   or malformed player entry, which resume as a fresh run.
 */
export function matchResumePoint(node, uid) {
  const players = (node && node.players && typeof node.players === 'object')
    ? node.players : {};
  const mine = uid ? players[uid] : null;
  const stored = Array.isArray(mine && mine.results) ? mine.results : [];
  const of = Array.isArray(node && node.boards) ? node.boards.length : 0;

  const results = [];
  for (let i = 0; i < of; i++) {
    const r = stored[i];
    const time = (r && typeof r.time === 'number' && Number.isFinite(r.time) && r.time >= 0)
      ? r.time : null;
    results[i] = time === null ? undefined : {
      time,
      penalty: (typeof r.penalty === 'number' && Number.isFinite(r.penalty)) ? r.penalty : 0,
      strikes: (typeof r.strikes === 'number' && Number.isFinite(r.strikes)) ? r.strikes : 0,
    };
  }
  let current = results.findIndex((r) => r === undefined);
  if (current < 0) current = of;
  return { results, current };
}

// ── The fit-row key ─────────────────────────────────────────────────────
//
// A finished match board files its times into the SAME daily/* + dailyMeta/*
// tables the R refit already reads, the way the weekly's first attempt does
// under its `_weekly_first` suffix. The key is derived from the BOARD'S OWN
// SEED, deliberately not from its page-and-index address in the library.
//
// page:idx is stable against the nightly reprice, which rewrites pars in place
// and never moves a board between pages, but it is NOT stable against a full
// library rebuild, which re-sorts every page. A seed-derived key survives that,
// and it buys the property the per-shape fit needs most: the same library board
// pools its rows across different matches and different hosts, so a Kites board
// played by four people in two matches is four observations of one board rather
// than four unrelated keys.
//
// 64 bits, as two chained 32-bit FNV-1a passes (the low half hashes the seed
// WITH the high half, so the two halves cannot be correlated the way two
// different starting bases over the same string can). At the library's ~920
// boards the chance of any collision is about 2e-14; a collision would silently
// pool two boards under one dailyMeta, which is why 32 bits was not enough.

const FNV_PRIME = 16777619;
const FNV_BASIS = 2166136261;

function fnv1a32(str, basis) {
  let h = basis >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

const hex8 = (n) => (n >>> 0).toString(16).padStart(8, '0');

/** The `match_<16 hex>` bucket a board's score rows and meta live under. */
export function matchRowKey(seed) {
  const s = String(seed == null ? '' : seed);
  const hi = fnv1a32(s, FNV_BASIS);
  const lo = fnv1a32(`${s}#${hi}`, FNV_BASIS);
  return `match_${hex8(hi)}${hex8(lo)}`;
}

/**
 * The one definition of what a match fit-row key looks like. The daily and
 * dailyMeta `$date` rules carry this alternative beside the date form, and a
 * key that fails their regex drops the WHOLE write with no client error (the
 * 866683d class that froze stats for two weeks), so the two are pinned equal.
 */
export const MATCH_ROW_KEY_REGEX = /^match_[0-9a-f]{16}$/;

/** Is this row bucket a match board rather than a daily or weekly one? */
export function isMatchRowKey(key) {
  return typeof key === 'string' && MATCH_ROW_KEY_REGEX.test(key);
}

// ── Invites: three answers, all reversible ──────────────────────────────
//
// His ruling: "Later is remind me in 24 h, reject is I don't want to play
// that". So DECLINING IS A STATE, NOT A DELETION. An invite you turned down
// stays in your list where you can change your mind, which is the whole point
// of having a list; deleting it would make "review invites you rejected"
// impossible to honor.
//
// Accepting is the one answer that removes the invite, because it graduates
// into a match under users/{uid}/matches and would otherwise be listed twice.

/** "Later" means exactly this long. */
export const INVITE_SNOOZE_MS = 86400000; // 24 hours

/** The three states an unanswered or turned-down invite can rest in. */
export const INVITE_STATES = ['pending', 'snoozed', 'declined'];

export function snoozeUntilFrom(now) {
  return now + INVITE_SNOOZE_MS;
}

/**
 * How an invite should be treated right now.
 *
 *   'expired'  its match is past its seven days, so there is nothing to join
 *   'declined' turned down, listed but never popped up again unasked
 *   'snoozed'  answered "later" and the 24 hours have not passed
 *   'pending'  waiting for an answer (a lapsed snooze lands back here, which
 *              is what makes "remind me" a reminder rather than a dismissal)
 *
 * An unknown or absent state reads as 'pending': an invite whose state cannot
 * be established is one the player has not answered.
 */
export function inviteState(invite, now) {
  if (!invite) return 'expired';
  const sentAt = Number(invite.sentAt);
  if (Number.isFinite(sentAt) && now >= sentAt + MATCH_TTL_MS) return 'expired';
  if (invite.state === 'declined') return 'declined';
  const until = Number(invite.snoozedUntil);
  if (invite.state === 'snoozed' && Number.isFinite(until) && now < until) return 'snoozed';
  return 'pending';
}

/** Should this invite interrupt the player with a card right now? */
export function inviteShouldPopUp(invite, now) {
  return inviteState(invite, now) === 'pending';
}

/**
 * Split a list of invites into the sections the review surface shows, each
 * ordered newest first. Expired ones are dropped: a match nobody can join is
 * not a decision anyone still has to make.
 */
export function partitionInvites(invites, now) {
  const out = { pending: [], snoozed: [], declined: [] };
  for (const inv of invites || []) {
    const state = inviteState(inv, now);
    if (state === 'expired') continue;
    out[state].push(inv);
  }
  for (const key of Object.keys(out)) {
    out[key].sort((a, b) => (Number(b.sentAt) || 0) - (Number(a.sentAt) || 0));
  }
  return out;
}

/**
 * The three places his review surface shows, from the invites and the matches
 * this player is in.
 *
 * His design, 2026-08-13: "a place where you can dig up old games you declined
 * that automatically get scrubbed when the code expires, a place where you can
 * look at the results of old games, and a place where you can join games
 * you're invited to (or resume ones you were working on)."
 *
 * Each place answers a different question, and the split falls out of the
 * LIFETIME each one has:
 *
 *   active    something is waiting for you. Invites still open (pending, and
 *             snoozed ones you asked to be reminded about) sit here beside
 *             runs you started and have not finished, because "join this" and
 *             "carry on with this" are the same intention to a player.
 *   finished  runs you played through. Reads stay open forever by his earlier
 *             ruling, so this place never empties on its own.
 *   declined  turned down, and SELF-SCRUBBING: inviteState reports 'expired'
 *             past the code's own seven days, so an old refusal drops out of
 *             the list without anyone tidying it. `expired` carries those out
 *             separately so the caller can delete the nodes too, which it can,
 *             since a player owns their own invite list.
 *
 * A match whose node could not be read is dropped rather than guessed at: an
 * unreadable run cannot be said to be finished OR waiting.
 *
 * TWO LATER RULINGS this partition carries (2026-08-17):
 *
 *  - SOLO RUNS SIT IN FINISHED beside the shared ones, from this device's own
 *    records (his ask: "it'd be nice if you could see your solo runs").
 *    They interleave by date; every finished entry has an `at` stamp so the
 *    list can group months without re-deriving which field each kind uses.
 *  - AN EXPIRED UNFINISHED RUN IS FINISHED, NOT WAITING. Past the seven days
 *    the rules refuse every result write, so "carry on with this" is an
 *    intention the server no longer honors; the run rests in finished with
 *    `ended` set so the row can say the run closed before the last board.
 *    Reads stay open forever, which is exactly what the finished place is.
 *
 * @param {{invites: Array, matches: Array, uid: string|null, now: number,
 *   solo?: Array}} args
 *   `matches` are fetchMyMatches rows, each with its `node` attached;
 *   `solo` are this device's stored solo-run records, newest first.
 * @returns {{active: Array, finished: Array, declined: Array, expired: Array}}
 */
export function partitionMatchReview({ invites, matches, uid, now, solo = [] }) {
  const parts = partitionInvites(invites, now);
  const expired = (invites || []).filter((inv) => inviteState(inv, now) === 'expired');

  const active = [];
  const finished = [];
  for (const row of matches || []) {
    if (!row || !row.node) continue;
    const players = (row.node.players && typeof row.node.players === 'object')
      ? row.node.players : {};
    const mine = uid ? players[uid] : null;
    const done = !!(mine && typeof mine.finishedAt === 'number'
      && Number.isFinite(mine.finishedAt) && mine.finishedAt > 0);
    const ended = !done && matchIsExpired(matchExpiresAt(row.node.createdAt), now);
    const at = Number(row.joinedAt) || 0;
    if (done || ended) finished.push({ kind: 'match', match: { ...row, done }, ended, at });
    else active.push({ ...row, done });
  }
  for (const record of solo || []) {
    if (!record) continue;
    finished.push({ kind: 'solo', record, at: Number(record.finishedAt) || 0 });
  }
  const newestFirst = (a, b) => (Number(b.joinedAt) || 0) - (Number(a.joinedAt) || 0);
  active.sort(newestFirst);
  finished.sort((a, b) => b.at - a.at);

  return {
    // Invites first inside active: an unanswered ask is more urgent than a
    // run that will still be there tomorrow.
    active: [
      ...parts.pending.map((invite) => ({ kind: 'invite', invite })),
      ...parts.snoozed.map((invite) => ({ kind: 'invite', invite, snoozed: true })),
      ...active.map((match) => ({ kind: 'match', match })),
    ],
    finished,
    declined: parts.declined.map((invite) => ({ kind: 'invite', invite })),
    expired,
  };
}
