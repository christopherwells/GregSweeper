// Orchestrates the Daily tab of the stats modal. Pulls data from Firebase +
// local storage, computes derived stats client-side (rolling handicap,
// per-modifier mean deltas, delta distribution, percentile ranks, etc.),
// and renders the charts defined in src/ui/charts.js.
//
// All data fetching happens in main.js; this module is pure view + math.

import { predictPar } from '../logic/dailyFeatures.js';
import { ratioDisplaySeconds, ratioDisplayPercent } from '../logic/handicaps.js';
import { rankAdjusted } from '../logic/leaderboardViews.js';
import {
  lineChart, barChart, heatBars, densityChart, valueGradient01,
} from './charts.js';
import { renderDailyHistoryChart } from './dailyHistoryChart.js';

// ── Helpers ───────────────────────────────────────────

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDate(dateStr) {
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  return `${SHORT_MONTHS[parseInt(parts[1], 10) - 1] || parts[1]} ${parseInt(parts[2], 10)}`;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function replaceContent(id, child) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = '';
  if (child instanceof Node) el.appendChild(child);
}

function emptyDiv(message) {
  const d = document.createElement('div');
  d.className = 'chart-empty';
  d.textContent = message;
  return d;
}


// ── Main entry point ──────────────────────────────────

/**
 * @param {Object} data
 * @param {Array<{date:string, time:number}>} data.history  user's own dailies
 * @param {Object<string, Object>} data.metaByDate          dailyMeta features keyed by date
 * @param {Object<string, Array<{uid:string, name:string, time:number, bombHits?:number}>>} data.scoresByDate
 *        all players' scores for each date (flat across pushIds)
 * @param {string} data.uid  signed-in user's uid
 * @param {number} data.ratio  user's multiplicative handicap k (1 = neutral)
 * @param {number} [data.bombSeconds]  the fit's additive bomb-seconds (0 if none)
 * @param {number} [data.refPar]  reference par for the seconds display
 * @param {boolean} [data.handicapProvisional]  true when the ratio came from
 *        the local-residual fallback (< MIN_PLAYS_FOR_FIT_INCLUSION plays)
 */
export function renderDailyStatsTab(data) {
  const { history, metaByDate, scoresByDate, uid, ratio = 1, bombSeconds = 0, refPar = 60, handicapProvisional, handicaps = null } = data;

  // Chronology is by the day the run was PLAYED (playedDate), not the board's
  // date key, an archive replay of an old board is a play that happened
  // today, and splicing it into the past corrupts the career/rolling averages
  // and back-dates dots on the history chart.
  const sorted = [...(history || [])].sort((a, b) =>
    (a.playedDate || a.date).localeCompare(b.playedDate || b.date));

  // Enrich each play with features, par, delta, and bombHits lookup, all
  // joined on the BOARD's date (h.date), preserved as boardDate below. The
  // outgoing `date` is the played day, so every chart plots plays when they
  // happened.
  const plays = sorted.map(h => {
    const features = metaByDate[h.date];
    const globalPar = features ? predictPar(features) : null;
    // Personal par scales with the board (ratio) plus fixed bomb seconds.
    const personalPar = globalPar != null ? globalPar * ratio + bombSeconds : null;
    const deltaGlobal = globalPar != null ? h.time - globalPar : null;
    const deltaPersonal = personalPar != null ? h.time - personalPar : null;
    const sameDayScores = scoresByDate[h.date] || [];
    const mine = sameDayScores.find(s => s.uid === uid && Math.abs(s.time - h.time) < 0.01);
    const bombHits = mine ? (mine.bombHits || 0) : 0;
    return {
      ...h,
      boardDate: h.date,
      date: h.playedDate || h.date,
      features, globalPar, personalPar, deltaGlobal, deltaPersonal, bombHits,
    };
  }).filter(p => p.features);

  // Zero-state: a brand-new player has no plays, so every chart below
  // would just say "need N plays". Lead with one friendly line instead
  // of that wall.
  const panel = document.getElementById('stats-panel-daily');
  if (panel) {
    let zero = document.getElementById('stats-daily-zero');
    if (plays.length === 0) {
      if (!zero) {
        zero = document.createElement('div');
        zero.id = 'stats-daily-zero';
        zero.className = 'chart-empty';
        panel.insertBefore(zero, panel.firstChild);
      }
      zero.textContent = 'Finish your first daily to start your stats and personal par. The charts below fill in after a few plays.';
    } else if (zero) {
      zero.remove();
    }
  }

  renderHeadlineCards(plays, ratio, refPar, handicapProvisional);
  renderHandicapTrajectory(plays);
  renderHistoryChart(plays);
  renderComplexityDelta(plays);
  renderStrikeRate(plays);
  renderModifierHeatmap(plays);
  renderDeltaDistribution(plays);
  renderPercentileTrend(plays, scoresByDate, uid, handicaps);
}

// ── Headline cards ────────────────────────────────────

function renderHeadlineCards(plays, ratio, refPar, handicapProvisional) {
  // Two-tier headline: show a real handicap whenever we have one (refit ratio
  // OR provisional from >= 2 plays); fall back to a "tracking" message for
  // brand-new players. The ratio is a RATING vs Greg, a stable seconds
  // magnitude (at a standard board) plus a percent, same form as the leaderboard
  // chip. POSITIVE = faster/better than Greg (k < 1), negative = slower.
  const hcSeconds = ratioDisplaySeconds(ratio, refPar);
  const hcPct = ratioDisplayPercent(ratio);
  if (plays.length >= 2 && ratio !== 1) {
    const sign = hcSeconds >= 0 ? '+' : '−';
    const chip = `${sign}${Math.abs(hcSeconds).toFixed(0)}s · ${sign}${Math.abs(hcPct).toFixed(0)}%`;
    const el = document.getElementById('stat-handicap-now');
    if (el) {
      // Provisional reads as a chip, the leaderboard's qualifier language.
      el.innerHTML = handicapProvisional
        ? `${chip} <span class="lb-hc-chip lb-hc-unrated">provisional · ${plays.length} plays</span>`
        : chip;
    }
  } else if (plays.length === 1) {
    setText('stat-handicap-now', '1 more daily');
  } else if (plays.length === 0) {
    setText('stat-handicap-now', '--');
  } else {
    // 2+ plays but ratio is exactly 1 (perfectly average). Render a literal
    // neutral figure instead of a misleading "need more plays" message.
    setText('stat-handicap-now', '+0s · +0%');
  }

  // History section cards
  setText('stat-daily-played', String(plays.length));
  const avgTime = plays.length > 0
    ? (plays.reduce((s, p) => s + p.time, 0) / plays.length).toFixed(1) + 's'
    : '--';
  setText('stat-daily-avg-time', avgTime);
  const bestTime = plays.length > 0
    ? Math.min(...plays.map(p => p.time)).toFixed(1) + 's'
    : '--';
  setText('stat-daily-best-time', bestTime);

  // Strike rate cards, one for lifetime, one for the last 7 days to match
  // the chart's trend line (fixing the "55% headline but chart endpoint
  // shows 25%" confusion).
  const totalStrikes = plays.reduce((s, p) => s + p.bombHits, 0);
  const daysWithStrike = plays.filter(p => p.bombHits > 0).length;
  const lifetimePct = plays.length > 0 ? Math.round(100 * daysWithStrike / plays.length) : 0;
  const last7 = plays.slice(-7);
  const last7Strike = last7.filter(p => p.bombHits > 0).length;
  const recentPct = last7.length > 0 ? Math.round(100 * last7Strike / last7.length) : 0;
  const meanStrikes = plays.length > 0 ? (totalStrikes / plays.length).toFixed(2) : '--';
  setText('stat-strike-rate-recent', `${recentPct}%`);
  setText('stat-strike-rate', `${lifetimePct}%`);
  setText('stat-mean-strikes', meanStrikes);
}

// ── Shared time-window pills (his ask, 2026-08-11: "All the dot graphs
// should have those 30/60/90/1y pills") ────────────────────────────────
// One factory, one window vocabulary; each dot chart keeps its own
// session-persistent selection, 60 days the default. Series that carry
// history in their math (the career average, the rolling means) are
// computed over ALL plays and the window only decides which points draw,
// so "career avg" keeps meaning career at every window.
const TIME_WINDOWS = [[30, '30d'], [60, '60d'], [90, '90d'], [365, '1y']];

function windowToggle(current, onPick) {
  const row = document.createElement('div');
  row.className = 'chart-toggle';
  for (const [days, label] of TIME_WINDOWS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chart-toggle-btn' + (current === days ? ' active' : '');
    btn.setAttribute('aria-pressed', current === days ? 'true' : 'false');
    btn.textContent = label;
    btn.addEventListener('click', () => { if (current !== days) onPick(days); });
    row.appendChild(btn);
  }
  return row;
}

function windowCutoff(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

// ── Chart: Handicap trajectory ────────────────────────

let _hcDays = 60;
let _hcCtx = null;

function renderHandicapTrajectory(plays) {
  _hcCtx = plays;
  _renderHandicapTrajectoryInner();
}

function _renderHandicapTrajectoryInner() {
  const plays = _hcCtx || [];
  const wrap = document.createElement('div');
  wrap.appendChild(windowToggle(_hcDays, (d) => { _hcDays = d; _renderHandicapTrajectoryInner(); }));
  if (plays.length < 3) {
    wrap.appendChild(emptyDiv('Need at least 3 plays to trace a handicap.'));
    replaceContent('chart-handicap-trajectory', wrap);
    return;
  }
  // Two series on the same y-axis: cumulative mean of deltaGlobal (your
  // career-long handicap trajectory) and last-10-plays rolling mean
  // (your recent form). The GAP between them reads as "am I trending
  // better or worse than my career average?", rolling BELOW cumulative
  // means you've been improving lately; ABOVE means regressing.
  const ROLLING_WINDOW = 10;
  let cumSum = 0;
  const cumulative = [];
  const rolling = [];
  for (let i = 0; i < plays.length; i++) {
    const p = plays[i];
    cumSum += p.deltaGlobal;
    const cumMean = cumSum / (i + 1);
    cumulative.push({
      d: p.date,
      x: shortDate(p.date),
      y: Math.round(cumMean * 10) / 10,
      label: `${p.date}: career avg ${cumMean >= 0 ? '+' : ''}${cumMean.toFixed(1)}s (after ${i + 1} plays)`,
    });
    const lo = Math.max(0, i - ROLLING_WINDOW + 1);
    const window = plays.slice(lo, i + 1);
    const rollMean = window.reduce((s, pp) => s + pp.deltaGlobal, 0) / window.length;
    rolling.push({
      d: p.date,
      x: shortDate(p.date),
      y: Math.round(rollMean * 10) / 10,
      label: `${p.date}: last ${window.length} plays avg ${rollMean >= 0 ? '+' : ''}${rollMean.toFixed(1)}s`,
    });
  }
  const cutoff = windowCutoff(_hcDays);
  const cumWin = cumulative.filter(pt => pt.d >= cutoff);
  const rollWin = rolling.filter(pt => pt.d >= cutoff);
  if (cumWin.length === 0) {
    wrap.appendChild(emptyDiv('No plays in this window. Widen it above.'));
    replaceContent('chart-handicap-trajectory', wrap);
    return;
  }
  wrap.appendChild(lineChart(cumWin, {
    ariaLabel: 'Handicap trajectory: career average and last-10-play rolling',
    thresholdLine: 0,
    yFormat: v => (v > 0 ? '+' : '') + v + 's',
    dotClassForValue: v => v < -0.5 ? 'chart-dot-good' : v > 0.5 ? 'chart-dot-bad' : 'chart-dot-even',
    lineClass: 'chart-line chart-line-handicap',
    secondary: rollWin,
  }));
  replaceContent('chart-handicap-trajectory', wrap);
}

// ── Chart: Delta by reasoning type ────────────────────
//
// Each bar is your mean delta vs. Greg-par on dailies that NEEDED a
// given kind of reasoning. Boards contribute to multiple bars
// simultaneously (a board needing process-of-elimination almost
// always also needed the simpler patterns), so the bars are
// overlapping rather than mutually exclusive, same convention as the
// modifier heatmap. Sorted by signed effect so reasoning kinds you
// handle better than expected sit on the left, ones that cost you
// extra time sit on the right.
//
// passAMoves is intentionally excluded, it's on every board, so its
// bar would equal your overall mean (no signal). disjunctiveMoves is
// excluded because it's structurally identical to "liar boards"
// (every disjunctive move comes from a liar cell), and the modifier
// chart already covers the liar bar.
const REASONING_TYPES = [
  { key: 'canonicalSubsetMoves', label: 'Easy patterns' },
  { key: 'genericSubsetMoves',   label: 'Complex patterns' },
  { key: 'advancedLogicMoves',   label: 'Process of elimination' },
];

function renderComplexityDelta(plays) {
  if (plays.length < 3) {
    replaceContent('chart-complexity-delta', emptyDiv('Need at least 3 plays.'));
    return;
  }
  const items = [];
  for (const r of REASONING_TYPES) {
    const rows = plays.filter(p => (p.features[r.key] || 0) > 0);
    if (rows.length === 0) continue;
    const mean = rows.reduce((s, p) => s + p.deltaGlobal, 0) / rows.length;
    items.push({
      label: r.label,
      value: Math.round(mean * 10) / 10,
    });
  }
  if (items.length === 0) {
    replaceContent('chart-complexity-delta', emptyDiv('Not enough data yet.'));
    return;
  }
  // Sort by signed effect, most-negative first → 0 → most-positive
  // last. Same convention as the modifier chart.
  items.sort((a, b) => a.value - b.value);
  const svg = heatBars(items, {
    ariaLabel: 'Mean delta by reasoning type',
    valueFormat: v => (v > 0 ? '+' : '') + v.toFixed(1) + 's',
  });
  replaceContent('chart-complexity-delta', svg);
}

// ── Chart: Strike rate rolling trend ──────────────────

let _strikeDays = 60;
let _strikeCtx = null;

function renderStrikeRate(plays) {
  _strikeCtx = plays;
  _renderStrikeRateInner();
}

function _renderStrikeRateInner() {
  const plays = _strikeCtx || [];
  const wrap = document.createElement('div');
  wrap.appendChild(windowToggle(_strikeDays, (d) => { _strikeDays = d; _renderStrikeRateInner(); }));
  if (plays.length < 3) {
    wrap.appendChild(emptyDiv('Need at least 3 plays.'));
    replaceContent('chart-strike-rate', wrap);
    return;
  }
  const window = 7;
  const points = plays.map((_, i) => {
    const lo = Math.max(0, i - window + 1);
    const slice = plays.slice(lo, i + 1);
    const rate = slice.filter(p => p.bombHits > 0).length / slice.length;
    return {
      d: plays[i].date,
      x: shortDate(plays[i].date),
      y: Math.round(rate * 100),
      label: `${plays[i].date}: ${Math.round(rate * 100)}% of last ${slice.length} dailies had a strike`,
    };
  });
  const cutoff = windowCutoff(_strikeDays);
  const win = points.filter(pt => pt.d >= cutoff);
  if (win.length === 0) {
    wrap.appendChild(emptyDiv('No plays in this window. Widen it above.'));
    replaceContent('chart-strike-rate', wrap);
    return;
  }
  wrap.appendChild(lineChart(win, {
    ariaLabel: 'Strike rate trend (rolling 7-day %)',
    yDomain: [0, 100],
    yFormat: v => v + '%',
    dotClassForValue: v => v <= 20 ? 'chart-dot-good' : v >= 50 ? 'chart-dot-bad' : 'chart-dot-even',
    lineClass: 'chart-line chart-line-strike',
  }));
  replaceContent('chart-strike-rate', wrap);
}

// ── Chart: Delta by modifier (single bar per modifier) ─

function renderModifierHeatmap(plays) {
  if (plays.length < 3) {
    replaceContent('chart-modifier-heatmap', emptyDiv('Not enough plays to stratify.'));
    return;
  }
  const MODIFIERS = [
    { key: 'mysteryCellCount',  label: 'mystery' },
    { key: 'liarCellCount',     label: 'liar' },
    { key: 'lockedCellCount',   label: 'locked' },
    { key: 'wallEdgeCount',     label: 'walls' },
    { key: 'wormholePairCount', label: 'wormhole' },
    { key: 'mirrorPairCount',   label: 'mirror' },
    { key: 'sonarCellCount',    label: 'sonar' },
    { key: 'compassCellCount',  label: 'compass' },
  ];
  const items = [];
  for (const m of MODIFIERS) {
    const rows = plays.filter(p => (p.features[m.key] || 0) > 0);
    if (rows.length === 0) continue;
    const mean = rows.reduce((s, p) => s + p.deltaGlobal, 0) / rows.length;
    items.push({
      label: m.label,
      value: Math.round(mean * 10) / 10,
    });
  }
  if (items.length === 0) {
    replaceContent('chart-modifier-heatmap', emptyDiv('No modifier days in your history yet.'));
    return;
  }
  // Sort by signed effect, most-negative first → 0 → most-positive last.
  // Reads as a smooth ramp from "modifiers you handle better than the
  // model expects" to "modifiers that consistently cost you time."
  items.sort((a, b) => a.value - b.value);
  const svg = heatBars(items, {
    ariaLabel: 'Mean delta by modifier',
    valueFormat: v => (v > 0 ? '+' : '') + v.toFixed(1) + 's',
  });
  replaceContent('chart-modifier-heatmap', svg);
}

// ── Chart: Delta distribution (histogram) ─────────────

function renderDeltaDistribution(plays) {
  if (plays.length < 5) {
    replaceContent('chart-consistency', emptyDiv('Need at least 5 plays to see distribution shape.'));
    setText('stat-over-par-pct', '--');
    setText('stat-under-par-pct', '--');
    setText('stat-median-delta', '--');
    return;
  }
  const deltas = plays.map(p => p.deltaGlobal);
  const n = deltas.length;
  const mean = deltas.reduce((s, v) => s + v, 0) / n;
  const over = deltas.filter(d => d > 0.5).length;
  const under = deltas.filter(d => d < -0.5).length;

  // Median delta: when the mean (handicap) is higher than the median,
  // the distribution is right-skewed, typical days are better than the
  // mean suggests, but a few bad days drag the average up. Surfacing
  // both numbers makes that skew visible.
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)];

  setText('stat-over-par-pct', `${Math.round(100 * over / n)}%`);
  setText('stat-under-par-pct', `${Math.round(100 * under / n)}%`);
  const medianSign = median > 0 ? '+' : '';
  const medEl = document.getElementById('stat-median-delta');
  if (medEl) {
    medEl.textContent = `${medianSign}${median.toFixed(1)}s`;
    // The leaderboard's delta coloring: under par green, over par red.
    medEl.classList.remove('par-under', 'par-over', 'par-even');
    medEl.classList.add(median < -0.5 ? 'par-under' : median > 0.5 ? 'par-over' : 'par-even');
  }

  const svg = densityChart(deltas, {
    ariaLabel: 'Distribution of your daily deltas',
    thresholdLine: 0,
    thresholdLabel: 'par',
    meanLine: mean,
    // Mean line is drawn but unlabeled, labeling it collides with the
    // x-axis tick when the mean falls near the midpoint of the data range.
    // The "Days over / under par" cards and the Handicap headline above
    // make the mean self-evident from context.
    xFormat: v => (v > 0 ? '+' : '') + v + 's',
  });
  replaceContent('chart-consistency', svg);
}

// ── Chart: Percentile trend ───────────────────────────
// Two modes, toggleable in place. Adjusted (the DEFAULT) divides each
// player's best time by their SHIPPED handicap ratio before ranking, the
// same rankAdjusted math as the leaderboard's Adjusted view, so the chart
// answers "who beat their own par by more" (unrated players rank at raw
// time, k=1). Raw ranks wall-clock times. The mode persists for the session.
let _pctMode = 'adjusted';
let _pctDays = 60;
let _pctCtx = null;

function renderPercentileTrend(plays, scoresByDate, uid, handicapMap) {
  _pctCtx = { plays, scoresByDate, uid, handicapMap };
  _renderPercentileTrendChart();
}

function _pctToggle() {
  const row = document.createElement('div');
  row.className = 'chart-toggle';
  for (const [mode, label] of [['adjusted', 'Adjusted'], ['raw', 'Raw']]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chart-toggle-btn' + (_pctMode === mode ? ' active' : '');
    btn.setAttribute('aria-pressed', _pctMode === mode ? 'true' : 'false');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (_pctMode === mode) return;
      _pctMode = mode;
      _renderPercentileTrendChart();
    });
    row.appendChild(btn);
  }
  return row;
}

function _renderPercentileTrendChart() {
  const { plays, scoresByDate, uid, handicapMap } = _pctCtx || {};
  if (!plays || plays.length < 3) {
    replaceContent('chart-percentile-trend', emptyDiv('Need at least 3 plays.'));
    return;
  }
  const adjusted = _pctMode === 'adjusted';
  const cutoff = windowCutoff(_pctDays);
  const points = [];
  for (const p of plays.filter(pp => (pp.date || '') >= cutoff)) {
    // Rank against the BOARD's field (archive replays have no daily/ row for
    // themselves, so they naturally drop out via the mine-check below).
    const dayScores = scoresByDate[p.boardDate || p.date] || [];
    const bestByUid = new Map();
    for (const s of dayScores) {
      if (!s.uid || typeof s.time !== 'number') continue;
      if (!bestByUid.has(s.uid) || s.time < bestByUid.get(s.uid)) {
        bestByUid.set(s.uid, s.time);
      }
    }
    if (bestByUid.size < 2) continue;
    // The ranked value per player: adjusted = time / k via the tested
    // rankAdjusted, raw = wall-clock best time.
    let valueByUid = bestByUid;
    if (adjusted) {
      const rows = [...bestByUid].map(([u, time]) => ({ uid: u, time }));
      valueByUid = new Map(rankAdjusted(rows, handicapMap || {}).map(r => [r.uid, r.adjusted]));
    }
    const allVals = [...valueByUid.values()];
    const mine = valueByUid.get(uid);
    if (mine == null) continue;
    // Percentile where 100 = fastest (everyone you beat) and 0 = slowest
    // (beaten by everyone). Conventionally readable: "90th percentile"
    // means top 10%. With 2 players the axis is bimodal (0 or 100); more
    // players spread out the intermediate values.
    const othersBelowMe = allVals.filter(t => t > mine).length;
    const percentile = Math.round(100 * othersBelowMe / (allVals.length - 1));
    points.push({
      x: shortDate(p.date),
      y: percentile,
      label: `${p.date}: ${percentile}th percentile of ${allVals.length} players${adjusted ? ' (adjusted)' : ''}`,
    });
  }

  const wrap = document.createElement('div');
  wrap.appendChild(_pctToggle());
  wrap.appendChild(windowToggle(_pctDays, (d) => { _pctDays = d; _renderPercentileTrendChart(); }));
  if (points.length === 0) {
    wrap.appendChild(emptyDiv('Populates when 2+ players have uid-tagged scores on the same day. If you played further back, widen the window above.'));
  } else {
    wrap.appendChild(lineChart(points, {
      ariaLabel: adjusted
        ? 'Rank among the field over time, handicap-adjusted'
        : 'Rank among the field over time',
      yDomain: [0, 100],
      yFormat: v => v + 'th',
      // Dots only, colored on a continuous 0-100 gradient (his ask,
      // 2026-08-11: no line between the rank-vs-field dots, and a more
      // interesting ramp than the old three-band traffic light). The
      // viridis ramp runs dark purple (0th) to bright yellow (100th), so
      // height and color say the same thing and a good week visibly
      // brightens.
      noLine: true,
      dotFill: v => valueGradient01(v / 100),
    }));
  }
  replaceContent('chart-percentile-trend', wrap);
}

// ── Chart: Daily history (moved from leaderboard) ─────
// Windowed by a time-pill row (his ask, 2026-08-11), 60 days the default.
// The fetch already pulls a year (statsModal passes 365 days of history),
// so a pill click is a pure re-render; the window persists for the
// session, same as the percentile chart's mode.
let _histDays = 60;
let _histCtx = null;

function renderHistoryChart(plays) {
  _histCtx = plays;
  _renderHistoryChartInner();
}

function _renderHistoryChartInner() {
  const plays = _histCtx || [];
  const entries = plays.map(p => ({
    date: p.date,               // the played day (see renderDailyStatsTab)
    boardDate: p.boardDate,     // the replayed board, for the tooltip
    archive: p.archive === true,
    time: p.time,
    par: p.personalPar != null ? p.personalPar : p.globalPar || 0,
    delta: p.deltaPersonal != null ? p.deltaPersonal : (p.deltaGlobal || 0),
  }));
  const wrap = document.createElement('div');
  wrap.appendChild(windowToggle(_histDays, (d) => { _histDays = d; _renderHistoryChartInner(); }));
  wrap.appendChild(renderDailyHistoryChart(entries, { daysBack: _histDays }));
  replaceContent('chart-daily-history', wrap);
}
