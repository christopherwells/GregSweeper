// The live race, the DOM half: one subscription per active shared match,
// the quiet chip on #game-info-bar, the between-boards gap lines, and the
// presence heartbeat. Every verdict it paints comes from logic/matchRace.js,
// where the tests live.
//
// Lifecycle, and who calls what: launchMatch/resumeMatch start it, the
// Next-board tap re-baselines it (so "while you played" means this board,
// not the whole run), the match-complete card and every road back to the
// title stop it. The heartbeat tick re-checks that the match it serves is
// still the one being played, so any exit path nobody thought to wire still
// goes quiet within one beat.

import { $, escapeHtml } from './domHelpers.js';
import { state } from '../state/gameState.js';
import { getUid } from '../firebase/firebaseProgress.js';
import { getHandicapRatioMap } from '../logic/handicaps.js';
import {
  raceChipModel, raceBaseline, raceEvents, gapComparison, gapLineText,
  gapNewsText, isPresenceFresh, PRESENCE_BEAT_MS,
} from '../logic/matchRace.js';
import { reportCaughtError } from '../diagnostics/errorReporter.js';

let _matchId = null;
let _unsub = null;
let _lastNode = null;
let _baseline = null;
let _names = {};
let _beatTimer = null;
let _beatFails = 0;
let _visibilityBound = false;

// Presence pauses while the tab is hidden: a background tab's throttled
// timers can keep writing for minutes, and a pocketed phone is not
// "playing right now". The fresh window lets the dot survive a quick
// tab-switch; a real absence outlives it.
function _onVisibility() {
  if (document.visibilityState === 'hidden') {
    _stopBeat();
  } else if (_matchId && _stillRacing()) {
    _startBeat();
  }
}

function _stillRacing() {
  return state.gameMode === 'match' && !!state.match && state.match.id === _matchId
    && !state.isLevelPractice;
}

function _startBeat() {
  _stopBeat();
  _beatFails = 0;
  const beat = async () => {
    if (!_stillRacing()) { stopMatchRace(); return; }
    const { touchMatchPresence } = await import('../firebase/firebaseMatch.js');
    const ok = await touchMatchPresence(_matchId);
    // Three quiet failures in a row is the seven-day gate (or a dead
    // connection): stop asking. The subscription stays, reads are forever.
    _beatFails = ok ? 0 : _beatFails + 1;
    if (_beatFails >= 3) _stopBeat();
  };
  beat();
  _beatTimer = setInterval(beat, PRESENCE_BEAT_MS);
}

function _stopBeat() {
  if (_beatTimer) { clearInterval(_beatTimer); _beatTimer = null; }
}

function _nameOf(uid, nodeName) {
  return _names[uid] || nodeName || 'A friend';
}

// ── The chip ────────────────────────────────────────────────────────────

function _paintChip() {
  const el = $('#match-race-chip');
  if (!el) return;
  const model = _matchId ? raceChipModel(_lastNode, { myUid: getUid(), now: Date.now() }) : null;
  if (!model) {
    el.classList.add('hidden');
    return;
  }
  const who = _nameOf(model.uid, model.name);
  const progress = model.finished ? 'finished' : `${model.done} of ${model.of}`;
  const others = model.others > 0 ? ` +${model.others}` : '';
  const dot = model.playingNow ? '<span class="match-race-dot"></span>' : '';
  // The text rides its own span so a 20-character name ellipsizes instead
  // of pushing the info bar wide (the bar never wraps).
  el.innerHTML = `${dot}<span class="match-race-chip-text">${escapeHtml(who)} · ${progress}${others}</span>`;
  el.setAttribute('aria-label', model.finished
    ? `${who} has finished the run`
    : `${who} has finished ${model.done} of ${model.of} boards`);
  el.classList.remove('hidden');
}

// ── The between-boards gap lines ────────────────────────────────────────

/**
 * Paint the gap area on the board-complete card: the standing line through
 * the boards both players have banked, then the news line (what landed
 * while this board was played, who is present now). Returns true when
 * anything rendered, so the caller decides visibility the gameoverPlan way.
 */
export function renderMatchGap() {
  const el = $('#gameover-race');
  if (!el) return false;
  if (!_matchId || !_lastNode) { el.classList.add('hidden'); return false; }
  const myUid = getUid();
  const now = Date.now();

  const cmp = gapComparison(_lastNode, { myUid, handicaps: getHandicapRatioMap() });
  const standing = cmp ? gapLineText(cmp, _nameOf(cmp.uid, cmp.name)) : '';

  const events = raceEvents(_baseline, _lastNode, { myUid })
    .map((e) => ({ ...e, name: _nameOf(e.uid, e.name) }));
  const players = (_lastNode.players && typeof _lastNode.players === 'object')
    ? _lastNode.players : {};
  const playingNames = Object.entries(players)
    .filter(([uid, p]) => uid !== myUid && isPresenceFresh(p && p.activeAt, now))
    .map(([uid, p]) => _nameOf(uid, (p && p.name !== 'Player' && p.name) || null));
  const news = gapNewsText(events, playingNames);

  if (!standing && !news) { el.classList.add('hidden'); return false; }
  el.innerHTML = [standing, news].filter(Boolean)
    .map((line) => `<p class="gameover-standing">${escapeHtml(line)}</p>`).join('');
  el.classList.remove('hidden');
  return true;
}

// ── Lifecycle ───────────────────────────────────────────────────────────

/**
 * Start following the active shared match. Idempotent per match: launch,
 * resume, and a board advance can all call it without stacking listeners.
 * A solo run (no node) starts nothing, which is exactly what it shows.
 */
export function startMatchRace() {
  const id = (state.gameMode === 'match' && state.match && !state.isLevelPractice)
    ? state.match.id : null;
  if (!id) { stopMatchRace(); return; }
  if (id === _matchId) { _baseline = _lastNode ? raceBaseline(_lastNode, getUid()) : null; return; }

  stopMatchRace();
  _matchId = id;
  if (!_visibilityBound && typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', _onVisibility);
    _visibilityBound = true;
  }
  _startBeat();
  import('../firebase/firebaseMatch.js').then(async ({ subscribeMatch }) => {
    if (_matchId !== id) return;
    // Join-at-read: the current playerNames entry beats the node's join-time
    // snapshot, the standings panel's own rule. Cached 60s in the
    // leaderboard module, fetched once per race start.
    try {
      const { fetchPlayerNames } = await import('../firebase/firebaseLeaderboard.js');
      _names = (await fetchPlayerNames()) || {};
    } catch { _names = {}; }
    if (_matchId !== id) return;
    _unsub = subscribeMatch(id, (node) => {
      if (!_stillRacing() && !_gapVisible()) { stopMatchRace(); return; }
      _lastNode = node;
      // The first snapshot is the opening baseline: everything already in
      // it happened before this player's board started.
      if (_baseline === null) _baseline = raceBaseline(node, getUid());
      _paintChip();
      if (_gapVisible()) renderMatchGap();
    });
  }).catch((err) => reportCaughtError('match-race-subscribe', err));
}

function _gapVisible() {
  const el = $('#gameover-race');
  return !!el && !el.classList.contains('hidden');
}

/**
 * A new board is starting: snapshot everyone's progress so the next gap
 * card reports only what happened during THIS board.
 */
export function matchRaceBoardStart() {
  startMatchRace();
  if (_matchId && _lastNode) _baseline = raceBaseline(_lastNode, getUid());
  _paintChip();
}

/** Leave the race entirely: the run ended, or the player left the boards. */
export function stopMatchRace() {
  if (_unsub) { _unsub(); _unsub = null; }
  _stopBeat();
  if (_visibilityBound && typeof document !== 'undefined' && document.removeEventListener) {
    document.removeEventListener('visibilitychange', _onVisibility);
    _visibilityBound = false;
  }
  _matchId = null;
  _lastNode = null;
  _baseline = null;
  const chip = $('#match-race-chip');
  if (chip) chip.classList.add('hidden');
}
