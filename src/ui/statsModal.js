// ── Stats modal (per-mode tabs + owner Model tab) ─────
// Extracted from main.js (2026-07-10 split). Owns the Challenge / Quick
// Play / Daily / Weekly panels, the owner-only Model tab, and the tab
// wiring. main.js only calls updateStatsDisplay when the modal opens.
// The heavy chart/stats renderers stay lazy-imported so they never touch
// the boot path.

import { state } from '../state/gameState.js';
import { $, $$, escapeHtml } from './domHelpers.js';
import { spriteImgHTML } from './spriteLoader.js';
import { getLocalDateString, getWeekStart } from '../logic/seededRandom.js';
import {
  isFirebaseOnline, fetchWeeklyLeaderboard, fetchUserDailyHistory,
  fetchAllDailyMeta, fetchAllDailyScores,
} from '../firebase/firebaseLeaderboard.js';
import { getUid } from '../firebase/firebaseProgress.js';
import { loadStats, statsForMode, getModeKey } from '../storage/statsStorage.js';
import {
  loadHandicaps, getHandicapRatio, getHandicapDetails, isRatedHandicap,
  getRefPar, estimateHandicapDetails,
} from '../logic/handicaps.js';
import { predictPar } from '../logic/dailyFeatures.js';
import { waitForUid } from '../game/startupGate.js';
import { prettyDate, RANK_MEDALS } from './leaderboardModal.js';
import { tilingLabel, CLASSIC_SHAPE_LABEL } from '../logic/coastlineLink.js';
import { getGimmickDefs } from '../logic/gimmicks.js';
import { reportCaughtError } from '../diagnostics/errorReporter.js';

// Owner-only Model tab. Renders the per-refit timeline (RMSE, bias,
// candidate CVs) from src/logic/modelHistory.json. Tab button is hidden
// at boot in index.html and only unhidden when getUid() === OWNER_UID,
// so other players never see the tab. The JSON file itself ships with
// the rest of the static assets, privacy-by-obscurity, not Firebase
// rules. Worth revisiting if the user base grows past ~10.
const OWNER_UID = '5Ht9d2io0ugU1NGsjdJmZvkJi382';
const MODEL_HISTORY_PATH = './src/logic/modelHistory.json';

// Default tab = the mode the player most recently played (when meaningful).
// The tab ids ARE the modeStats key space (the panel is `stats-panel-${tab}`),
// so this asks getModeKey rather than restating the normal -> challenge
// mapping a third time.
const STATS_TABS = new Set(['challenge', 'match', 'weekly', 'daily']);
function pickDefaultStatsTab() {
  const key = getModeKey(state.gameMode);
  return STATS_TABS.has(key) ? key : 'daily';
}

function setActiveStatsTab(tab) {
  for (const btn of $$('.stats-tab')) {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  }
  for (const panel of $$('.stats-panel')) {
    panel.classList.toggle('hidden', panel.id !== `stats-panel-${tab}`);
  }
}

export async function updateStatsDisplay() {
  setActiveStatsTab(pickDefaultStatsTab());
  populateChallengePanel();
  populateMatchPanel();
  populateWeeklyPanel();

  // Resolve uid + populate Model tab in parallel with the daily panel,
  // the auth wait shouldn't gate the visible part of the modal.
  await Promise.all([
    populateDailyPanel(),
    (async () => {
      const uid = await waitForUid();
      const isOwner = uid === OWNER_UID;
      $('#stats-tab-model').classList.toggle('hidden', !isOwner);
      if (isOwner) await populateModelPanel();
    })(),
  ]);
}

// Populate the Weekly stats tab. Pulls the player's row from
// weekly/{currentWeek}/{uid} (via fetchWeeklyLeaderboard's uid filter)
// and renders headline cards + the 7-day line chart. Fire-and-forget
// from updateStatsDisplay so it doesn't block the visible daily panel.
async function populateWeeklyPanel() {
  const weekStart = getWeekStart();
  const bestEl = $('#stat-weekly-best');
  const attemptsEl = $('#stat-weekly-attempts');
  const rankEl = $('#stat-weekly-rank');
  const chartEl = $('#chart-weekly-history');
  const pastEl = $('#stat-weekly-past');
  const pastEmptyEl = $('#stat-weekly-past-empty');
  if (!bestEl || !chartEl) return;

  // Defaults so the cards never render '--' forever on cold-load.
  bestEl.textContent = '--';
  attemptsEl.textContent = '0/7';
  rankEl.textContent = '--';

  if (!isFirebaseOnline()) {
    chartEl.innerHTML = '<div class="chart-empty">Online play required for weekly stats.</div>';
    return;
  }

  try {
    const entries = await fetchWeeklyLeaderboard(weekStart);
    const uid = getUid();
    const myRow = uid ? entries.find(e => e.uid === uid) : null;

    if (myRow) {
      bestEl.textContent = myRow.bestTime.toFixed(1) + 's';
      attemptsEl.textContent = (myRow.attemptsUsed || 0) + '/7';
      const rank = entries.indexOf(myRow) + 1;
      // Medal for the four top ranks, the leaderboard's rank language.
      rankEl.innerHTML = rank <= RANK_MEDALS.length
        ? `${spriteImgHTML(RANK_MEDALS[rank - 1], 'sprite-rank', `#${rank}`)} of ${entries.length}`
        : `#${rank} of ${entries.length}`;
    } else {
      bestEl.textContent = '--';
      attemptsEl.textContent = '0/7';
      rankEl.textContent = entries.length > 0 ? `unranked of ${entries.length}` : '--';
    }

    // Render the 7-day chart via the lazy-loaded charts module.
    const { lineChart } = await import('./charts.js');
    const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const points = [];
    if (myRow && myRow.dayTimes) {
      for (let d = 0; d < 7; d++) {
        const t = myRow.dayTimes[d];
        if (typeof t === 'number') {
          points.push({ x: DAY_LABELS[d], y: t, label: `${DAY_LABELS[d]}: ${t.toFixed(1)}s` });
        }
      }
    }
    chartEl.innerHTML = '';
    if (points.length === 0) {
      chartEl.innerHTML = '<div class="chart-empty">No attempts yet this week.</div>';
    } else {
      const bestVal = myRow.bestTime;
      const svg = lineChart(points, {
        ariaLabel: 'Weekly puzzle times Mon to Sun',
        yFormat: v => v.toFixed(0) + 's',
        dotClassForValue: v => Math.abs(v - bestVal) < 0.05 ? 'chart-dot-good' : 'chart-dot-even',
        lineClass: 'chart-line',
      });
      chartEl.appendChild(svg);
    }

    // Past weeks table, last 4 finished weeks before this one, in the
    // leaderboard's row language with medal cells for top-4 finishes.
    if (pastEl && pastEmptyEl) {
      const past = await collectPastWeeklyBests(uid, 4);
      const tbody = pastEl.querySelector('tbody');
      tbody.innerHTML = '';
      if (past.length === 0) {
        pastEl.classList.add('hidden');
        pastEmptyEl.textContent = 'No past weekly attempts yet.';
        pastEmptyEl.classList.remove('hidden');
      } else {
        pastEl.classList.remove('hidden');
        pastEmptyEl.classList.add('hidden');
        for (const pw of past) {
          const tr = document.createElement('tr');
          const rankCell = (pw.rank && pw.rank <= RANK_MEDALS.length)
            ? `<td class="lb-rank-cell">${spriteImgHTML(RANK_MEDALS[pw.rank - 1], 'sprite-rank', `#${pw.rank}`)} of ${pw.fieldSize}</td>`
            : `<td>${pw.rank ? `#${pw.rank} of ${pw.fieldSize}` : '-'}</td>`;
          tr.innerHTML = `<td>${prettyDate(pw.weekStart)}</td><td>${pw.bestTime.toFixed(1)}s</td><td>${pw.attemptsUsed}/7</td>${rankCell}`;
          tbody.appendChild(tr);
        }
      }
    }
  } catch (err) {
    console.warn('weekly panel populate failed:', err.message);
  }
}

async function collectPastWeeklyBests(uid, count) {
  if (!uid) return [];
  // Build the list of weekStart strings first, then fetch all weeks in
  // parallel. Each fetchWeeklyLeaderboard is independent, running them
  // sequentially burns ~4 round-trips on the network for the 4-week
  // case. Promise.all cuts that to ~1 round-trip's worth of latency.
  const today = new Date(`${getLocalDateString()}T00:00:00-05:00`);
  const start = new Date(today);
  const dayBefore = (start.getUTCDay() + 6) % 7; // 0=Mon
  start.setUTCDate(start.getUTCDate() - dayBefore - 7); // last week's Monday
  const weekStarts = [];
  for (let i = 0; i < count; i++) {
    const yy = start.getUTCFullYear();
    const mm = String(start.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(start.getUTCDate()).padStart(2, '0');
    weekStarts.push(`${yy}-${mm}-${dd}`);
    start.setUTCDate(start.getUTCDate() - 7);
  }
  const settled = await Promise.allSettled(weekStarts.map(w => fetchWeeklyLeaderboard(w)));
  const out = [];
  for (let i = 0; i < weekStarts.length; i++) {
    const r = settled[i];
    if (r.status !== 'fulfilled') continue;
    const rows = r.value || [];
    const row = rows.find(e => e.uid === uid);
    if (row) {
      out.push({
        weekStart: weekStarts[i],
        bestTime: row.bestTime,
        attemptsUsed: row.attemptsUsed || 0,
        rank: rows.indexOf(row) + 1,
        fieldSize: rows.length,
      });
    }
  }
  return out;
}

// Short month-day label for chart x-axis ticks. Stats tab elsewhere has
// its own copy in statsRenderer.js; duplicating the 5-line helper here
// keeps the lazy-loaded charts.js the only thing this module pulls from
// the stats stack.
const SHORT_MONTHS_M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDateModel(dateStr) {
  const parts = String(dateStr || '').split('-');
  if (parts.length !== 3) return dateStr || '';
  return `${SHORT_MONTHS_M[parseInt(parts[1], 10) - 1] || parts[1]} ${parseInt(parts[2], 10)}`;
}

function clearChartContainer(id) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = '';
  return el;
}

function renderChartEmpty(id, message) {
  const el = clearChartContainer(id);
  if (!el) return;
  const d = document.createElement('div');
  d.className = 'chart-empty';
  d.textContent = message;
  el.appendChild(d);
}

// Populate the owner-only Model tab. Skipped entirely for non-owner
// uids (gated in updateStatsDisplay), non-owners never even fetch
// modelHistory.json.
async function populateModelPanel() {
  // Reset to placeholders while fetching, in case a previous open's
  // values are still in the DOM and this fetch fails.
  $('#stat-model-date').textContent = '…';
  $('#stat-model-n').textContent = '…';
  $('#stat-model-rmse').textContent = '…';
  $('#stat-model-bias').textContent = '…';
  $('#stat-model-target-line').textContent = 'Loading…';
  $('#stat-model-history-table').textContent = '…';
  $('#stat-model-cv-table').textContent = '…';
  renderChartEmpty('chart-model-rmse-bias', 'Loading…');
  renderChartEmpty('chart-model-n', 'Loading…');

  let history;
  try {
    const r = await fetch(MODEL_HISTORY_PATH, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`fetch failed: HTTP ${r.status}`);
    history = await r.json();
    if (!Array.isArray(history)) throw new Error('not an array');
  } catch (err) {
    $('#stat-model-target-line').textContent = `Failed to load model history: ${err.message}`;
    renderChartEmpty('chart-model-rmse-bias', 'Failed to load.');
    renderChartEmpty('chart-model-n', 'Failed to load.');
    return;
  }

  if (history.length === 0) {
    const msg = 'No fits yet. The first row lands after the next refit run.';
    $('#stat-model-target-line').textContent = msg;
    $('#stat-model-history-table').textContent = '(empty)';
    $('#stat-model-cv-table').textContent = '(empty)';
    renderChartEmpty('chart-model-rmse-bias', msg);
    renderChartEmpty('chart-model-n', msg);
    return;
  }

  const latest = history[history.length - 1];
  const recent = history.slice(-14);

  const fmtRmse = v => (v == null) ? 'NA' : `${v.toFixed(2)}s`;
  const fmtBias = v => (v == null) ? 'NA' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}s`;

  $('#stat-model-date').textContent = latest.date || '--';
  $('#stat-model-n').textContent = `${latest.n_scores ?? '?'} · ${latest.n_players ?? '?'}`;
  $('#stat-model-rmse').textContent = fmtRmse(latest.rmse);
  $('#stat-model-bias').textContent = fmtBias(latest.bias);
  $('#stat-model-target-line').textContent =
    `Target: ${latest.target || '-'} · Method: ${latest.method || '?'} · Total fits: ${history.length}`;

  // ── Charts ────────────────────────────────────────────
  // Lazy-import so the chart toolkit only comes in when the owner
  // actually opens the Model tab, matching how other Stats charts load.
  const { lineChart } = await import('./charts.js');

  const rmsePoints = recent
    .filter(r => r.rmse != null && Number.isFinite(r.rmse))
    .map(r => ({
      x: shortDateModel(r.date),
      y: r.rmse,
      label: `${r.date}: RMSE ${r.rmse.toFixed(2)}s`,
    }));
  const biasPoints = recent
    .filter(r => r.bias != null && Number.isFinite(r.bias))
    .map(r => ({
      x: shortDateModel(r.date),
      y: r.bias,
      label: `${r.date}: bias ${r.bias >= 0 ? '+' : ''}${r.bias.toFixed(2)}s`,
    }));
  const rmseChartEl = clearChartContainer('chart-model-rmse-bias');
  if (rmseChartEl) {
    if (rmsePoints.length === 0 && biasPoints.length === 0) {
      renderChartEmpty('chart-model-rmse-bias', 'No RMSE data yet.');
    } else {
      rmseChartEl.appendChild(lineChart(rmsePoints, {
        ariaLabel: 'RMSE (solid) and bias (dashed) per refit',
        thresholdLine: 0,
        yFormat: v => (v > 0 ? '+' : '') + (Math.round(v * 10) / 10) + 's',
        secondary: biasPoints,
      }));
    }
  }

  const nPoints = recent
    .filter(r => r.n_scores != null && Number.isFinite(r.n_scores))
    .map(r => ({
      x: shortDateModel(r.date),
      y: r.n_scores,
      label: `${r.date}: N=${r.n_scores}, ${r.n_players ?? '?'} players`,
    }));
  const nChartEl = clearChartContainer('chart-model-n');
  if (nChartEl) {
    if (nPoints.length === 0) {
      renderChartEmpty('chart-model-n', 'No N data yet.');
    } else {
      nChartEl.appendChild(lineChart(nPoints, {
        ariaLabel: 'Total scores per refit',
        yFormat: v => String(Math.round(v)),
      }));
    }
  }

  // ── Tables ────────────────────────────────────────────
  // History trend table, monospace so columns line up.
  const headerLine  = 'date         meth   N    RMSE     bias      target';
  const dividerLine = '----         ----   --   ----     ----      ------';
  const dataLines = recent.map(r => {
    const meth = (r.method || '?').slice(0, 4);
    return (
      (r.date || '').padEnd(12) + ' ' +
      meth.padEnd(6) + ' ' +
      String(r.n_scores ?? '?').padStart(3) + '  ' +
      fmtRmse(r.rmse).padStart(7) + '  ' +
      fmtBias(r.bias).padStart(8) + '  ' +
      (r.target || '-')
    );
  });
  $('#stat-model-history-table').textContent =
    [headerLine, dividerLine, ...dataLines].join('\n');

  // Candidate CVs from the latest fit. seed-residuals fallback rows have
  // no posterior, so candidates is an empty array, show that explicitly
  // rather than a blank table.
  if (Array.isArray(latest.candidates) && latest.candidates.length > 0) {
    const cvLines = ['feature                    mean       sd        cv'];
    latest.candidates.slice(0, 8).forEach(c => {
      cvLines.push(
        (c.feature || '').padEnd(26) + ' ' +
        (c.mean != null ? c.mean.toFixed(3) : '   -  ').padStart(8) + '  ' +
        (c.sd   != null ? c.sd.toFixed(3)   : '   -  ').padStart(8) + '  ' +
        (c.cv   != null ? c.cv.toFixed(3)   : '   -  ').padStart(8)
      );
    });
    $('#stat-model-cv-table').textContent = cvLines.join('\n');
  } else {
    $('#stat-model-cv-table').textContent =
      '(seed-residuals fallback, no posterior this refit)';
  }
}

function populateChallengePanel() {
  const stats = loadStats();
  // statsForMode owns the gameMode → modeStats key mapping ('normal' lives
  // under 'challenge'). The old literal `modeStats?.normal` was always
  // undefined, so this panel silently showed the ALL-MODES aggregate,
  // every daily/weekly/match/chaos game inflated "Played" and the win rate
  // (2026-07-10 audit). The `|| stats` fallback survives only for a
  // pre-modeStats legacy save.
  const cm = statsForMode(stats, 'normal') || stats;
  $('#stat-challenge-played').textContent = cm.totalGames ?? stats.totalGames ?? 0;
  const total = cm.totalGames ?? stats.totalGames ?? 0;
  const wins = cm.wins ?? stats.wins ?? 0;
  const rate = total > 0 ? Math.round((wins / total) * 100) : 0;
  $('#stat-challenge-win-rate').textContent = `${rate}%`;
  $('#stat-challenge-max-level').textContent = cm.maxLevelReached ?? stats.maxLevelReached ?? 1;
  $('#stat-challenge-checkpoint').textContent = state.checkpoint || 1;
  const bestKey = `level${state.currentLevel}`;
  const best = (cm.bestTimes || stats.bestTimes || {})[bestKey];
  $('#stat-challenge-best-time').textContent = best != null ? `${best}s` : '--';

  const chart = $('#stat-challenge-recent');
  if (!chart) return;
  chart.innerHTML = '';
  const recent = (cm.recentGames || stats.recentGames || []).slice(-20);
  if (recent.length === 0) {
    chart.innerHTML = '<span class="chart-empty">Play a few Climb levels to see your history!</span>';
    return;
  }
  const winTimes = recent.filter(g => g.won).map(g => g.time);
  const maxTime = winTimes.length > 0 ? Math.max(...winTimes, 30) : 30;
  for (const game of recent) {
    const bar = document.createElement('div');
    bar.className = `game-bar ${game.won ? 'win' : 'loss'}`;
    if (game.won) {
      const pct = Math.max(15, 100 - (game.time / maxTime) * 70);
      bar.style.height = `${pct}%`;
      bar.title = `Win: ${game.time}s (Level ${game.level || '?'})`;
    } else {
      bar.style.height = '30%';
      bar.title = 'Loss';
    }
    chart.appendChild(bar);
  }
}

// The Challenge head-to-head record: win rate over boards somebody else also
// played, adjusted and raw, plus what the player is best at.
//
// Every decision lives in the pure logic/matchRecord.js; this fetches, paints
// and says when there is not enough yet to say anything. Splits are withheld
// below MIN_SPLIT_BOARDS because one contested board reading "100% on Kites"
// is a claim the data cannot support, and every row it does show carries its
// own sample beside the percentage.
const MIN_SPLIT_BOARDS = 3;

async function _renderMatchHeadToHead() {
  const el = $('#stat-match-h2h');
  if (!el) return;
  el.innerHTML = '<p class="stats-blurb">Looking up your runs…</p>';

  let nodes = null;
  try {
    const [{ fetchMyMatches }, { matchRecord, rivalries, rankedSplits }, { getHandicapRatioMap }] =
      await Promise.all([
        import('../firebase/firebaseMatch.js'),
        import('../logic/matchRecord.js'),
        import('../logic/handicaps.js'),
      ]);
    const rows = await fetchMyMatches(30);
    if (!rows) {
      el.innerHTML = '<p class="stats-blurb">Could not reach your runs right now.</p>';
      return;
    }
    nodes = rows.map((r) => r.node);
    const rec = matchRecord(nodes, { myUid: getUid(), handicaps: getHandicapRatioMap() });

    if (rec.contested === 0) {
      el.innerHTML = `<p class="stats-blurb">${rec.boardsPlayed > 0
        ? 'Nobody has raced you yet. Send a friend a code and these fill in.'
        : 'Play a Challenge against a friend and your record shows up here.'}</p>`;
      return;
    }

    // Rivalries, not percentages (his call 2026-08-16: "X out of X seems a
    // little disingenuine"): with two to four real rivals, a rate over a
    // dozen boards claims a stability the sample cannot back, while "7-5
    // against MJP, usually 6s ahead" is a plain fact. Counts everywhere; the
    // margin is the median adjusted gap so one blown board cannot move it.
    const riv = rivalries(nodes, { myUid: getUid(), handicaps: getHandicapRatioMap() });
    // Rival names resolve join-at-read, the leaderboard's own rule: the
    // CURRENT playerNames entry for the uid beats whatever name the match
    // node snapshotted at join time, and the stored 'Player' sentinel never
    // reaches here at all (matchRecord reads it as absent). Only a player
    // unnamed to this day falls back to the literal.
    let names = {};
    try {
      const { fetchPlayerNames } = await import('../firebase/firebaseLeaderboard.js');
      names = (await fetchPlayerNames()) || {};
    } catch { /* node names still label the rows */ }
    const rivalName = (r) => names[r.uid] || r.name || 'Player';
    const marginPhrase = (m) => {
      if (m == null || Math.abs(m) < 0.5) return '<span class="stat-riv-even">too close to call</span>';
      const amount = Math.abs(m) < 10 ? `${Math.abs(m).toFixed(1)}s` : `${Math.round(Math.abs(m))}s`;
      return m < 0
        ? `<span class="stat-riv-ahead">usually ${amount} ahead</span>`
        : `<span class="stat-riv-behind">usually ${amount} behind</span>`;
    };
    const rivalRow = (label, r, me) => `<div class="stat-riv-row${me ? ' stat-riv-field' : ''}">
        <span class="stat-riv-name">${escapeHtml(label)}</span>
        <span class="stat-riv-tally">${r.won}-${r.lost}${r.ties ? ` (${r.ties} tied)` : ''}</span>
        ${marginPhrase(r.medianMargin)}
      </div>`;
    const rivalRows = [rivalRow('vs anyone', riv.field, true),
      ...riv.rivals.slice(0, 4).map((r) => rivalRow(`vs ${rivalName(r)}`, r, false))].join('');
    const more = riv.rivals.length > 4
      ? `<p class="friends-code-hint">and ${riv.rivals.length - 4} more you have raced less.</p>` : '';

    const shapes = rankedSplits(rec.splits.shape, { minContested: MIN_SPLIT_BOARDS });
    const shapeLabel = (n) => (n === 'rect' ? CLASSIC_SHAPE_LABEL : tilingLabel(n));
    const ground = shapes.length >= 2
      ? `<p class="stats-blurb">Strongest ground: ${escapeHtml(shapeLabel(shapes[0].name))},
          ${shapes[0].wonAdjusted}-${shapes[0].contested - shapes[0].wonAdjusted}.
          Weakest: ${escapeHtml(shapeLabel(shapes[shapes.length - 1].name))},
          ${shapes[shapes.length - 1].wonAdjusted}-${shapes[shapes.length - 1].contested - shapes[shapes.length - 1].wonAdjusted}.</p>`
      : '';

    const solo = rec.boardsPlayed - rec.contested;
    const ties = riv.field.ties;
    el.innerHTML = `
      <h4 class="stat-h2h-heading">Your rivalries</h4>
      ${rivalRows}${more}
      <p class="stats-blurb">${rec.contested} board${rec.contested === 1 ? '' : 's'} raced.
        You took ${rec.wonAdjusted} adjusted, ${rec.wonRaw} raw${ties
  ? `; ${ties} tie${ties === 1 ? '' : 's'} counted for nobody` : ''}.
        Adjusted divides every time by that player's handicap, so it is the fair
        comparison; raw is who finished first.</p>
      ${ground}
      ${solo > 0 ? `<p class="friends-code-hint">${solo} more board${solo === 1 ? '' : 's'} run solo.
        Nobody raced them, so they carry no record.</p>` : ''}`;
  } catch (err) {
    reportCaughtError('match-h2h', err);
    el.innerHTML = '<p class="stats-blurb">Could not work out your record right now.</p>';
  }
}


function populateMatchPanel() {
  const stats = loadStats();
  const mm = stats.modeStats?.match;
  const chart = $('#stat-match-recent');
  // The head-to-head record needs the match NODES (everyone else's times),
  // so it loads on its own and paints when it arrives.
  _renderMatchHeadToHead();
  if (!mm) {
    $('#stat-match-played').textContent = '0';
    $('#stat-match-streak').textContent = '0';
    $('#stat-match-wins').textContent = '0';
    if (chart) chart.innerHTML = '<span class="chart-empty">Build a Challenge run to see your history!</span>';
    return;
  }
  $('#stat-match-played').textContent = mm.totalGames || 0;
  $('#stat-match-streak').textContent = mm.currentStreak || 0;
  $('#stat-match-wins').textContent = mm.wins || 0;

  // Per-board history, the Climb panel's own bar chart: a match's unit is
  // the board, and the mode has no level table to key best times on.
  if (!chart) return;
  chart.innerHTML = '';
  const recent = (mm.recentGames || []).slice(-20);
  if (recent.length === 0) {
    chart.innerHTML = '<span class="chart-empty">Build a Challenge run to see your history!</span>';
    return;
  }
  const winTimes = recent.filter(g => g.won).map(g => g.time);
  const maxTime = winTimes.length > 0 ? Math.max(...winTimes, 30) : 30;
  for (const game of recent) {
    const bar = document.createElement('div');
    bar.className = `game-bar ${game.won ? 'win' : 'loss'}`;
    if (game.won) {
      bar.style.height = `${Math.max(15, 100 - (game.time / maxTime) * 70)}%`;
      bar.title = `Win: ${game.time}s`;
    } else {
      bar.style.height = '30%';
      bar.title = 'Loss';
    }
    chart.appendChild(bar);
  }
}

async function populateDailyPanel() {
  // Show an unobtrusive loading state while we pull from Firebase.
  const tierChartIds = [
    'chart-handicap-trajectory', 'chart-daily-history',
    'chart-complexity-delta', 'chart-strike-rate',
    'chart-modifier-heatmap', 'chart-consistency',
    'chart-percentile-trend',
  ];
  for (const id of tierChartIds) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<div class="chart-empty">Loading…</div>';
  }

  const uid = getUid();
  if (!uid) {
    for (const id of tierChartIds) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '<div class="chart-empty">Sign-in still pending. Open again in a moment.</div>';
    }
    return;
  }

  // Fetch in parallel. handicaps.json is a static asset.
  const [history, metaByDate, scoresByDate, handicapsMap] = await Promise.all([
    fetchUserDailyHistory(uid, 365),
    fetchAllDailyMeta(),
    fetchAllDailyScores(),
    loadHandicaps(),
  ]);

  if (history === null || metaByDate === null) {
    for (const id of tierChartIds) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '<div class="chart-empty">Couldn\'t reach Firebase. Try again later.</div>';
    }
    return;
  }

  // Use the refitted handicap from handicaps.json when available. Fall
  // back to a client-computed mean residual against the user's own
  // history so first-time players see something meaningful before the
  // nightly refit catches up. Provisional flag tells the stats renderer
  // to qualify the number ("(provisional, N plays)") so the player
  // understands it'll tighten as more data accumulates.
  let ratio = getHandicapRatio(uid);
  let bombSeconds = (getHandicapDetails(uid) || {}).bombSeconds || 0;
  let handicapProvisional = false;
  if (!isRatedHandicap(uid) && history && history.length >= 2) {
    // Provisional ratio from the player's own history until the nightly refit
    // includes them: the geometric mean of time/par, shrunk toward k=1. Bombs
    // ride in the ratio implicitly (a player who bombs is slower), so there's
    // no clean/bomb split until the fit ships one.
    const pairs = history
      .map(h => {
        const f = metaByDate[h.date];
        if (!f) return null;
        return { time: h.time, predictedPar: predictPar(f) };
      })
      .filter(Boolean);
    const est = estimateHandicapDetails(pairs);
    if (est) {
      ratio = est.k;
      bombSeconds = 0;
      handicapProvisional = true;
    }
  }
  const { renderDailyStatsTab } = await import('./statsRenderer.js');
  renderDailyStatsTab({
    history: history || [],
    metaByDate: metaByDate || {},
    scoresByDate: scoresByDate || {},
    uid,
    ratio,
    bombSeconds,
    refPar: getRefPar(),
    handicapProvisional,
    // The full shipped ratio map, the percentile chart's Adjusted mode
    // ranks the whole field by time/k, same as the leaderboard view.
    handicaps: handicapsMap || null,
  });
}

// Tab switcher, bound once at module load.
for (const btn of $$('.stats-tab')) {
  btn.addEventListener('click', () => setActiveStatsTab(btn.dataset.tab));
}
