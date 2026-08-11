// Greg's Journal — findings derived from the refit history. The core
// honesty contract under test: the par model changed coefficient scales
// on 2026-07-02 (additive seconds → log-multipliers), so an SD from one
// era is in different units from the other. A naive start-vs-end
// comparison across the flip reads as a ~97% "tightening" that never
// happened — every trajectory therefore reads ONE consistent log-scale
// series: live `candidates` on/after the epoch, the sequential
// backfit's `candidatesLog` retrodiction before it, and a pre-epoch
// row's original seconds-scale `candidates` NEVER. Retrodicted points
// are chart history only: a sparse date's posterior mostly echoes its
// prior, so verdict sentences stay windowed to the live era's fits.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  SCALE_EPOCHS, VERDICT_THRESHOLD_PCT, RESTING_MIN_IDLE_DAYS,
  dedupeHistory, deriveStudies, deriveStudyForFeature, classifyVerdict,
  estimateSummary, estimateLine, fmtPct, parameterTable,
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
  // The window names its REAL start date (the trajectory's first fit),
  // never a vague "since I started measuring" that could be misread
  // against the card's study-start line.
  assert.match(settling.copy, /narrowed 20% since Jul 2\./);
  // Honesty: settling speaks about the ESTIMATE, never confirms the mechanism.
  assert.ok(!/confirm/i.test(settling.copy));

  const widened = mk(0.020, 0.024); // +20% spread — published, not hidden
  assert.equal(widened.kind, 'widened');
  assert.match(widened.copy, /20% WIDER/);
  assert.match(widened.copy, /finding too/i);

  const open = mk(0.020, 0.0195); // ~2%, inside the bar
  assert.equal(open.kind, 'open');
  assert.match(open.copy, /barely budged/);

  // Voice ruling (2026-07-12): player copy is Greg's first person with
  // zero em-dashes.
  for (const v of [settling, widened, open, classifyVerdict(null)]) {
    assert.ok(!v.copy.includes('—'), `em-dash in verdict copy: "${v.copy}"`);
  }

  // Fewer than two era fits → early, no number.
  assert.equal(classifyVerdict({ trajectory: [{ date: '2026-07-02', mean: 0.03, sd: 0.02 }] }).kind, 'early');
  assert.equal(classifyVerdict(null).kind, 'early');
});

test('REGRESSION: pre-epoch rows contribute candidatesLog ONLY, and retrodictions never enter the verdict window', () => {
  const history = [
    // Pre-epoch row carrying BOTH tables. The original candidates entry is
    // poisoned (sd 0.64, seconds scale): if the reader ever consumed it,
    // the deepEqual below breaks. The candidatesLog sd (0.025) is also a
    // tripwire: if retrodictions leaked into the verdict window, the
    // delta would read 36% instead of the live era's 20%.
    row('2026-06-30', 'sonarCellCount', [cand('sonarCellCount', 0.71, 0.64)], {
      candidatesLog: [cand('sonarCellCount', 0.045, 0.025)],
    }),
    // Pre-epoch row WITHOUT candidatesLog (the backfit skipped it on a
    // diagnostics failure) — contributes nothing, never falls back.
    row('2026-07-01', 'compassCellCount', [cand('sonarCellCount', 0.70, 0.67)]),
    row('2026-07-02', 'sonarCellCount', [cand('sonarCellCount', 0.043, 0.020)]),
    row('2026-07-08', 'compassCellCount', [cand('sonarCellCount', 0.042, 0.016)]),
  ];
  const study = deriveStudies(history).find(s => s.feature === 'sonarCellCount');
  assert.equal(study.trajectory.length, 3, 'the skipped date leaves a gap, not a seconds-scale point');
  assert.deepEqual(study.trajectory[0], { date: '2026-06-30', mean: 0.045, sd: 0.025, retro: true });
  assert.deepEqual(study.trajectory[1], { date: '2026-07-02', mean: 0.043, sd: 0.020, retro: false });
  // The verdict windows to the LIVE fits: (0.020 − 0.016) / 0.020 = 20%,
  // anchored at the era start, never at the retrodicted point.
  assert.equal(study.verdict.kind, 'settling');
  assert.equal(study.verdict.deltaPct, 20);
  assert.match(study.verdict.copy, /narrowed 20% since Jul 2\./);
  assert.ok(!study.verdict.copy.includes('Jun 30'), 'the sentence must not claim the retrodicted window');
});

test('fmtPct: whole percents at 1% and above, one decimal below, no fake 0.0', () => {
  // Christopher's ruling (2026-07-12): tenths on five players' data are
  // false precision — whole percents except below 1%.
  assert.equal(fmtPct(3.34), '3');
  assert.equal(fmtPct(4.37), '4');
  assert.equal(fmtPct(1.41), '1');
  assert.equal(fmtPct(0.95), '1');
  assert.equal(fmtPct(0.34), '0.3');
  assert.equal(fmtPct(0.15), '0.1'); // toFixed(1) gives 0.1, fine
  assert.equal(fmtPct(0.04), '0.1', 'a positive value never renders as exactly zero');
  assert.equal(fmtPct(0), '0');
  assert.equal(fmtPct(-2.6), '-3');
  assert.equal(fmtPct(NaN), null);
  assert.equal(fmtPct('3'), null);
});

test('resting: idle past the bar AND bottom-half CV rank; never over widened or early', () => {
  assert.equal(RESTING_MIN_IDLE_DAYS, 14);
  const base = {
    trajectory: [
      { date: '2026-07-02', mean: 0.03, sd: 0.020 },
      { date: '2026-07-10', mean: 0.03, sd: 0.019 }, // ~5% move → open underneath
    ],
    daysIdle: 20, cvRank: 8, cvCount: 12,
  };
  const resting = classifyVerdict(base);
  assert.equal(resting.kind, 'resting');
  assert.equal(resting.deltaPct, null, 'resting claims no number');
  assert.match(resting.copy, /sure enough .* boards elsewhere/);
  assert.match(resting.copy, /^I’m /, 'Greg speaks in plain first person');
  assert.ok(!resting.copy.includes('—'), `em-dash in resting copy: "${resting.copy}"`);

  // Targeted recently → still an active study, not resting.
  assert.equal(classifyVerdict({ ...base, daysIdle: RESTING_MIN_IDLE_DAYS - 1 }).kind, 'open');
  // High uncertainty rank → the model still wants data here; boundary is
  // ceil(12/2) = 6 (0-indexed): rank 5 is top-half, rank 6 rests.
  assert.equal(classifyVerdict({ ...base, cvRank: 5 }).kind, 'open');
  assert.equal(classifyVerdict({ ...base, cvRank: 6 }).kind, 'resting');
  // Absent from the latest fit's table → no rank, never resting.
  assert.equal(classifyVerdict({ ...base, cvRank: null }).kind, 'open');
  // A widened picture is not "sure enough", however idle.
  const widened = classifyVerdict({
    ...base,
    trajectory: [
      { date: '2026-07-02', mean: 0.03, sd: 0.020 },
      { date: '2026-07-10', mean: 0.03, sd: 0.026 },
    ],
  });
  assert.equal(widened.kind, 'widened');
  // Resting takes the chip over settling (the tightening stays visible on
  // the sparkline and estimate; the chip explains why no new boards).
  const overSettling = classifyVerdict({
    ...base,
    trajectory: [
      { date: '2026-07-02', mean: 0.03, sd: 0.020 },
      { date: '2026-07-10', mean: 0.03, sd: 0.015 },
    ],
  });
  assert.equal(overSettling.kind, 'resting');
  // Early stays early regardless — no number, no resting claim.
  assert.equal(classifyVerdict({
    trajectory: [{ date: '2026-07-10', mean: 0.03, sd: 0.02 }],
    daysIdle: 40, cvRank: 11, cvCount: 12,
  }).kind, 'early');
});

test('deriveStudies computes the resting inputs from the latest refit row', () => {
  const history = [
    row('2026-07-02', 'sonarCellCount', [
      cand('sonarCellCount', 0.04, 0.020), cand('compassCellCount', 0.03, 0.020),
    ]),
    row('2026-07-20', 'compassCellCount', [
      cand('compassCellCount', 0.03, 0.021), // cv 0.70 → rank 0
      cand('sonarCellCount', 0.04, 0.008),   // cv 0.20 → rank 1 of 2 (bottom half)
    ]),
  ];
  const studies = deriveStudies(history);
  const sonar = studies.find(s => s.feature === 'sonarCellCount');
  assert.equal(sonar.daysIdle, 18, 'idle days anchor to the latest refit date, not the wall clock');
  assert.equal(sonar.cvRank, 1);
  assert.equal(sonar.cvCount, 2);
  assert.equal(sonar.verdict.kind, 'resting', 'idle + bottom-half rank rests even though the SD tightened 60%');
  const compass = studies.find(s => s.feature === 'compassCellCount');
  assert.equal(compass.daysIdle, 0);
  assert.notEqual(compass.verdict.kind, 'resting', 'the live target never rests');
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
  // A NAMED feature the refit has never targeted still resolves — the
  // active card can be exactly that study on a fresh target's first
  // day, and its share link must not dead-end on the recipient.
  const fresh = findingById([
    row('2026-07-02', 'sonarCellCount', [
      cand('sonarCellCount', 0.043, 0.020), cand('compassCellCount', 0.033, 0.021),
    ]),
  ], 'compassCellCount');
  assert.equal(fresh?.feature, 'compassCellCount');
  assert.equal(fresh?.studyDayCount, 0);
});

test('estimateSummary converts log coefficients to plain percentages with a ±1 SD band', () => {
  const study = {
    latest: { date: '2026-07-12', mean: 0.0329, sd: 0.0189 },
  };
  const est = estimateSummary(study);
  // Per-TEN units, universally (his 2026-08-11 tightening: "all on a 10
  // tile basis"): exp(0.329) − 1 ≈ 38.96%, and the band must bracket it.
  assert.equal(est.scale, 10);
  assert.ok(Math.abs(est.pct - 38.96) < 0.1, `pct ${est.pct}`);
  assert.ok(est.lo < est.pct && est.pct < est.hi);
  assert.ok(Math.abs(est.lo - 15.03) < 0.1, `lo ${est.lo}`);
  assert.ok(Math.abs(est.hi - 67.86) < 0.1, `hi ${est.hi}`);
  assert.equal(est.asOf, '2026-07-12');
  assert.equal(estimateSummary({ latest: null }), null, 'no era fits → no estimate, never a fabricated one');
});

test('estimateLine: one sentence, whole percents, never a fake negative (copy ruling 2026-07-12; per-ten scaling 2026-08-11)', () => {
  // Liar cells today: mean 0.0015 ± 0.0019, a per-unit effect deep in
  // decimal territory. His 2026-08-11 ruling: speak per TEN tiles there
  // ("less decimally... for every 10 tiles of that in a puzzle"), so the
  // subject goes plural and the numbers scale as exp(10x), the model's
  // own prediction for ten more units. The zero-band form stays ONE
  // sentence and the bound is spoken as the number 0%, never "nothing"
  // (ruling 2026-07-12, second pass).
  const tiny = estimateLine({ unit: 'liar cell', feature: 'liarCellCount', latest: { date: '2026-07-12', mean: 0.0015, sd: 0.0019 } });
  assert.equal(tiny, 'Ten liar cells add somewhere between 0% and about 3% to your time.');
  assert.ok(!/-\d/.test(tiny), `no negative percentages on a player surface: "${tiny}"`);
  assert.ok(!/\d\.\d/.test(tiny), `the per-ten scale exists to retire decimals: "${tiny}"`);
  // A clearly-positive band is quoted per ten like everything else (his
  // 2026-08-11 tightening removed the size carve-out): whole percents,
  // exactly one hedge word, exp-compounded because that is the model's
  // own prediction for ten more units.
  const solid = estimateLine({ unit: 'compass cell', feature: 'compassCellCount', latest: { date: '2026-07-12', mean: 0.0329, sd: 0.0189 } });
  assert.equal(solid, 'Ten compass cells add about 39% to your time, likely between 15% and 68%.');
  // A whole-band refund (no live example yet) flags itself for re-check
  // instead of rendering a minus sign. mean -0.02 is under the scale bar,
  // so it speaks per ten as well: exp(-0.2) is an 18% refund.
  const refund = estimateLine({ unit: 'open area', feature: 'zeroClusterCount', latest: { date: '2026-07-12', mean: -0.02, sd: 0.005 } });
  assert.match(refund, /^Ten open areas seem to give a little time back, about 18%/);
  assert.ok(!/-\d/.test(refund), `no minus signs on a player surface: "${refund}"`);
  // Digit shares NEVER scale: their unit is already a composite ("extra
  // three in ten clues"), and ten of those is not a board quantity.
  const digit = estimateLine({ unit: 'extra three in ten numbers', feature: 'clueShare3', latest: { date: '2026-07-12', mean: 0.0015, sd: 0.0005 } });
  assert.match(digit, /^Each extra three in ten numbers adds/);
  for (const line of [tiny, solid, refund, digit]) {
    assert.ok(!line.includes('—'), `em-dash in estimate line: "${line}"`);
  }
  assert.equal(estimateLine({ unit: 'compass cell', latest: null }), null);
  assert.equal(estimateLine({ unit: null, latest: { date: 'x', mean: 0.03, sd: 0.01 } }), null);
});

test('parameterTable: every named feature from the latest fit, no fake negatives, effect-sorted', () => {
  const history = [
    row('2026-07-12', 'compassCellCount', [
      cand('compassCellCount', 0.0329, 0.0189),
      cand('liarCellCount', 0.0015, 0.0019),   // band straddles zero
      cand('totalMines', 0.0581, 0.0038),
      cand('wormLoad', 0.0157, 0.008),         // composite unit, unscaled
      cand('clueShare3', 0.03, 0.01),          // composite unit, unscaled
      cand('fragmentationRatio', 0.02, 0.01),  // unnamed — never rendered
      { feature: 'broken', mean: 0.1 },        // no sd — dropped
    ]),
  ];
  const table = parameterTable(history);
  assert.deepEqual(table.map(r => r.feature),
    ['totalMines', 'compassCellCount', 'clueShare3', 'wormLoad', 'liarCellCount'],
    'named only, sorted by effect');
  const worm = table.find(r => r.feature === 'wormLoad');
  assert.equal(worm.per, 'per hundred worm moves', 'a composite unit states its basis');
  assert.equal(worm.effect, '+2%'); // exp(0.0157) - 1, UNscaled: the unit is already 100 moves
  const threes = table.find(r => r.feature === 'clueShare3');
  assert.equal(threes.per, 'per extra three in ten numbers');
  const liar = table.find(r => r.feature === 'liarCellCount');
  // Per-ten like every estimate surface (his 2026-08-11 report: the
  // ledger gave no indication of the basis): exp(0.015) − 1 = 1.51%.
  assert.equal(liar.effect, '+2%');
  assert.equal(liar.range, '0% to 3%', 'straddling band floors at 0, never a minus');
  // The ten-tile basis is the table's stated default now (his 2026-08-11
  // note that repeating it under every label reads as noise); a row says
  // its own basis only when it measures differently.
  assert.equal(liar.per, null, 'default-basis rows say nothing');
  const compass = table.find(r => r.feature === 'compassCellCount');
  assert.equal(compass.effect, '+39%');
  assert.equal(compass.range, '15% to 68%');
  assert.equal(compass.per, null);
  // Whole-band-negative renders as time saved, still without minus signs.
  const negTable = parameterTable([
    row('2026-07-12', 'zeroClusterCount', [cand('zeroClusterCount', -0.02, 0.001)]),
  ]);
  assert.equal(negTable[0].effect, 'saves 18%');
  // At scale ten the refund band's ends no longer round together:
  // exp(-0.19) and exp(-0.21) sit a full point apart.
  assert.equal(negTable[0].range, '17% to 19% saved');
  assert.ok(!negTable[0].range.includes('-'));
  assert.deepEqual(parameterTable([]), []);
  // REGRESSION: a history ending on a pre-epoch row (stale cached copy)
  // must render NO table — exponentiating seconds-scale coefficients
  // fabricates garbage like "+348% mine density".
  assert.deepEqual(parameterTable([
    row('2026-06-20', 'sonarCellCount', [cand('totalMines', 1.5, 0.3)]),
  ]), []);
});

test('REGRESSION: a diagnostics-rejected night cannot blank the parameter ledger', () => {
  // 2026-08-01: the first refit after the per-shape rework was rejected on
  // diagnostics, and the safety gate appended a thin seed-residuals row with
  // an EMPTY candidates list. dedupeHistory keeps the LAST row per date, so
  // that fallback row shadowed the same day's good fit and parameterTable —
  // which read the latest live row unconditionally — rendered zero rows. The
  // table must walk back to the most recent row carrying a real fit: a night
  // the gate did its job is not a night the ledger goes blank.
  const goodDay = row('2026-07-30', 'sonarCellCount', [
    cand('totalMines', 0.0581, 0.0038),
    cand('sonarCellCount', 0.0329, 0.0189),
  ]);
  const rejectedNight = row('2026-07-31', 'sonarCellCount', []);
  const table = parameterTable([goodDay, rejectedNight]);
  assert.deepEqual(table.map(r => r.feature), ['totalMines', 'sonarCellCount'],
    'the last REAL fit renders, not the thin fallback row');

  // Control: a history that is nothing but thin rows still renders nothing —
  // the walk-back must not invent a table out of a candidates-less era.
  assert.deepEqual(parameterTable([row('2026-07-31', 'sonarCellCount', [])]), []);
});

test('estimateLine: band ends that round to the same figure collapse instead of "between 79% and 79%"', () => {
  // At the per-ten scale the fixture needs a tighter sd for the ends to
  // round together: exp(0.581) − 1 ≈ 78.8%, both ends rounding to 79.
  const tight = estimateLine({ unit: 'mine', feature: 'totalMines', latest: { date: '2026-07-12', mean: 0.0581, sd: 0.0001 } });
  assert.equal(tight, 'Ten mines add about 79% to your time, and the band barely strays from that.');
});

test('deriveStudyForFeature: a never-targeted feature still gets an honest study object', () => {
  const history = [
    row('2026-07-02', 'sonarCellCount', [
      cand('sonarCellCount', 0.043, 0.020), cand('compassCellCount', 0.033, 0.021),
    ]),
    row('2026-07-08', 'sonarCellCount', [
      cand('sonarCellCount', 0.043, 0.018), cand('compassCellCount', 0.033, 0.019),
    ]),
  ];
  const s = deriveStudyForFeature(history, 'compassCellCount');
  assert.equal(s.feature, 'compassCellCount');
  assert.equal(s.studyDayCount, 0, 'never targeted');
  assert.equal(s.firstStudied, null);
  assert.equal(s.trajectory.length, 2, 'the posterior rides in every row regardless');
  assert.equal(s.verdict.kind, 'open', 'the trajectory alone supports a verdict');
  assert.equal(deriveStudyForFeature(history, ''), null);
  assert.equal(deriveStudyForFeature([], 'sonarCellCount'), null);
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
  const kinds = new Set(['settling', 'widened', 'resting', 'open', 'early']);
  const rowsByDate = new Map(dedupeHistory(real).map(r => [r.date, r]));
  for (const s of journal.studies) {
    assert.ok(s.label, `${s.feature} has a plain name`);
    assert.ok(s.hypothesis && !/[A-Z][a-z]+Count/.test(s.hypothesis), `${s.feature} hypothesis is plain language`);
    assert.ok(!s.hypothesis.includes('—') && !s.verdict.copy.includes('—'),
      `${s.feature} carries an em-dash in player copy`);
    assert.ok(kinds.has(s.verdict.kind), `${s.feature} verdict ${s.verdict.kind}`);
    for (const p of s.trajectory) {
      // Provenance per point: a live point must equal the row's candidates
      // entry, a pre-epoch point the row's candidatesLog entry — and the
      // retro flag must say which side it came from.
      const src = rowsByDate.get(p.date);
      const table = p.date >= epoch ? src.candidates : src.candidatesLog;
      assert.ok(Array.isArray(table), `${s.feature} ${p.date}: point without a log-scale source table`);
      const entry = table.find(c => c.feature === s.feature);
      assert.equal(p.mean, entry.mean, `${s.feature} ${p.date} mean provenance`);
      assert.equal(p.sd, entry.sd, `${s.feature} ${p.date} sd provenance`);
      assert.equal(p.retro, p.date < epoch, `${s.feature} ${p.date} retro flag`);
      // Seconds-scale SDs run up to ~22; log-scale ones sit far below 1.
      // A point at or past 1 means the old-scale candidates leaked in.
      assert.ok(p.sd < 1, `${s.feature} ${p.date}: sd ${p.sd} looks seconds-scale`);
    }
    // The verdict's number must match SD math computed independently here,
    // over the LIVE window only (retrodictions are chart history).
    const live = s.trajectory.filter(p => !p.retro);
    if (live.length >= 2 && s.verdict.deltaPct !== null) {
      const sd0 = live[0].sd;
      const sd1 = live[live.length - 1].sd;
      assert.equal(s.verdict.deltaPct, Math.round(((sd0 - sd1) / sd0) * 100), `${s.feature} deltaPct`);
    }
    // Estimates exist for every named study with era fits, with a sane band.
    const est = estimateSummary(s);
    if (s.latest) {
      assert.ok(est.lo < est.pct && est.pct < est.hi, `${s.feature} estimate band`);
    }
  }

  // The sequential backfit reached back: the flagship studies' series
  // begin before the scale epoch and are genuinely long.
  for (const f of ['sonarCellCount', 'compassCellCount']) {
    const s = journal.studies.find(x => x.feature === f);
    assert.ok(s.trajectory.length >= 20, `${f} unified series length ${s.trajectory.length}`);
    assert.ok(s.trajectory[0].date < epoch, `${f} series must start before the epoch`);
    assert.equal(s.trajectory[0].retro, true, `${f} first point is a flagged retrodiction`);
  }

  // Backfit coverage and provenance: nearly every pre-epoch row carries
  // candidatesLog (a couple of diagnostics skips are honest), each with
  // its fit provenance, and the original candidates stay untouched.
  const preRows = dedupeHistory(real).filter(r => r.date < epoch);
  const withLog = preRows.filter(r => Array.isArray(r.candidatesLog));
  assert.ok(withLog.length >= 60, `backfit coverage: ${withLog.length}/${preRows.length} pre-epoch rows`);
  for (const r of withLog) {
    assert.ok(r.candidatesLogFit && r.candidatesLogFit.n_scores >= 30, `${r.date} candidatesLogFit provenance`);
    assert.match(r.candidatesLogFit.diagnostics, /Rhat/, `${r.date} diagnostics recorded`);
    assert.ok(Array.isArray(r.candidates) && r.candidates.length > 0, `${r.date} original candidates preserved`);
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
