// Greg's voice — every sentence must be backed by data, and the bad days
// (widened estimate, rejected fit, nobody played) must speak too. A Greg
// who only reports good news is a mascot, not a scientist.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  fieldNoteLine, fieldNoteFromBoard, yesterdayNote, labFileLine, featureName,
  featureHypothesis, classifySdDelta,
} = await import('../src/logic/gregVoice.js');

test('fieldNoteLine distinguishes primary probes from coverage studies, null on unknowns', () => {
  assert.match(fieldNoteLine({ target: 'sonarCellCount', isPrimary: true }), /probes sonar.*widest uncertainty/);
  assert.match(fieldNoteLine({ target: 'lockedCellCount', isPrimary: false }), /locked cells study.*more data/);
  assert.equal(fieldNoteLine({ target: 'someUnknownFeature', isPrimary: true }), null);
  assert.equal(fieldNoteLine(null), null);
});

test('a decorrelation day says what it pulls apart, and never calls itself a study of the feature', () => {
  // The claim has to match the board. A decorrelation board was not picked
  // for carrying many threes; it was picked for having threes and density
  // disagree. Calling it "a threes study" would be the wrong sentence, and
  // it is the sentence the ordinary coverage branch would produce.
  const line = fieldNoteLine({
    target: 'clueShare3', isPrimary: false,
    type: 'decorrelation', confounder: 'density',
  });
  assert.match(line, /pulls threes apart from mine density/);
  assert.ok(!/threes study/.test(line), 'a decorrelation board is not a study of its feature');

  // Both names must be sayable in plain words or Greg says nothing. An
  // unnamed confounder is the case a raw code name would leak through.
  assert.equal(fieldNoteLine({
    target: 'clueShare3', isPrimary: false,
    type: 'decorrelation', confounder: 'someUnnamedAxis',
  }), null);
  assert.equal(fieldNoteLine({
    target: 'someUnnamedFeature', isPrimary: false,
    type: 'decorrelation', confounder: 'density',
  }), null);

  // Voice rails, same bar as the rest of the notebook copy.
  assert.ok(!line.includes('—') && !line.includes('–'), 'zero em-dashes and en-dashes');
  assert.ok(!/\d/.test(line), 'the Field Note never states a number the board has not earned');
  const hedges = (line.match(/\b(maybe|perhaps|possibly|might|somewhat|fairly|rather)\b/gi) || []);
  assert.ok(hedges.length <= 1, 'at most one hedge per sentence');
});

test('fieldNoteFromBoard carries the decorrelation stamp through from the payload', () => {
  // The stamped mission is the only drift-proof record of why a board exists:
  // boards generate up to 7 days ahead and the nightly refit reorders the
  // targets, so re-deriving from the seed names the wrong study.
  assert.match(
    fieldNoteFromBoard({
      missionTarget: 'clueShare3', missionIsPrimary: false,
      missionType: 'decorrelation', missionConfounder: 'density',
      activeGimmicks: ['sonar'],
    }),
    /pulls threes apart from mine density/,
  );
  // A board stamped by an older pipeline has no type, so it reads as the
  // ordinary study it was.
  assert.match(
    fieldNoteFromBoard({ missionTarget: 'sonarCellCount', missionIsPrimary: false }),
    /sonar study/,
  );
});

test('fieldNoteFromBoard cannot contradict the board (regression: 2026-06-10 wormhole board labeled compass)', () => {
  // Stamped mission wins when present (boards written after the fix).
  assert.match(
    fieldNoteFromBoard({ missionTarget: 'wormholePairCount', missionIsPrimary: false, activeGimmicks: ['wormhole'] }),
    /wormholes study.*more data/,
  );
  assert.match(
    fieldNoteFromBoard({ missionTarget: 'sonarCellCount', missionIsPrimary: true }),
    /probes sonar.*widest uncertainty/,
  );
  // No stamp (historical boards): fall back to the board's ACTUAL
  // gimmicks in the neutral framing — never a re-derived slot mapping.
  assert.equal(
    fieldNoteFromBoard({ activeGimmicks: ['wormhole'] }),
    'Greg: today is a wormholes study',
  );
  assert.equal(
    fieldNoteFromBoard({ activeGimmicks: ['liar', 'walls'] }),
    'Greg: today is a liar cells + walls study',
  );
  // Worm tiles (2026-07-16) are named, never silently dropped.
  assert.equal(
    fieldNoteFromBoard({ activeGimmicks: ['worm'] }),
    'Greg: today is a worm tiles study',
  );
  // Gimmick-free board → no note, never a vague one.
  assert.equal(fieldNoteFromBoard({ activeGimmicks: [] }), null);
  assert.equal(fieldNoteFromBoard(null), null);
});

const row = (over) => ({
  date: '2026-06-09', method: 'brms-ranef', n_scores: 100, target: 'sonarCellCount',
  candidates: [{ feature: 'sonarCellCount', mean: 0.8, sd: 0.9, cv: 1.1 }],
  ...over,
});

test('yesterdayNote: all four honesty branches', () => {
  // Tightened: sd 0.9 -> 0.8 with 3 new runs.
  const tightened = yesterdayNote([
    row({ n_scores: 100 }),
    row({ date: '2026-06-10', n_scores: 103, candidates: [{ feature: 'sonarCellCount', sd: 0.8 }] }),
  ]);
  assert.match(tightened, /3 runs tightened my sonar estimate by 11%/);

  // Widened.
  const widened = yesterdayNote([
    row({ n_scores: 100 }),
    row({ date: '2026-06-10', n_scores: 102, candidates: [{ feature: 'sonarCellCount', sd: 1.0 }] }),
  ]);
  assert.match(widened, /WIDENED my sonar estimate by 11%/);

  // Fit rejected (diagnostics failure -> residuals fallback method).
  const rejected = yesterdayNote([
    row({ n_scores: 100 }),
    row({ date: '2026-06-10', n_scores: 105, method: 'seed-residuals' }),
  ]);
  assert.match(rejected, /failed my quality bar/);

  // Nobody played.
  const nobody = yesterdayNote([
    row({ n_scores: 100 }),
    row({ date: '2026-06-10', n_scores: 100 }),
  ]);
  assert.match(nobody, /nobody fed the model/i);

  // Not enough history -> silence, never fabrication.
  assert.equal(yesterdayNote([row({})]), null);
  assert.equal(yesterdayNote(null), null);
});

test('labFileLine itemizes only with a real {k, bombSeconds} decomposition', () => {
  // Pace is board-scaled: gregPar × (k - 1). k=1.0875 on a 96s board = +8.4s.
  const line = labFileLine(96.0, { k: 1.0875, bombSeconds: 6.1 });
  assert.match(line, /Your par 110\.5s = Greg 96\.0s your pace \+8\.4s bombs \+6\.1s/);
  // Faster-than-typical (k < 1) renders the pace with a minus sign.
  assert.match(labFileLine(96.0, { k: 0.9354167, bombSeconds: 0 }), /your pace −6\.2s/);
  // Zero bomb factor drops the bombs term entirely.
  assert.ok(!labFileLine(96.0, { k: 1.02, bombSeconds: 0 }).includes('bombs'));
  // No decomposition -> null, never a fabricated split. Old {clean,bomb}
  // shape (missing k) also returns null.
  assert.equal(labFileLine(96.0, null), null);
  assert.equal(labFileLine(96.0, { k: 1.05 }), null);
  assert.equal(labFileLine(96.0, { clean: 1, bomb: 0 }), null);
});

test('classifySdDelta: the one shared definition of tightened/widened/flat', () => {
  // yesterdayNote's verbal tier (default ±2%).
  assert.deepEqual(classifySdDelta(0.9, 0.8), { kind: 'tightened', deltaPct: 11 });
  assert.deepEqual(classifySdDelta(0.9, 1.0), { kind: 'widened', deltaPct: -11 });
  assert.equal(classifySdDelta(0.9, 0.895).kind, 'flat');
  // The Journal's higher bar rides the same function.
  assert.equal(classifySdDelta(0.020, 0.016, 15).kind, 'tightened');
  assert.equal(classifySdDelta(0.020, 0.018, 15).kind, 'flat');
  // Garbage SDs are invalid, never a number.
  assert.equal(classifySdDelta(0, 0.5).kind, 'invalid');
  assert.equal(classifySdDelta(0.5, undefined).kind, 'invalid');
  assert.equal(classifySdDelta(NaN, 0.5).kind, 'invalid');
});

test('featureHypothesis: bespoke claims are structural and plain; unnamed features get the honest generic', () => {
  for (const f of ['lockedCellCount', 'sonarCellCount', 'compassCellCount', 'mirrorPairCount',
    'liarCellCount', 'mysteryCellCount', 'wormholePairCount', 'wallEdgeCount', 'wormLoad',
    'zeroClusterCount', 'searchMoves', 'patternMoves', 'totalMines', 'cellCount']) {
    const h = featureHypothesis(f);
    assert.ok(h && h.length > 30, `missing hypothesis for ${f}`);
    assert.ok(!/\d+\s*%|\d+\.\d+|\bseconds\b.*\d/.test(h), `${f} hypothesis must not pose a number: "${h}"`);
    assert.ok(!/[a-z][A-Z]/.test(h), `${f} hypothesis leaks a code name: "${h}"`);
    assert.ok(!h.includes('—'), `${f} hypothesis carries an em-dash: "${h}"`);
  }
  // A studied-but-unnamed feature: honest generic, never the raw key.
  const generic = featureHypothesis('fragmentationRatio');
  assert.match(generic, /experimental board measure/);
  assert.ok(!generic.includes('fragmentationRatio'));
  assert.equal(featureHypothesis(''), null);
  assert.equal(featureHypothesis(null), null);
});

test('featureName covers every push-able model feature', () => {
  for (const f of ['lockedCellCount', 'sonarCellCount', 'compassCellCount', 'mirrorPairCount',
    'liarCellCount', 'mysteryCellCount', 'wormholePairCount', 'wallEdgeCount', 'wormLoad',
    'zeroClusterCount', 'searchMoves', 'patternMoves', 'totalMines']) {
    assert.ok(featureName(f), `missing plain-English name for ${f}`);
  }
});
