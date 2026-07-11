// ── Leaderboard modal (scope × view) ──────────────────
// Extracted from main.js (2026-07-10 split). One module owns the whole
// modal: Daily/Weekly SCOPE pill-toggle crossed with the Scores /
// Adjusted (default) / Friends VIEW tabs, Greg's ghost row, the friends
// panel, and the tab wiring. main.js only calls updateLeaderboardDisplay
// when the modal opens.

import { state } from '../state/gameState.js';
import { $, $$, escapeHtml } from './domHelpers.js';
import { spriteImgHTML, uiSpriteImgHTML } from './spriteLoader.js';
import { getLocalDateString, getWeekStart } from '../logic/seededRandom.js';
import {
  isFirebaseOnline, fetchOnlineLeaderboard, fetchWeeklyLeaderboard,
  fetchPlayerNames, resolveDisplayName,
} from '../firebase/firebaseLeaderboard.js';
import { getUid } from '../firebase/firebaseProgress.js';
import { loadDailyLeaderboard } from '../storage/statsStorage.js';
import { loadHandicaps, getRefPar, ratioDisplaySeconds, ratioDisplayPercent } from '../logic/handicaps.js';
import { rankAdjusted, filterToFriends } from '../logic/leaderboardViews.js';
import { computeDailyParForDate, computeWeeklyPar } from '../game/parResolve.js';

const LONG_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function prettyDate(dateStr) {
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const mo = LONG_MONTH_NAMES[parseInt(parts[1], 10) - 1];
  if (!mo) return dateStr;
  return `${mo} ${parseInt(parts[2], 10)}, ${parts[0]}`;
}

// Greg's yesterday note — once per session, computed from the shipped
// modelHistory.json (no network). The voice budget is a hard rule: one
// Greg line on this surface, rendered the first time the modal opens.
let _gregNoteRendered = false;
async function _renderGregYesterdayNote() {
  if (_gregNoteRendered) return;
  _gregNoteRendered = true;
  try {
    const el = $('#greg-yesterday-note');
    if (!el) return;
    const [{ yesterdayNote }, historyRes] = await Promise.all([
      import('../logic/gregVoice.js'),
      fetch('./src/logic/modelHistory.json').then(r => (r.ok ? r.json() : null)),
    ]);
    const note = yesterdayNote(historyRes);
    if (note) {
      el.textContent = note;
      el.classList.remove('hidden');
    }
  } catch { /* no note — the leaderboard renders fine without it */ }
}

// Rank cell: the four drawn medals for the four top ranks (diamond,
// gold, silver, bronze - the achievement-tier order), numbers below.
// Exported: the Stats modal's weekly panel speaks the same rank language.
export const RANK_MEDALS = ['medalDiamond', 'medalGold', 'medalSilver', 'medalBronze'];
function _rankCell(i) {
  if (i < RANK_MEDALS.length) {
    return `<td class="lb-rank-cell">${spriteImgHTML(RANK_MEDALS[i], 'sprite-rank', `#${i + 1}`)}</td>`;
  }
  return `<td>${i + 1}</td>`;
}

// Scrollable name cell: long names scroll horizontally instead of
// truncating, so the full name is always reachable.
function _nameCell(name) {
  return `<td class="lb-name-cell"><span class="lb-name">${escapeHtml(name)}</span></td>`;
}

// Greg's ghost row: the par rendered as a competitor at its sorted
// position. Non-interactive, dashed border, NO rank number, so humans
// keep their ranks and Greg just shows where his time would land.
// Rendered in the daily and weekly scores tables, Friends view
// included (Greg is everyone's rival). Callers supply the cells after
// the Time column because the two tables differ there.
function _gregGhostRow(par, trailingCells) {
  const tr = document.createElement('tr');
  tr.className = 'greg-row';
  tr.title = "Greg's time is the model's par for this board";
  tr.innerHTML = `<td class="lb-rank-cell">${spriteImgHTML('smiley', 'sprite-greg-row', 'Greg')}</td>`
    + _nameCell('Greg') + `<td>${par.toFixed(1)}s</td>` + trailingCells;
  return tr;
}

// Par-delta cell, shared by daily/weekly/friends tables.
function _parDeltaCell(time, par) {
  if (!(par > 0)) return '<td>-</td>';
  const delta = time - par;
  const abs = Math.abs(delta).toFixed(1);
  if (delta < -0.5) return `<td class="par-under">-${abs}</td>`;
  if (delta > 0.5) return `<td class="par-over">+${abs}</td>`;
  return '<td class="par-even">E</td>';
}

async function renderWeeklyLeaderboard(weekStart, friendCtx = null, emptyText = null) {
  const tbody = $('#leaderboard-body');
  tbody.innerHTML = '';
  // Repurpose the table header for weekly: "Best" instead of "Time",
  // "Played" instead of "Par". Restored to the daily defaults if the
  // player switches back to a daily tab via the modal's tab strip.
  const thead = $('#leaderboard-table thead');
  if (thead) {
    thead.innerHTML = '<tr><th>#</th><th>Name</th><th>Best</th><th>Played</th><th>Par</th></tr>';
  }
  let entries = await fetchWeeklyLeaderboard(weekStart);
  const playedCount = entries.length;
  if (friendCtx) entries = filterToFriends(entries, friendCtx.uids, friendCtx.myUid);
  $('#leaderboard-date').textContent = `Week of ${prettyDate(weekStart)}`
    + (playedCount > 0 ? ` · ${playedCount} played` : '');
  const hasEntries = entries.length > 0;
  $('#leaderboard-table').classList.toggle('hidden', !hasEntries);
  $('#leaderboard-empty').textContent = emptyText
    || 'No weekly times yet. Be the first to set one.';
  $('#leaderboard-empty').classList.toggle('hidden', hasEntries);
  if (!hasEntries) return;
  // Weekly columns: Best = fastest across the 7 attempts, Played =
  // attempts used, Par = delta of Best vs the canonical weekly board's
  // par (solved once per session via computeWeeklyPar).
  const weeklyPar = await computeWeeklyPar(weekStart);
  const myUidW = getUid();
  // Greg's ghost row, same contract as the daily table: par-sorted
  // position, ties go to the player, no Played count (he generated the
  // board, he does not get attempts).
  const gregTrailingW = `<td>-</td>${_parDeltaCell(weeklyPar, weeklyPar)}`;
  let gregPlacedW = !(weeklyPar > 0);
  entries.forEach((entry, i) => {
    if (!gregPlacedW && entry.bestTime > weeklyPar) {
      tbody.appendChild(_gregGhostRow(weeklyPar, gregTrailingW));
      gregPlacedW = true;
    }
    const tr = document.createElement('tr');
    if (myUidW && entry.uid === myUidW) tr.classList.add('lb-row-mine');
    const used = entry.attemptsUsed || 0;
    const parCol = _parDeltaCell(entry.bestTime, weeklyPar);
    tr.innerHTML = `${_rankCell(i)}${_nameCell(entry.name)}<td>${entry.bestTime.toFixed(1)}s</td><td>${used}/7</td>${parCol}`;
    tbody.appendChild(tr);
  });
  if (!gregPlacedW) tbody.appendChild(_gregGhostRow(weeklyPar, gregTrailingW));
}

// Pick the default leaderboard tab based on current mode. Player in
// weekly → start on Weekly tab; otherwise Daily.
function _defaultLeaderboardTab() {
  if (state.gameMode === 'weekly' && state.weeklySeed) return 'weekly';
  return 'daily';
}

function _setActiveLeaderboardTab(tab) {
  for (const btn of $$('.leaderboard-tab')) {
    const isActive = btn.dataset.lbTab === tab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  }
}

// Leaderboard state: scope (daily/weekly) x view (scores/adjusted/
// friends). Adjusted is the DEFAULT view and works under both scopes —
// the handicap k is a dimensionless ratio, so weekly best-times divide
// by it the same way daily times do (the fit is daily-anchored, so a
// weekly ranking leans on the ratio generalizing across board sizes).
let _lbScope = 'daily';
let _lbView = 'adjusted';

function _setActiveLeaderboardView(view) {
  for (const btn of $$('.lb-view-tab')) {
    const isActive = btn.dataset.lbView === view;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  }
}

export async function updateLeaderboardDisplay() {
  _lbScope = _defaultLeaderboardTab();
  _renderGregYesterdayNote();
  await renderLeaderboard();
}

async function renderLeaderboard() {
  _setActiveLeaderboardTab(_lbScope);
  _setActiveLeaderboardView(_lbView);
  $('#friends-panel')?.classList.toggle('hidden', _lbView !== 'friends');
  $('#leaderboard-footnote')?.classList.add('hidden');

  if (_lbView === 'friends') { await _renderFriendsView(); return; }
  if (_lbView === 'adjusted') { await _renderAdjustedView(); return; }
  if (_lbScope === 'weekly') { await renderWeeklyLeaderboard(getWeekStart()); return; }
  await _renderDailyScores();
}

// Fetch today's rows: online first (rows carry uid), local fallback.
async function _fetchDailyEntries(dateStr) {
  let entries = null;
  if (isFirebaseOnline()) {
    entries = await fetchOnlineLeaderboard(dateStr);
  }
  if (entries === null) {
    entries = loadDailyLeaderboard(dateStr);
  }
  return entries || [];
}

// The raw daily table. filterSet (Set of uids) narrows to friends ∪ me
// for the Friends view; emptyText overrides the no-rows message there.
async function _renderDailyScores(friendCtx = null, emptyText = null) {
  const thead = $('#leaderboard-table thead');
  if (thead) {
    thead.innerHTML = friendCtx
      ? '<tr><th>#</th><th>Name</th><th>Time</th><th>Par</th><th>Adjusted</th></tr>'
      : '<tr><th>#</th><th>Name</th><th>Time</th><th>Par</th></tr>';
  }
  const today = getLocalDateString();
  const dateStr = today;
  const tbody = $('#leaderboard-body');
  tbody.innerHTML = '';

  let entries = await _fetchDailyEntries(dateStr);
  const playedCount = entries.length;
  if (friendCtx) entries = filterToFriends(entries, friendCtx.uids, friendCtx.myUid);

  $('#leaderboard-date').textContent = prettyDate(today)
    + (playedCount > 0 ? ` · ${playedCount} played` : '');

  const hasEntries = entries.length > 0;
  $('#leaderboard-table').classList.toggle('hidden', !hasEntries);
  $('#leaderboard-empty').textContent = emptyText
    || 'No times yet today. Be the first to finish it.';
  $('#leaderboard-empty').classList.toggle('hidden', hasEntries);
  if (!hasEntries) return;

  // Daily par (shared with the title-card par badge). The friends view
  // also shows each row's handicap-adjusted time.
  const { par: dailyPar } = await computeDailyParForDate(dateStr);
  const handicapMap = friendCtx ? await loadHandicaps() : null;

  const myUid = getUid();
  // Greg rides the table at his par-sorted position. Ties go to the
  // player: Greg only slots in once a time is strictly slower.
  const gregTrailing = _parDeltaCell(dailyPar, dailyPar)
    + (friendCtx ? '<td class="lb-adjusted">-</td>' : '');
  let gregPlaced = !(dailyPar > 0);
  entries.forEach((entry, i) => {
    if (!gregPlaced && entry.time > dailyPar) {
      tbody.appendChild(_gregGhostRow(dailyPar, gregTrailing));
      gregPlaced = true;
    }
    const tr = document.createElement('tr');
    if (myUid && entry.uid === myUid) tr.classList.add('lb-row-mine');
    const parCol = _parDeltaCell(entry.time, dailyPar);
    let adjCol = '';
    if (friendCtx) {
      const [r] = rankAdjusted([entry], handicapMap || {});
      adjCol = r.rated
        ? `<td class="lb-adjusted">${r.adjusted.toFixed(1)}s</td>`
        : '<td class="lb-adjusted">-</td>';
    }
    tr.innerHTML = `${_rankCell(i)}${_nameCell(entry.name)}<td>${entry.time}s</td>${parCol}${adjCol}`;
    tbody.appendChild(tr);
  });
  if (!gregPlaced) tbody.appendChild(_gregGhostRow(dailyPar, gregTrailing));
}

// Handicap-adjusted view (the modal's default): time / fitted ratio,
// ranked. Uses the SHIPPED handicaps.json (public, identical for every
// viewer); players not in the fit (under 5 plays) rank by raw time with
// an unrated tag. Scope-aware: daily ranks today's times, weekly ranks
// the week's best times by the same dimensionless ratio.
async function _renderAdjustedView() {
  const isWeekly = _lbScope === 'weekly';
  const thead = $('#leaderboard-table thead');
  if (thead) {
    thead.innerHTML = '<tr><th>#</th><th>Name</th><th>HC</th><th>Adjusted</th></tr>';
  }
  const today = getLocalDateString();
  const weekStart = getWeekStart();
  $('#leaderboard-date').textContent = isWeekly
    ? `Week of ${prettyDate(weekStart)}` : prettyDate(today);
  const tbody = $('#leaderboard-body');
  tbody.innerHTML = '';

  if (!isFirebaseOnline()) {
    $('#leaderboard-table').classList.add('hidden');
    $('#leaderboard-empty').textContent = 'The adjusted board needs a connection.';
    $('#leaderboard-empty').classList.remove('hidden');
    return;
  }

  const [entries, handicapMap] = await Promise.all([
    isWeekly
      ? fetchWeeklyLeaderboard(weekStart).then(rows =>
          (rows || []).map(r => ({ uid: r.uid, name: r.name, time: r.bestTime })))
      : fetchOnlineLeaderboard(today).then(e => e || []),
    loadHandicaps(),
  ]);
  const ranked = rankAdjusted(entries, handicapMap || new Map());

  const hasEntries = ranked.length > 0;
  $('#leaderboard-table').classList.toggle('hidden', !hasEntries);
  $('#leaderboard-empty').textContent = isWeekly
    ? 'No weekly times yet. Be the first to set one.'
    : 'No times yet today. Be the first to finish it.';
  $('#leaderboard-empty').classList.toggle('hidden', hasEntries);

  const myUid = getUid();
  const refPar = getRefPar();
  ranked.forEach((entry, i) => {
    const tr = document.createElement('tr');
    if (myUid && entry.uid === myUid) tr.classList.add('lb-row-mine');
    // HC chip: the ratio shown as a RATING vs Greg — a stable seconds magnitude
    // (at a standard board) AND a percent. POSITIVE = faster/better than Greg
    // (k < 1), negative = slower (k > 1).
    let hcChip;
    if (entry.rated) {
      const secs = ratioDisplaySeconds(entry.ratio, refPar);
      const pct = ratioDisplayPercent(entry.ratio);
      const sign = secs >= 0 ? '+' : '−';
      hcChip = `<span class="lb-hc-chip">${sign}${Math.abs(secs).toFixed(0)}s · ${sign}${Math.abs(pct).toFixed(0)}%</span>`;
    } else {
      hcChip = '<span class="lb-hc-chip lb-hc-unrated">unrated</span>';
    }
    tr.innerHTML = `${_rankCell(i)}${_nameCell(entry.name)}`
      + `<td>${hcChip}</td><td class="lb-adjusted">${entry.adjusted.toFixed(1)}s</td>`;
    tbody.appendChild(tr);
  });

  const foot = $('#leaderboard-footnote');
  if (foot) {
    foot.textContent = 'Adjusted = your time at Greg’s pace · HC = typical vs Greg (+ faster / − slower) · rated after 5 plays';
    foot.classList.remove('hidden');
  }
}

// ── Friends view ─────────────────────────────────────
// Panel (code + add + list) above a scores table filtered to
// friends ∪ me for the current scope. All I/O via firebaseFriends.js
// (lazy import — modal-only module).
let _friendsCodeTimer = null;

function _friendsStatus(msg, isError = false) {
  const el = $('#friends-status');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('friends-status-error', isError);
  el.classList.toggle('hidden', !msg);
}

function _startCodeCountdown(createdAtLocal) {
  if (_friendsCodeTimer) { clearInterval(_friendsCodeTimer); _friendsCodeTimer = null; }
  const el = $('#friends-code-expiry');
  if (!el) return;
  const tick = async () => {
    const { codeMsRemaining } = await import('../logic/friendCodes.js');
    const ms = codeMsRemaining(createdAtLocal, Date.now());
    if (ms <= 0) {
      clearInterval(_friendsCodeTimer);
      _friendsCodeTimer = null;
      el.textContent = 'Code expired — get a new one.';
      $('#friends-my-code').textContent = '······';
      $('#friends-new-code').textContent = 'Get code';
      return;
    }
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    el.textContent = `expires in ${m}:${String(s).padStart(2, '0')}`;
  };
  tick();
  _friendsCodeTimer = setInterval(tick, 1000);
}

async function _renderFriendsView() {
  const friends = await import('../firebase/firebaseFriends.js');

  // Code block: re-show a still-fresh cached code with its countdown.
  const cached = friends.getCachedCode();
  $('#friends-my-code').textContent = cached ? cached.code : '······';
  $('#friends-new-code').textContent = cached ? 'New code' : 'Get code';
  if (cached) _startCodeCountdown(cached.createdAtLocal);
  else $('#friends-code-expiry').textContent = '';

  // Friends list.
  const listEl = $('#friends-list');
  listEl.innerHTML = '';
  const list = await friends.fetchFriends();
  if (list === null) {
    listEl.innerHTML = '<p class="friends-empty">Friends need a connection.</p>';
  } else if (list.length === 0) {
    listEl.innerHTML = '<p class="friends-empty">No friends yet — share your code or paste theirs.</p>';
  } else {
    // Show each friend's LIVE name (playerNames join by uid), not the copy
    // frozen into the friend entry when they were added — so a friend who
    // renamed shows their new name here too.
    const names = await fetchPlayerNames();
    for (const f of list) {
      const row = document.createElement('div');
      row.className = 'friends-row';
      row.innerHTML = `<span class="friends-row-name">${escapeHtml(resolveDisplayName(f.uid, f.name, names))}</span>`
        + `<button class="friends-remove" data-friend-uid="${escapeHtml(f.uid)}" title="Remove friend" aria-label="Remove friend">${uiSpriteImgHTML('uiClose', 'ui-icon')}</button>`;
      listEl.appendChild(row);
    }
  }

  // Scores table filtered to friends ∪ me (via the tested
  // filterToFriends), current scope.
  const friendCtx = { uids: (list || []).map(f => f.uid), myUid: getUid() };
  if (_lbScope === 'weekly') {
    await renderWeeklyLeaderboard(getWeekStart(), friendCtx,
      'None of your friends set a weekly time yet.');
  } else {
    await _renderDailyScores(friendCtx,
      'None of your friends finished today’s board yet.');
  }
}

// ── Wiring (bound once at module load, like the rest of the UI) ──────

// Leaderboard scope (Daily/Weekly) and view (Scores/Adjusted/Friends)
// clicks re-render the body without closing the modal. Every view works
// under both scopes; the view sticks across scope flips.
for (const tabBtn of $$('.leaderboard-tab')) {
  tabBtn.addEventListener('click', () => {
    const tab = tabBtn.dataset.lbTab;
    if (!tab) return;
    _lbScope = tab;
    renderLeaderboard();
  });
}
for (const viewBtn of $$('.lb-view-tab')) {
  viewBtn.addEventListener('click', () => {
    const view = viewBtn.dataset.lbView;
    if (!view || viewBtn.disabled) return;
    _lbView = view;
    renderLeaderboard();
  });
}

// Friends panel actions. Handlers are wired once; all state is read at
// click time via the lazy firebaseFriends module.
$('#friends-new-code')?.addEventListener('click', async () => {
  _friendsStatus('');
  try {
    const friends = await import('../firebase/firebaseFriends.js');
    const entry = $('#friends-my-code').textContent.includes('·')
      ? await friends.createFriendCode()
      : await friends.regenerateFriendCode();
    $('#friends-my-code').textContent = entry.code;
    $('#friends-new-code').textContent = 'New code';
    _startCodeCountdown(entry.createdAtLocal);
  } catch (err) {
    _friendsStatus(err && err.message === 'offline'
      ? 'Codes need a connection.' : 'Could not get a code — try again.', true);
  }
});
$('#friends-add-btn')?.addEventListener('click', async () => {
  const input = $('#friends-code-input');
  _friendsStatus('');
  try {
    const friends = await import('../firebase/firebaseFriends.js');
    const added = await friends.redeemFriendCode(input.value);
    input.value = '';
    _friendsStatus(`You and ${added.name} are now friends.`);
    await _renderFriendsView();
  } catch (err) {
    const msgs = {
      invalid: 'That does not look like a code (6 letters and numbers).',
      expired: 'Code expired or not found — ask for a fresh one.',
      self: 'That is your own code.',
      offline: 'Adding friends needs a connection.',
    };
    _friendsStatus(msgs[err && err.reason] || 'Could not add — try again.', true);
  }
});
// Remove buttons are created per-render: delegate. First tap arms the
// button ("Sure?"), second tap removes — both sides unlink.
$('#friends-list')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('.friends-remove');
  if (!btn) return;
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = 'Sure?';
    setTimeout(() => { btn.dataset.armed = ''; btn.textContent = '✕'; }, 2500);
    return;
  }
  try {
    const friends = await import('../firebase/firebaseFriends.js');
    await friends.removeFriend(btn.dataset.friendUid);
    _friendsStatus('Removed.');
    await _renderFriendsView();
  } catch {
    _friendsStatus('Could not remove — try again.', true);
  }
});
