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

// Which complexity bucket does a board fall into — based on the HARDEST
// move type the solver needed. Matches the user's mental model: "was this
// an easy board, a medium board, or a hard board?"
function complexityBucket(features) {
  if ((features.disjunctiveMoves || 0) > 0 || (features.advancedLogicMoves || 0) > 0) return 'hard';
  if ((features.genericSubsetMoves || 0) > 0) return 'medium';
  return 'easy';
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
  let sum = 0;
  const points = plays.map((p, i) => {
    sum += p.deltaGlobal;
    const rolling = sum / (i + 1);
    return {
      x: shortDate(p.date),
      y: Math.round(rolling * 10) / 10,
      label: `${p.date}: handicap ${rolling >= 0 ? '+' : ''}${rolling.toFixed(1)}s (after ${i + 1} plays)`,
    };
  });
  const svg = lineChart(points, {
    ariaLabel: 'Handicap trajectory over time',
    thresholdLine: 0,
    yFormat: v => (v > 0 ? '+' : '') + v + 's',
    dotClassForValue: v => v < -0.5 ? 'chart-dot-good' : v > 0.5 ? 'chart-dot-bad' : 'chart-dot-even',
    lineClass: 'chart-line chart-line-handicap',
  });
  replaceContent('chart-handicap-trajectory', svg);
}

// ── Chart: Delta by board complexity ──────────────────

function renderComplexityDelta(plays) {
  if (plays.length < 3) {
    replaceContent('chart-complexity-delta', emptyDiv('Need at least 3 plays.'));
    return;
  }
  const buckets = { easy: [], medium: [], hard: [] };
  for (const p of plays) {
    const b = complexityBucket(p.features);
    buckets[b].push(p.deltaGlobal);
  }
  const order = [
    { label: 'easy',   values: buckets.easy },
    { label: 'medium', values: buckets.medium },
    { label: 'hard',   values: buckets.hard },
  ];
  const groups = order
    .filter(b => b.values.length > 0)
    .map(b => {
      const mean = b.values.reduce((s, v) => s + v, 0) / b.values.length;
      return {
        label: `${b.label} (n=${b.values.length})`,
        value: mean,
        sub: '',
      };
    });
  if (groups.length === 0) {
    replaceContent('chart-complexity-delta', emptyDiv('Not enough data yet.'));
    return;
  }
  const svg = heatBars(groups, {
    ariaLabel: 'Mean delta by board complexity',
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
      sub: `n=${rows.length}`,
    });
  }
  if (items.length === 0) {
    replaceContent('chart-modifier-heatmap', emptyDiv('No modifier days in your history yet.'));
    return;
  }
  // Sort by absolute impact so biggest problems float to the top.
  items.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
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
    const beatenBy = allTimes.filter(t => t < myTime).length;
    const percentile = Math.round(100 * beatenBy / allTimes.length);
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
    dotClassForValue: v => v <= 30 ? 'chart-dot-good' : v >= 60 ? 'chart-dot-bad' : 'chart-dot-even',
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
