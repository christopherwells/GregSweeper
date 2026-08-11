// ── Greg's Journal, findings derived from the refit history ──────────
// Pure functions over the shipped modelHistory.json (one row per nightly
// Bayesian refit) and experimentTarget.json (the live mission). No DOM,
// no Firebase, no network, node-testable.
//
// A STUDY is a per-feature longitudinal track. The rows whose `target`
// is that feature mark the days Greg deliberately sent boards with
// that feature (the study days); the feature's posterior mean/sd rides along in
// EVERY row's `candidates` table, so the uncertainty trajectory is read
// from all rows, not just study days. Grouping by contiguous target
// runs would be meaningless, the refit never repeats a target within
// three days, so nearly every run has length one.
//
// Honesty rules (the same contract as gregVoice.js):
//  - The par model changed coefficient scales on 2026-07-02 (additive
//    seconds → log-multipliers, v1.6.127). An SD from before that date
//    is in different units from one after it; comparing across the
//    boundary would fabricate a huge "tightening" that never happened
//    (sonar reads 0.67 → 0.02 across the flip on ONE new score). Every
//    trajectory, verdict, and estimate therefore reads ONE consistent
//    log-scale series: rows on/after SCALE_EPOCH contribute their live
//    `candidates`; earlier rows contribute ONLY `candidatesLog`, the
//    sequential backfit's retrodiction (today's model refit on just the
//    data each date had; scripts/backfit-model-history.R). A pre-epoch
//    row's original `candidates` is seconds-scale provenance and never
//    enters a trajectory. Retrodicted points carry `retro: true`; the
//    sparkline draws them dimmer and its hover tooltip says
//    "re-measured" (the standalone caption was cut 2026-07-12,
//    disclosure copy that raises questions it doesn't answer).
//  - Retrodicted points are CHART HISTORY, never verdict inputs: a
//    sparse early feature's posterior mostly echoes its prior (sonar's
//    sd sat at prior level through Apr 24, then jumped 10x when real
//    sonar data landed; compass stayed prior-flat into June), so a
//    verdict spanning them would narrate a prior artifact as a
//    finding. classifyVerdict windows to the live era's fits only.
//  - A study with fewer than two live-era fits gets an 'early'
//    verdict, never a number.
//  - A studied feature the voice layer has no plain name for is never
//    rendered under its code name, buildJournal separates those out
//    so the UI can count them honestly without jargon.

import { featureName, featureHypothesis, classifySdDelta } from './gregVoice.js';

// The date the refit's coefficients changed meaning (seconds → log
// multipliers). If the model ever rescales again, append the new date;
// the current era always starts at the LAST epoch.
export const SCALE_EPOCHS = ['2026-07-02'];

// A study's verdict needs a real move, not day-to-day wobble: the
// yesterday note speaks at ±2%, the Journal only calls a study settled
// or widened at ±15% across the whole series.
export const VERDICT_THRESHOLD_PCT = 15;

// Resting: the model has moved on. A study rests when the refit hasn't
// targeted it for this many days AND its posterior CV is in the
// bottom half of the latest fit's uncertainty ordering, the literal
// mechanism by which the nightly target chooser spends boards elsewhere
// (the primary target is the top-CV feature). Both halves matter: an
// untargeted feature with HIGH remaining uncertainty isn't resting,
// it's waiting its turn.
export const RESTING_MIN_IDLE_DAYS = 14;

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
  zeroClusterCount: 'blank patch',
  searchMoves: 'search deduction',
  patternMoves: 'pattern read',
  totalMines: 'mine',
  cellCount: 'cell',
  // One wormLoad point is exactly one hundred worm segment-moves
  // (WORM_LOAD_SCALE), so the unit is the composite phrase and, like the
  // digit shares below, it never takes the x10 (his question 2026-08-11:
  // worms had no basis at all because the unit was never named).
  wormLoad: 'hundred worm moves',
  // Digit shares are fit ×10 (one unit = one more N among each ten revealed
  // numbers). "Numbers" is the game's own word for what a player reads on
  // the board; "clues" was solver jargon (his note, 2026-08-11).
  clueShare2: 'extra two in ten numbers',
  clueShare3: 'extra three in ten numbers',
  clueShare4: 'extra four in ten numbers',
  clueShare5plus: 'extra five-or-higher in ten numbers',
};

export function featureUnit(feature) {
  return FEATURE_UNITS[feature] || null;
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 'YYYY-MM-DD' → 'Jul 2'. Lives here (pure) because the settling
// verdict embeds it; the journal UI modules import it from here. The
// stats chart and leaderboard carry their own copies today, and
// consolidating the three is a separate cleanup.
export function formatShortDate(dateStr) {
  const parts = typeof dateStr === 'string' ? dateStr.split('-') : [];
  if (parts.length !== 3) return dateStr;
  const mo = SHORT_MONTHS[parseInt(parts[1], 10) - 1] || parts[1];
  return `${mo} ${parseInt(parts[2], 10)}`;
}

function currentEpoch() {
  return SCALE_EPOCHS[SCALE_EPOCHS.length - 1];
}

// Whole calendar days from a to b ('YYYY-MM-DD' strings), UTC-anchored
// so no timezone can shift a boundary. Null when either date is malformed.
function daysBetween(a, b) {
  const pa = typeof a === 'string' ? a.split('-').map(Number) : [];
  const pb = typeof b === 'string' ? b.split('-').map(Number) : [];
  if (pa.length !== 3 || pb.length !== 3 || pa.some(Number.isNaN) || pb.some(Number.isNaN)) return null;
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

// The row's log-scale candidates table for the unified series. Rows in
// the current era carry it natively as `candidates`; pre-epoch rows
// contribute ONLY their `candidatesLog` retrodiction (null when the
// backfit skipped that date), their original seconds-scale
// `candidates` must never be read into a trajectory.
function _logScaleTable(row, epoch) {
  if (row.date >= epoch) return { table: row.candidates, retro: false };
  return { table: Array.isArray(row.candidatesLog) ? row.candidatesLog : null, retro: true };
}

// One usable row per date, chronological. Some dates carry several
// refits (re-runs, the migration day had four); the LAST row for a date
// is the latest, matching how the file is appended. Rows without a date
// or a candidates table are useless to a finding, dropped.
export function dedupeHistory(history) {
  if (!Array.isArray(history)) return [];
  const byDate = new Map();
  for (const row of history) {
    if (!row || typeof row.date !== 'string' || !Array.isArray(row.candidates)) continue;
    byDate.set(row.date, row);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function _buildStudy(feature, rows, epoch, latestContext) {
  const studyDays = rows.filter(r => r.target === feature);

  // The unified log-scale uncertainty trajectory, the feature's entry
  // on every row holding a log-scale table for it (live candidates
  // in the current era, candidatesLog retrodictions before it).
  const trajectory = [];
  for (const row of rows) {
    const { table, retro } = _logScaleTable(row, epoch);
    if (!Array.isArray(table)) continue;
    const entry = table.find(c => c && c.feature === feature);
    if (entry && typeof entry.mean === 'number' && entry.sd > 0) {
      trajectory.push({ date: row.date, mean: entry.mean, sd: entry.sd, retro });
    }
  }

  const lastStudied = studyDays[studyDays.length - 1]?.date ?? null;
  const cvRank = latestContext.cvOrder.findIndex(c => c.feature === feature);
  const study = {
    id: feature,
    feature,
    label: featureName(feature),
    unit: featureUnit(feature),
    hypothesis: featureHypothesis(feature),
    firstStudied: studyDays[0]?.date ?? null,
    lastStudied,
    studyDayCount: studyDays.length,
    allBackfilled: studyDays.length > 0 && studyDays.every(r => r.backfilled === true),
    trajectory,
    latest: trajectory[trajectory.length - 1] ?? null,
    // Resting inputs, both anchored to the LATEST refit (never the wall
    // clock, so the derivation is deterministic): how long since the
    // experiment last targeted this feature, and where its uncertainty
    // ranks in the latest fit's CV ordering (0 = the widest, i.e. what
    // the target chooser picks next).
    daysIdle: lastStudied ? daysBetween(lastStudied, latestContext.date) : null,
    cvRank: cvRank >= 0 ? cvRank : null,
    cvCount: latestContext.cvOrder.length,
  };
  study.verdict = classifyVerdict(study);
  return study;
}

function _latestContext(rows) {
  const latestRow = rows[rows.length - 1];
  return {
    date: latestRow.date,
    // The latest fit's uncertainty ordering, sorted here rather than
    // trusting file order, so cvRank can't drift if a writer ever emits
    // the table unsorted.
    cvOrder: latestRow.candidates
      .filter(c => c && typeof c.cv === 'number' && typeof c.feature === 'string')
      .slice()
      .sort((a, b) => b.cv - a.cv),
  };
}

// Every feature the refit has ever deliberately targeted, each as a
// full longitudinal study, in first-targeted order. Includes unnamed
// features, buildJournal decides what is renderable.
export function deriveStudies(history) {
  const rows = dedupeHistory(history);
  if (rows.length === 0) return [];
  const epoch = currentEpoch();
  const latestContext = _latestContext(rows);
  const targets = [];
  const seen = new Set();
  for (const row of rows) {
    if (typeof row.target === 'string' && row.target && !seen.has(row.target)) {
      seen.add(row.target);
      targets.push(row.target);
    }
  }
  return targets.map(f => _buildStudy(f, rows, epoch, latestContext));
}

// A study for ANY feature, targeted or not. The live experiment target
// can be a feature the refit has never targeted before (its first
// stamped row lands with the next nightly run), but its posterior
// rides in every row's candidates table, so the trajectory and
// estimate are real; only the study-day facts are empty. The notebook's
// active card uses this so a fresh target still gets an honest page.
export function deriveStudyForFeature(history, feature) {
  if (typeof feature !== 'string' || !feature) return null;
  const rows = dedupeHistory(history);
  if (rows.length === 0) return null;
  return _buildStudy(feature, rows, currentEpoch(), _latestContext(rows));
}

// The study's verdict, windowed to the LIVE model era (non-retro fits
// only). Retrodicted points are chart history, never verdict inputs: on
// a date with little usable signal, the fit's posterior mostly echoes
// its prior, so a first-to-last comparison spanning retrodictions would
// narrate a prior artifact as a finding. The kinds:
//   settling, the estimate tightened past the threshold (the study is working)
//   widened , more data brought MORE spread (a finding, published like any other)
//   resting , untargeted for weeks AND low on the latest fit's CV ordering;
//              the experiment is deliberately spending its boards elsewhere.
//              Never shown over a widened study (a widening picture is not
//              "sure enough"), and carries no number.
//   open    , moved less than the threshold either way
//   early   , fewer than two live-era fits; no number, ever
// The copy is Greg's first person, plain register, no em-dashes
// (Christopher's voice ruling, 2026-07-12). It never names the feature
// (the card header does) and never claims the MECHANISM was confirmed,
// narrowing proves the estimate is settling, not that Greg's hunch
// about why was right. The settling verdict names its window's REAL
// start date (the first live-era fit) so it can never be misread
// against the card's study-start line or the sparkline's longer reach.
export function classifyVerdict(study) {
  const t = Array.isArray(study?.trajectory) ? study.trajectory : [];
  const w = t.filter(p => p && p.retro !== true);
  if (w.length < 2) {
    return {
      kind: 'early',
      deltaPct: null,
      copy: 'It’s too soon to say. I’ve only just started measuring this one.',
    };
  }
  const first = w[0];
  const last = w[w.length - 1];
  const delta = classifySdDelta(first.sd, last.sd, VERDICT_THRESHOLD_PCT);
  if (delta.kind === 'widened') {
    return {
      kind: 'widened',
      deltaPct: delta.deltaPct,
      copy: `My range got ${Math.abs(delta.deltaPct)}% WIDER. More plays brought less certainty. That’s a real finding too: this one is messier than I thought.`,
    };
  }
  // Resting takes the card over settling/open: the chip explains why no
  // new boards include this feature. The tightening story is still on the
  // sparkline and the estimate line; nothing is hidden, and deltaPct is
  // null because the resting copy claims no number.
  if (
    typeof study.daysIdle === 'number' && study.daysIdle >= RESTING_MIN_IDLE_DAYS
    && typeof study.cvRank === 'number' && study.cvCount > 0
    && study.cvRank >= Math.ceil(study.cvCount / 2)
  ) {
    return {
      kind: 'resting',
      deltaPct: null,
      copy: 'I’m sure enough about this one to spend my boards elsewhere.',
    };
  }
  if (delta.kind === 'tightened') {
    return {
      kind: 'settling',
      deltaPct: delta.deltaPct,
      copy: `I’m closing in: my range for this has narrowed ${delta.deltaPct}% since ${formatShortDate(first.date)}.`,
    };
  }
  return {
    kind: 'open',
    deltaPct: delta.deltaPct,
    copy: 'There’s no verdict yet. The numbers have barely moved. More boards will settle it.',
  };
}

// The current fitted effect as plain percentages: the model is
// log-scale in the current era (that is what SCALE_EPOCHS marks), so a
// coefficient is a log-multiplier and exp(coef) − 1 is "percent added
// per unit". lo/hi are the ±1 SD band, the give-or-take the card must
// always show alongside the point estimate. Null when the study has no
// era fits yet.
// PER-TEN-TILES SCALING (his ask 2026-08-11, tightened the same day:
// "I'd prefer if all are on a 10 tile basis"). EVERY estimate is quoted
// per TEN units, uniformly, so no two journal surfaces quote the same
// feature on different bases. Exact on the log scale, never
// approximated: the model's own prediction for ten more units is
// exp(10 x coef), which is what a reader would check it against in R,
// and which compounds rather than multiplying (ten of a strong feature
// reads large, and that is the model's honest claim, not an error).
// The one exemption is the digit shares, whose unit is already the
// composite "one extra N in ten numbers"; ten of those is not a quantity
// a board can contain.
const COMPOSITE_UNIT_FEATURES = new Set(['wormLoad']);
export function featureScaleOf(feature) {
  const f = String(feature || '');
  if (f.startsWith('clueShare') || COMPOSITE_UNIT_FEATURES.has(f)) return 1;
  return 10;
}

function estimateScale(study) {
  if (!study?.latest) return 1;
  return featureScaleOf(study?.feature);
}

// All FEATURE_UNITS nouns pluralize regularly (cell, pair, wall, area,
// deduction, read, mine), so the phrase is "ten " + unit + "s".
function pluralUnit(unit) {
  return `${unit}s`;
}

/** The display unit phrase, scale included: "sonar cell" or "ten sonar cells". */
export function estimateUnit(study) {
  const unit = study?.unit;
  if (!unit) return null;
  return estimateScale(study) === 10 ? `ten ${pluralUnit(unit)}` : unit;
}

export function estimateSummary(study) {
  const latest = study?.latest;
  if (!latest) return null;
  const scale = estimateScale(study);
  const pct = (x) => (Math.exp(x * scale) - 1) * 100;
  return {
    pct: pct(latest.mean),
    lo: pct(latest.mean - latest.sd),
    hi: pct(latest.mean + latest.sd),
    asOf: latest.date,
    scale,
  };
}

// Percent formatting for player surfaces (Christopher's ruling,
// 2026-07-12): whole percents, tenths on five players' data are false
// precision, except below 1%, where a whole number would read as
// exactly zero or exactly one; there a single decimal survives ("about
// 0.3%"). A positive value that would still render "0.0" floors at
// "0.1", "about 0.1%" stays honest where "0%" would claim a certainty
// the fit doesn't have.
export function fmtPct(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  if (Math.abs(x) >= 0.95) return String(Math.round(x));
  const one = x.toFixed(1);
  if (one === '0.0' || one === '-0.0') return x > 0 ? '0.1' : '0';
  return one;
}

// The estimate as ONE plain sentence (Greg's plain register, no
// em-dashes, at most one hedge word). When the ±1 SD band dips to or
// below zero the honest reading is "between 0% and about X%", tiny
// effects (liar cells today) must never render as a fake negative, the
// old two-sentence hedge stack read as fake, and the bound is spoken
// as the number 0%, never "nothing" (Christopher's ruling, 2026-07-12).
// Null when there is no era estimate or no unit vocabulary.
export function estimateLine(study) {
  const est = estimateSummary(study);
  const unit = study?.unit;
  if (!est || !unit) return null;
  // At scale ten the subject is a quantity ("ten sonar cells"), so the
  // verbs go plural; at scale one it stays the classic "each sonar cell".
  const ten = est.scale === 10;
  const subj = ten ? `Ten ${pluralUnit(unit)}` : `Each ${unit}`;
  const add = ten ? 'add' : 'adds';
  const seem = ten ? 'seem' : 'seems';
  if (est.hi <= 0) {
    // A whole band below zero (no live example yet): the honest claim
    // is a small time refund, flagged as one Greg is re-checking.
    return `${subj} ${seem} to give a little time back, about ${fmtPct(Math.abs(est.pct))}%. I’m double-checking that.`;
  }
  if (est.lo <= 0) {
    return `${subj} ${add} somewhere between 0% and about ${fmtPct(est.hi)}% to your time.`;
  }
  const loStr = fmtPct(est.lo);
  const hiStr = fmtPct(est.hi);
  if (loStr === hiStr) {
    // Both band ends round to the same figure (mine density today),
    // "likely between 6% and 6%" is not a sentence.
    return `${subj} ${add} about ${fmtPct(est.pct)}% to your time, and the band barely strays from that.`;
  }
  return `${subj} ${add} about ${fmtPct(est.pct)}% to your time, likely between ${loStr}% and ${hiStr}%.`;
}

// The full-ledger table: every NAMED feature in the latest fit's
// candidates as a compact effect + range row, sorted by effect size.
// This is the "full parameter picture" behind the notebook's one link,
// never-targeted features (board size, mine density) appear here even
// though no study exists for them. A band straddling zero shows a
// floor of 0% (same no-fake-negatives rule as estimateLine); the
// whole-band-negative shape renders as time saved.
export function parameterTable(history) {
  const rows = dedupeHistory(history);
  // Same scale rail as every other surface: a pre-epoch row's candidates
  // are seconds-scale and exponentiating them fabricates garbage (+348%
  // mine density), so the table reads the latest LIVE-ERA row or nothing
  // (reachable when a stale cached history ends before the epoch).
  const epoch = currentEpoch();
  const liveRows = rows.filter(r => r.date >= epoch);
  // Walk BACK to the most recent row holding a real fit. A
  // diagnostics-rejected refit appends a thin fallback row with an EMPTY
  // candidates list (method seed-residuals, the safety gate keeping the
  // previous model), and because dedupeHistory keeps the LAST row per date,
  // one rejected re-run can shadow the same day's good fit. Reading that row
  // blanked the whole parameter ledger the first night it happened
  // (2026-08-01, the rejected run after the per-shape rework): the table
  // must show the last real fit, not an empty page for a night the gate did
  // its job.
  let last = null;
  for (let i = liveRows.length - 1; i >= 0; i--) {
    if (liveRows[i].candidates.length > 0) { last = liveRows[i]; break; }
  }
  if (!last) return [];
  const out = [];
  for (const c of last.candidates) {
    if (!c || typeof c.feature !== 'string' || typeof c.mean !== 'number' || !(c.sd > 0)) continue;
    const label = featureName(c.feature);
    if (!label) continue;
    // The same per-ten basis as every estimate line, and the row SAYS its
    // basis (his report, 2026-08-11: "I'm not seeing any indication that
    // the full ledger is by 10 tiles"): `per` is the phrase the renderer
    // prints under the feature name.
    const scale = featureScaleOf(c.feature);
    const unit = featureUnit(c.feature);
    const pct = (Math.exp(c.mean * scale) - 1) * 100;
    const lo = (Math.exp((c.mean - c.sd) * scale) - 1) * 100;
    const hi = (Math.exp((c.mean + c.sd) * scale) - 1) * 100;
    const row = {
      feature: c.feature, label, pctValue: pct,
      // The ten-tile basis is the default and the table note states it
      // once; a per-row line appears only where the basis DIFFERS (the
      // clue mixes, worm moves), his 2026-08-11 note that repeating
      // "per ten X" under every label reads as noise.
      per: scale === 10 || !unit ? null : `per ${unit}`,
    };
    if (hi <= 0) {
      row.effect = `saves ${fmtPct(Math.abs(pct))}%`;
      const hiStr = fmtPct(Math.abs(hi));
      const loStr = fmtPct(Math.abs(lo));
      row.range = hiStr === loStr ? `about ${hiStr}% saved` : `${hiStr}% to ${loStr}% saved`;
    } else {
      row.effect = `+${fmtPct(Math.max(0, pct))}%`;
      const loStr = fmtPct(Math.max(0, lo));
      const hiStr = fmtPct(hi);
      // A band whose ends round to the same figure (mine density today)
      // must not read "6% to 6%".
      row.range = loStr === hiStr ? `about ${hiStr}%` : `${loStr}% to ${hiStr}%`;
    }
    out.push(row);
  }
  out.sort((a, b) => b.pctValue - a.pctValue);
  return out;
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
    // The live study, null when the target is unnamed (no jargon on a
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
// NAMED features are shareable; anything else is null, so a mistyped or
// unknown id falls back gracefully. A named feature the refit has never
// targeted still resolves (via deriveStudyForFeature), the active card
// can be exactly that study on a fresh target's first day, and its
// Share button must not dead-end on the recipient.
export function findingById(history, id) {
  if (typeof id !== 'string' || !id || !featureName(id)) return null;
  const study = deriveStudies(history).find(s => s.feature === id)
    || deriveStudyForFeature(history, id);
  return study && study.label ? study : null;
}
