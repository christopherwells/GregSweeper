// Greg's Journal — the prose engine (PR C, the notebook reframe). The
// rails under test are Christopher's writing rulings (2026-07-12):
// zero em-dashes, max ONE hedge word per sentence, every digit sequence
// in rendered prose must exist in the entry's fact object, day counts
// render as "study day N" / "N study days" (never a bare "Day N"),
// player behavior is never claimed from a band, nothing ties a finding
// to today's board, and no two entries visible on the same screen share
// a skeleton or a closer.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  hashStr, countWord, newSession, bandClass, resolutionFor, driftSinceClose,
  narrativeState, buildFacts, composeEntry, conclusionLine, queueLine,
  labLog, planJournalScreen, activeFeatureFrom, allProseLines,
  planStudyFigures, allFigureCaptions, FIGURE_TYPES,
  NEGLIGIBLE_PCT, MAX_LOG_ENTRIES,
} = await import('../src/logic/journalProse.js');
const { estimateSummary } = await import('../src/logic/journalFindings.js');

// ── Fixture helpers ───────────────────────────────────────────────────

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

// Hand-built study objects: narrativeState/composeEntry read verdict,
// latest (the estimate), trajectory (drift), and the study-day facts —
// building them directly keeps each state fixture readable.
function mkStudy(over = {}) {
  const latest = over.latest ?? { date: '2026-08-02', mean: 0.03, sd: 0.019 };
  return {
    id: over.feature ?? 'compassCellCount',
    feature: over.feature ?? 'compassCellCount',
    label: 'compass',
    unit: 'compass cell',
    hypothesis: 'placeholder',
    firstStudied: '2026-07-02',
    lastStudied: '2026-08-01',
    studyDayCount: 19,
    allBackfilled: false,
    trajectory: over.trajectory ?? [
      { date: '2026-07-02', mean: 0.033, sd: 0.020, retro: false },
      latest,
    ],
    latest,
    daysIdle: 1,
    cvRank: 1,
    cvCount: 10,
    verdict: { kind: 'open', deltaPct: 5, copy: 'x' },
    ...over,
  };
}

// ── Voice guards over every pool line ─────────────────────────────────

const HEDGES = /\b(might|maybe|probably|perhaps|possibly|likely|seems?|appears?|suspect(?:ed)?|presumably|I think|I guess)\b/gi;

test('voice guards: every pool line obeys the writing rails', () => {
  const lines = allProseLines();
  assert.ok(lines.length >= 90, `pool inventory looks wrong: ${lines.length} lines`);
  for (const line of lines) {
    assert.equal(typeof line, 'string');
    assert.ok(!line.includes('—'), `em-dash in pool line: "${line}"`);
    assert.ok(!line.includes('–'), `en-dash in pool line: "${line}"`);
    assert.ok(!/\bGreg\b/.test(line), `third-person Greg in first-person prose: "${line}"`);
    assert.ok(!/today.s board/i.test(line), `fieldnote-drift claim in pool line: "${line}"`);
    // Day counts must be study days; a bare "Day N" reads as calendar days.
    assert.ok(!/(?<!study )\bday\s+\d/i.test(line), `bare day-count in pool line: "${line}"`);
    // Player behavior is never claimed from a band — a pool line may
    // only mention players inside a quoted hypothesis.
    if (/\bplayers?\b/i.test(line)) {
      assert.ok(/(I wrote|my note)/i.test(line),
        `player-behavior claim outside a quoted hypothesis: "${line}"`);
    }
    // Max ONE hedge word per sentence (hedge-stacking reads as fake).
    for (const sentence of line.split(/(?<=[.?!])\s+/)) {
      const hedges = sentence.match(HEDGES) || [];
      assert.ok(hedges.length <= 1, `hedge stack (${hedges.join(', ')}) in: "${sentence}"`);
    }
    // Every line carries content: no line is only connective filler.
    assert.ok(line.replace(/\{[A-Za-z]+\}/g, '').trim().length >= 10, `thin pool line: "${line}"`);
    // The 0%-not-"nothing" ruling holds at the pool level too.
    assert.ok(!NOTHING_AS_NUMBER.test(line), `say 0%, not "nothing", in pool line: "${line}"`);
    // And so does the measurement-verb ruling.
    assert.ok(!IMPRECISE_VERBS.test(line), `imprecise verb in pool line: "${line}"`);
    // Every pool sentence is a complete sentence (fragments banned).
    assertCompleteSentences(line, 'pool');
  }
});

// ── Digit honesty ─────────────────────────────────────────────────────

function digitRuns(s) {
  return String(s).match(/\d+(?:\.\d+)?/g) || [];
}

function assertDigitsDerivable(text, facts, label) {
  const allowed = new Set();
  for (const v of Object.values(facts)) {
    if (v === null || v === undefined) continue;
    for (const run of digitRuns(v)) allowed.add(run);
  }
  for (const run of digitRuns(text)) {
    assert.ok(allowed.has(run), `${label}: digit "${run}" in "${text}" has no source fact`);
  }
}

// "Nothing" as a stand-in for the number is banned: the bound is 0%
// (Christopher's ruling, 2026-07-12). Ordinary uses ("nothing left to
// squeeze") stay legal; these are the quantity phrasings.
const NOTHING_AS_NUMBER = /\b(between nothing|nothing to about|nothing at all|almost nothing|nearly nothing|nothing much)\b/i;

// Sentences describing data, estimates, bands, or the model use
// measurement verbs (Christopher's ruling, 2026-07-12: "Scientists
// don't write with such imprecise verbs"). This list pins the exact
// phrasings the verb audit removed — body/emotion verbs on numbers,
// and invented instruments — so they can't creep back into a pool.
const IMPRECISE_VERBS = /(\bate\b|breathe|frown|wiggle|wander|wobbl|firmed up|\bmeter\b|needle|for the pot|keeps the desk|math keeps|pushing back|sat still|range came in|band came in|changed hands|shrug|grew doubt|misbehav|doubt lives|stands in the hallway)/i;

// Complete sentences only (Christopher's ruling 2026-07-12: "It's not
// even complete sentences"). Every sentence must carry a finite verb
// (or be a true imperative); the two sanctioned notations are the lab
// log's datelines and the ledger's Closed/Parked file stamps, both from
// his own spec examples. The verb lexicon is curated to the pools'
// closed vocabulary — a new pool line either matches it or the failure
// message forces a deliberate call: fix the fragment, or add the verb.
const FINITE_VERBS = new Set(('is are was were be been am has have had do does did will would can could should must might '
  + 'stays stayed stay stands stand stood sits sit holds hold held reads read runs run ran comes come came goes go went '
  + 'gets get got keeps keep kept lands land landed left leaves moves move moved narrows narrowed widens widened widening '
  + 'tightens tightened grew grow grows shrank fell rose settles settle settled closes close closed opens open opened '
  + 'picks pick picked drew draws draw takes take took puts put says say said tells tell telling told asks ask asked '
  + 'answers answer answered wrote writes write written predicted suspected measures measure measured knows know knew '
  + 'wants want wanted watches watch waits wait publishes publish hides hide counts count counted costs cost carried '
  + 'carries carry registered registers register showed shows show shown failed fails fail arrives arrive arrived brought '
  + 'brings bring feeds feed fed filed files file aims aim aimed drifts drift drifting resolves resolve rests rest '
  + 'remembers remember matters matter bothers bother refuses refuse budge budged pinned pins pin surprises surprise '
  + 'survives survive teaches teach taught turns turn turned dies die died limps limp outranks outrank owes owe makes '
  + 'make made means mean meant pays pay paid spends spend spent thought think thinks checks check checked ranking ranks '
  + 'rank ranked listening listened ordered orders order dodges dodge talked talks talk signed slows slow helps help '
  + 'helped looks look looked started starts start stopped stops stop found finds find blinks blink blinked points point '
  + 'pointed converges converge converged updated update updates amounts amount covers cover covered tracks track tracked '
  + 'plotted bets bet lets let seems seem becomes become became needs need needed works work worked disagrees disagree '
  + 'disagreed agrees agree agreed sides side sided siding loses lose lost enjoys enjoy ate eats eat wonder wonders call '
  + 'calls called wins win won lies lie lay figures figure figured happens happen happened wishes wish wished doubles '
  + 'double squeeze squeezed bills bill billed notes note noted records record recorded adds add added gives give gave '
  + 'given continues continue continued').split(' ').map(w => w.toLowerCase()));
const CONTRACTION_VERB = /(\b\w+’(s|re|ll|d|ve|m)\b|n’t\b|’s\b)/;
const NOTATION = /^((Closed|Parked) (\{closedDate\}|[A-Z][a-z]{2} \d{1,2})|[A-Z][a-z]{2} \d{1,2})$/;

function assertCompleteSentences(text, label) {
  for (const raw of String(text).split(/(?<=[.?!])\s+/)) {
    const sentence = raw.replace(/[.?!…]+$/, '').trim();
    if (!sentence || NOTATION.test(sentence)) continue;
    if (CONTRACTION_VERB.test(sentence)) continue;
    const hasVerb = sentence.replace(/\{[A-Za-z]+\}/g, ' ')
      .toLowerCase().split(/[^a-z-]+/)
      .some(w => FINITE_VERBS.has(w));
    assert.ok(hasVerb, `${label}: sentence without a finite verb: "${sentence}" (in "${text}")`);
  }
}

function assertProseRails(text, label) {
  assert.ok(!text.includes('—') && !text.includes('–'), `${label}: dash in "${text}"`);
  assert.ok(!/today.s board/i.test(text), `${label}: fieldnote-drift claim in "${text}"`);
  assert.ok(!/(?<!study )\bday\s+\d/i.test(text), `${label}: bare day-count in "${text}"`);
  assert.ok(!/\{[A-Za-z]+\}/.test(text), `${label}: unresolved template hole in "${text}"`);
  assert.ok(!NOTHING_AS_NUMBER.test(text), `${label}: say 0%, not "nothing": "${text}"`);
  assert.ok(!IMPRECISE_VERBS.test(text), `${label}: imprecise verb on a measurement: "${text}"`);
  assertCompleteSentences(text, label);
}

// ── State machine ─────────────────────────────────────────────────────

test('narrativeState: all nine states are reachable from data', () => {
  // early — fewer than two live fits.
  assert.equal(narrativeState(mkStudy({ verdict: { kind: 'early', deltaPct: null } })), 'early');

  // active-unresolved — compass: open verdict, question lean.
  const compass = mkStudy({ feature: 'compassCellCount' });
  assert.equal(resolutionFor(compass), 'out', 'a mechanism question is never settled by band sign');
  assert.equal(narrativeState(compass), 'active-unresolved');

  // grind — sonar: open verdict, cost lean, clearly-positive band.
  const sonar = mkStudy({
    feature: 'sonarCellCount', label: 'sonar', unit: 'sonar cell',
    latest: { date: '2026-08-02', mean: 0.0428, sd: 0.0203 },
  });
  assert.equal(bandClass(estimateSummary(sonar)), 'pos');
  assert.equal(resolutionFor(sonar), 'sided');
  assert.equal(narrativeState(sonar), 'grind');

  // anomaly — widened verdict wins over everything active.
  const mirrors = mkStudy({
    feature: 'mirrorPairCount', label: 'mirrors', unit: 'mirror pair',
    verdict: { kind: 'widened', deltaPct: -46 },
    latest: { date: '2026-08-02', mean: 0.0249, sd: 0.0158 },
  });
  assert.equal(narrativeState(mirrors), 'anomaly');

  // closed-lost — wormholes: resting, cost lean, zero band.
  const wormholes = mkStudy({
    feature: 'wormholePairCount', label: 'wormholes', unit: 'wormhole pair',
    verdict: { kind: 'resting', deltaPct: null },
    lastStudied: '2026-05-30', studyDayCount: 6,
    latest: { date: '2026-08-02', mean: 0.0015, sd: 0.0018 },
    trajectory: [
      { date: '2026-07-02', mean: 0.0015, sd: 0.0018, retro: false },
      { date: '2026-08-02', mean: 0.0015, sd: 0.0018, retro: false },
    ],
  });
  assert.equal(bandClass(estimateSummary(wormholes)), 'zero');
  assert.equal(resolutionFor(wormholes), 'against');
  assert.equal(narrativeState(wormholes), 'closed-lost');

  // closed-won — liar: resting, fork lean, zero band (the data picked a door).
  const liar = mkStudy({
    feature: 'liarCellCount', label: 'liar cells', unit: 'liar cell',
    verdict: { kind: 'resting', deltaPct: null },
    lastStudied: '2026-06-28', studyDayCount: 10,
    latest: { date: '2026-08-02', mean: 0.0015, sd: 0.0019 },
    trajectory: [
      { date: '2026-07-02', mean: 0.0015, sd: 0.0019, retro: false },
      { date: '2026-08-02', mean: 0.0015, sd: 0.0019, retro: false },
    ],
  });
  assert.equal(resolutionFor(liar), 'answered');
  assert.equal(narrativeState(liar), 'closed-won');

  // resting — parked with an ambiguous band: no won/lost claim.
  const parked = mkStudy({
    feature: 'mysteryCellCount', label: 'mystery cells', unit: 'mystery cell',
    verdict: { kind: 'resting', deltaPct: null },
    lastStudied: '2026-07-04', studyDayCount: 1,
    latest: { date: '2026-08-02', mean: 0.010, sd: 0.012 },
    trajectory: [
      { date: '2026-07-02', mean: 0.010, sd: 0.012, retro: false },
      { date: '2026-08-02', mean: 0.010, sd: 0.012, retro: false },
    ],
  });
  assert.equal(bandClass(estimateSummary(parked)), 'ambiguous');
  assert.equal(narrativeState(parked), 'resting');

  // reopened — a parked study whose point estimate left the band it was
  // parked with.
  const drifted = mkStudy({
    feature: 'lockedCellCount', label: 'locked cells', unit: 'locked cell',
    verdict: { kind: 'resting', deltaPct: null },
    lastStudied: '2026-07-05', studyDayCount: 5,
    latest: { date: '2026-08-02', mean: 0.045, sd: 0.006 },
    trajectory: [
      { date: '2026-07-02', mean: 0.030, sd: 0.006, retro: false },
      { date: '2026-07-05', mean: 0.030, sd: 0.006, retro: false },
      { date: '2026-08-02', mean: 0.045, sd: 0.006, retro: false },
    ],
  });
  const drift = driftSinceClose(drifted);
  assert.ok(drift, 'the drift is detected');
  assert.equal(drift.refDate, '2026-07-05', 'reference = last live fit at or before the close');
  assert.equal(narrativeState(drifted), 'reopened');

  // revalidation — the stamp (PR D) promotes the ACTIVE study only.
  const ctx = { activeFeature: 'sonarCellCount', revalidation: true };
  assert.equal(narrativeState(sonar, ctx), 'revalidation');
  assert.equal(narrativeState(compass, ctx), 'active-unresolved', 'the stamp never leaks to other studies');
});

// PR D — the clue-digit studies. Proves the new vocabulary (FEATURE_NAMES,
// FEATURE_UNITS, ARCS) wires together so a digit share renders a clean study
// card the moment the refit targets it, and that the revalidation stamp
// promotes an active digit study. Fixture numbers mirror the real secondary
// fit (clueShare3 ~ +30% tight; clueShare5plus ~ 0% wide).
test('digit-share studies render clean prose and support revalidation (PR D)', () => {
  const threes = mkStudy({
    feature: 'clueShare3', label: 'threes', unit: 'extra three in ten numbers',
    latest: { date: '2026-08-02', mean: 0.2605, sd: 0.0465 },
    trajectory: [
      { date: '2026-07-17', mean: 0.28, sd: 0.055, retro: false },
      { date: '2026-08-02', mean: 0.2605, sd: 0.0465, retro: false },
    ],
    verdict: { kind: 'open', deltaPct: null,
      copy: 'There’s no verdict yet. The numbers have barely budged. More boards will settle it.' },
  });
  assert.equal(bandClass(estimateSummary(threes)), 'pos', 'the ~30% cost is a clean positive band');
  const entry = composeEntry(threes, { activeFeature: 'clueShare3' }, newSession());
  assertProseRails(entry.text, 'clueShare3 entry');
  assertDigitsDerivable(entry.text, entry.facts, 'clueShare3 entry');
  assert.ok(/extra three in ten numbers/.test(entry.text), 'the digit unit reaches the estimate line');

  // The revalidation stamp promotes the active digit study to its own state.
  const reval = composeEntry(threes, { activeFeature: 'clueShare3', revalidation: true }, newSession());
  assert.equal(reval.state, 'revalidation');
  assertProseRails(reval.text, 'clueShare3 revalidation entry');
  assertDigitsDerivable(reval.text, reval.facts, 'clueShare3 revalidation entry');

  // clueShare5plus — the near-zero, sparse tail: a clean zero band renders
  // the honest "between 0% and about X%" reading, never a floored negative.
  const highs = mkStudy({
    feature: 'clueShare5plus', label: 'high numbers', unit: 'extra high number in ten numbers',
    latest: { date: '2026-08-02', mean: 0.0016, sd: 0.0021 },
    trajectory: [
      { date: '2026-07-17', mean: 0.002, sd: 0.0025, retro: false },
      { date: '2026-08-02', mean: 0.0016, sd: 0.0021, retro: false },
    ],
    verdict: { kind: 'open', deltaPct: null,
      copy: 'There’s no verdict yet. The numbers have barely budged. More boards will settle it.' },
  });
  assert.equal(bandClass(estimateSummary(highs)), 'zero');
  const highEntry = composeEntry(highs, { activeFeature: 'clueShare5plus' }, newSession());
  assertProseRails(highEntry.text, 'clueShare5plus entry');
  assertDigitsDerivable(highEntry.text, highEntry.facts, 'clueShare5plus entry');
});

test('driftSinceClose stays inside the live era and needs a real move', () => {
  // Retrodicted points never feed a drift claim.
  const retroHeavy = mkStudy({
    lastStudied: '2026-06-01',
    trajectory: [
      { date: '2026-05-01', mean: 0.01, sd: 0.002, retro: true },
      { date: '2026-07-02', mean: 0.030, sd: 0.006, retro: false },
      { date: '2026-08-02', mean: 0.031, sd: 0.006, retro: false },
    ],
  });
  assert.equal(driftSinceClose(retroHeavy), null, 'a within-band wobble is not drift');
  // A close before the era measures from the era's first live fit.
  const preEpochClose = mkStudy({
    lastStudied: '2026-06-01',
    trajectory: [
      { date: '2026-05-01', mean: 0.01, sd: 0.002, retro: true },
      { date: '2026-07-02', mean: 0.030, sd: 0.006, retro: false },
      { date: '2026-08-02', mean: 0.045, sd: 0.006, retro: false },
    ],
  });
  assert.equal(driftSinceClose(preEpochClose)?.refDate, '2026-07-02');
});

// ── Entries ───────────────────────────────────────────────────────────

test('composeEntry is deterministic and honest about its digits', () => {
  const studies = [
    mkStudy({ feature: 'compassCellCount' }),
    mkStudy({
      feature: 'sonarCellCount', label: 'sonar', unit: 'sonar cell',
      latest: { date: '2026-08-02', mean: 0.0428, sd: 0.0203 },
      verdict: { kind: 'settling', deltaPct: 20 },
    }),
    mkStudy({
      feature: 'mirrorPairCount', label: 'mirrors', unit: 'mirror pair',
      verdict: { kind: 'widened', deltaPct: -46 },
      latest: { date: '2026-08-02', mean: 0.0249, sd: 0.0158 },
    }),
    mkStudy({
      feature: 'wormholePairCount', label: 'wormholes', unit: 'wormhole pair',
      verdict: { kind: 'resting', deltaPct: null },
      lastStudied: '2026-05-30', studyDayCount: 6, firstStudied: '2026-04-29',
      latest: { date: '2026-08-02', mean: 0.0015, sd: 0.0018 },
      trajectory: [
        { date: '2026-07-02', mean: 0.0015, sd: 0.0018, retro: false },
        { date: '2026-08-02', mean: 0.0015, sd: 0.0018, retro: false },
      ],
    }),
    mkStudy({ verdict: { kind: 'early', deltaPct: null }, trajectory: [], latest: null, studyDayCount: 0, firstStudied: null, lastStudied: null }),
  ];
  const ctx = { activeFeature: 'compassCellCount' };
  for (const study of studies) {
    const a = composeEntry(study, ctx, newSession());
    const b = composeEntry(study, ctx, newSession());
    assert.deepEqual(a, b, `${study.feature}: same data must give the same prose`);
    assert.ok(a.text.length > 0);
    assertProseRails(a.text, study.feature);
    assertDigitsDerivable(a.text, a.facts, study.feature);
    // First person: an entry speaks as Greg, never about him.
    assert.ok(!/\bGreg\b/.test(a.text), `${study.feature}: third person in entry`);
    // arcSpoken drives the card's epigraph: when the entry quotes the
    // hunch ("I wrote that…"), the separate hypothesis line hides.
    assert.equal(typeof a.arcSpoken, 'boolean', `${study.feature}: arcSpoken flag`);
    if (a.state === 'early') assert.equal(a.arcSpoken, false, 'early entries never speak the arc');
  }
});

test('transition walk: mirrors anomaly → settled changes state, skeleton, and prose', () => {
  const anomaly = mkStudy({
    feature: 'mirrorPairCount', label: 'mirrors', unit: 'mirror pair',
    verdict: { kind: 'widened', deltaPct: -46 },
    latest: { date: '2026-07-10', mean: 0.0249, sd: 0.0158 },
  });
  // Later: the model parked it with the band it predicted (zero) — the
  // Should survived, the file closes in Greg's favor.
  const settled = mkStudy({
    feature: 'mirrorPairCount', label: 'mirrors', unit: 'mirror pair',
    verdict: { kind: 'resting', deltaPct: null },
    lastStudied: '2026-07-10', studyDayCount: 4,
    latest: { date: '2026-08-20', mean: 0.002, sd: 0.002 },
    trajectory: [
      { date: '2026-07-02', mean: 0.002, sd: 0.002, retro: false },
      { date: '2026-08-20', mean: 0.002, sd: 0.002, retro: false },
    ],
  });
  const before = composeEntry(anomaly, {}, newSession());
  const after = composeEntry(settled, {}, newSession());
  assert.equal(before.state, 'anomaly');
  assert.equal(after.state, 'closed-won');
  assert.notEqual(before.skeleton, after.skeleton, 'the skeleton changes with the state');
  assert.notEqual(before.text, after.text);
});

test('same-screen collision: same-state entries never share a skeleton or closer', () => {
  const zeroBand = (feature, label, unit, lastStudied) => mkStudy({
    feature, label, unit,
    verdict: { kind: 'resting', deltaPct: null },
    lastStudied, studyDayCount: 3, firstStudied: '2026-07-02',
    latest: { date: '2026-08-02', mean: 0.0015, sd: 0.0018 },
    trajectory: [
      { date: '2026-07-02', mean: 0.0015, sd: 0.0018, retro: false },
      { date: '2026-08-02', mean: 0.0015, sd: 0.0018, retro: false },
    ],
  });
  // Three studies that all land in closed-won (size/fork leans, zero band).
  const screen = [
    zeroBand('wallEdgeCount', 'walls', 'wall', '2026-05-17'),
    zeroBand('liarCellCount', 'liar cells', 'liar cell', '2026-06-28'),
    zeroBand('unknownNewFeature', 'new thing', 'cell', '2026-06-01'), // generic arc, same state
  ];
  const session = newSession();
  const entries = screen.map(s => composeEntry(s, {}, session));
  assert.ok(entries.every(e => e.state === 'closed-won'), entries.map(e => e.state).join(','));
  const skeletons = entries.map(e => e.skeleton);
  assert.equal(new Set(skeletons).size, entries.length, `skeleton collision: ${skeletons.join(' / ')}`);
  const closers = entries.map(e => e.text.split(/(?<=\.)\s+/).pop());
  assert.equal(new Set(closers).size, entries.length, `closer collision: ${closers.join(' / ')}`);
  // REGRESSION: today's live data parks FOUR zero-band studies at once —
  // the one-liner pool must keep four adjacent lines template-distinct
  // (walls and mystery cells shipped the same "came to almost nothing"
  // sentence before the pool grew).
  const four = [
    ...screen,
    zeroBand('mysteryCellCount', 'mystery cells', 'mystery cell', '2026-06-08'),
  ];
  const ledgerSession = newSession();
  const lines = four.map(s => conclusionLine(s, 'closed-won', ledgerSession));
  // Reverse the substitution to recover each line's template shape —
  // two lines that differ only by label/unit/date still "feel the same".
  const shapes = lines.map((l, i) => {
    const s = four[i];
    const cap = s.label.charAt(0).toUpperCase() + s.label.slice(1);
    return l.replaceAll(cap, '{L}').replaceAll(s.label, '{l}')
      .replace(/per \w+\./, 'per {u}.').replace(/Closed \w+ \d+\.$/, 'Closed {d}.');
  });
  assert.equal(new Set(shapes).size, shapes.length, `ledger template collision: ${lines.join(' / ')}`);
});

test('conclusionLine: past-tense finding anchored to its close date', () => {
  const wormholes = mkStudy({
    feature: 'wormholePairCount', label: 'wormholes', unit: 'wormhole pair',
    verdict: { kind: 'resting', deltaPct: null },
    lastStudied: '2026-05-30',
    latest: { date: '2026-08-02', mean: 0.0015, sd: 0.0018 },
  });
  const line = conclusionLine(wormholes, 'closed-lost', newSession());
  assert.match(line, /^Wormholes |^The wormholes /);
  // The header names the feature, so the unit is short: "per ten pairs",
  // never "per ten wormhole pairs" (Christopher's spec example, carried
  // through the 2026-08-11 per-ten scaling: a 0.15% per-pair effect now
  // speaks as its whole-percent per-ten form).
  assert.match(line, /3% per ten pairs/);
  assert.ok(!/\d\.\d% per ten pairs/.test(line), `the per-ten scale exists to retire decimals: "${line}"`);
  assert.match(line, /Closed May 30\.$/);
  assertProseRails(line, 'ledger');

  const positive = conclusionLine(mkStudy({
    feature: 'sonarCellCount', label: 'sonar', unit: 'sonar cell',
    verdict: { kind: 'resting', deltaPct: null }, lastStudied: '2026-07-20',
    latest: { date: '2026-08-02', mean: 0.0428, sd: 0.0203 },
  }), 'closed-won', newSession());
  // Per ten, universally: exp(0.43) - 1 = 53.7% for the fixture's mean.
  assert.match(positive, /about 53% per ten cells/);
  assert.match(positive, /Closed Jul 20\./);

  const parked = conclusionLine(mkStudy({
    feature: 'mysteryCellCount', label: 'mystery cells', unit: 'mystery cell',
    verdict: { kind: 'resting', deltaPct: null }, lastStudied: '2026-07-04',
    latest: { date: '2026-08-02', mean: 0.010, sd: 0.012 },
  }), 'resting', newSession());
  assert.match(parked, /Parked Jul 4\./);

  // Reopened routes to its own pool, and the reference figure carries
  // its OWN date (this fixture's reference is the era start, Jul 2 —
  // NOT the May 30 close; stamping the close date on the era-start
  // figure was a bug this fixture caught).
  const reopened = conclusionLine(wormholes, 'reopened', newSession());
  assert.match(reopened, /Jul 2/);
  assert.match(reopened, /watching it\.$/);
  assert.ok(!reopened.includes('May 30'), `close date misattributed to the reference figure: "${reopened}"`);
});

test('queueLine: want-data-next framing, skips the active target and unnamed features', () => {
  const coverage = [
    { feature: 'fragmentationRatio', n_boards: 2 },     // unnamed — skipped
    { feature: 'compassCellCount', n_boards: 7 },       // active — skipped
    { feature: 'wormholePairCount', n_boards: 10 },
  ];
  const restingStudies = [{ feature: 'wormholePairCount', verdict: { kind: 'resting' } }];
  const q = queueLine(coverage, 'compassCellCount', restingStudies);
  assert.equal(q.feature, 'wormholePairCount');
  assert.match(q.text, /wormhole/);
  assert.match(q.text, /closed|balance/i, 'a closed queue target gets the honest closed phrasing');
  assertProseRails(q.text, 'queue');
  assertDigitsDerivable(q.text, q.facts, 'queue');
  assert.ok(!/\btoday\b/i.test(q.text), 'the queue never claims anything about today');

  const open = queueLine(coverage, 'compassCellCount', []);
  assert.match(open.text, /ten|10/, 'the board count is spoken');
  assert.equal(queueLine([], 'x', []), null);
  assert.equal(queueLine(null, 'x', []), null);
});

// ── Lab log ───────────────────────────────────────────────────────────

test('labLog: notable days only, newest first, honest diffs', () => {
  const f = 'compassCellCount';
  const history = [
    row('2026-07-02', 'sonarCellCount', [cand(f, 0.033, 0.020)], { n_scores: 100 }),
    // Switch to compass + 4 runs + 5% tightening (0.020 → 0.019).
    row('2026-07-03', f, [cand(f, 0.033, 0.019)], { n_scores: 104 }),
    // Quiet non-latest day — must be skipped entirely.
    row('2026-07-04', 'lockedCellCount', [cand(f, 0.033, 0.019)], { n_scores: 104 }),
    // 2 runs, ~21% widening (0.019 → 0.023).
    row('2026-07-05', 'lockedCellCount', [cand(f, 0.033, 0.023)], { n_scores: 106 }),
    // Rejected fit.
    row('2026-07-06', 'lockedCellCount', [cand(f, 0.033, 0.023)], { n_scores: 106, method: 'seed-residuals' }),
    // Quiet latest day — rendered so the log opens on the current state.
    row('2026-07-07', 'lockedCellCount', [cand(f, 0.033, 0.023)], { n_scores: 106 }),
  ];
  const log = labLog(history, f);
  assert.deepEqual(log.map(e => e.date),
    ['2026-07-07', '2026-07-06', '2026-07-05', '2026-07-03'],
    'newest first; the quiet non-latest day is silent');

  const [quiet, rejected, widened, switched] = log;
  assert.match(quiet.text, /^Jul 7\./);
  assert.equal(quiet.facts.runs, 0);
  assert.match(rejected.text, /quality bar|Diagnostics|converge/);
  assert.equal(widened.facts.delta, 21);
  assert.match(widened.text, /21%/);
  assert.equal(switched.facts.runs, 4);
  assert.equal(switched.facts.delta, 5);
  assert.match(switched.text, /^Jul 3\./);
  assert.match(switched.text, /file|assignment|chooser/, 'the switch is narrated');

  for (const e of log) {
    assertProseRails(e.text, `log ${e.date}`);
    assertDigitsDerivable(e.text, e.facts, `log ${e.date}`);
  }

  // The cap holds and drops the OLDEST notable days.
  const long = [];
  for (let d = 1; d <= 20; d++) {
    const date = `2026-07-${String(d).padStart(2, '0')}`;
    long.push(row(date, f, [cand(f, 0.033, 0.020)], { n_scores: 100 + d * 3 }));
  }
  const capped = labLog(long, f);
  assert.equal(capped.length, MAX_LOG_ENTRIES);
  assert.equal(capped[0].date, '2026-07-20');
});

test('REGRESSION: a live-era return to a long-studied feature never claims a first assignment', () => {
  // Compass has study days back to April; the log's number diffs are
  // windowed to the live era, but "first assignment" is a whole-history
  // claim. Before the fix, the first live-era switch rendered "This
  // file drew its first assignment."
  const f = 'compassCellCount';
  const history = [
    row('2026-04-27', f, [cand(f, 0.7, 0.6)], { n_scores: 40 }),   // pre-epoch study day
    row('2026-07-02', 'sonarCellCount', [cand(f, 0.033, 0.020)], { n_scores: 100 }),
    row('2026-07-08', f, [cand(f, 0.033, 0.019)], { n_scores: 104 }),
  ];
  const log = labLog(history, f);
  const switchDay = log.find(e => e.date === '2026-07-08');
  assert.ok(switchDay, 'the switch day is notable');
  assert.ok(!/first assignment|opened this file/.test(switchDay.text),
    `first-assignment claim on a returning study: "${switchDay.text}"`);
  // A genuinely-new target still gets the first-assignment phrasing.
  const fresh = labLog(history.slice(1), f);
  const freshSwitch = fresh.find(e => e.date === '2026-07-08');
  assert.match(freshSwitch.text, /first assignment|opened this file/);
});

// ── The whole screen ──────────────────────────────────────────────────

test('planJournalScreen: active card, ledger, queue, and table from one fixture', () => {
  const f = {
    compass: 'compassCellCount', sonar: 'sonarCellCount', worm: 'wormholePairCount', liar: 'liarCellCount',
  };
  // cv values mirror the real refit output (NOT sd/mean — the pipeline
  // computes cv on its own terms; the derivation only sorts the field):
  // compass and sonar rank top-half, the tiny zero-band features bottom.
  const cands = () => [
    { feature: f.compass, mean: 0.033, sd: 0.019, cv: 0.57 },
    { feature: f.sonar, mean: 0.0428, sd: 0.0203, cv: 0.48 },
    { feature: f.worm, mean: 0.0015, sd: 0.0018, cv: 0.18 },
    { feature: f.liar, mean: 0.0015, sd: 0.0019, cv: 0.19 },
  ];
  const history = [
    row('2026-07-02', f.worm, cands(), { n_scores: 100 }),
    row('2026-07-03', f.liar, cands(), { n_scores: 104 }),
    row('2026-07-04', f.sonar, cands(), { n_scores: 108 }),
    row('2026-08-01', f.compass, cands(), { n_scores: 150 }),
    row('2026-08-02', f.compass, cands(), { n_scores: 154 }),
  ];
  const meta = {
    target: f.compass,
    reason: 'highest posterior CV',
    coverage_targets: [{ feature: f.worm, n_boards: 10 }],
  };
  const screen = planJournalScreen(history, meta);

  assert.equal(screen.active.study.feature, f.compass);
  assert.equal(screen.active.entry.state, 'active-unresolved');
  assert.ok(screen.active.log.length > 0, 'the active card carries a lab log');

  // Wormholes and liar cells are idle 30+ days with bottom-half CV →
  // resting verdicts → the conclusions ledger, newest close first.
  assert.deepEqual(screen.ledger.map(l => l.study.feature), [f.liar, f.worm]);
  assert.equal(screen.ledger[0].state, 'closed-won');
  assert.equal(screen.ledger[1].state, 'closed-lost');
  for (const l of screen.ledger) {
    assert.ok(l.line, `${l.study.feature} has a ledger line`);
    assert.match(l.line, /Closed|Parked/);
  }

  assert.equal(screen.queue.feature, f.worm);
  assert.deepEqual(screen.table.map(r => r.feature),
    [f.sonar, f.compass, f.worm, f.liar], 'table sorted by effect size');

  // The collision rule holds across the screen: every closer distinct.
  const entries = [screen.active.entry, ...screen.ledger.map(l => l.entry)];
  const closers = entries.map(e => e.text.split(/(?<=\.)\s+/).pop());
  assert.equal(new Set(closers).size, closers.length, `closer collision: ${closers.join(' / ')}`);

  // Revalidation stamp (PR D) promotes the active entry's state.
  const revalidated = planJournalScreen(history, { ...meta, reason: 'revalidation' });
  assert.equal(revalidated.active.entry.state, 'revalidation');

  // No meta (offline): the latest row's target stands in.
  const offline = planJournalScreen(history, null);
  assert.equal(offline.active.study.feature, f.compass);
  assert.equal(offline.queue, null, 'no coverage list, no queue line');
});

test('smoke: the real modelHistory.json composes a clean screen (structural invariants only)', () => {
  const real = JSON.parse(readFileSync(new URL('../src/logic/modelHistory.json', import.meta.url), 'utf8'));
  const meta = JSON.parse(readFileSync(new URL('../src/logic/experimentTarget.json', import.meta.url), 'utf8'));
  const screen = planJournalScreen(real, meta);

  assert.ok(screen.active, 'a named active study exists');
  assert.ok(screen.active.study.label, 'the active study has a plain name');
  assert.ok(screen.active.entry.text.length > 80, 'the active entry is a real paragraph');
  assert.ok(screen.active.log.length > 0, 'the lab log has entries');
  assert.ok(screen.table.length >= 8, `table rows: ${screen.table.length}`);

  const texts = [
    screen.active.entry.text,
    ...screen.active.log.map(e => e.text),
    ...screen.ledger.flatMap(l => [l.line, l.entry.text]),
    ...(screen.queue ? [screen.queue.text] : []),
  ];
  assert.ok(texts.length >= 3);
  for (const t of texts) assertProseRails(t, 'real-data');
  assertDigitsDerivable(screen.active.entry.text, screen.active.entry.facts, 'real active entry');
  for (const e of screen.active.log) assertDigitsDerivable(e.text, e.facts, `real log ${e.date}`);
  for (const l of screen.ledger) {
    assertDigitsDerivable(l.entry.text, l.entry.facts, `real ${l.study.feature}`);
    assert.ok(['closed-won', 'closed-lost', 'resting', 'reopened'].includes(l.state), l.state);
  }
  if (screen.queue) assertDigitsDerivable(screen.queue.text, screen.queue.facts, 'real queue');

  // Ledger is sorted by close date, newest first.
  const closes = screen.ledger.map(l => l.study.lastStudied || '');
  assert.deepEqual(closes, [...closes].sort().reverse());

  // Determinism end to end.
  const again = planJournalScreen(real, meta);
  assert.equal(again.active.entry.text, screen.active.entry.text);
  assert.deepEqual(again.ledger.map(l => l.line), screen.ledger.map(l => l.line));

  // Table renders no minus signs and no unresolved holes.
  for (const r of screen.table) {
    assert.ok(!r.effect.includes('-') && !r.range.includes('-'), `${r.feature}: ${r.effect} ${r.range}`);
  }
});

test('REGRESSION: a straddling or refund band can never render a fake negative or a fake floor', () => {
  // Ambiguous band with a negative point estimate (the shape the review
  // caught): the estimate beat must stay on the canonical straddling
  // sentence — the rotated POS pool would render "costs about -2%" with
  // a fabricated 0% floor.
  const straddling = mkStudy({
    feature: 'liarCellCount', label: 'liar cells', unit: 'liar cell',
    latest: { date: '2026-08-02', mean: -0.02, sd: 0.05 },
    trajectory: [
      { date: '2026-07-02', mean: -0.02, sd: 0.05, retro: false },
      { date: '2026-08-02', mean: -0.02, sd: 0.05, retro: false },
    ],
  });
  assert.equal(bandClass(estimateSummary(straddling)), 'ambiguous');
  for (const asOf of ['2026-08-02', '2026-08-03', '2026-08-04']) {
    const s = { ...straddling, latest: { ...straddling.latest, date: asOf } };
    const entry = composeEntry(s, {}, newSession());
    assert.ok(!/-\d/.test(entry.text), `fake negative in: "${entry.text}"`);
    assert.match(entry.text, /between 0% and about/, 'the honest straddling form renders');
  }
  // A parked ambiguous study's ledger line uses the straddling form too.
  const parked = conclusionLine({
    ...straddling,
    verdict: { kind: 'resting', deltaPct: null }, lastStudied: '2026-07-04',
  }, 'resting', newSession());
  assert.ok(!/-\d/.test(parked), `fake negative in ledger: "${parked}"`);
  assert.match(parked, /0%/);
});

test('bandClass: a band that excludes zero is pos even under 1%, zero requires lo <= 0', () => {
  // lo > 0, hi < 1: a PROVEN tiny effect — calling it "almost nothing"
  // would contradict the estimate sentence on the same card.
  assert.equal(bandClass({ pct: 0.5, lo: 0.3, hi: 0.7 }), 'pos');
  assert.equal(bandClass({ pct: 0.2, lo: -0.1, hi: 0.4 }), 'zero');
  assert.equal(bandClass({ pct: 2, lo: -0.5, hi: 4 }), 'ambiguous');
  assert.equal(bandClass({ pct: -2, lo: -3, hi: -1 }), 'neg');
  // A faster-lean zero band (mostly-negative with a tiny positive top)
  // stays OUT — it can't close against a hypothesis it half-supports.
  const faster = mkStudy({
    feature: 'zeroClusterCount', label: 'open areas', unit: 'open area',
    verdict: { kind: 'resting', deltaPct: null }, lastStudied: '2026-07-04',
    latest: { date: '2026-08-02', mean: -0.02, sd: 0.025 },
    trajectory: [
      { date: '2026-07-02', mean: -0.02, sd: 0.025, retro: false },
      { date: '2026-08-02', mean: -0.02, sd: 0.025, retro: false },
    ],
  });
  assert.equal(resolutionFor(faster), 'out');
  assert.equal(narrativeState(faster), 'resting', 'never closed-lost while the data half-supports the hunch');
});

test('REGRESSION: the arc fallback never fabricates "my note was a question mark" for a bespoke file', () => {
  // A cost-lean feature whose band goes whole-negative has no bespoke
  // 'neg' line; the fallback must be its OWN out line, not the generic.
  const sonarNeg = mkStudy({
    feature: 'sonarCellCount', label: 'sonar', unit: 'sonar cell',
    latest: { date: '2026-08-02', mean: -0.05, sd: 0.01 },
    trajectory: [
      { date: '2026-07-02', mean: -0.05, sd: 0.01, retro: false },
      { date: '2026-08-02', mean: -0.05, sd: 0.01, retro: false },
    ],
  });
  for (const asOf of ['2026-08-02', '2026-08-03', '2026-08-04']) {
    const entry = composeEntry({ ...sonarNeg, latest: { ...sonarNeg.latest, date: asOf } }, {}, newSession());
    assert.ok(!entry.text.includes('question mark'),
      `fabricated note claim for a bespoke file: "${entry.text}"`);
  }
});

test('arcSpoken means the entry QUOTES the hunch, not merely that an arc beat rendered', () => {
  // cellCount's out-arc line carries no hypothesis content — the card
  // must keep the epigraph.
  const cell = mkStudy({
    feature: 'cellCount', label: 'board size', unit: 'cell',
    latest: { date: '2026-08-02', mean: 0.01, sd: 0.02 }, // ambiguous → out
    trajectory: [
      { date: '2026-07-02', mean: 0.01, sd: 0.02, retro: false },
      { date: '2026-08-02', mean: 0.01, sd: 0.02, retro: false },
    ],
  });
  const entry = composeEntry(cell, {}, newSession());
  if (entry.text.includes('The size rate drifts')) {
    assert.equal(entry.arcSpoken, false, 'a no-quote arc line must not hide the epigraph');
  }
  // And a quoting arc does set it (wormholes closed-lost quotes "I predicted").
  const worm = mkStudy({
    feature: 'wormholePairCount', label: 'wormholes', unit: 'wormhole pair',
    verdict: { kind: 'resting', deltaPct: null }, lastStudied: '2026-05-30', studyDayCount: 6,
    firstStudied: '2026-04-29',
    latest: { date: '2026-08-02', mean: 0.0015, sd: 0.0018 },
    trajectory: [
      { date: '2026-07-02', mean: 0.0015, sd: 0.0018, retro: false },
      { date: '2026-08-02', mean: 0.0015, sd: 0.0018, retro: false },
    ],
  });
  const wormEntry = composeEntry(worm, {}, newSession());
  assert.ok(wormEntry.text.includes('I predicted'));
  assert.equal(wormEntry.arcSpoken, true);
});

test('reopened ledger line cites the parked figure and the current one, never one as the other', () => {
  const drifted = mkStudy({
    feature: 'lockedCellCount', label: 'locked cells', unit: 'locked cell',
    verdict: { kind: 'resting', deltaPct: null },
    lastStudied: '2026-07-05', studyDayCount: 5,
    latest: { date: '2026-08-02', mean: 0.045, sd: 0.006 },
    trajectory: [
      { date: '2026-07-02', mean: 0.030, sd: 0.006, retro: false },
      { date: '2026-07-05', mean: 0.030, sd: 0.006, retro: false },
      { date: '2026-08-02', mean: 0.045, sd: 0.006, retro: false },
    ],
  });
  assert.equal(narrativeState(drifted), 'reopened');
  const line = conclusionLine(drifted, 'reopened', newSession());
  assert.match(line, /35%/, 'the parked figure');   // exp(0.30) − 1 = 35.0
  assert.match(line, /57%/, 'the current figure');  // exp(0.45) − 1 = 56.8 → 57
  assert.match(line, /watching/i);
  assert.match(line, /Jul 5/, 'anchored to the close date');
});

test('driftSinceClose stays silent when the two figures round to the same display value', () => {
  // Statistically past the sd bar, but both means render "3%": the
  // reopened prose would assert movement and then show identical numbers.
  const sameRounded = mkStudy({
    lastStudied: '2026-07-05',
    trajectory: [
      { date: '2026-07-05', mean: 0.0300, sd: 0.002, retro: false },
      { date: '2026-08-02', mean: 0.0330, sd: 0.002, retro: false },
    ],
  });
  assert.equal(driftSinceClose(sameRounded), null);
});

test('REGRESSION: queue line grammar survives n_boards = 1, and a first-fit-night log claims no range', () => {
  const q = queueLine([{ feature: 'liarCellCount', n_boards: 1 }], 'compassCellCount', []);
  assert.ok(!/one boards\b/.test(q.text), `plural slip: "${q.text}"`);
  assert.match(q.text, /one board\b|One is not/, q.text);

  // A feature absent from the previous night's candidates (its first
  // appearance in the fit) must not read "the range didn't blink".
  const f = 'newDigitShare';
  const history = [
    row('2026-07-02', 'sonarCellCount', [cand('sonarCellCount', 0.04, 0.02)], { n_scores: 100 }),
    row('2026-07-03', 'sonarCellCount', [cand('sonarCellCount', 0.04, 0.02), cand(f, 0.01, 0.008)], { n_scores: 104 }),
  ];
  const log = labLog(history, f);
  const night = log.find(e => e.date === '2026-07-03');
  assert.ok(night, 'runs landed, the night is notable');
  assert.ok(!/range|band|estimate|needle|doubt/i.test(night.text),
    `range claim without a measured range: "${night.text}"`);
});

test('activeFeatureFrom: meta target when named, latest row target otherwise, null when unnamed', () => {
  const history = [
    row('2026-07-02', 'sonarCellCount', [cand('sonarCellCount', 0.04, 0.02)]),
  ];
  assert.equal(activeFeatureFrom(history, { target: 'compassCellCount' }), 'compassCellCount');
  assert.equal(activeFeatureFrom(history, { target: 'fragmentationRatio' }), 'sonarCellCount', 'unnamed meta target falls back');
  assert.equal(activeFeatureFrom(history, null), 'sonarCellCount');
  assert.equal(activeFeatureFrom([{ ...row('2026-07-02', 'fragmentationRatio', [cand('x', 1, 1)]) }], null), null);
});

test('pool floors: the variety Christopher asked for is pinned, not accidental', () => {
  // Counting templates per beat family from the guard inventory: the
  // freshness round grew every pool; a future edit shrinking one below
  // these floors would quietly re-stale the notebook.
  const lines = allProseLines();
  assert.ok(lines.length >= 150, `pool inventory shrank: ${lines.length} lines`);
});

test('planStudyFigures: deterministic, eligible-only, sometimes two, shapes rotate', () => {
  const base = mkStudy({});
  // Determinism.
  assert.deepEqual(planStudyFigures(base), planStudyFigures(base));

  // Eligibility: no estimate → only the sd-trend can draw; a one-point
  // series draws nothing.
  const noEst = mkStudy({ latest: null, trajectory: [
    { date: '2026-07-02', mean: 0.03, sd: 0.02, retro: false },
    { date: '2026-07-08', mean: 0.03, sd: 0.019, retro: false },
  ] });
  noEst.latest = null;
  assert.ok(planStudyFigures(noEst).every(s => s.type === 'sd-trend'));
  assert.deepEqual(planStudyFigures(mkStudy({ trajectory: [], latest: null })), []);
  // A whole-band refund never gets the band-strip (its axis starts at 0).
  const refund = mkStudy({ latest: { date: '2026-08-02', mean: -0.05, sd: 0.01 } });
  assert.ok(planStudyFigures(refund).every(s => s.type !== 'band-strip'));

  // Across many feature/date seeds: every figure type occurs, some cards
  // get two figures (distinct types), and sd-trend shapes vary.
  const types = new Set();
  const shapes = new Set();
  let twoFigure = 0;
  for (let i = 0; i < 40; i++) {
    const s = mkStudy({ feature: `feature${i}`, latest: { date: '2026-08-02', mean: 0.03, sd: 0.019 } });
    const plan = planStudyFigures(s);
    assert.ok(plan.length >= 1 && plan.length <= 2, `plan size ${plan.length}`);
    assert.equal(new Set(plan.map(p => p.type)).size, plan.length, 'no duplicate figure types on one card');
    if (plan.length === 2) twoFigure++;
    for (const spec of plan) {
      assert.ok(FIGURE_TYPES.includes(spec.type), spec.type);
      assert.ok(spec.caption && spec.caption.length > 10, 'every figure carries a lay caption');
      assert.ok(!/\{[A-Za-z]+\}/.test(spec.caption), `unresolved token in caption: "${spec.caption}"`);
      types.add(spec.type);
      if (spec.type === 'sd-trend') shapes.add(spec.dotShape);
      else assert.equal(spec.dotShape, null);
    }
  }
  assert.equal(types.size, FIGURE_TYPES.length, `all figure types occur: ${[...types].join(',')}`);
  assert.ok(shapes.size >= 3, `dot shapes rotate: ${[...shapes].join(',')}`);
  assert.ok(twoFigure >= 5 && twoFigure <= 25, `two-figure cards ~1/3: ${twoFigure}/40`);

  // A series with retrodicted points never gets the bare-line style —
  // the dimmed dot IS the retro disclosure.
  for (let i = 0; i < 40; i++) {
    const s = mkStudy({
      feature: `retro${i}`,
      trajectory: [
        { date: '2026-06-01', mean: 0.03, sd: 0.02, retro: true },
        { date: '2026-07-02', mean: 0.03, sd: 0.02, retro: false },
        { date: '2026-08-02', mean: 0.03, sd: 0.019, retro: false },
      ],
    });
    for (const spec of planStudyFigures(s)) {
      if (spec.type === 'sd-trend') assert.notEqual(spec.dotShape, 'none');
    }
  }
});

test('figure captions and intro variants obey the framing-copy rails', () => {
  const captions = allFigureCaptions();
  assert.ok(captions.length >= 9, `caption pool: ${captions.length}`);
  for (const c of captions) {
    assert.ok(!c.includes('—') && !c.includes('–'), `dash in caption: "${c}"`);
    assert.ok(!/\d/.test(c), `caption claims a number: "${c}"`);
    assert.ok(!/today.s board/i.test(c), `fieldnote-drift claim in caption: "${c}"`);
    assert.ok(!IMPRECISE_VERBS.test(c), `imprecise verb in caption: "${c}"`);
    assertCompleteSentences(c, 'caption');
  }
  // The modal intro rotates by refit date but always frames the same
  // honest promise (his notes, bad days included).
  const mk = (date) => [
    row(date, 'sonarCellCount', [cand('sonarCellCount', 0.043, 0.020)]),
    row('2026-07-02', 'sonarCellCount', [cand('sonarCellCount', 0.043, 0.021)]),
  ];
  const intros = new Set();
  for (const d of ['2026-07-10', '2026-07-11', '2026-07-12', '2026-07-13', '2026-07-14', '2026-07-15']) {
    const screen = planJournalScreen(mk(d), null);
    assert.ok(screen.intro.length > 60);
    assert.ok(!screen.intro.includes('—') && !screen.intro.includes('–'));
    intros.add(screen.intro);
  }
  assert.ok(intros.size >= 2, 'the intro actually rotates across dates');
});

test('utilities: hashStr is stable, countWord spells small counts', () => {
  assert.equal(hashStr('compassCellCount'), hashStr('compassCellCount'));
  assert.notEqual(hashStr('a'), hashStr('b'));
  assert.equal(countWord(0), 'zero');
  assert.equal(countWord(6), 'six');
  assert.equal(countWord(20), 'twenty');
  assert.equal(countWord(21), '21');
  assert.equal(NEGLIGIBLE_PCT, 1);
});
