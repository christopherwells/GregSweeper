/**
 * The Challenge match node, Firebase I/O.
 *
 * Thin plumbing over the pure logic in src/logic/matchCodes.js (codes, the
 * seven-day lifetime, the join verdict, the fit-row key) and
 * src/logic/matchStandings.js (the ranked panel). Every decision lives there;
 * only reads and writes live here.
 *
 * Model (see firebase-rules.json):
 *  - matches/{matchId} = { host, rules, boards, createdAt, playerCount,
 *    players }. Created WHOLE by the host in one write-once set, so the boards
 *    are frozen from the first moment anyone can see them. `boards` are the
 *    dealt library entries stored verbatim, which is the arc's standing rule:
 *    both players play the same bytes, never a shared seed re-derived at play
 *    time. The guest still re-certifies every board through
 *    certifyStoredBoard's ground-truth audit before installing it, so trust in
 *    the host is never required, and no signature is needed to replace it.
 *  - matches/{matchId}/players/{uid} keyed by the WRITER's uid, the
 *    users/{uid}/friends/{friendUid} grant idiom: a stranger holding the code
 *    can write exactly one slot, their own, and no other.
 *  - matchCodes/{CODE} = { matchId, createdAt }, the friendCodes shape at the
 *    match's own seven-day life (his ruling: one lifetime for both). Expiry is
 *    server-enforced in the read gate, so an old code is unreadable regardless
 *    of the client clock.
 *  - users/{uid}/matchInvites/{matchId} = { from, code, sentAt }. A friend may
 *    CREATE this in your node, which is the second deliberate write exception
 *    on users/ after friends/, and the grant stops at creation: the rule
 *    carries `!data.exists()`, so once an invite is in your list only YOU can
 *    change it. Without that clause the sender kept standing write access,
 *    because a partial update leaves `from` untouched and the rule reads it
 *    from the merged result, so the person who sent an invite could answer it
 *    on your behalf, and a re-sent invite (a plain set()) would wipe the
 *    `state` recording your "no thanks" back to pending. An answer belongs to
 *    the person who was asked. The sender's NAME is deliberately not stored:
 *    it resolves from playerNames at render time (join-at-read), so there is
 *    one fewer name-bearing path to sweep and a renamed friend reads correctly.
 *
 * EXPIRY IS ONE-SIDED, his ruling: after seven days the match takes no new
 * joins and no new results, and stays readable to everyone who has its id,
 * forever. The rules derive that deadline from `createdAt` rather than from a
 * stored `expiresAt`, because createdAt is the server sentinel and is exact,
 * while any client-computed expiry would have to survive clock skew; a player
 * whose phone runs five minutes fast would otherwise fail to create a match at
 * all.
 */

import { waitForFirebaseReady } from './waitForFirebase.js';
import { getUid } from './firebaseProgress.js';
import { getPlayerName } from '../storage/statsStorage.js';
import { isTestEnvironment } from './env.js';
import { reportCaughtError } from '../diagnostics/errorReporter.js';
import {
  generateCode, normalizeCode, planMatchJoin, matchExpiresAt,
  snoozeUntilFrom, inviteShouldPopUp,
} from '../logic/matchCodes.js';
import { matchBoardCountOf } from '../logic/matchRules.js';

export { matchExpiresAt };

function db() {
  return firebase.database();
}

// The offline contract every function here documents, rather than letting
// waitForFirebaseReady's raw throw leak out of a click handler (the shape
// firebaseFriends settled on after exactly that bug).
async function _readyOrNull() {
  try {
    return await waitForFirebaseReady();
  } catch {
    return null;
  }
}

function _fail(reason, message) {
  const e = new Error(message || reason);
  e.reason = reason;
  return e;
}

/** The five fields a guest needs to play a board, and nothing else. */
function _storableEntry(entry) {
  return {
    seed: entry.seed,
    par: entry.par || 0,
    features: entry.features,
    spec: entry.spec,
    payload: entry.payload,
  };
}

/**
 * Create a match from the sheet's rules and the boards already dealt for it.
 *
 * Writes the node first and the code second, because the code's write rule
 * checks that the caller hosts the match it names. A code that cannot be
 * allocated leaves a playable match with no invite rather than no match; the
 * caller says so and can retry.
 *
 * @param {object} rules   the sanitized match rules
 * @param {Array<object>} entries the dealt library entries, in play order
 * @returns {Promise<{matchId: string, code: string|null}>}
 * @throws Error with .reason in {'offline','test','failed'}
 */
export async function createMatch(rules, entries) {
  // A test build must never create a real match: /test/ shares this origin's
  // storage and this database with production.
  if (isTestEnvironment()) throw _fail('test', 'test build');
  const ready = await _readyOrNull();
  const uid = getUid();
  if (!ready || !uid) throw _fail('offline');
  if (!Array.isArray(entries) || entries.length === 0) throw _fail('failed', 'no boards');

  const matchId = db().ref('matches').push().key;
  // 'Player' here is a stored SENTINEL, not a name: the rules require a name
  // child on every players/{uid}. Readers resolve the uid through playerNames
  // first (join-at-read), and matchRecord treats this literal as absent so it
  // can never shadow a real name in another node.
  const name = (getPlayerName() || 'Player').slice(0, 20);
  const node = {
    host: uid,
    rules,
    boards: entries.map(_storableEntry),
    createdAt: firebase.database.ServerValue.TIMESTAMP,
    playerCount: 1,
    players: {
      [uid]: { name, joinedAt: firebase.database.ServerValue.TIMESTAMP },
    },
  };
  try {
    await db().ref(`matches/${matchId}`).set(node);
  } catch (err) {
    reportCaughtError('match-create', err);
    throw _fail('failed');
  }

  // Collision odds at 31^6 are negligible; the retry exists because the
  // create-only-if-absent rule reports a clash as a permission denial, which
  // is indistinguishable from any other write failure.
  let code = null;
  for (let attempt = 0; attempt < 3 && !code; attempt++) {
    const candidate = generateCode();
    try {
      await db().ref(`matchCodes/${candidate}`).set({
        matchId,
        createdAt: firebase.database.ServerValue.TIMESTAMP,
      });
      code = candidate;
    } catch { /* clash or transient, try another code */ }
  }
  // Remember it as one of mine, so the review list can offer a way back into
  // it later. Best-effort: a lost record costs the listing, never the match.
  recordMyMatch(matchId, code, true).catch(() => {});
  return { matchId, code };
}

/** Read a match node. Null when it is absent or unreadable. */
export async function fetchMatch(matchId) {
  const ready = await _readyOrNull();
  if (!ready || !matchId) return null;
  try {
    return (await db().ref(`matches/${matchId}`).once('value')).val();
  } catch {
    return null;
  }
}

/**
 * Resolve an invite code to its match.
 *
 * The rules hide codes older than the seven-day window, so an expired code is
 * unreadable and indistinguishable from one that never existed. Both report
 * 'expired', which is the truer thing to tell a player holding an old text
 * message than "no such code".
 *
 * @returns {Promise<{matchId: string, match: object}>}
 * @throws Error with .reason in {'invalid','offline','expired'}
 */
export async function fetchMatchByCode(input) {
  const code = normalizeCode(input);
  if (!code) throw _fail('invalid');
  const ready = await _readyOrNull();
  if (!ready) throw _fail('offline');

  let entry = null;
  try {
    entry = (await db().ref(`matchCodes/${code}`).once('value')).val();
  } catch {
    throw _fail('expired');
  }
  if (!entry || !entry.matchId) throw _fail('expired');
  const match = await fetchMatch(entry.matchId);
  if (!match) throw _fail('expired');
  return { matchId: entry.matchId, match };
}

/**
 * Take a slot in a match. Idempotent for a player already in it (their entry
 * stands and the count is left alone, so a resume never inflates it).
 *
 * The slot and the count go in ONE multi-location update: the count is what
 * bounds a match's size in the rules, and writing it separately would leave a
 * window where a slot exists that the count does not know about.
 *
 * @returns {Promise<'joined'|'resume'|'finished'>}
 * @throws Error with .reason in {'offline','expired','full','missing','failed'}
 */
export async function joinMatch(matchId, match, code = null) {
  const ready = await _readyOrNull();
  const uid = getUid();
  if (!ready || !uid) throw _fail('offline');

  const verdict = planMatchJoin({ match, uid, now: Date.now() });
  if (verdict === 'resume' || verdict === 'finished') {
    // Already in it, so nothing to write except the listing, which a player
    // who joined before this shipped will not have. 'finished' passes back
    // rather than throwing: a completed run is a destination (the standings),
    // not a failure, and the caller is what refuses to re-deal its boards.
    recordMyMatch(matchId, code, match.host === uid).catch(() => {});
    return verdict;
  }
  if (verdict !== 'join') throw _fail(verdict);

  // 'Player' is the stored sentinel; see createMatch.
  const name = (getPlayerName() || 'Player').slice(0, 20);
  const count = Number(match.playerCount) || Object.keys(match.players || {}).length;
  const update = {
    [`matches/${matchId}/players/${uid}`]: {
      name,
      joinedAt: firebase.database.ServerValue.TIMESTAMP,
    },
    [`matches/${matchId}/playerCount`]: count + 1,
  };
  try {
    await db().ref().update(update);
  } catch (err) {
    reportCaughtError('match-join', err);
    throw _fail('failed');
  }
  recordMyMatch(matchId, code, false).catch(() => {});
  return 'joined';
}

/**
 * Post one cleared board's result.
 *
 * An `update` under the player's own slot, never a `set` of the whole slot:
 * `joinedAt` validates as the server sentinel, so rewriting the slot would
 * both re-stamp a join time that already happened and put the write at the
 * mercy of a rule it has no reason to touch.
 */
export async function postMatchResult(matchId, index, result) {
  const ready = await _readyOrNull();
  const uid = getUid();
  if (!ready || !uid || !matchId) return false;
  if (!Number.isInteger(index) || index < 0 || index > 9) return false;
  try {
    await db().ref(`matches/${matchId}/players/${uid}`).update({
      [`results/${index}`]: {
        time: Math.round((Number(result.time) || 0) * 10) / 10,
        penalty: Math.round((Number(result.penalty) || 0) * 10) / 10,
        strikes: Number(result.strikes) || 0,
      },
    });
    return true;
  } catch (err) {
    // A refused post is almost always the seven-day gate closing mid-run.
    // The board still counted locally and the match summary still renders.
    reportCaughtError('match-result-post', err);
    return false;
  }
}

/**
 * Re-stamp this player's presence (his heartbeat ruling, 2026-08-17): one
 * `activeAt` server timestamp under the player's own slot, the finishMatch
 * update idiom, while they are inside the match's boards. Quiet on failure
 * BY DESIGN: past the seven-day gate every beat would be refused, and a
 * diagnostics report every 45 seconds is noise about a door that is known
 * to be closed. The caller counts consecutive failures and stops beating.
 */
export async function touchMatchPresence(matchId) {
  const ready = await _readyOrNull();
  const uid = getUid();
  if (!ready || !uid || !matchId) return false;
  try {
    await db().ref(`matches/${matchId}/players/${uid}`).update({
      activeAt: firebase.database.ServerValue.TIMESTAMP,
    });
    return true;
  } catch {
    return false;
  }
}

/** Mark this player's run over, after the last result has landed. */
export async function finishMatch(matchId) {
  const ready = await _readyOrNull();
  const uid = getUid();
  if (!ready || !uid || !matchId) return false;
  try {
    await db().ref(`matches/${matchId}/players/${uid}`).update({
      finishedAt: firebase.database.ServerValue.TIMESTAMP,
    });
    return true;
  } catch (err) {
    reportCaughtError('match-finish', err);
    return false;
  }
}

/**
 * Watch a match for live standings (his ruling: times appear as they land).
 * @returns {Function} an unsubscribe
 */
export function subscribeMatch(matchId, callback) {
  if (!matchId || typeof callback !== 'function') return () => {};
  let ref = null;
  let handler = null;
  let stopped = false;
  let retries = 0;
  let retryTimer = null;
  // An error on a compat `on('value')` CANCELS the listener for good, and
  // the old comment here ("the panel keeps its last render") was that freeze
  // described approvingly: a phone sleeping mid-match or an auth-token
  // refresh race killed the feed silently and the final report never moved
  // again (his report, 2026-08-16). Re-attach on a bounded backoff; past the
  // last retry the surface keeps its paint and any reopen re-subscribes
  // fresh, so the failure mode is stale-until-touched, never stale-forever
  // with no way back.
  const RETRY_MS = [5000, 15000, 45000];
  const attach = () => {
    if (stopped) return;
    try {
      ref = db().ref(`matches/${matchId}`);
      handler = ref.on('value', (snap) => {
        retries = 0;
        try { callback(snap.val()); } catch (err) { reportCaughtError('match-subscribe-cb', err); }
      }, () => {
        if (stopped || retries >= RETRY_MS.length) return;
        retryTimer = setTimeout(attach, RETRY_MS[retries]);
        retries += 1;
      });
    } catch (err) {
      reportCaughtError('match-subscribe', err);
    }
  };
  attach();
  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    try { if (ref && handler) ref.off('value', handler); } catch { /* already gone */ }
  };
}

// ── Friend invites ──────────────────────────────────────────────────────

/**
 * Invite a friend directly, so they see the match without anyone reading a
 * code aloud (his ruling: "you can either share a code or invite someone if
 * you're friends already"). The invite carries the code, so accepting it takes
 * the same path a pasted code does.
 *
 * @returns {Promise<'sent'|'exists'|'offline'>} never throws
 */
export async function sendMatchInvite(friendUid, matchId, code) {
  const ready = await _readyOrNull();
  const uid = getUid();
  if (!ready || !uid || !friendUid || !matchId || !code) return 'offline';
  try {
    await db().ref(`users/${friendUid}/matchInvites/${matchId}`).set({
      from: uid,
      code,
      sentAt: firebase.database.ServerValue.TIMESTAMP,
    });
    return 'sent';
  } catch (err) {
    // Two refusals reach here and the sender cannot tell them apart from the
    // error alone, because a recipient's invite list is owner-read: the
    // recipient has not befriended them, or an invite for this match is
    // ALREADY in their list (the creation-only grant refuses the overwrite,
    // which is what stops a re-send wiping their answer). This button only
    // renders for people already on the friend list, so the second is the
    // live case and the copy says so.
    reportCaughtError('match-invite-send', err);
    return 'exists';
  }
}

/**
 * Watch this player's invites.
 *
 * `child_added` fires once for every invite already sitting there when the
 * listener attaches, and again for each new one, which is exactly his rule:
 * the invite arrives while the app is open, or the next time it opens.
 * Invites past the match's own lifetime are skipped rather than shown, since
 * the match behind them no longer accepts anyone.
 *
 * @returns {Function} an unsubscribe
 */
export function subscribeMatchInvites(callback) {
  const uid = getUid();
  if (!uid || typeof callback !== 'function') return () => {};
  let ref = null;
  let handler = null;
  try {
    ref = db().ref(`users/${uid}/matchInvites`);
    handler = ref.on('child_added', (snap) => {
      const v = snap.val();
      if (!v || !v.code) return;
      // Only a PENDING invite interrupts. Declined ones never pop up again,
      // and a snoozed one stays quiet until its 24 hours are up, at which
      // point inviteState reports it pending again and this listener offers
      // it on the next open. Both remain visible in the review list.
      const invite = { matchId: snap.key, ...v };
      if (!inviteShouldPopUp(invite, Date.now())) return;
      try {
        callback(invite);
      } catch (err) { reportCaughtError('match-invite-cb', err); }
    }, () => { /* offline: invites arrive on the next open instead */ });
  } catch (err) {
    reportCaughtError('match-invite-subscribe', err);
    return () => {};
  }
  return () => { try { ref.off('child_added', handler); } catch { /* already gone */ } };
}

/**
 * Clear an invite. Used on ACCEPT only: the match graduates into
 * users/{uid}/matches and would otherwise appear in two lists at once.
 *
 * Declining does NOT come through here (see declineMatchInvite): his ruling
 * makes "I don't want to play that" a state you can change your mind about,
 * and a deleted invite is not reviewable.
 */
export async function dismissMatchInvite(matchId) {
  const ready = await _readyOrNull();
  const uid = getUid();
  if (!ready || !uid || !matchId) return false;
  try {
    await db().ref(`users/${uid}/matchInvites/${matchId}`).remove();
    return true;
  } catch {
    return false;
  }
}

/**
 * Record the player's answer to an invite, short of accepting it.
 *
 * `update` rather than `set`, so `sentAt` is not rewritten: it validates as
 * the server sentinel, and re-stamping it would both move the invite's own
 * seven-day horizon and put the write at the mercy of a rule it has no reason
 * to touch.
 *
 * @param {'snoozed'|'declined'|'pending'} state
 * @param {number|null} [snoozedUntil] required for 'snoozed'
 */
export async function setMatchInviteState(matchId, state, snoozedUntil = null) {
  const ready = await _readyOrNull();
  const uid = getUid();
  if (!ready || !uid || !matchId) return false;
  const patch = { state };
  if (state === 'snoozed') patch.snoozedUntil = snoozedUntil;
  try {
    await db().ref(`users/${uid}/matchInvites/${matchId}`).update(patch);
    return true;
  } catch (err) {
    reportCaughtError('match-invite-state', err);
    return false;
  }
}

/** "Later": come back in 24 hours (his ruling). */
export function snoozeMatchInvite(matchId, now = Date.now()) {
  return setMatchInviteState(matchId, 'snoozed', snoozeUntilFrom(now));
}

/** "No thanks": listed, never popped up again, reversible. */
export function declineMatchInvite(matchId) {
  return setMatchInviteState(matchId, 'declined');
}

/** Change your mind about a declined or snoozed invite. */
export function reopenMatchInvite(matchId) {
  return setMatchInviteState(matchId, 'pending');
}

/** Every invite sent to this player, whatever state it rests in. */
export async function fetchMatchInvites() {
  const ready = await _readyOrNull();
  const uid = getUid();
  if (!ready || !uid) return null;
  try {
    const snap = await db().ref(`users/${uid}/matchInvites`).once('value');
    const val = snap.val() || {};
    return Object.entries(val).map(([matchId, v]) => ({ matchId, ...(v || {}) }));
  } catch {
    return null;
  }
}

/**
 * The metadata a list row needs, WITHOUT the frozen board payloads (issue
 * #331: a ten-board node runs 18-148 KB and the review list reads three
 * lines of it; ten nodes in parallel cost up to ~1.5 MB before the tab
 * painted). Four child reads in parallel, assembled node-shaped so
 * matchStandings and the row renderers take it unchanged; the board count
 * resolves through matchBoardCountOf's rules.count fallback, which the
 * rules require on every node ever written. Real opens (openMatchById,
 * joins, installs) keep fetching the whole node: they deal the boards.
 * WITH SPECS, on request: the head-to-head record's shape, density and
 * modifier splits bucket each board by its spec, which lives under
 * boards/{i}/spec. Those are fetched as per-index child reads sized by the
 * board COUNT (rules.count, required by the rules on every node), never as a
 * read of `boards` itself, which is the payload bytes #331 rationed; a spec
 * is ~100 bytes. The result carries them as a boards array of bare
 * `{spec}` entries so matchBoardBreakdown reads a summary and a full node
 * the same way. A spec read that fails leaves a null slot, and the splits
 * sit that board out while the times still count.
 *
 * @returns {Promise<object|null>} {rules, players, host, createdAt} or null
 */
export async function fetchMatchSummary(matchId, { withSpecs = false } = {}) {
  const ready = await _readyOrNull();
  if (!ready || !matchId) return null;
  try {
    const [rules, players, host, createdAt] = await Promise.all([
      db().ref(`matches/${matchId}/rules`).once('value').then((x) => x.val()),
      db().ref(`matches/${matchId}/players`).once('value').then((x) => x.val()),
      db().ref(`matches/${matchId}/host`).once('value').then((x) => x.val()),
      db().ref(`matches/${matchId}/createdAt`).once('value').then((x) => x.val()),
    ]);
    if (!rules && !players) return null;
    const summary = { rules: rules || null, players: players || null, host: host || null, createdAt: createdAt || null };
    if (withSpecs) {
      const count = matchBoardCountOf(summary);
      if (count > 0) {
        summary.boards = await Promise.all(Array.from({ length: count }, (_, i) =>
          db().ref(`matches/${matchId}/boards/${i}/spec`).once('value')
            .then((x) => ({ spec: x.val() || null }))
            .catch(() => ({ spec: null }))));
      }
    }
    return summary;
  } catch {
    return null;
  }
}

// ── The matches this player is in ───────────────────────────────────────
//
// The match node is readable by anyone holding its id, but nothing else
// records WHICH matches are yours, so without this list a player who joined
// two matches could only ever get back to the one sitting in the single save
// slot. Owner-written and owner-read, keyed by matchId.

/** Record that this player created or joined a match. */
export async function recordMyMatch(matchId, code, isHost) {
  const ready = await _readyOrNull();
  const uid = getUid();
  if (!ready || !uid || !matchId) return false;
  const payload = { joinedAt: firebase.database.ServerValue.TIMESTAMP, host: !!isHost };
  if (code) payload.code = code;
  try {
    await db().ref(`users/${uid}/matches/${matchId}`).set(payload);
    return true;
  } catch (err) {
    reportCaughtError('match-record-mine', err);
    return false;
  }
}

/**
 * Every match this player is in, newest first, as bare references (matchId,
 * code, joinedAt, host flag) with nothing fetched. The full list is one small
 * owner-node read, so the callers that page (the finished list's Show older)
 * and the ones that need an honest total (the stats panel's window line) read
 * it once and choose which summaries to pay for.
 */
export async function fetchMyMatchRefs() {
  const ready = await _readyOrNull();
  const uid = getUid();
  if (!ready || !uid) return null;
  try {
    const snap = await db().ref(`users/${uid}/matches`).once('value');
    return Object.entries(snap.val() || {})
      .map(([matchId, v]) => ({ matchId, ...(v || {}) }))
      .sort((a, b) => (Number(b.joinedAt) || 0) - (Number(a.joinedAt) || 0));
  } catch {
    return null;
  }
}

/**
 * Attach a summary to each reference. Each node is fetched separately rather
 * than denormalized into the list, so a standing row can never disagree with
 * the match it names. Summaries, never whole nodes: the payloads are the
 * other 95% of the bytes and nothing on a list reads them (issue #331).
 * References whose node could not be read are dropped.
 */
export async function fetchMatchSummaries(refs, opts = {}) {
  const rows = Array.isArray(refs) ? refs : [];
  const nodes = await Promise.all(rows.map((r) => fetchMatchSummary(r.matchId, opts)));
  return rows.map((r, i) => ({ ...r, node: nodes[i] })).filter((r) => r.node);
}

/** The player's matches, newest first, each with its summary attached. */
export async function fetchMyMatches(limit = 10, opts = {}) {
  const refs = await fetchMyMatchRefs();
  if (!refs) return null;
  return fetchMatchSummaries(refs.slice(0, limit), opts);
}
