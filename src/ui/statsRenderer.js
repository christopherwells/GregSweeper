// Orchestrates the Daily tab of the stats modal. Pulls data from Firebase +
// local storage, computes derived stats client-side (rolling handicap,
// per-modifier mean deltas, delta distribution, percentile ranks, etc.),
// and renders the charts defined in src/ui/charts.js.
//
// All data fetching happens in main.js; this module is pure view + math.

import { predictPar } from '../logic/dailyFeatures.js';
import {
  lineChart, barChart, heatBars, densityChart,
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
 * @param {number} data.handicap  user's current handicap
 */
export function renderDailyStatsTab(data) {
  const { history, metaByDate, scoresByDate, uid, handicap } = data;

  const sorted = [...(history || [])].sort((a, b) => a.date.localeCompare(b.date));

  // Enrich each play with features, par, delta, and bombHits lookup.
  const plays = sorted.map(h => {
    const features = metaByDate[h.date];
    const globalPar = features ? predictPar(features) : null;
    const personalPar = globalPar != null ? globalPar + handicap : null;
    const deltaGlobal = globalPar != null ? h.time - globalPar : null;
    const deltaPersonal = personalPar != null ? h.time - personalPar : null;
    const sameDayScores = scoresByDate[h.date] || [];
    const mine = sameDayScores.find(s => s.uid === uid && Math.abs(s.time - h.time) < 0.01);
    const bombHits = mine ? (mine.bombHits || 0) : 0;
    return { ...h, features, globalPar, personalPar, deltaGlobal, deltaPersonal, bombHits };
  }).filter(p => p.features);

  renderHeadlineCards(plays, handicap);
  renderHandicapTrajectory(plays);
  renderHistoryChart(plays);
  renderComplexityDelta(plays);
  renderStrikeRate(plays);
  renderModifierHeatmap(plays);
  renderDeltaDistribution(plays, handicap);
  renderPercentileTrend(plays, scoresByDate, uid);
}

// ── Headline cards ────────────────────────────────────

function renderHeadlineCards(plays, handicap) {
  if (plays.length >= 3) {
    const sign = handicap >= 0 ? '+' : '';
    setText('stat-handicap-now', `${sign}${handicap.toFixed(1)}s`);
  } else {
    setText('stat-handicap-now', 'Need 3+ plays');
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

  // Strike rate cards — one for lifetime, one for the last 7 days to match
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

// ── Chart: Handicap trajectory ────────────────────────

function renderHandicapTrajectory(plays) {
  if (plays.length < 3) {
    replaceContent('chart-handicap-trajectory', emptyDiv('Need at least 3 plays to trace a handicap.'));
    return;
  }
  // Two series on the same y-axis: cumulative mean of deltaGlobal (your
  // career-long handicap trajectory) and last-10-plays rolling mean
  // (your recent form). The GAP between them reads as "am I trending
  // better or worse than my career average?" — rolling BELOW cumulative
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
      x: shortDate(p.date),
      y: Math.round(cumMean * 10) / 10,
      label: `${p.date}: career avg ${cumMean >= 0 ? '+' : ''}${cumMean.toFixed(1)}s (after ${i + 1} plays)`,
    });
    const lo = Math.max(0, i - ROLLING_WINDOW + 1);
    const window = plays.slice(lo, i + 1);
    const rollMean = window.reduce((s, pp) => s + pp.deltaGlobal, 0) / window.length;
    rolling.push({
      x: shortDate(p.date),
      y: Math.round(rollMean * 10) / 10,
      label: `${p.date}: last ${window.length} plays avg ${rollMean >= 0 ? '+' : ''}${rollMean.toFixed(1)}s`,
    });
  }
  const svg = lineChart(cumulative, {
    ariaLabel: 'Handicap trajectory — career average and last-10-play rolling',
    thresholdLine: 0,
    yFormat: v => (v > 0 ? '+' : '') + v + 's',
    dotClassForValue: v => v < -0.5 ? 'chart-dot-good' : v > 0.5 ? 'chart-dot-bad' : 'chart-dot-even',
    lineClass: 'chart-line chart-line-handicap',
    secondary: rolling,
  });
  replaceContent('chart-handicap-trajectory', svg);
}

// ── Chart: Delta by reasoning type ────────────────────
//
// Each bar is your mean delta vs. Greg-par on dailies that NEEDED a
// given kind of reasoning. Boards contribute to multiple bars
// simultaneously (a board needing process-of-elimination almost
// always also needed the simpler patterns), so the bars are
// overlapping rather than mutually exclusive — same convention as the
// modifier heatmap. Sorted by signed effect so reasoning kinds you
// handle better than expected sit on the left, ones that cost you
// extra time sit on the right.
//
// passAMoves is intentionally excluded — it's on every board, so its
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

function renderStrikeRate(plays) {
  if (plays.length < 3) {
    replaceContent('chart-strike-rate', emptyDiv('Need at least 3 plays.'));
    return;
  }
  const window = 7;
  const points = plays.map((_, i) => {
    const lo = Math.max(0, i - window + 1);
    const slice = plays.slice(lo, i + 1);
    const rate = slice.filter(p => p.bombHits > 0).length / slice.length;
    return {
      x: shortDate(plays[i].date),
      y: Math.round(rate * 100),
      label: `${plays[i].date}: ${Math.round(rate * 100)}% of last ${slice.length} dailies had a strike`,
    };
  });
  const svg = lineChart(points, {
    ariaLabel: 'Strike rate trend (rolling 7-day %)',
    yDomain: [0, 100],
    yFormat: v => v + '%',
    dotClassForValue: v => v <= 20 ? 'chart-dot-good' : v >= 50 ? 'chart-dot-bad' : 'chart-dot-even',
    lineClass: 'chart-line chart-line-strike',
  });
  replaceContent('chart-strike-rate', svg);
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

function renderDeltaDistribution(plays, handicap) {
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
  // the distribution is right-skewed — typical days are better than the
  // mean suggests, but a few bad days drag the average up. Surfacing
  // both numbers makes that skew visible.
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)];

  setText('stat-over-par-pct', `${Math.round(100 * over / n)}%`);
  setText('stat-under-par-pct', `${Math.round(100 * under / n)}%`);
  const medianSign = median > 0 ? '+' : '';
  setText('stat-median-delta', `${medianSign}${median.toFixed(1)}s`);

  const svg = densityChart(deltas, {
    ariaLabel: 'Distribution of your daily deltas',
    thresholdLine: 0,
    thresholdLabel: 'par',
    meanLine: mean,
    // Mean line is drawn but unlabeled — labeling it collides with the
    // x-axis tick when the mean falls near the midpoint of the data range.
    // The "Days over / under par" cards and the Handicap headline above
    // make the mean self-evident from context.
    xFormat: v => (v > 0 ? '+' : '') + v + 's',
  });
  replaceContent('chart-consistency', svg);
}

// ── Chart: Percentile trend ───────────────────────────

function renderPercentileTrend(plays, scoresByDate, uid) {
  if (plays.length < 3) {
    replaceContent('chart-percentile-trend', emptyDiv('Need at least 3 plays.'));
    return;
  }
  const points = [];
  for (const p of plays) {
    const dayScores = scoresByDate[p.date] || [];
    const bestByUid = new Map();
    for (const s of dayScores) {
      if (!s.uid || typeof s.time !== 'number') continue;
      if (!bestByUid.has(s.uid) || s.time < bestByUid.get(s.uid)) {
        bestByUid.set(s.uid, s.time);
      }
    }
    const allTimes = [...bestByUid.values()];
    if (allTimes.length < 2) continue;
    const myTime = bestByUid.get(uid);
    if (myTime == null) continue;
    // Percentile where 100 = fastest (everyone you beat) and 0 = slowest
    // (beaten by everyone). Conventionally readable: "90th percentile"
    // means top 10%. With 2 players the axis is bimodal (0 or 100); more
    // players spread out the intermediate values.
    const othersBelowMe = allTimes.filter(t => t > myTime).length;
    const percentile = Math.round(100 * othersBelowMe / (allTimes.length - 1));
    points.push({
      x: shortDate(p.date),
      y: percentile,
      label: `${p.date}: ${percentile}th percentile of ${allTimes.length} players`,
    });
  }

  if (points.length === 0) {
    replaceContent('chart-percentile-trend', emptyDiv('Populates when 2+ players have uid-tagged scores on the same day.'));
    return;
  }
  const svg = lineChart(points, {
    ariaLabel: 'Rank among the field over time',
    yDomain: [0, 100],
    yFormat: v => v + 'th',
    // High percentile = good. Low = bad.
    dotClassForValue: v => v >= 70 ? 'chart-dot-good' : v <= 30 ? 'chart-dot-bad' : 'chart-dot-even',
    lineClass: 'chart-line chart-line-rank',
  });
  replaceContent('chart-percentile-trend', svg);
}

// ── Chart: Daily history (moved from leaderboard) ─────

function renderHistoryChart(plays) {
  const entries = plays.map(p => ({
    date: p.date,
    time: p.time,
    par: p.personalPar != null ? p.personalPar : p.globalPar || 0,
    delta: p.deltaPersonal != null ? p.deltaPersonal : (p.deltaGlobal || 0),
  }));
  const svg = renderDailyHistoryChart(entries);
  replaceContent('chart-daily-history', svg);
}
