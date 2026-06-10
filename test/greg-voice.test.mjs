// Greg's voice — every sentence must be backed by data, and the bad days
// (widened estimate, rejected fit, nobody played) must speak too. A Greg
// who only reports good news is a mascot, not a scientist.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { fieldNoteLine, fieldNoteFromBoard, yesterdayNote, labFileLine, featureName } = await import('../src/logic/gregVoice.js');

test('fieldNoteLine distinguishes primary probes from coverage studies, null on unknowns', () => {
  assert.match(fieldNoteLine({ target: 'sonarCellCount', isPrimary: true }), /probes sonar.*widest uncertainty/);
  assert.match(fieldNoteLine({ target: 'lockedCellCount', isPrimary: false }), /locked cells study.*more data/);
  assert.equal(fieldNoteLine({ target: 'someUnknownFeature', isPrimary: true }), null);
  assert.equal(fieldNoteLine(null), null);
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

test('labFileLine itemizes only with a real decomposition', () => {
  const line = labFileLine(96.0, { clean: 8.4, bomb: 6.1 });
  assert.match(line, /Your par 110\.5s = Greg 96\.0s your pace \+8\.4s bombs \+6\.1s/);
  // Negative pace (faster than typical) renders with a minus sign.
  assert.match(labFileLine(96.0, { clean: -6.2, bomb: 0 }), /your pace −6\.2s/);
  // Zero bomb factor drops the bombs term entirely.
  assert.ok(!labFileLine(96.0, { clean: 2, bomb: 0 }).includes('bombs'));
  // No decomposition -> null, never a fabricated split.
  assert.equal(labFileLine(96.0, null), null);
  assert.equal(labFileLine(96.0, { clean: 1 }), null);
});

test('featureName covers every push-able model feature', () => {
  for (const f of ['lockedCellCount', 'sonarCellCount', 'compassCellCount', 'mirrorPairCount',
    'liarCellCount', 'mysteryCellCount', 'wormholePairCount', 'wallEdgeCount',
    'zeroClusterCount', 'searchMoves', 'patternMoves', 'totalMines']) {
    assert.ok(featureName(f), `missing plain-English name for ${f}`);
  }
});
