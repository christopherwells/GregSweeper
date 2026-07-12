// Greg's Journal — findings derived from the refit history. The core
// honesty contract under test: the par model changed coefficient scales
// on 2026-07-02 (additive seconds → log-multipliers), so an SD from one
// era is in different units from the other. A naive start-vs-end
// comparison across the flip reads as a ~97% "tightening" that never
// happened — every verdict must be scoped to the current era only.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  SCALE_EPOCHS, VERDICT_THRESHOLD_PCT,
  dedupeHistory, deriveStudies, classifyVerdict, estimateSummary, estimateLine,
  buildJournal, findingById, featureUnit,
} = await import('../src/logic/journalFindings.js');

// Fixture rows. Dates on/after 2026-07-02 are current-era (log scale);
// earlier dates are the old seconds scale.
const row = (date, target, candidates, over = {}) => ({
  date,
  updatedAt: `${date}T15:00:00Z`,
  method: 'brms-ranef',
  n_scores: 100,
  n_players: 4,
  target,
  candidates,
  ...over,
});
const cand = (feature, mean, sd) => ({ feature, mean, sd, cv: sd / Math.abs(mean) });

test('dedupeHistory keeps the last row per date, sorted, and drops unusable rows', () => {
  const early = row('2026-07-02', 'sonarCellCount', [cand('sonarCellCount', 0.04, 0.030)]);
  const later = row('2026-07-02', 'sonarCellCount', [cand('sonarCellCount', 0.04, 0.020)]);
  const other = row('2026-07-01', 'sonarCellCount', [cand('sonarCellCount', 0.7, 0.68)]);
  const out = dedupeHistory([early, later, other, null, { date: '2026-07-03' } /* no candidates */]);
  assert.equal(out.length, 2);
  assert.equal(out[0].date, '2026-07-01');
  assert.equal(out[1].candidates[0].sd, 0.020, 'last row for a duplicated date wins');
  assert.deepEqual(dedupeHistory(null), []);
});

test('REGRESSION: the 2026-07-02 scale flip can never be read as a tightening', () => {
  // Sonar's real shape: SD ~0.67 on the seconds scale, ~0.02 on the log
  // scale the very next day. Cross-era comparison would report ~97%
  // tightened; the era-scoped verdict must say "early" (one era fit).
  const history = [
    row('2026-06-30', 'sonarCellCount', [cand('sonarCellCount', 0.71, 0.64)]),
    row('2026-07-01', 'compassCellCount', [cand('sonarCellCount', 0.70, 0.67)]),
    row('2026-07-02', 'sonarCellCount', [cand('sonarCellCount', 0.043, 0.020)]),
  ];
  const study = deriveStudies(history).find(s => s.feature === 'sonarCellCount');
  assert.equal(study.trajectory.length, 1, 'pre-epoch rows must not enter the trajectory');
  assert.equal(study.verdict.kind, 'early');
  assert.equal(study.verdict.deltaPct, null, 'an early study never carries a number');
  // The study still remembers its full history as narrative facts.
  assert.equal(study.firstStudied, '2026-06-30');
  assert.equal(study.studyDayCount, 2);
});

test('verdict branches: settling / widened / open at the ±15% era bar', () => {
  const mk = (sdStart, sdEnd) => classifyVerdict({
    trajectory: [
      { date: '2026-07-02', mean: 0.03, sd: sdStart },
      { date: '2026-07-05', mean: 0.03, sd: (sdStart + sdEnd) / 2 },
      { date: '2026-07-10', mean: 0.03, sd: sdEnd },
    ],
  });
  assert.equal(VERDICT_THRESHOLD_PCT, 15);

  const settling = mk(0.020, 0.016); // -20% spread
  assert.equal(settling.kind, 'settling');
  assert.equal(settling.deltaPct, 20);
  assert.match(settling.copy, /tightened 20%/);
  // Honesty: settling speaks about the ESTIMATE, never confirms the mechanism.
  assert.ok(!/confirm/i.test(settling.copy));

  const widened = mk(0.020, 0.024); // +20% spread — published, not hidden
  assert.equal(widened.kind, 'widened');
  assert.match(widened.copy, /WIDENED by 20%/);
  assert.match(widened.copy, /finding too/i);

  const open = mk(0.020, 0.0195); // ~2%, inside the bar
  assert.equal(open.kind, 'open');
  assert.match(open.copy, /barely moved/);

  // Fewer than two era fits → early, no number.
  assert.equal(classifyVerdict({ trajectory: [{ date: '2026-07-02', mean: 0.03, sd: 0.02 }] }).kind, 'early');
  assert.equal(classifyVerdict(null).kind, 'early');
});

test('unnamed features derive a study but never reach a player surface', () => {
  const history = [
    row('2026-07-02', 'fragmentationRatio', [
      cand('fragmentationRatio', 0.02, 0.015),
      cand('sonarCellCount', 0.043, 0.020),
    ]),
    row('2026-07-03', 'sonarCellCount', [
      cand('fragmentationRatio', 0.02, 0.014),
      cand('sonarCellCount', 0.043, 0.019),
    ]),
  ];
  const studies = deriveStudies(history);
  const frag = studies.find(s => s.feature === 'fragmentationRatio');
  assert.ok(frag, 'the study exists');
  assert.equal(frag.label, null, 'no plain name — no fabricated one either');
  assert.match(frag.hypothesis, /experimental board measure/);

  const journal = buildJournal(history, { target: 'sonarCellCount' });
  assert.ok(!journal.studies.some(s => s.feature === 'fragmentationRatio'));
  assert.equal(journal.unnamedCount, 1);
  assert.equal(findingById(history, 'fragmentationRatio'), null, 'unnamed ids are not shareable');
  assert.equal(findingById(history, 'sonarCellCount')?.feature, 'sonarCellCount');
  assert.equal(findingById(history, 'nonsense'), null);
});

test('estimateSummary converts log coefficients to plain percentages with a ±1 SD band', () => {
  const study = {
    latest: { date: '2026-07-12', mean: 0.0329, sd: 0.0189 },
  };
  const est = estimateSummary(study);
  // exp(0.0329) − 1 ≈ 3.34% per unit; the band must bracket it.
  assert.ok(Math.abs(est.pct - 3.34) < 0.05, `pct ${est.pct}`);
  assert.ok(est.lo < est.pct && est.pct < est.hi);
  assert.ok(Math.abs(est.lo - 1.41) < 0.05, `lo ${est.lo}`);
  assert.ok(Math.abs(est.hi - 5.31) < 0.05, `hi ${est.hi}`);
  assert.equal(est.asOf, '2026-07-12');
  assert.equal(estimateSummary({ latest: null }), null, 'no era fits → no estimate, never a fabricated one');
});

test('estimateLine: a band touching zero reads as "possibly nothing", never a fake negative', () => {
  // Liar cells today: mean 0.0015 ± 0.0019 → the band dips below zero.
  const tiny = estimateLine({ unit: 'liar cell', latest: { date: '2026-07-12', mean: 0.0015, sd: 0.0019 } });
  assert.match(tiny, /possibly nothing at all/);
  assert.ok(!tiny.includes('-'), `no negative percentages on a player surface: "${tiny}"`);
  // A clearly-positive band reads as give-or-take.
  const solid = estimateLine({ unit: 'compass cell', latest: { date: '2026-07-12', mean: 0.0329, sd: 0.0189 } });
  assert.match(solid, /Each compass cell adds about 3\.3% to a solve, give or take \(1\.4%–5\.3%\)\./);
  assert.equal(estimateLine({ unit: 'compass cell', latest: null }), null);
  assert.equal(estimateLine({ unit: null, latest: { date: 'x', mean: 0.03, sd: 0.01 } }), null);
});

test('buildJournal: open study from the live target, unnamed target suppressed', () => {
  const history = [
    row('2026-07-02', 'sonarCellCount', [cand('sonarCellCount', 0.043, 0.020)]),
    row('2026-07-03', 'compassCellCount', [
      cand('sonarCellCount', 0.043, 0.019),
      cand('compassCellCount', 0.033, 0.019),
    ]),
  ];
  const journal = buildJournal(history, { target: 'compassCellCount' });
  assert.equal(journal.open.label, 'compass');
  assert.ok(journal.open.hypothesis.length > 20);
  assert.equal(journal.open.study.feature, 'compassCellCount');
  assert.equal(journal.meta.fitOk, true);
  // Unnamed or missing target → no open card, never jargon.
  assert.equal(buildJournal(history, { target: 'fragmentationRatio' }).open, null);
  assert.equal(buildJournal(history, null).open, null);
  // A rejected latest fit is reported, not hidden.
  const rejected = buildJournal(
    [...history, row('2026-07-04', 'sonarCellCount', [cand('sonarCellCount', 0.05, 0.02)], { method: 'seed-residuals' })],
    null,
  );
  assert.equal(rejected.meta.fitOk, false);
});

test('smoke: the real modelHistory.json derives a sane journal (structural invariants only)', () => {
  const real = JSON.parse(readFileSync(new URL('../src/logic/modelHistory.json', import.meta.url), 'utf8'));
  const journal = buildJournal(real, null);

  // Structure, not counts — the file grows nightly.
  assert.ok(journal.studies.length >= 8, `named studies: ${journal.studies.length}`);
  const features = journal.studies.map(s => s.feature);
  assert.ok(features.includes('compassCellCount'));
  assert.ok(features.includes('sonarCellCount'));
  assert.ok(journal.meta.totalRuns > 200);

  const epoch = SCALE_EPOCHS[SCALE_EPOCHS.length - 1];
  const kinds = new Set(['settling', 'widened', 'open', 'early']);
  for (const s of journal.studies) {
    assert.ok(s.label, `${s.feature} has a plain name`);
    assert.ok(s.hypothesis && !/[A-Z][a-z]+Count/.test(s.hypothesis), `${s.feature} hypothesis is plain language`);
    assert.ok(kinds.has(s.verdict.kind), `${s.feature} verdict ${s.verdict.kind}`);
    for (const p of s.trajectory) {
      assert.ok(p.date >= epoch, `${s.feature} trajectory leaked a pre-epoch row (${p.date})`);
    }
    // The verdict's number must match SD math computed independently here.
    if (s.trajectory.length >= 2 && s.verdict.deltaPct !== null) {
      const sd0 = s.trajectory[0].sd;
      const sd1 = s.trajectory[s.trajectory.length - 1].sd;
      assert.equal(s.verdict.deltaPct, Math.round(((sd0 - sd1) / sd0) * 100), `${s.feature} deltaPct`);
    }
    // Estimates exist for every named study with era fits, with a sane band.
    const est = estimateSummary(s);
    if (s.latest) {
      assert.ok(est.lo < est.pct && est.pct < est.hi, `${s.feature} estimate band`);
    }
  }

  // fragmentationRatio (the one historical unnamed target) only ever
  // appeared as a superseded same-day rerun on 2026-04-26, so
  // last-row-per-date dedupe correctly erases it: on today's data the
  // unnamed count is 0. The fixture test above pins the >0 path.
  assert.ok(Number.isInteger(journal.unnamedCount) && journal.unnamedCount >= 0);
});

test('featureUnit covers every named model feature', () => {
  for (const f of ['lockedCellCount', 'sonarCellCount', 'compassCellCount', 'mirrorPairCount',
    'liarCellCount', 'mysteryCellCount', 'wormholePairCount', 'wallEdgeCount',
    'zeroClusterCount', 'searchMoves', 'patternMoves', 'totalMines', 'cellCount']) {
    assert.ok(featureUnit(f), `missing unit for ${f}`);
  }
});
