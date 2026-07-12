// ── Greg's Journal — findings derived from the refit history ──────────
// Pure functions over the shipped modelHistory.json (one row per nightly
// Bayesian refit) and experimentTarget.json (the live mission). No DOM,
// no Firebase, no network — node-testable.
//
// A STUDY is a per-feature longitudinal track. The rows whose `target`
// is that feature mark the days Greg deliberately sent boards carrying
// it (the study days); the feature's posterior mean/sd rides along in
// EVERY row's `candidates` table, so the uncertainty trajectory is read
// from all rows, not just study days. Grouping by contiguous target
// runs would be meaningless — the refit never repeats a target within
// three days, so nearly every run has length one.
//
// Honesty rules (the same contract as gregVoice.js):
//  - The par model changed coefficient scales on 2026-07-02 (additive
//    seconds → log-multipliers, v1.6.127). An SD from before that date
//    is in different units from one after it; comparing across the
//    boundary would fabricate a huge "tightening" that never happened
//    (sonar reads 0.67 → 0.02 across the flip on ONE new score). Every
//    trajectory, verdict, and estimate is therefore scoped to rows on
//    or after SCALE_EPOCH.
//  - A study with fewer than two current-era fits gets an 'early'
//    verdict, never a number.
//  - A studied feature the voice layer has no plain name for is never
//    rendered under its code name — buildJournal separates those out
//    so the UI can count them honestly without jargon.

import { featureName, featureHypothesis, classifySdDelta } from './gregVoice.js';

// The date the refit's coefficients changed meaning (seconds → log
// multipliers). If the model ever rescales again, append the new date;
// the current era always starts at the LAST epoch.
export const SCALE_EPOCHS = ['2026-07-02'];

// A study's verdict needs a real move, not day-to-day wobble: the
// yesterday note speaks at ±2%, the Journal only calls a study settled
// or widened at ±15% across the whole era.
export const VERDICT_THRESHOLD_PCT = 15;

// What one unit of each feature is, for the estimate line ("per compass
// cell"). Display vocabulary, deliberately parallel to FEATURE_NAMES.
const FEATURE_UNITS = {
  lockedCellCount: 'locked cell',
  sonarCellCount: 'sonar cell',
  compassCellCount: 'compass cell',
  mirrorPairCount: 'mirror pair',
  liarCellCount: 'liar cell',
  mysteryCellCount: 'mystery cell',
  wormholePairCount: 'wormhole pair',
  wallEdgeCount: 'wall',
  zeroClusterCount: 'open area',
  searchMoves: 'search deduction',
  patternMoves: 'pattern read',
  totalMines: 'mine',
  cellCount: 'cell',
};

export function featureUnit(feature) {
  return FEATURE_UNITS[feature] || null;
}

function currentEpoch() {
  return SCALE_EPOCHS[SCALE_EPOCHS.length - 1];
}

// One usable row per date, chronological. Some dates carry several
// refits (re-runs, the migration day had four); the LAST row for a date
// is the latest, matching how the file is appended. Rows without a date
// or a candidates table carry nothing a finding can cite — dropped.
export function dedupeHistory(history) {
  if (!Array.isArray(history)) return [];
  const byDate = new Map();
  for (const row of history) {
    if (!row || typeof row.date !== 'string' || !Array.isArray(row.candidates)) continue;
    byDate.set(row.date, row);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function _buildStudy(feature, rows, eraRows) {
  const studyDays = rows.filter(r => r.target === feature);

  // Current-era uncertainty trajectory — the feature's own candidates
  // entry on every era row that carries one.
  const trajectory = [];
  for (const row of eraRows) {
    const entry = row.candidates.find(c => c && c.feature === feature);
    if (entry && typeof entry.mean === 'number' && entry.sd > 0) {
      trajectory.push({ date: row.date, mean: entry.mean, sd: entry.sd });
    }
  }

  const study = {
    id: feature,
    feature,
    label: featureName(feature),
    unit: featureUnit(feature),
    hypothesis: featureHypothesis(feature),
    firstStudied: studyDays[0]?.date ?? null,
    lastStudied: studyDays[studyDays.length - 1]?.date ?? null,
    studyDayCount: studyDays.length,
    allBackfilled: studyDays.length > 0 && studyDays.every(r => r.backfilled === true),
    trajectory,
    latest: trajectory[trajectory.length - 1] ?? null,
  };
  study.verdict = classifyVerdict(study);
  return study;
}

// Every feature the refit has ever deliberately targeted, each as a
// full longitudinal study, in first-targeted order. Includes unnamed
// features — buildJournal decides what is renderable.
export function deriveStudies(history) {
  const rows = dedupeHistory(history);
  if (rows.length === 0) return [];
  const epoch = currentEpoch();
  const eraRows = rows.filter(r => r.date >= epoch);
  const targets = [];
  const seen = new Set();
  for (const row of rows) {
    if (typeof row.target === 'string' && row.target && !seen.has(row.target)) {
      seen.add(row.target);
      targets.push(row.target);
    }
  }
  return targets.map(f => _buildStudy(f, rows, eraRows));
}

// The study's verdict, from the era-scoped trajectory only. The kinds:
//   settling — the estimate tightened past the threshold (the study is working)
//   widened  — more data brought MORE spread (a finding, published like any other)
//   open     — moved less than the threshold either way
//   early    — fewer than two fits on the current model; no number, ever
// The copy is Greg's first person, plain register, no em-dashes
// (Christopher's voice ruling, 2026-07-12). It never names the feature
// (the card header does) and never claims the MECHANISM was confirmed —
// narrowing proves the estimate is settling, not that Greg's hunch
// about why was right. "Since I started measuring" means this
// measurement series: the scale change restarted the clock, and the
// trajectory only exists inside the current era.
export function classifyVerdict(study) {
  const t = study?.trajectory;
  if (!Array.isArray(t) || t.length < 2) {
    return {
      kind: 'early',
      deltaPct: null,
      copy: 'Too soon to say. I’ve only just started measuring this one.',
    };
  }
  const first = t[0];
  const last = t[t.length - 1];
  const delta = classifySdDelta(first.sd, last.sd, VERDICT_THRESHOLD_PCT);
  if (delta.kind === 'tightened') {
    return {
      kind: 'settling',
      deltaPct: delta.deltaPct,
      copy: `I’m closing in: my range for this has narrowed ${delta.deltaPct}% since I started measuring.`,
    };
  }
  if (delta.kind === 'widened') {
    return {
      kind: 'widened',
      deltaPct: delta.deltaPct,
      copy: `My range got ${Math.abs(delta.deltaPct)}% WIDER. More plays, less certainty. That’s a real finding too: this one is messier than I thought.`,
    };
  }
  return {
    kind: 'open',
    deltaPct: delta.deltaPct,
    copy: 'No verdict yet. The numbers have barely budged. More boards will settle it.',
  };
}

// The current fitted effect as plain percentages: the model is
// log-scale in the current era (that is what SCALE_EPOCHS marks), so a
// coefficient is a log-multiplier and exp(coef) − 1 is "percent added
// per unit". lo/hi are the ±1 SD band — the give-or-take the card must
// always show alongside the point estimate. Null when the study has no
// era fits yet.
export function estimateSummary(study) {
  const latest = study?.latest;
  if (!latest) return null;
  const pct = (x) => (Math.exp(x) - 1) * 100;
  return {
    pct: pct(latest.mean),
    lo: pct(latest.mean - latest.sd),
    hi: pct(latest.mean + latest.sd),
    asOf: latest.date,
  };
}

// The estimate as one plain sentence (Greg's plain register, no
// em-dashes). When the ±1 SD band dips to or below zero the honest
// reading is "or nothing at all" — tiny effects (liar cells today) must
// never render as a fake negative. "Probably no more than" is the +1 SD
// point (~84% of the posterior sits below it): a probable edge, never
// "at most", which would claim a bound the fit does not prove. Null
// when there is no era estimate or no unit vocabulary.
export function estimateLine(study) {
  const est = estimateSummary(study);
  const unit = study?.unit;
  if (!est || !unit) return null;
  const f = (x) => x.toFixed(1);
  if (est.lo <= 0) {
    return `Each ${unit} might add about ${f(est.pct)}% to your time, or nothing at all. Probably no more than ${f(est.hi)}%.`;
  }
  return `Each ${unit} adds about ${f(est.pct)}% to your time. Could be as little as ${f(est.lo)}%, maybe as much as ${f(est.hi)}%.`;
}

// The whole journal, ready to render: named studies newest-first, the
// live open study (from experimentTarget.json's target), the honest
// count of studied-but-unnamed features, and the latest refit's
// meta line. `experimentMeta` is the loadExperimentTarget() result.
export function buildJournal(history, experimentMeta) {
  const rows = dedupeHistory(history);
  const studies = deriveStudies(history);
  const named = studies
    .filter(s => s.label)
    .sort((a, b) => (b.lastStudied || '').localeCompare(a.lastStudied || ''));
  const unnamedCount = studies.length - named.length;

  const lastRow = rows[rows.length - 1] ?? null;
  const openTarget = typeof experimentMeta?.target === 'string' ? experimentMeta.target : null;
  const openLabel = openTarget ? featureName(openTarget) : null;

  return {
    studies: named,
    unnamedCount,
    // The live study — null when the target is unnamed (no jargon on a
    // player surface) or when no target is loaded.
    open: openTarget && openLabel
      ? {
        feature: openTarget,
        label: openLabel,
        hypothesis: featureHypothesis(openTarget),
        study: studies.find(s => s.feature === openTarget) ?? null,
      }
      : null,
    meta: lastRow
      ? {
        lastRefitDate: lastRow.date,
        totalRuns: typeof lastRow.n_scores === 'number' ? lastRow.n_scores : null,
        nPlayers: typeof lastRow.n_players === 'number' ? lastRow.n_players : null,
        fitOk: lastRow.method === 'brms-ranef',
      }
      : null,
  };
}

// Resolve a shareable finding id (the feature key) to its study. Only
// named studies are shareable surfaces; anything else is null, so a
// mistyped or unknown id can fall back gracefully.
export function findingById(history, id) {
  if (typeof id !== 'string' || !id) return null;
  const study = deriveStudies(history).find(s => s.feature === id);
  return study && study.label ? study : null;
}
