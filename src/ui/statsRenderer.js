// Orchestrates the Daily tab of the stats modal. Pulls data from Firebase +
// local storage, computes derived stats client-side (rolling handicap,
// per-move-type shares, consistency IQR, percentile ranks, etc.), and
// renders the charts defined in src/ui/charts.js.
//
// All data fetching happens in main.js; this module is pure view + math.

import { predictPar, breakdownPar } from '../logic/dailyFeatures.js';
import {
  lineChart, stackedAreaChart, groupedBarChart,
  barChart, boxChart, heatBars,
} from './charts.js';
import { renderDailyHistoryChart } from './dailyHistoryChart.js';

// ── Helpers ───────────────────────────────────────────

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDate(dateStr) {
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  return `${SHORT_MONTHS[parseInt(parts[1], 10) - 1] || parts[1]} ${parseInt(parts[2], 10)}`;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (base + 1 < sorted.length) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  return sorted[base];
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

// ── Main entry point ──────────────────────────────────

/**
 * @param {Object} data
 * @param {Array<{date:string, time:number}>} data.history  user's own dailies, newest-first
 * @param {Object<string, Object>} data.metaByDate          dailyMeta features keyed by date
 * @param {Object<string, Array<{uid:string, name:string, time:number, bombHits?:number}>>} data.scoresByDate
 *        all players' scores for each date (flat across pushIds)
 * @param {string} data.uid  signed-in user's uid
 * @param {number} data.handicap  user's current handicap
 */
export function renderDailyStatsTab(data) {
  const { history, metaByDate, scoresByDate, uid, handicap } = data;

  // Sort history oldest-first for trend computations
  const sorted = [...(history || [])].sort((a, b) => a.date.localeCompare(b.date));

  // Enrich each play with features, par, delta, and bombHits lookup.
  const plays = sorted.map(h => {
    const features = metaByDate[h.date];
    const globalPar = features ? predictPar(features) : null;
    const personalPar = globalPar != null ? globalPar + handicap : null;
    const delta = personalPar != null ? h.time - personalPar : null;
    const deltaGlobal = globalPar != null ? h.time - globalPar : null;
    // Find the user's own score row for bombHits
    const sameDayScores = scoresByDate[h.date] || [];
    const mine = sameDayScores.find(s => s.uid === uid && Math.abs(s.time - h.time) < 0.01);
    const bombHits = mine ? (mine.bombHits || 0) : 0;
    return { ...h, features, globalPar, personalPar, delta, deltaGlobal, bombHits };
  }).filter(p => p.features); // drop entries with no meta

  renderHeadlineCards(plays, handicap);
  renderHandicapTrajectory(plays);
  renderMoveTypeShare(plays);
  renderStrikeRate(plays);
  renderModifierHeatmap(plays);
  renderConsistency(plays);
  renderPercentileTrend(plays, scoresByDate, uid);
  renderPlayFrequency(plays);
  renderHistoryChart(plays);
}

// ── Section: Headline cards (frequency + strike rate totals) ─────

function renderHeadlineCards(plays, handicap) {
  // Handicap headline (big)
  if (plays.length >= 3) {
    const sign = handicap >= 0 ? '+' : '';
    setText('stat-handicap-now', `${sign}${handicap.toFixed(1)}s`);
  } else {
    setText('stat-handicap-now', 'Need 3+ plays');
  }

  // Strike totals
  const totalStrikes = plays.reduce((s, p) => s + p.bombHits, 0);
  const daysWithStrike = plays.filter(p => p.bombHits > 0).length;
  const strikeRatePct = plays.length > 0 ? Math.round(100 * daysWithStrike / plays.length) : 0;
  const meanStrikes = plays.length > 0 ? (totalStrikes / plays.length).toFixed(2) : '--';
  setText('stat-strike-rate', `${strikeRatePct}%`);
  setText('stat-mean-strikes', meanStrikes);
  setText('stat-total-strikes', String(totalStrikes));

  // Play frequency
  setText('stat-daily-played', String(plays.length));
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 28);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const last28 = plays.filter(p => p.date >= cutoffStr);
  const perWeek = last28.length > 0 ? (last28.length / 4).toFixed(1) : '0';
  setText('stat-daily-per-week', perWeek);
  const avgTime = plays.length > 0 ? (plays.reduce((s, p) => s + p.time, 0) / plays.length).toFixed(1) + 's' : '--';
  setText('stat-daily-avg-time', avgTime);
}

// ── Chart: Handicap trajectory ────────────────────────

function renderHandicapTrajectory(plays) {
  if (plays.length < 3) {
    replaceContent('chart-handicap-trajectory', emptyDiv('Need at least 3 plays to trace a handicap.'));
    return;
  }
  // Rolling handicap = running mean of deltaGlobal up to and including that day.
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

// ── Chart: Move-type time share (per week) ────────────

function renderMoveTypeShare(plays) {
  if (plays.length < 2) {
    replaceContent('chart-move-type-share', emptyDiv('Need at least 2 plays for the time-share chart.'));
    return;
  }
  // For each daily: time allocated to each bucket ∝ the bucket's predicted par contribution.
  // Then aggregate into weekly buckets (ISO weeks).
  const weekly = new Map(); // weekKey -> { easy, medium, hard, total }

  function weekKey(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const day = d.getDay() || 7; // Mon=1..Sun=7
    d.setDate(d.getDate() - day + 1); // Monday of that week
    return d.toISOString().slice(0, 10);
  }

  for (const p of plays) {
    const breakdown = breakdownPar(p.features);
    const byLabel = Object.fromEntries(breakdown.map(b => [b.label, b.seconds]));
    const easyPar = byLabel['easy moves'] || 0;
    const medPar  = byLabel['medium moves'] || 0;
    const hardPar = byLabel['hard moves'] || 0;
    const totalPar = easyPar + medPar + hardPar;
    if (totalPar <= 0) continue;

    // Allocate actual time proportionally
    const t = p.time;
    const easy = t * easyPar / totalPar;
    const med  = t * medPar / totalPar;
    const hard = t * hardPar / totalPar;

    const wk = weekKey(p.date);
    const entry = weekly.get(wk) || { easy: 0, medium: 0, hard: 0, n: 0 };
    entry.easy += easy;
    entry.medium += med;
    entry.hard += hard;
    entry.n += 1;
    weekly.set(wk, entry);
  }

  const weeks = [...weekly.keys()].sort();
  if (weeks.length < 2) {
    replaceContent('chart-move-type-share', emptyDiv('Need at least 2 weeks of data.'));
    return;
  }

  const series = [
    { label: 'easy',   colorClass: 'chart-area-easy',   values: weeks.map(w => weekly.get(w).easy / weekly.get(w).n) },
    { label: 'medium', colorClass: 'chart-area-medium', values: weeks.map(w => weekly.get(w).medium / weekly.get(w).n) },
    { label: 'hard',   colorClass: 'chart-area-hard',   values: weeks.map(w => weekly.get(w).hard / weekly.get(w).n) },
  ];

  const labels = weeks.map(w => shortDate(w));
  const svg = stackedAreaChart(series, labels, {
    ariaLabel: 'Move-type time share by week',
    normalize: true,
  });
  replaceContent('chart-move-type-share', svg);
}

// ── Chart: Strike rate over time (rolling 7-day) ──────

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
    ariaLabel: 'Strike rate trend',
    yDomain: [0, 100],
    yFormat: v => v + '%',
    dotClassForValue: v => v <= 20 ? 'chart-dot-good' : v >= 50 ? 'chart-dot-bad' : 'chart-dot-even',
    lineClass: 'chart-line chart-line-strike',
  });
  replaceContent('chart-strike-rate', svg);
}

// ── Chart: Delta-by-modifier heat map ─────────────────

function renderModifierHeatmap(plays) {
  if (plays.length < 6) {
    replaceContent('chart-modifier-heatmap', emptyDiv('Need more plays to detect modifier patterns.'));
    return;
  }
  // For each modifier, collect mean deltaGlobal across plays where that modifier was present.
  // Split into two windows: last 14 days vs. prior 14 days.
  const today = new Date();
  const cutoffRecent = new Date(today); cutoffRecent.setDate(cutoffRecent.getDate() - 14);
  const cutoffOld = new Date(today); cutoffOld.setDate(cutoffOld.getDate() - 28);
  const recentStr = cutoffRecent.toISOString().slice(0, 10);
  const oldStr = cutoffOld.toISOString().slice(0, 10);

  const MODIFIERS = [
    { key: 'mysteryCellCount', label: 'mystery' },
    { key: 'liarCellCount', label: 'liar' },
    { key: 'lockedCellCount', label: 'locked' },
    { key: 'wallEdgeCount', label: 'walls' },
    { key: 'wormholePairCount', label: 'wormhole' },
    { key: 'mirrorPairCount', label: 'mirror' },
    { key: 'sonarCellCount', label: 'sonar' },
    { key: 'compassCellCount', label: 'compass' },
  ];

  const recent = plays.filter(p => p.date >= recentStr);
  const prior  = plays.filter(p => p.date >= oldStr && p.date < recentStr);

  function meanDeltaWhenPresent(subset, key) {
    const rows = subset.filter(p => (p.features[key] || 0) > 0);
    if (rows.length === 0) return null;
    return {
      mean: rows.reduce((s, p) => s + p.deltaGlobal, 0) / rows.length,
      n: rows.length,
    };
  }

  const groups = [];
  for (const m of MODIFIERS) {
    const r = meanDeltaWhenPresent(recent, m.key);
    const p = meanDeltaWhenPresent(prior, m.key);
    if (!r && !p) continue;
    groups.push({
      label: m.label,
      values: [r ? r.mean : 0, p ? p.mean : 0],
      ns: [r ? r.n : 0, p ? p.n : 0],
    });
  }

  if (groups.length === 0) {
    replaceContent('chart-modifier-heatmap', emptyDiv('No modifier days in the last 28.'));
    return;
  }

  const svg = groupedBarChart(groups, ['last 14d', 'prior 14d'], {
    ariaLabel: 'Delta by modifier, recent vs. prior',
    yFormat: v => (v > 0 ? '+' : '') + Math.round(v) + 's',
    barClasses: ['chart-bar-recent', 'chart-bar-prior'],
  });
  replaceContent('chart-modifier-heatmap', svg);
}

// ── Chart: Consistency (rolling weekly IQR) ───────────

function renderConsistency(plays) {
  if (plays.length < 7) {
    replaceContent('chart-consistency', emptyDiv('Need at least 7 plays for an IQR band.'));
    return;
  }
  // Group into ISO weeks (Mon-start); need >= 3 plays per week to compute a box.
  const weekly = new Map();
  function weekKey(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const day = d.getDay() || 7;
    d.setDate(d.getDate() - day + 1);
    return d.toISOString().slice(0, 10);
  }
  for (const p of plays) {
    const wk = weekKey(p.date);
    if (!weekly.has(wk)) weekly.set(wk, []);
    weekly.get(wk).push(p.deltaGlobal);
  }

  const boxes = [];
  const weekKeys = [...weekly.keys()].sort();
  for (const wk of weekKeys) {
    const deltas = weekly.get(wk);
    if (deltas.length < 3) continue;
    const sorted = [...deltas].sort((a, b) => a - b);
    boxes.push({
      label: shortDate(wk),
      median: quantile(sorted, 0.5),
      q1: quantile(sorted, 0.25),
      q3: quantile(sorted, 0.75),
      min: sorted[0],
      max: sorted[sorted.length - 1],
    });
  }

  if (boxes.length === 0) {
    replaceContent('chart-consistency', emptyDiv('Need 3+ plays in at least one week.'));
    return;
  }
  const svg = boxChart(boxes, {
    ariaLabel: 'Weekly consistency (IQR of delta)',
    thresholdLine: 0,
    yFormat: v => (v > 0 ? '+' : '') + Math.round(v) + 's',
  });
  replaceContent('chart-consistency', svg);
}

// ── Chart: Rank-vs-field percentile trend ─────────────

function renderPercentileTrend(plays, scoresByDate, uid) {
  if (plays.length < 3) {
    replaceContent('chart-percentile-trend', emptyDiv('Need at least 3 plays.'));
    return;
  }
  const points = [];
  for (const p of plays) {
    const dayScores = scoresByDate[p.date] || [];
    // Best score per uid (for dates where someone played twice under the same uid)
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
    replaceContent('chart-percentile-trend', emptyDiv('No days with cross-player data.'));
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

// ── Chart: Play frequency (plays per week bar chart) ──

function renderPlayFrequency(plays) {
  if (plays.length === 0) {
    replaceContent('chart-play-frequency', emptyDiv('No plays yet.'));
    return;
  }
  const weekly = new Map();
  function weekKey(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const day = d.getDay() || 7;
    d.setDate(d.getDate() - day + 1);
    return d.toISOString().slice(0, 10);
  }
  for (const p of plays) {
    const wk = weekKey(p.date);
    weekly.set(wk, (weekly.get(wk) || 0) + 1);
  }
  const weeks = [...weekly.keys()].sort();
  const labels = weeks.map(w => shortDate(w));
  const values = weeks.map(w => weekly.get(w));
  const svg = barChart(labels, values, {
    ariaLabel: 'Dailies per week',
    yFormat: v => String(Math.round(v)),
    barClass: 'chart-bar-freq',
  });
  replaceContent('chart-play-frequency', svg);
}

// ── Chart: Daily history (moved from leaderboard) ─────

function renderHistoryChart(plays) {
  const entries = plays.map(p => ({
    date: p.date,
    time: p.time,
    par: p.personalPar != null ? p.personalPar : p.globalPar || 0,
    delta: p.delta != null ? p.delta : (p.deltaGlobal || 0),
  }));
  const svg = renderDailyHistoryChart(entries);
  replaceContent('chart-daily-history', svg);
}

function emptyDiv(message) {
  const d = document.createElement('div');
  d.className = 'chart-empty';
  d.textContent = message;
  return d;
}
