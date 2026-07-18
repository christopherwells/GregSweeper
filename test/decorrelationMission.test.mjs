// Decorrelation missions: the residual scorer, its validation, and the
// client/precompute agreement that makes a decorrelation day deterministic.
//
// The experiment's other missions chase a coefficient's uncertainty or a
// gimmick's sample gap. Neither breaks COLLINEARITY, and on the canonical-era
// boards clue 3-share runs r = 0.80 against mine density, so "threes cost time"
// and "threes ride on the dense boards they appear on" fit the data almost
// equally well. A decorrelation mission aims at the RESIDUAL of that pair: the
// board where the two disagree is the one that tells the hypotheses apart.
//
// Two invariants carry the most weight here.
//
// 1. The scorer and the slot mapping have TWO consumers that must pick the
//    same seed for the same date: the client (selectDailyRngSeed / parResolve)
//    and the Node precompute (daily-board-pipeline). That mirror pair already
//    drifted once on the slot arithmetic (see missionSlots.test.mjs), so both
//    the scoring rule and the candidate count are single-sourced from the
//    start and asserted identical here.
//
// 2. The plain count scorer must never read a clue share. Porting the clue
//    histogram to the client made features.clueShare3 a real number where it
//    used to be undefined, and a count mission would then MAXIMIZE 3-share —
//    which piles up exactly the high-3-high-density boards the decorrelation
//    mission exists to counterbalance. That refusal used to hold by accident
//    and now has to be explicit.
//
// Run: node --test test/decorrelationMission.test.mjs

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  resolveMissionForSlot,
  resolveCandidateCount,
  missionCandidateScore,
  normalizeDecorrelationMission,
  decorrelationResidualZ,
  missionStamp,
  isObservationalTarget,
  COUNT_CAP,
  CANDIDATE_COUNT,
  DECORRELATION_SLOTS,
} = await import('../src/logic/experimentDesign.js');
const { missionForSlot, candidateCountFor } =
  await import('../scripts/daily-board-pipeline.mjs');
const { clueShares, computeDailyFeatures } =
  await import('../src/logic/dailyFeatures.js');

// The live shape the refit emits: clueShare3 regressed on density. The
// numbers are chosen to be exact in binary floating point so the assertions
// below can state the residual arithmetic exactly rather than within a
// tolerance — the real emitted values are not this tidy, but the scorer is
// deterministic either way because both selection paths evaluate the
// identical expression on identical inputs.
const MISSION = {
  feature: 'clueShare3',
  confounder: 'density',
  slope: 8,
  intercept: 0.5,
  sign: 1,
  residualSd: 0.5,
  weight: 0.3,
};

const coverage = (n) => Array.from({ length: n }, (_, i) => ({
  feature: `feature${i}`,
  deficit_weight: 0.5 / (i + 1),
}));

const spec = (n, decor = null) => ({
  target: 'primaryFeature',
  coverage_targets: coverage(n),
  decorrelation_mission: decor,
});

// ── validation ───────────────────────────────────────────────────────

test('a malformed mission degrades to no decorrelation, never to a NaN score', () => {
  const bad = [
    null,
    undefined,
    'clueShare3',
    { ...MISSION, feature: '' },
    { ...MISSION, confounder: null },
    { ...MISSION, feature: 'density' },        // regressed on itself
    { ...MISSION, slope: 'eight' },
    { ...MISSION, intercept: NaN },
    { ...MISSION, sign: 0 },                   // not a clean tail choice
    { ...MISSION, sign: 0.5 },
  ];
  for (const raw of bad) {
    assert.equal(
      normalizeDecorrelationMission(raw), null,
      `${JSON.stringify(raw)} must not become a live mission`,
    );
  }
});

test('optional fields fall back rather than disabling the mission', () => {
  const noScale = normalizeDecorrelationMission({ ...MISSION, residualSd: undefined, weight: undefined });
  assert.ok(noScale, 'a mission without a scale or weight is still usable');
  assert.equal(noScale.residualSd, 1, 'no residualSd means score in raw feature units');
  assert.ok(noScale.weight > 0, 'a default weight lets the mission still compete');
  // A zero or negative scale would divide the residual into infinity, so it
  // has to fall back rather than be trusted.
  assert.equal(normalizeDecorrelationMission({ ...MISSION, residualSd: 0 }).residualSd, 1);
  assert.equal(normalizeDecorrelationMission({ ...MISSION, residualSd: -2 }).residualSd, 1);
});

test('normalizing is idempotent, because both paths normalize independently', () => {
  // The client normalizes once in getDecorrelationMission and again inside
  // resolveMissionForSlot; the precompute passes the raw file spec straight in.
  // If normalizing twice changed anything, those two would score differently.
  const once = normalizeDecorrelationMission(MISSION);
  assert.deepEqual(normalizeDecorrelationMission(once), once);
});

// ── the residual ─────────────────────────────────────────────────────

test('the residual measures the feature against what the confounder predicts', () => {
  const m = normalizeDecorrelationMission(MISSION);
  // density 0.25 predicts clueShare3 = 8(0.25) + 0.5 = 2.5.
  assert.equal(decorrelationResidualZ(m, { clueShare3: 2.5, density: 0.25 }), 0,
    'a board exactly on the fitted line carries no new information');
  // One residual SD (0.5) above the line.
  assert.equal(decorrelationResidualZ(m, { clueShare3: 3.0, density: 0.25 }), 1,
    'threes higher than the density predicts is the under-sampled corner');
  assert.equal(decorrelationResidualZ(m, { clueShare3: 2.0, density: 0.25 }), -1,
    'threes lower than predicted sits on the wrong side for sign +1');

  // A high-3 board is only interesting if it is NOT also a high-density board.
  // 4.5 threes is far more than the 3.0 board above, yet it tells us nothing:
  // at density 0.5 it is exactly what the confound already predicts.
  assert.equal(decorrelationResidualZ(m, { clueShare3: 4.5, density: 0.5 }), 0,
    'a board high in threes AND density is exactly the confounded shape we already have');
});

test('sign flips which tail counts as the corner', () => {
  const m = normalizeDecorrelationMission({ ...MISSION, sign: -1 });
  assert.equal(decorrelationResidualZ(m, { clueShare3: 2.0, density: 0.25 }), 1);
  assert.equal(decorrelationResidualZ(m, { clueShare3: 3.0, density: 0.25 }), -1);
});

test('an unscorable board is skipped, not ranked as zero', () => {
  const m = normalizeDecorrelationMission(MISSION);
  assert.equal(decorrelationResidualZ(m, { density: 0.2 }), null, 'feature missing');
  assert.equal(decorrelationResidualZ(m, { clueShare3: 2 }), null, 'confounder missing');
  assert.equal(decorrelationResidualZ(m, { clueShare3: 'x', density: 0.2 }), null);
  assert.equal(decorrelationResidualZ(m, { clueShare3: NaN, density: 0.2 }), null);
  assert.equal(decorrelationResidualZ(null, { clueShare3: 2, density: 0.2 }), null);
  // Skipping matters: a null must reach the caller so the candidate drops out
  // of the contest rather than tying at the bottom of it.
  const mission = resolveMissionForSlot(9, 'p', coverage(3), MISSION);
  assert.equal(missionCandidateScore(mission, { density: 0.2 }), null);
});

// ── scoring ──────────────────────────────────────────────────────────

test('REGRESSION: the count scorer refuses to read a clue share', () => {
  // Before the histogram was ported to the client, features.clueShare3 was
  // undefined and a count mission scored it 0. Now that it is a real number,
  // a primary slot targeting clueShare3 would MAXIMIZE 3-share — and because
  // 3-share runs r = 0.80 with density, maximizing it ships more of the
  // confounded boards the decorrelation mission is trying to offset. The
  // refusal has to be explicit or the port quietly works against itself.
  const features = { clueShare3: 4.0, sonarCellCount: 3 };
  const digitMission = { target: 'clueShare3', deficitWeight: 0.5 };
  assert.equal(missionCandidateScore(digitMission, features), 0,
    'a clue share is measured on every board, never maximized');

  const gimmickMission = { target: 'sonarCellCount', deficitWeight: 0.5 };
  assert.equal(missionCandidateScore(gimmickMission, features), 1.5,
    'an ordinary count target is unaffected');

  for (const k of ['clueShare2', 'clueShare3', 'clueShare4', 'clueShare5plus']) {
    assert.ok(isObservationalTarget(k), `${k} is observational`);
  }
  assert.equal(isObservationalTarget('sonarCellCount'), false);
});

test('the cap is shared, so no mission can buy an unbounded score', () => {
  const counted = { target: 'sonarCellCount', deficitWeight: 0.5 };
  assert.equal(missionCandidateScore(counted, { sonarCellCount: 99 }), COUNT_CAP * 0.5);

  const decor = resolveMissionForSlot(9, 'p', coverage(3), MISSION);
  // A freak board 50 residual SDs out must not win by 50x.
  const wild = missionCandidateScore(decor, { clueShare3: 27.5, density: 0.25 });
  assert.equal(wild, COUNT_CAP * MISSION.weight);
});

test('a wrong-side board scores negative and loses the day to coverage', () => {
  const decor = resolveMissionForSlot(9, 'p', coverage(3), MISSION);
  const wrongSide = missionCandidateScore(decor, { clueShare3: 2.0, density: 0.25 });
  assert.ok(wrongSide < 0, 'below the fitted line is worse than useless for this study');
  const emptyCoverage = missionCandidateScore({ target: 'feature0', deficitWeight: 0.5 }, {});
  assert.equal(emptyCoverage, 0);
  assert.ok(wrongSide < emptyCoverage,
    'on a day nothing reaches the corner, the board is better spent on coverage');
});

test('REGRESSION: a decorrelation board actually beats the coverage slate', () => {
  // Found by a live probe before this shipped: with a flat weight of 0.3 the
  // mission won ZERO days out of twelve and would have shipped as dead code.
  // The raw inputs are on different scales — a coverage count saturates
  // COUNT_CAP on almost any board (wormLoad runs 0.6 to 12), while a residual
  // z rarely passes 2.5 — so a decorrelation candidate topped out near 0.75
  // against a coverage slot sitting at 5 x 0.33 = 1.67 and always lost.
  //
  // The refit now DERIVES the weight so that a board TARGET_Z residual SDs
  // into the corner exactly ties the strongest coverage mission. This pins the
  // consequence rather than the formula: reaching the corner has to win.
  const topCoverageWeight = 0.3333;              // the live wormLoad deficit
  const targetZ = 1.0;
  const weight = (COUNT_CAP * topCoverageWeight) / targetZ;
  const decor = resolveMissionForSlot(9, 'p', coverage(3), { ...MISSION, weight });

  // The strongest thing a coverage slot can ever score.
  const coverageCeiling = missionCandidateScore(
    { target: 'wormLoad', deficitWeight: topCoverageWeight }, { wormLoad: 12 },
  );
  // A board two residual SDs into the corner (clueShare3 = 3.5 at density 0.25,
  // predicted 2.5, residual 1.0 = 2 x the 0.5 SD).
  const deep = missionCandidateScore(decor, { clueShare3: 3.5, density: 0.25 });
  assert.ok(deep > coverageCeiling,
    `a board 2 SD into the corner must take the day (${deep} vs ${coverageCeiling})`);

  // And a board that barely clears the fitted line must NOT: a shallow
  // residual is not worth spending the day's board on.
  const shallow = missionCandidateScore(decor, { clueShare3: 2.6, density: 0.25 });
  assert.ok(shallow < coverageCeiling,
    `a board 0.2 SD out leaves the day to coverage (${shallow} vs ${coverageCeiling})`);
});

// ── slots ────────────────────────────────────────────────────────────

test('decorrelation claims the slots past the coverage list, and only those', () => {
  const s = spec(3, MISSION);
  assert.equal(missionForSlot(s, 0).isPrimary, true, 'slot 0 stays the primary probe');
  for (let i = 1; i <= 3; i++) {
    assert.equal(missionForSlot(s, i).target, `feature${i - 1}`, 'coverage keeps its slots');
    assert.equal(missionForSlot(s, i).type, undefined);
  }
  const decor = missionForSlot(s, 4);
  assert.equal(decor.type, 'decorrelation');
  assert.equal(decor.target, 'clueShare3', 'the target is the confounded feature');
  assert.equal(decor.isPrimary, false);
  assert.equal(decor.singleOnly, false, 'the natural gimmick lottery, nothing forced');
  assert.equal(decor.deficitWeight, MISSION.weight);
  assert.equal(decor.decorrelation.confounder, 'density');
});

test('REGRESSION: the precompute and client agree on every decorrelation slot', () => {
  // The same mirror pair that drifted on slot arithmetic in 2026-07-18 now
  // also shares the scoring rule and the candidate count. Sweep the coverage
  // lengths where the old wrap diverged, with and without a mission live.
  for (const decor of [null, MISSION]) {
    for (const n of [0, 1, 5, 7, 8, 9, 12]) {
      const s = spec(n, decor);
      const count = candidateCountFor(s);
      assert.equal(count, resolveCandidateCount(s.coverage_targets, decor),
        'both paths evaluate the same number of candidates');
      for (let slot = 0; slot < count + 2; slot++) {
        assert.deepEqual(
          missionForSlot(s, slot),
          resolveMissionForSlot(slot, s.target, s.coverage_targets, decor),
          `slot ${slot}, ${n}-entry coverage, decorrelation ${decor ? 'live' : 'absent'}`,
        );
      }
    }
  }
});

test('an empty coverage list still yields decorrelation slots, not primary', () => {
  // The legacy collapse ("no coverage list means every slot optimises the
  // primary target") must not swallow the decorrelation block, or a fresh
  // deploy with a stale target file would silently run zero decorrelation.
  const s = spec(0, MISSION);
  assert.equal(missionForSlot(s, 0).isPrimary, true);
  assert.equal(missionForSlot(s, 1).type, 'decorrelation');
  // Without a mission, the collapse still holds.
  const legacy = spec(0, null);
  assert.equal(missionForSlot(legacy, 1).isPrimary, true);
  assert.equal(missionForSlot(legacy, 5).isPrimary, true);
});

test('a malformed mission leaves selection exactly as it was', () => {
  // The back-compat contract: anything the validator rejects has to produce
  // the pre-F1 board, not a half-configured one.
  for (const junk of [null, undefined, {}, { feature: 'clueShare3' }, { ...MISSION, sign: 3 }]) {
    for (const n of [0, 3, 8]) {
      assert.equal(candidateCountFor(spec(n, junk)), CANDIDATE_COUNT,
        'no extra candidates are evaluated');
      for (let slot = 0; slot < CANDIDATE_COUNT; slot++) {
        assert.deepEqual(
          missionForSlot(spec(n, junk), slot),
          resolveMissionForSlot(slot, 'primaryFeature', coverage(n)),
          `slot ${slot} matches the pre-F1 arithmetic`,
        );
      }
    }
  }
});

test('candidate count rises only on a decorrelation day', () => {
  assert.equal(resolveCandidateCount(coverage(8), null), CANDIDATE_COUNT);
  assert.equal(resolveCandidateCount(coverage(8), MISSION), 1 + 8 + DECORRELATION_SLOTS);
  assert.equal(resolveCandidateCount(coverage(0), MISSION), 1 + DECORRELATION_SLOTS);
  // Selection depth is the ONLY reach knob a decorrelation mission has: it
  // force-injects nothing, so every slot past the coverage list is one more
  // board to choose the corner from.
  assert.ok(resolveCandidateCount(coverage(8), MISSION) > CANDIDATE_COUNT);
});

// ── the payload stamp ────────────────────────────────────────────────

test('the stamp records what a decorrelation board was pulling apart', () => {
  const decor = resolveMissionForSlot(9, 'p', coverage(3), MISSION);
  assert.deepEqual(missionStamp(decor), {
    missionTarget: 'clueShare3',
    missionIsPrimary: false,
    missionType: 'decorrelation',
    missionConfounder: 'density',
  });
  // An ordinary mission stamps exactly what it stamped before F1: the two new
  // keys must stay absent, or every canonical written on an ordinary day
  // changes shape for no reason.
  assert.deepEqual(
    missionStamp({ target: 'sonarCellCount', isPrimary: true }),
    { missionTarget: 'sonarCellCount', missionIsPrimary: true },
  );
  assert.deepEqual(missionStamp(null), {});
  assert.deepEqual(missionStamp({ isPrimary: true }), {}, 'no target, nothing to say');
});

// ── the ported histogram ─────────────────────────────────────────────

const cell = (adj, extra = {}) => ({ isMine: false, adjacentMines: adj, ...extra });

test('clue shares are per-ten of the cells that show a number', () => {
  // Five numbered clues: 2,2,3,4,6. Zeros and mines are not clues.
  const board = [
    [cell(0), cell(2), cell(2)],
    [cell(3), cell(4), cell(6)],
    [cell(0, { isMine: true }), cell(0), cell(0)],
  ];
  const s = clueShares(board, 3, 3);
  assert.equal(s.clueShare2, 4, 'two of five clues are twos, times ten');
  assert.equal(s.clueShare3, 2);
  assert.equal(s.clueShare4, 2);
  assert.equal(s.clueShare5plus, 2, 'fives and up lump together');
});

test('a cell that never shows the player a number is not a clue', () => {
  // Mirrors clue_histogram in scripts/refit-par-model.R exactly: mines carry
  // no clue, mystery hides its number, a plate shows a timer. If the two
  // copies disagreed, the client would score a candidate on one histogram and
  // the fit would measure it on another.
  const board = [
    [cell(3), cell(3, { isMystery: true }), cell(3, { isPressurePlate: true })],
    [cell(2), cell(9, { isMine: true }), cell(0)],
  ];
  const s = clueShares(board, 2, 3);
  assert.equal(s.clueShare3, 5, 'only one of the three threes is a visible clue');
  assert.equal(s.clueShare2, 5);
});

test('a board with no numbered clue has no denominator and reads 0%', () => {
  const board = [[cell(0), cell(0)], [cell(0), cell(0, { isMine: true })]];
  const s = clueShares(board, 2, 2);
  assert.deepEqual(s, { clueShare2: 0, clueShare3: 0, clueShare4: 0, clueShare5plus: 0 });
});

test('the shares ride along in the feature vector without touching par', () => {
  const board = [
    [cell(1), cell(2), cell(3)],
    [cell(2), cell(0), cell(4)],
    [cell(0), cell(0), cell(0, { isMine: true })],
  ];
  for (const row of board) for (const c of row) { c.isRevealed = false; c.isFlagged = false; }
  const features = computeDailyFeatures(
    { board, rows: 3, cols: 3, totalMines: 1, activeGimmicks: [], rngSeed: 'x' },
    { passAMoves: 1, totalClicks: 2 },
  );
  assert.equal(features.clueShare2, 4, 'the shares land in dailyMeta with everything else');
  assert.deepEqual(
    { c2: features.clueShare2, c3: features.clueShare3 },
    { c2: clueShares(board, 3, 3).clueShare2, c3: clueShares(board, 3, 3).clueShare3 },
  );
});
