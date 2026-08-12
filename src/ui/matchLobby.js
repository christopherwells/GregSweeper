// The Challenge match's shared surfaces: making an invite, taking one, and
// watching the standings.
//
// Every decision this file acts on lives somewhere a test can reach it:
// logic/matchCodes.js (the seven-day life, the join verdict), matchRules.js
// (which rules a launch plays and which of them a guest has not met), and
// matchStandings.js (the ranking). What is here is markup, wiring, and the
// order of operations.
//
// Styling follows the vocabulary the app already has, and one rule dominates:
// white text on a themed accent measures 1.30:1 on chalkboard and about 2:1 on
// half a dozen others, so the primary action reuses .match-start-btn (accent
// BORDER over the hidden-cell fill) and never .action-btn.primary or
// .friends-btn-primary. Body copy uses --font-family, since --font-display is
// a pixel font on neon and blackletter on stainedglass.

import { $, escapeHtml } from './domHelpers.js';
import { hideModal } from './modalManager.js';
import { showModalFromTitle, closeModalAndReturn, setReturnToTitle, hideTitleScreen } from './titleScreen.js';
import { showToast } from './toastManager.js';
import { state } from '../state/gameState.js';
import { launchMatch } from '../game/modeManager.js';
import { dealMatchEntries } from '../game/matchDeal.js';
import { loadStats } from '../storage/statsStorage.js';
import { getUid } from '../firebase/firebaseProgress.js';
import { getHandicapRatioMap } from '../logic/handicaps.js';
import { matchUnlocks, unmetMatchRules } from '../logic/matchRules.js';
import { matchStandings } from '../logic/matchStandings.js';
import { normalizeCode, planMatchJoin, matchDaysRemaining, partitionInvites } from '../logic/matchCodes.js';
import { tilingLabel, CLASSIC_SHAPE_LABEL } from '../logic/coastlineLink.js';
import { getGimmickDefs } from '../logic/gimmicks.js';
import { PROD_SITE_BASE } from '../config.js';
import { reportCaughtError } from '../diagnostics/errorReporter.js';

// The match this device just created and has not started playing yet. Session
// state, deliberately not storage: an invite the player walked away from is
// still live on the server under its code, and re-offering a half-made one on
// the next boot would be a surface with nothing behind it.
let _pending = null;
// The live standings subscription, one at a time.
let _standingsUnsub = null;

const shapeLabelOf = (s) => (s === 'rect' ? CLASSIC_SHAPE_LABEL : tilingLabel(s));

/** The URL a friend follows to land on the join card with the code filled in. */
export function matchShareUrl(code) {
  return `${PROD_SITE_BASE}?match=${code}`;
}

function _status(id, message, isError) {
  const el = $(id);
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
  el.classList.toggle('friends-status-error', !!isError);
}

// ── Creating an invite ──────────────────────────────────────────────────

/**
 * Deal a match's boards, publish it, and show its code.
 *
 * The boards are dealt HERE rather than at first play, because the whole
 * arc rests on both players playing the same bytes: they are written into the
 * node write-once, before anyone can join, and every player re-certifies each
 * one at install through certifyStoredBoard's ground-truth audit.
 */
export async function createSharedMatch(rules) {
  showModalFromTitle('match-invite-modal');
  _renderInvitePending();
  let deal = null;
  try {
    deal = await dealMatchEntries(rules);
  } catch (err) {
    reportCaughtError('match-invite-deal', err);
  }
  if (!deal || !deal.entries.length) {
    _renderInviteError('Could not load the boards. Check your connection and try again.');
    return;
  }

  const { createMatch, fetchMatch } = await import('../firebase/firebaseMatch.js');
  let created = null;
  try {
    created = await createMatch(rules, deal.entries);
  } catch (err) {
    _renderInviteError(err.reason === 'offline'
      ? 'You need a connection to invite someone. You can still play this run on your own.'
      : 'That invite could not be created. Try again in a moment.');
    return;
  }

  // Read the node back for its SERVER createdAt: the seven-day deadline the
  // rules enforce is measured from that, and a client clock is not it.
  const node = await fetchMatch(created.matchId);
  const createdAt = (node && typeof node.createdAt === 'number') ? node.createdAt : Date.now();
  _pending = {
    matchId: created.matchId,
    code: created.code,
    rules,
    entries: deal.entries,
    createdAt,
    expiresAt: createdAt + 604800000,
  };
  _renderInvite();
}

function _renderInvitePending() {
  const body = $('#match-invite-body');
  if (body) body.innerHTML = '<p class="friends-code-hint">Dealing the boards…</p>';
}

function _renderInviteError(message) {
  const body = $('#match-invite-body');
  if (body) body.innerHTML = `<p class="friends-status friends-status-error">${escapeHtml(message)}</p>`;
}

function _renderInvite() {
  const body = $('#match-invite-body');
  if (!body || !_pending) return;
  const { code, rules, expiresAt } = _pending;
  const days = matchDaysRemaining(expiresAt, Date.now());
  const codeBlock = code
    ? `<div class="friends-code-block">
         <p class="friends-code-label">Challenge code</p>
         <div class="friends-code-row"><span class="friends-code">${escapeHtml(code)}</span></div>
         <p class="friends-code-expiry">Good for ${days} day${days === 1 ? '' : 's'}</p>
         <button id="match-copy-link" class="friends-btn">Copy link</button>
       </div>`
    : `<p class="friends-status friends-status-error">The code could not be created, but the run is ready to play.</p>`;

  const n = rules.count;
  const shapes = (rules.shapes || []).map(shapeLabelOf).join(', ');
  body.innerHTML = `${codeBlock}
    <p class="friends-code-hint">${n} board${n === 1 ? '' : 's'} · ${escapeHtml(shapes)}.
      Everyone who joins plays these same boards.</p>
    <div id="match-invite-friends"></div>
    <p id="match-invite-status" class="friends-status hidden"></p>
    <button id="match-invite-start" class="match-start-btn">Start playing</button>`;

  const copyBtn = $('#match-copy-link');
  if (copyBtn && code) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(matchShareUrl(code));
        showToast('Link copied.');
      } catch {
        _status('#match-invite-status', matchShareUrl(code), false);
      }
    });
  }
  const startBtn = $('#match-invite-start');
  if (startBtn) startBtn.addEventListener('click', _startPending);
  _renderInviteFriends();
}

function _startPending() {
  if (!_pending) return;
  const p = _pending;
  _pending = null;
  hideModal('match-invite-modal');
  setReturnToTitle(false);
  hideTitleScreen();
  launchMatch(null, null, {
    id: p.matchId, code: p.code, expiresAt: p.expiresAt,
    rules: p.rules, entries: p.entries,
  });
}

// His second invite route: send the invite straight to a friend already on
// the list, with no code read aloud at all.
async function _renderInviteFriends() {
  const el = $('#match-invite-friends');
  if (!el || !_pending || !_pending.code) return;
  let friends = null;
  try {
    const { fetchFriends } = await import('../firebase/firebaseFriends.js');
    friends = await fetchFriends();
  } catch (err) {
    reportCaughtError('match-invite-friends', err);
  }
  if (!friends || friends.length === 0) {
    el.innerHTML = '<p class="friends-empty">Add friends on the leaderboard to invite them straight from here.</p>';
    return;
  }
  el.innerHTML = friends.map((f) => `<div class="friends-row">
      <span class="friends-row-name">${escapeHtml(f.name)}</span>
      <button class="friends-btn match-invite-send" data-uid="${escapeHtml(f.uid)}">Invite</button>
    </div>`).join('');
  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('.match-invite-send');
    if (!btn || btn.disabled || !_pending) return;
    btn.disabled = true;
    const { sendMatchInvite } = await import('../firebase/firebaseMatch.js');
    const ok = await sendMatchInvite(btn.dataset.uid, _pending.matchId, _pending.code);
    btn.textContent = ok ? 'Invited' : 'Try again';
    if (!ok) btn.disabled = false;
  });
}

// ── Taking an invite ────────────────────────────────────────────────────

/** Open the join card, optionally with a code already in the box. */
export function openMatchJoin(prefill) {
  const input = $('#match-join-input');
  if (input) input.value = normalizeCode(prefill) || '';
  _status('#match-join-status', '', false);
  const preview = $('#match-join-preview');
  if (preview) preview.innerHTML = '';
  showModalFromTitle('match-join-modal');
  if (prefill) _lookupJoinCode();
}

const JOIN_MESSAGES = {
  invalid: 'That code does not look right. Codes are six letters and numbers.',
  offline: 'You need a connection to join a Challenge.',
  expired: 'That code has expired or was never used. Ask for a new one.',
  full: 'That Challenge is full.',
  missing: 'That Challenge is no longer available.',
  failed: 'Could not join that Challenge. Try again in a moment.',
};

// What the lookup found, held between the preview render and the Join tap so
// the tap does not re-fetch a node the player is already looking at.
let _joinFound = null;

async function _lookupJoinCode() {
  const input = $('#match-join-input');
  const preview = $('#match-join-preview');
  if (!input || !preview) return;
  _joinFound = null;
  preview.innerHTML = '';
  const code = normalizeCode(input.value);
  if (!code) { _status('#match-join-status', JOIN_MESSAGES.invalid, true); return; }
  _status('#match-join-status', 'Looking…', false);

  let found = null;
  try {
    const { fetchMatchByCode } = await import('../firebase/firebaseMatch.js');
    found = await fetchMatchByCode(code);
  } catch (err) {
    _status('#match-join-status', JOIN_MESSAGES[err.reason] || JOIN_MESSAGES.failed, true);
    return;
  }

  const verdict = planMatchJoin({ match: found.match, uid: getUid(), now: Date.now() });
  if (verdict !== 'join' && verdict !== 'resume') {
    _status('#match-join-status', JOIN_MESSAGES[verdict] || JOIN_MESSAGES.failed, true);
    return;
  }
  _status('#match-join-status', '', false);
  _joinFound = { ...found, code, verdict };
  _renderJoinPreview();
}

function _renderJoinPreview() {
  const preview = $('#match-join-preview');
  if (!preview || !_joinFound) return;
  const { match } = _joinFound;
  const rules = match.rules || {};
  const n = Array.isArray(match.boards) ? match.boards.length : (rules.count || 0);
  const shapes = (rules.shapes || []).map(shapeLabelOf).join(', ');

  // His ruling: the HOST's unlocks build the match, WITH A WARNING naming
  // anything the guest has not met. Never the intersection, so this says what
  // is coming and never removes it.
  const unmet = unmetMatchRules(rules, matchUnlocks(loadStats().modeStats?.challenge?.maxLevelReached || 1));
  const defs = getGimmickDefs();
  const unmetNames = [
    ...unmet.shapes.map(shapeLabelOf),
    ...unmet.mods.map((m) => (defs[m] && defs[m].name) || m),
  ];
  const warning = unmetNames.length
    ? `<p class="friends-code-hint match-join-warning">New to you in this run:
         ${escapeHtml(unmetNames.join(', '))}. You will get an introduction before each one.</p>`
    : '';

  preview.innerHTML = `<div class="friends-code-block">
      <p class="friends-code-label">${n} board${n === 1 ? '' : 's'}</p>
      <p class="friends-code-hint">${escapeHtml(shapes)}</p>
    </div>${warning}
    <button id="match-join-go" class="match-start-btn">
      ${_joinFound.verdict === 'resume' ? 'Back to this run' : 'Join and play'}</button>`;
  const go = $('#match-join-go');
  if (go) go.addEventListener('click', _acceptJoin);
}

async function _acceptJoin() {
  if (!_joinFound) return;
  const found = _joinFound;
  const go = $('#match-join-go');
  if (go) go.disabled = true;
  try {
    const { joinMatch } = await import('../firebase/firebaseMatch.js');
    await joinMatch(found.matchId, found.match, found.code);
  } catch (err) {
    if (go) go.disabled = false;
    _status('#match-join-status', JOIN_MESSAGES[err.reason] || JOIN_MESSAGES.failed, true);
    return;
  }
  const { dismissMatchInvite } = await import('../firebase/firebaseMatch.js');
  dismissMatchInvite(found.matchId).catch(() => { /* the invite ages out anyway */ });

  _joinFound = null;
  hideModal('match-join-modal');
  setReturnToTitle(false);
  hideTitleScreen();
  const createdAt = typeof found.match.createdAt === 'number' ? found.match.createdAt : Date.now();
  launchMatch(null, null, {
    id: found.matchId,
    code: found.code,
    expiresAt: createdAt + 604800000,
    rules: found.match.rules,
    entries: found.match.boards,
  });
}

// ── Standings ───────────────────────────────────────────────────────────

/**
 * Paint a match's standings into `el` and keep them painted.
 *
 * Live for everyone, finished or not (his ruling), so this never withholds a
 * time. The subscription is torn down and replaced on every call, which is
 * what stops a second match's panel writing into the first one's element.
 */
export function renderMatchStandingsInto(el, matchId) {
  if (!el || !matchId) return;
  if (_standingsUnsub) { _standingsUnsub(); _standingsUnsub = null; }
  el.classList.remove('hidden');
  el.innerHTML = '<div class="match-standings-row"><span>Loading the other runs…</span></div>';
  import('../firebase/firebaseMatch.js').then(({ subscribeMatch }) => {
    _standingsUnsub = subscribeMatch(matchId, (node) => _paintStandings(el, node));
  }).catch((err) => reportCaughtError('match-standings-subscribe', err));
}

/** Stop watching a match (leaving the surface, or starting another). */
export function stopMatchStandings() {
  if (_standingsUnsub) { _standingsUnsub(); _standingsUnsub = null; }
}

function _paintStandings(el, node) {
  const rows = matchStandings(node, { handicaps: getHandicapRatioMap(), myUid: getUid() });
  if (rows.length === 0) {
    el.innerHTML = '<div class="match-standings-row"><span>Nobody has joined yet.</span></div>';
    return;
  }
  // Adjusted is the mode's comparison (his ruling), so it leads. An unrated
  // player shows their raw total with a marker rather than a pretend rating,
  // exactly as every other adjusted view in the app does.
  const anyUnrated = rows.some((r) => !r.rated);
  const head = `<div class="match-standings-head"><span>Adjusted</span></div>`;
  const body = rows.map((r, i) => {
    const place = r.finished ? `${i + 1}.` : '·';
    const value = r.finished
      ? `${r.adjusted.toFixed(1)}s${r.rated ? '' : ' *'}`
      : `${r.done} of ${r.of}`;
    return `<div class="match-standings-row${r.isMe ? ' match-standings-me' : ''}">
        <span class="match-standings-place">${place}</span>
        <span class="match-standings-name">${escapeHtml(r.name)}</span>
        <span class="match-standings-value">${value}</span>
      </div>`;
  }).join('');
  const note = anyUnrated
    ? '<p class="friends-code-hint">* not rated yet, so that total is the raw clock.</p>'
    : '';
  el.innerHTML = head + body + note;
}

// ── Incoming friend invites ─────────────────────────────────────────────

// Invites this session has already offered, so a re-render or a reconnect
// does not stack the same card twice.
const _seenInvites = new Set();

/**
 * Start listening for friend invites.
 *
 * His rule: an invite shows up while the app is open, or the next time it
 * opens. `child_added` gives both from one listener, since it replays what is
 * already there when it attaches.
 */
export function initMatchInvites() {
  import('../firebase/firebaseMatch.js').then(({ subscribeMatchInvites }) => {
    subscribeMatchInvites((invite) => _offerInvite(invite));
  }).catch((err) => reportCaughtError('match-invite-init', err));
}

/**
 * The sender's name, resolved at READ time from playerNames rather than
 * stored on the invite, so a renamed friend always reads correctly and there
 * is one fewer name-bearing path for the hate-speech sweep to cover.
 */
async function _senderName(uid) {
  try {
    const { fetchPlayerNames, resolveDisplayName } = await import('../firebase/firebaseLeaderboard.js');
    const name = resolveDisplayName(uid, null, await fetchPlayerNames());
    return (name && name !== 'Anonymous') ? name : 'A friend';
  } catch {
    return 'A friend';
  }
}

/** One line describing what a match actually is: how many boards, what shapes. */
function _matchSummaryLine(node) {
  if (!node) return '';
  const n = Array.isArray(node.boards) ? node.boards.length : 0;
  const shapes = ((node.rules && node.rules.shapes) || []).map(shapeLabelOf).join(', ');
  const boards = `${n} board${n === 1 ? '' : 's'}`;
  return shapes ? `${boards} · ${shapes}` : boards;
}

async function _offerInvite(invite) {
  if (!invite || _seenInvites.has(invite.matchId)) return;
  _seenInvites.add(invite.matchId);
  // Never over a board in progress: an invite is not worth interrupting a run
  // for, and it will still be here when the run ends.
  if (state.status === 'playing') return;

  const card = $('#match-invite-toast');
  const text = $('#match-invite-toast-text');
  const detail = $('#match-invite-toast-detail');
  if (!card || !text) return;

  // Fetch the match BEFORE offering it: a player answering "join", "later" or
  // "no thanks" needs to know what they are answering about (his rule). If the
  // fetch fails the card still appears without the detail line, because Join
  // opens the join card, which previews the match in full before committing.
  const [who, node] = await Promise.all([
    _senderName(invite.from),
    import('../firebase/firebaseMatch.js').then((m) => m.fetchMatch(invite.matchId)).catch(() => null),
  ]);

  text.textContent = `${who} invited you to a Challenge.`;
  if (detail) {
    detail.textContent = _matchSummaryLine(node);
    detail.classList.toggle('hidden', !detail.textContent);
  }
  card.dataset.code = invite.code;
  card.dataset.matchId = invite.matchId;
  card.classList.remove('hidden');
}

let _wired = false;
/** Bind the invite card's two buttons. Called once at import time. */
function wire() {
  if (_wired) return;
  _wired = true;

  // His three answers. All of them are reversible from the review list, which
  // is why "no thanks" records a STATE instead of deleting the invite.
  const card = $('#match-invite-toast');
  if (card) {
    card.querySelector('#match-invite-accept')?.addEventListener('click', () => {
      const code = card.dataset.code;
      card.classList.add('hidden');
      openMatchJoin(code);
    });
    card.querySelector('#match-invite-later')?.addEventListener('click', async () => {
      const id = card.dataset.matchId;
      card.classList.add('hidden');
      const m = await import('../firebase/firebaseMatch.js');
      await m.snoozeMatchInvite(id);
      showToast('We will ask again tomorrow.');
    });
    card.querySelector('#match-invite-decline')?.addEventListener('click', async () => {
      const id = card.dataset.matchId;
      card.classList.add('hidden');
      const m = await import('../firebase/firebaseMatch.js');
      await m.declineMatchInvite(id);
      showToast('Turned down. You can still find it under Challenges.');
    });
  }

  const review = $('#match-review');
  if (review) review.addEventListener('click', _onReviewClick);

  const joinBtn = $('#match-join-lookup');
  if (joinBtn) joinBtn.addEventListener('click', _lookupJoinCode);
  const joinInput = $('#match-join-input');
  if (joinInput) {
    joinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); _lookupJoinCode(); }
    });
  }

  for (const id of ['match-invite-modal', 'match-join-modal']) {
    const modal = $(`#${id}`);
    if (!modal) continue;
    modal.querySelector('.modal-close')?.addEventListener('click', () => closeModalAndReturn(id));
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModalAndReturn(id); });
  }
}
wire();

// ── The review list ─────────────────────────────────────────────────────
//
// His requirement: somewhere to review invites that were sent and
// accepted, snoozed or turned down, change your mind, and start playing.
//
// Two sections, because they answer different questions. INVITES are
// decisions still open to you, in all three states, each reversible. YOUR
// CHALLENGES are matches you are already in, and this is the only way back
// into one: the save slot holds a single match, so a player in two of them
// could otherwise never return to the other.

/** Render the review list into the setup sheet. Hidden when there is nothing. */
export async function renderMatchReview() {
  const el = $('#match-review');
  if (!el) return;
  el.innerHTML = '';
  el.classList.add('hidden');

  let invites = null;
  let mine = null;
  try {
    const m = await import('../firebase/firebaseMatch.js');
    [invites, mine] = await Promise.all([m.fetchMatchInvites(), m.fetchMyMatches()]);
  } catch (err) {
    reportCaughtError('match-review-fetch', err);
    return;
  }
  const parts = partitionInvites(invites || [], Date.now());
  const anyInvite = parts.pending.length + parts.snoozed.length + parts.declined.length;
  if (!anyInvite && !(mine && mine.length)) return;

  const names = await _reviewNames([...(invites || [])].map((i) => i.from));
  const chunks = [];

  if (anyInvite) {
    chunks.push('<h3>Invites</h3>');
    for (const [state, label] of [['pending', ''], ['snoozed', 'Asked to be reminded'], ['declined', 'Turned down']]) {
      for (const inv of parts[state]) {
        chunks.push(_inviteRowHTML(inv, names, label));
      }
    }
  }
  if (mine && mine.length) {
    chunks.push('<h3>Your Challenges</h3>');
    for (const row of mine) chunks.push(_myMatchRowHTML(row));
  }
  el.innerHTML = chunks.join('');
  el.classList.remove('hidden');
}

async function _reviewNames(uids) {
  try {
    const { fetchPlayerNames } = await import('../firebase/firebaseLeaderboard.js');
    return await fetchPlayerNames();
  } catch {
    return {};
  }
}

function _inviteRowHTML(inv, names, stateLabel) {
  const who = (names && names[inv.from]) || 'A friend';
  // Every state offers Join, which is the point of a review list: a turned-down
  // invite you changed your mind about must be playable without a fresh one.
  const note = stateLabel ? `<span class="match-review-note">${escapeHtml(stateLabel)}</span>` : '';
  return `<div class="match-review-row" data-invite="${escapeHtml(inv.matchId)}" data-code="${escapeHtml(inv.code || '')}">
      <span class="match-review-name">${escapeHtml(who)}${note}</span>
      <span class="match-review-actions">
        <button type="button" class="friends-btn match-review-join">Play</button>
        ${stateLabel ? '' : '<button type="button" class="friends-btn match-review-decline">No thanks</button>'}
      </span>
    </div>`;
}

function _myMatchRowHTML(row) {
  const node = row.node;
  const players = node.players && typeof node.players === 'object' ? node.players : {};
  const rows = matchStandings(node, { myUid: getUid() });
  const me = rows.find((r) => r.isMe);
  const of = Array.isArray(node.boards) ? node.boards.length : 0;
  const done = me ? me.done : 0;
  const others = Math.max(0, Object.keys(players).length - 1);
  const progress = done >= of && of > 0
    ? 'Finished'
    : `Board ${Math.min(done + 1, of)} of ${of}`;
  const company = others === 0
    ? 'Nobody else yet'
    : `${others} other${others === 1 ? '' : 's'} playing`;
  return `<div class="match-review-row" data-match="${escapeHtml(row.matchId)}" data-code="${escapeHtml(row.code || '')}">
      <span class="match-review-name">${escapeHtml(_matchSummaryLine(node))}
        <span class="match-review-note">${progress} · ${company}</span></span>
      <span class="match-review-actions">
        <button type="button" class="friends-btn match-review-open">Open</button>
      </span>
    </div>`;
}

// One delegated listener, bound with the rest of the wiring: the rows
// re-render on every open, so per-button listeners would leak.
async function _onReviewClick(e) {
  const joinBtn = e.target.closest('.match-review-join, .match-review-open');
  const declineBtn = e.target.closest('.match-review-decline');
  const row = e.target.closest('.match-review-row');
  if (!row) return;
  const m = await import('../firebase/firebaseMatch.js');

  if (declineBtn) {
    await m.declineMatchInvite(row.dataset.invite);
    renderMatchReview();
    return;
  }
  if (!joinBtn) return;
  // Playing a snoozed or turned-down invite is a change of mind, so clear the
  // state first: the invite becomes live again, and accepting removes it.
  if (row.dataset.invite) await m.reopenMatchInvite(row.dataset.invite);
  hideModal('match-setup-modal');
  openMatchJoin(row.dataset.code);
}

// ── Rematch ─────────────────────────────────────────────────────────────

/**
 * Play the same rules again on a NEW set of boards (his ruling: "a new set
 * with the same rules... so more data can be generated and it's a fair
 * fight"). A shared run makes a new node and a new code, since the old one
 * holds the old boards and everyone's times on them.
 */
export async function startRematch() {
  const m = state.match;
  if (!m || !m.rules) return;
  const rules = m.rules;
  const wasShared = !!m.id;
  hideModal('gameover-overlay');
  stopMatchStandings();
  if (wasShared) {
    await createSharedMatch(rules);
    return;
  }
  setReturnToTitle(false);
  launchMatch(rules);
}
