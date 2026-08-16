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

import { $, $$, escapeHtml } from './domHelpers.js';
import { hideModal } from './modalManager.js';
import { showModalFromTitle, closeModalAndReturn, setReturnToTitle, hideTitleScreen } from './titleScreen.js';
import { showToast } from './toastManager.js';
import { state } from '../state/gameState.js';
import { launchMatch } from '../game/modeManager.js';
import { dealMatchEntries } from '../game/matchDeal.js';
import { loadStats } from '../storage/statsStorage.js';
import { getUid } from '../firebase/firebaseProgress.js';
import { getHandicapRatioMap } from '../logic/handicaps.js';
import { matchUnlocks, unmetMatchRules, fmtClock, needsTenths } from '../logic/matchRules.js';
import { matchStandings } from '../logic/matchStandings.js';
import { matchBoardBreakdown } from '../logic/matchRecord.js';
import { normalizeCode, planMatchJoin, matchDaysRemaining, matchExpiresAt, partitionMatchReview, matchResumePoint } from '../logic/matchCodes.js';
import { tilingLabel, CLASSIC_SHAPE_LABEL } from '../logic/coastlineLink.js';
import { getGimmickDefs } from '../logic/gimmicks.js';
import { PROD_SITE_BASE } from '../config.js';
import { reportCaughtError } from '../diagnostics/errorReporter.js';

// The match this device just created and has not started playing yet. Session
// state, deliberately not storage: an invite the player walked away from is
// still live on the server under its code, and re-offering a half-made one on
// the next boot would be a surface with nothing behind it.
let _pending = null;
// One live subscription PER SURFACE, keyed by the element it paints. The
// old singleton let any other standings render steal the end board's
// listener (open the sheet to glance at Your runs mid-wait, come back,
// frozen at its last paint forever; his report, 2026-08-16). An element
// owns its feed until it is re-rendered or leaves the DOM, and surfaces
// never contend.
const _standingsSubs = new Map();

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
    expiresAt: matchExpiresAt(createdAt),
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
    const outcome = await sendMatchInvite(btn.dataset.uid, _pending.matchId, _pending.code);
    // 'exists' is a refusal, but not a failure the player should retry: the
    // invite is already sitting in their friend's list, and the rules refuse
    // the overwrite precisely so a re-send cannot wipe an answer they have
    // already given. Only a genuinely offline attempt is worth another tap.
    btn.textContent = outcome === 'sent' ? 'Invited'
      : outcome === 'exists' ? 'Already invited'
      : 'Try again';
    if (outcome === 'offline') btn.disabled = false;
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

/**
 * Open a match by its ID, the way the review list reaches a run it already
 * knows about. Codes expire at seven days and are scrubbed outright, so a
 * finished run opened by code becomes unopenable exactly when the ruling says
 * it should still be readable (issue #318). The node keeps answering by id.
 */
export async function openMatchById(matchId, code = null) {
  showModalFromTitle('match-join-modal');
  const preview = $('#match-join-preview');
  if (preview) preview.innerHTML = '';
  _joinFound = null;
  _status('#match-join-status', 'Looking…', false);
  let match = null;
  try {
    const { fetchMatch } = await import('../firebase/firebaseMatch.js');
    match = await fetchMatch(matchId);
  } catch (err) {
    reportCaughtError('match-open-by-id', err);
  }
  if (!match) {
    _status('#match-join-status', JOIN_MESSAGES.missing, true);
    return;
  }
  const verdict = planMatchJoin({ match, uid: getUid(), now: Date.now() });
  if (verdict !== 'join' && verdict !== 'resume' && verdict !== 'finished') {
    _status('#match-join-status', JOIN_MESSAGES[verdict] || JOIN_MESSAGES.failed, true);
    return;
  }
  _status('#match-join-status', '', false);
  _joinFound = { matchId, match, code, verdict };
  _renderJoinPreview();
}

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
  // 'finished' is a destination, not a refusal: the run is over and the
  // preview shows where everyone landed instead of dealing the boards again.
  if (verdict !== 'join' && verdict !== 'resume' && verdict !== 'finished') {
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

  // A run this player already finished shows the standings and no way back
  // onto the boards. Replaying it would restart at board 1 and overwrite the
  // times they actually set, so the button is absent rather than disabled:
  // there is nothing here for them to do again.
  if (_joinFound.verdict === 'finished') {
    preview.innerHTML = `<div class="friends-code-block">
        <p class="friends-code-label">${n} board${n === 1 ? '' : 's'}</p>
        <p class="friends-code-hint">${escapeHtml(shapes)}</p>
      </div>
      <p class="friends-code-hint">You have played this one. Here is how it went.</p>
      <div id="match-join-standings" class="match-standings"></div>`;
    renderMatchStandingsInto($('#match-join-standings'), _joinFound.matchId);
    return;
  }

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
    // Re-checked against the node as it is NOW, not as the preview found it:
    // the run can finish in another tab between the lookup and this tap, and
    // dealing the boards again would overwrite the results it just posted.
    const verdict = await joinMatch(found.matchId, found.match, found.code);
    if (verdict === 'finished') {
      _joinFound = { ...found, verdict };
      _renderJoinPreview();
      return;
    }
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
  // A RESUME carries the run forward. Re-entering used to hand back a fresh
  // {current: 0, results: []}, so every board replayed posted under its index
  // and overwrote the time already in the node (issue #317). The node's own
  // results are the truth here rather than the local save, because the review
  // list exists precisely to reach a match the save slot is not holding.
  const resume = matchResumePoint(found.match, getUid());
  launchMatch(null, null, {
    id: found.matchId,
    code: found.code,
    expiresAt: matchExpiresAt(createdAt),
    rules: found.match.rules,
    entries: found.match.boards,
    current: resume.current,
    results: resume.results,
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
  const prev = _standingsSubs.get(el);
  if (prev) { prev(); _standingsSubs.delete(el); }
  el.classList.remove('hidden');
  el.innerHTML = '<div class="match-standings-row"><span>Loading the other runs…</span></div>';
  import('../firebase/firebaseMatch.js').then(({ subscribeMatch }) => {
    const unsub = subscribeMatch(matchId, (node) => {
      // A surface that left the DOM unsubscribes itself: painting a
      // detached element is work nobody sees and a listener nobody frees.
      if (!el.isConnected) {
        const u = _standingsSubs.get(el);
        if (u) { u(); _standingsSubs.delete(el); }
        return;
      }
      _paintStandings(el, node);
    });
    _standingsSubs.set(el, unsub);
  }).catch((err) => reportCaughtError('match-standings-subscribe', err));
}

/** Stop watching every match surface (leaving the mode entirely). */
export function stopMatchStandings() {
  for (const unsub of _standingsSubs.values()) unsub();
  _standingsSubs.clear();
}

/** A margin in speech: tenths under ten seconds, whole seconds past it. */
function _fmtGap(gap) {
  const g = Math.abs(gap);
  return g < 10 ? `${g.toFixed(1)}s` : `${Math.round(g)}s`;
}

/** The handicap the chip convention speaks: positive = faster than Greg. */
function _hcLabel(handicaps, uid) {
  const k = typeof handicaps.get === 'function' ? handicaps.get(uid) : handicaps[uid];
  if (!Number.isFinite(k) || k <= 0) return '·';
  const pct = Math.round((1 - k) * 100);
  return pct > 0 ? `+${pct}%` : `${pct}%`;
}

function _shapeLabel(spec) {
  const t = spec && spec.shape;
  if (!t || t === 'rect') return CLASSIC_SHAPE_LABEL;
  return tilingLabel(t) || t;
}

const _ORDINALS = ['1st', '2nd', '3rd'];
const _ordinal = (n) => _ORDINALS[n - 1] || `${n}th`;

/**
 * The clean comparison, one painter for the live standings and the end
 * board alike (his design 2026-08-16): a margin headline, the per-board
 * grid with players as columns and the board's adjusted leader in the lead
 * color, and Total / Adjusted / Handicap rows under the columns. Board
 * labels sit LEFT (his ruling); totals show whole seconds with tenths only
 * where a gap is inside one second (his ruling); a tie leads nobody; an
 * unplayed board is a dot, honest absence rather than zero.
 */
function _paintStandings(el, node) {
  const handicaps = getHandicapRatioMap();
  const myUid = getUid();
  const rows = matchStandings(node, { handicaps, myUid });
  if (rows.length === 0) {
    el.innerHTML = '<div class="match-standings-row"><span>Nobody has joined yet.</span></div>';
    return;
  }

  const me = rows.find((r) => r.isMe) || null;
  const cols = me ? [me, ...rows.filter((r) => !r.isMe)] : rows.slice();
  const breakdown = matchBoardBreakdown(node, { myUid, handicaps });

  // ── Headline: place and margin among the FINISHED, adjusted ──
  const finished = rows.filter((r) => r.finished);
  let head = '';
  if (me && me.finished && finished.length >= 2) {
    const place = finished.indexOf(me);
    if (place === 0) {
      const gap = finished[1].adjusted - me.adjusted;
      head = gap === 0
        ? `<div class="match-headline">Tied with ${escapeHtml(finished[1].name)}</div>`
        : `<div class="match-headline">You won <span class="match-lead">by ${_fmtGap(gap)}</span></div>
           <div class="match-headline-sub">ahead of ${escapeHtml(finished[1].name)}, adjusted</div>`;
    } else {
      const gap = me.adjusted - finished[0].adjusted;
      head = `<div class="match-headline">${_ordinal(place + 1)} of ${rows.length}</div>
        <div class="match-headline-sub">${_fmtGap(gap)} behind ${escapeHtml(finished[0].name)}, adjusted</div>`;
    }
  } else if (me && me.finished) {
    head = '<div class="match-headline-sub">Run complete · waiting on the others</div>';
  }

  // ── The per-board grid ──
  const headerCells = cols.map((c) =>
    `<th class="match-grid-p${c.isMe ? ' match-grid-me' : ''}">${escapeHtml(c.isMe ? 'You' : c.name)}</th>`).join('');
  const bodyRows = breakdown.map((r) => {
    const label = `${r.index + 1} · ${escapeHtml(_shapeLabel(r.spec))}`;
    const best = r.fastestAdjusted;
    const cells = cols.map((c) => {
      const e = r.entries.find((x) => x.uid === c.uid);
      if (!e) return '<td class="match-grid-none">·</td>';
      if (r.entries.length === 1) {
        return `<td class="match-grid-solo">${e.adjusted.toFixed(1)}</td>`;
      }
      if (best && e.adjusted === best.adjusted) {
        return `<td class="${best.tied ? 'match-grid-tied' : 'match-grid-lead'}">${e.adjusted.toFixed(1)}</td>`;
      }
      return `<td class="match-grid-gap">+${(e.adjusted - best.adjusted).toFixed(1)}</td>`;
    }).join('');
    return `<tr><th scope="row" class="match-grid-board">${label}</th>${cells}</tr>`;
  }).join('');

  // ── Totals: whole seconds unless a gap is inside one second ──
  const rawTenths = needsTenths(cols.filter((c) => c.finished).map((c) => c.time));
  const adjTenths = needsTenths(cols.filter((c) => c.finished).map((c) => c.adjusted));
  const totalCells = cols.map((c) => `<td>${c.finished
    ? fmtClock(c.time, rawTenths) : `${c.done} of ${c.of}`}</td>`).join('');
  const adjCells = cols.map((c) => (c.finished
    ? `<td class="${c.isMe && finished[0] === c ? 'match-grid-lead' : ''}">${fmtClock(c.adjusted, adjTenths)}${c.rated ? '' : ' *'}</td>`
    : '<td class="match-grid-none">·</td>')).join('');
  const hcCells = cols.map((c) => `<td>${_hcLabel(handicaps, c.uid)}</td>`).join('');

  // ── The board that decided it ──
  let swing = '';
  const contested = breakdown.filter((r) => r.contested && r.mine);
  if (me && contested.length >= 2) {
    let top = null;
    for (const r of contested) {
      const rivals = r.entries.filter((e) => !e.isMe);
      let bestRival = rivals[0];
      for (const e of rivals) { if (e.adjusted < bestRival.adjusted) bestRival = e; }
      const gap = r.mine.adjusted - bestRival.adjusted;
      if (!top || Math.abs(gap) > Math.abs(top.gap)) top = { index: r.index, gap };
    }
    if (top && Math.abs(top.gap) > 0) {
      swing = `<div class="match-swing">Board ${top.index + 1} decided it: ${_fmtGap(top.gap)} `
        + `${top.gap < 0 ? 'swung your way' : 'went against you'}.</div>`;
    }
  }

  const anyUnrated = rows.some((r) => !r.rated);
  const note = anyUnrated
    ? '<p class="friends-code-hint">* not rated yet, so that total is the raw clock.</p>'
    : '';
  el.innerHTML = `${head}
    <div class="match-grid-wrap"><table class="match-grid">
      <thead><tr><th class="match-grid-board"></th>${headerCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
      <tfoot>
        <tr><th scope="row" class="match-grid-board">Total</th>${totalCells}</tr>
        <tr><th scope="row" class="match-grid-board">Adjusted</th>${adjCells}</tr>
        <tr><th scope="row" class="match-grid-board">Handicap</th>${hcCells}</tr>
      </tfoot>
    </table></div>
    ${swing}${note}`;
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
/** Show one of the sheet's two tabs. */
export function showMatchTab(tab) {
  const runs = tab !== 'new';
  for (const btn of $$('.match-tab')) {
    const on = (btn.dataset.tab === 'runs') === runs;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  $('#match-panel-runs')?.classList.toggle('hidden', !runs);
  $('#match-panel-new')?.classList.toggle('hidden', runs);
}

function wire() {
  if (_wired) return;
  _wired = true;

  // The two tabs, and his three places inside the first. Delegated from the
  // sheet rather than bound per button: both rows are static markup, but the
  // place rows below them re-render on every open.
  for (const btn of $$('.match-tab')) {
    btn.addEventListener('click', () => showMatchTab(btn.dataset.tab));
  }
  for (const btn of $$('.match-place')) {
    btn.addEventListener('click', () => showMatchPlace(btn.dataset.place));
  }

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

// Which of his three places is open. Session state: a player who was reading
// their finished runs and opens the sheet again is most likely still after
// the same thing, and re-deriving it from the data would flip the tab under
// them as invites arrive.
let _place = 'active';

// The last fetch, so switching place re-renders without going back to the
// network. Invalidated by every renderMatchReview call.
let _review = null;
let _reviewNamesCache = {};

const PLACE_EMPTY = {
  active: 'Nothing waiting. Start a run on the New run tab, or use a code a friend sent you.',
  finished: 'No finished runs yet. They collect here once you play one through.',
  declined: 'Nothing turned down. Invites you say no thanks to wait here until their code expires.',
};

/** Switch place without re-fetching. */
export function showMatchPlace(place) {
  if (!PLACE_EMPTY[place]) return;
  _place = place;
  for (const btn of $$('.match-place')) {
    const on = btn.dataset.place === place;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  _paintPlace();
}

function _paintPlace() {
  const el = $('#match-review');
  if (!el) return;
  if (!_review) { el.innerHTML = '<p class="friends-empty">Loading…</p>'; return; }
  const rows = _review[_place] || [];
  if (rows.length === 0) {
    el.innerHTML = `<p class="friends-empty">${escapeHtml(PLACE_EMPTY[_place])}</p>`;
    return;
  }
  el.innerHTML = rows.map((entry) => (entry.kind === 'invite'
    ? _inviteRowHTML(entry.invite, _reviewNamesCache, _place, entry.snoozed)
    : _myMatchRowHTML(entry.match))).join('');
}

/**
 * Fetch and render his three places.
 *
 * The partition is pure (partitionMatchReview): what belongs where is decided
 * where a test can reach it, and this function is fetch, paint, and the
 * self-scrub.
 */
export async function renderMatchReview() {
  _review = null;
  _paintPlace();

  let invites = null;
  let mine = null;
  try {
    const m = await import('../firebase/firebaseMatch.js');
    [invites, mine] = await Promise.all([m.fetchMatchInvites(), m.fetchMyMatches()]);
  } catch (err) {
    reportCaughtError('match-review-fetch', err);
    const el = $('#match-review');
    if (el) el.innerHTML = '<p class="friends-empty">Could not reach your runs. Check your connection.</p>';
    return;
  }

  _reviewNamesCache = await _reviewNames();
  _review = partitionMatchReview({
    invites: invites || [], matches: mine || [], uid: getUid(), now: Date.now(),
  });
  _paintPlace();

  // The self-scrub, his ruling: an invite past its code's seven days is gone
  // from the list already (partitionMatchReview drops it), and this deletes
  // the node behind it so a player's own invite list cannot grow forever.
  // Best-effort and after the paint: a failed delete costs nothing visible,
  // and the next open tries again.
  if (_review.expired.length > 0) {
    import('../firebase/firebaseMatch.js').then(({ dismissMatchInvite }) => {
      for (const inv of _review.expired) dismissMatchInvite(inv.matchId).catch(() => {});
    }).catch(() => {});
  }
}

async function _reviewNames() {
  try {
    const { fetchPlayerNames } = await import('../firebase/firebaseLeaderboard.js');
    return await fetchPlayerNames();
  } catch {
    return {};
  }
}

function _inviteRowHTML(inv, names, place, snoozed) {
  const who = (names && names[inv.from]) || 'A friend';
  // Every place offers Play, which is the point of keeping the turned-down
  // ones: an invite you changed your mind about must be playable without
  // asking for a fresh one. Only an unanswered invite offers "No thanks",
  // since that is the only place the answer is still open.
  const label = snoozed ? 'Asked to be reminded' : '';
  const note = label ? `<span class="match-review-note">${escapeHtml(label)}</span>` : '';
  const decline = (place === 'active' && !snoozed)
    ? '<button type="button" class="friends-btn match-review-decline">No thanks</button>' : '';
  return `<div class="match-review-row" data-invite="${escapeHtml(inv.matchId)}" data-code="${escapeHtml(inv.code || '')}">
      <span class="match-review-name">${escapeHtml(who)} invited you${note}</span>
      <span class="match-review-actions">
        <button type="button" class="friends-btn match-review-join">Play</button>
        ${decline}
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
  // BY ID where the row has one. Codes die after seven days (server-enforced
  // in the read rule, and the 3-hourly scrub deletes them), so opening a
  // finished run by code made it unopenable a week on, against the ruling
  // that finished runs stay readable forever (issue #318). The node itself is
  // still readable by id, and fetchMyMatches has already read it to draw this
  // row. An invite row has no matchId of its own on the match node, so it
  // keeps the code path.
  if (row.dataset.match) openMatchById(row.dataset.match, row.dataset.code || null);
  else openMatchJoin(row.dataset.code);
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
