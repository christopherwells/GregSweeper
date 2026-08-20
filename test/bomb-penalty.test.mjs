// Bomb info-value penalty accounting. This is the freshest and most
// fragile math in the app — a regression here silently mis-charges the
// player and corrupts the par/handicap pipeline (see the 2026-06 timer
// bug). Guarded to skip cleanly on branches where the feature isn't
// present yet (e.g. main before the bomb feature merges).

import './helpers.mjs';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

let bomb, diff, gameState;
try {
  bomb = await import('../src/logic/bombInfoValue.js');
  diff = await import('../src/logic/difficulty.js');
  gameState = await import('../src/state/gameState.js');
} catch { /* feature not on this branch — tests below self-skip */ }

const HAS_FEATURE = !!(bomb && diff && gameState && typeof diff.BOMB_PENALTY_BASE === 'number');

// A seeded board verified (offline) to be solvable with ≥4 pattern moves
// and ≥3 mines carrying positive info-value under the pooled pricing.
// The previous hand-built fixture was degenerate: 5 mines on 7x7 meant
// the opening cascade revealed every non-mine cell (totalClicks: 1, zero
// deductions), so every mine priced 0 under ANY coefficients and the
// test could not detect a de-wired model.
const FIXTURE = { rows: 9, cols: 9, mines: 16, fr: 4, fc: 4, seed: 'unit-bomb-9' };

async function deductionBoard() {
  const { generateBoard, cleanSolverArtifacts } = await import('../src/logic/boardGenerator.js');
  const { createDailyRNG } = await import('../src/logic/seededRandom.js');
  const { rows, cols, mines, fr, fc, seed } = FIXTURE;
  const board = generateBoard(rows, cols, mines, fr, fc, createDailyRNG(seed));
  cleanSolverArtifacts(board);
  return board;
}

test('BOMB_PENALTY_BASE is the documented 3s', { skip: !HAS_FEATURE }, () => {
  assert.equal(diff.BOMB_PENALTY_BASE, 3);
});

test('every pricing coefficient name exists in PAR_MODEL', { skip: !HAS_FEATURE }, () => {
  // The regression this pins: PR #36 renamed the PAR_MODEL move
  // coefficients hours after PR #32 shipped bomb pricing against the old
  // names, and `|| 0` silently zeroed every info-value. A coefficient
  // rename must fail HERE, not in production telemetry.
  for (const term of bomb.POOLED_TERMS) {
    assert.equal(typeof diff.PAR_MODEL[term.coef], 'number',
      `POOLED_TERMS references "${term.coef}" but PAR_MODEL has no such coefficient`);
  }
});

test('info-value differentiates mines: some mine must price > 0 on a deduction-heavy board', { skip: !HAS_FEATURE }, async () => {
  const board = await deductionBoard();
  const { rows, cols, fr, fc } = FIXTURE;
  let maxInfo = -Infinity;
  let positives = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!board[r][c].isMine) continue;
      const { infoValue } = bomb.computeBombInfoValue(board, rows, cols, fr, fc, r, c);
      assert.ok(infoValue >= 0, `infoValue ${infoValue} negative at (${r},${c})`);
      if (infoValue > 0) positives++;
      maxInfo = Math.max(maxInfo, infoValue);
    }
  }
  // This seeded board requires pattern deduction, so at least one mine
  // must anchor some of it. The previous assertion here
  // (maxInfo >= minInfo) was vacuously true and let the de-wire ship.
  assert.ok(maxInfo > 0, `all mines priced 0 — pricing is de-wired (max ${maxInfo})`);
  assert.ok(positives >= 1, `expected ≥1 mine with positive info-value, got ${positives}`);
});

test('first strike: penalty = round(infoValue + base) and the accounting identity holds', { skip: !HAS_FEATURE }, () => {
  // The core identity the timer/par/handicap pipeline depends on, for the
  // FIRST strike (the common case — most bomb-hit plays hit once):
  //   penalty added to clock = infoValue + base
  //   clean-play time (for fitting/handicap) = displayed - base*hits
  // A par-skill player who skipped `infoValue` of deduction and paid
  // `infoValue + base` lands exactly `base` over par. (Later strikes escalate
  // the base — see the next test.)
  const base = diff.BOMB_PENALTY_BASE;
  const par = 60;
  for (const infoValue of [0, 5.2, 18, 31.7]) {
    const penalty = Math.round((infoValue + base) * 10) / 10;
    const wallClock = par - infoValue;            // skipped that much deduction
    const displayed = Math.round((wallClock + penalty) * 10) / 10;
    const deltaVsPar = Math.round((displayed - par) * 10) / 10;
    assert.equal(deltaVsPar, base, `delta should be +${base}s over par, got ${deltaVsPar}`);
    const cleanTime = displayed - base * 1;       // handicap/refit subtraction
    assert.ok(Math.abs(cleanTime - par) < 0.05, `clean time ${cleanTime} should ≈ par ${par}`);
  }
});

test('ramped base: 1st strike = base, each later strike adds half a base', { skip: !HAS_FEATURE }, () => {
  // handleDailyBombHit computes penalty = round((infoValue + rampedBase)*10)/10,
  // rampedBase(n) = base × (1 + ramp × (n-1)), n = priorHits + 1. A gentle ramp
  // (the >30% anti-cheat handles brute-force) while the info-value rides on top.
  const base = diff.BOMB_PENALTY_BASE;   // 3
  const ramp = diff.BOMB_PENALTY_RAMP;   // 0.5
  assert.equal(ramp, 0.5);
  const penaltyFor = (infoValue, n) => Math.round((infoValue + base * (1 + ramp * (n - 1))) * 10) / 10;
  // Zero-info strikes cost 3, 4.5, 6, 7.5 … (base, then +half-a-base each).
  assert.deepEqual([1, 2, 3, 4].map(n => penaltyFor(0, n)), [3, 4.5, 6, 7.5]);
  // The first strike is exactly the standard base — a lone hit is unchanged.
  assert.equal(penaltyFor(5.2, 1), Math.round((5.2 + base) * 10) / 10);
  // Info-value rides on top of the ramped base (3rd strike base = 6).
  assert.equal(penaltyFor(12.4, 3), Math.round((12.4 + 6) * 10) / 10);
});

test('isBombHitCheat: excavating the board is a probing run, a bad day is not', { skip: !HAS_FEATURE }, () => {
  const {
    isBombHitCheat, BOMB_HIT_CHEAT_FRACTION, BOMB_HIT_CHEAT_FLOOR,
    BOMB_HIT_EXCAVATED_FRACTION,
  } = diff;
  assert.equal(BOMB_HIT_CHEAT_FRACTION, 0.50);
  assert.equal(BOMB_HIT_CHEAT_FLOOR, 10);
  assert.equal(BOMB_HIT_EXCAVATED_FRACTION, 0.80);

  // REGRESSION (2026-08-09, Kate): today's daily was a 36-cell Kites board with
  // NINE mines. Under the old flat "> 30% of mines" the gate refused a run at
  // THREE hits — an ordinary bad day on the dearest lattice we ship — and she
  // lost both her leaderboard row and the dot on her own history chart. The
  // fraction was written against 25-30-mine rectangles, where it meant nine
  // mistakes; the shape rotation moved the scale under it.
  assert.equal(isBombHitCheat(3, 9), false, 'three hits on a 9-mine board is a bad day, not a probe');
  assert.equal(isBombHitCheat(4, 9), false);
  // The smallest shipped tiling configs (floret / deltoidal 2x3) carry SIX
  // mines, where the old rule refused at two.
  assert.equal(isBombHitCheat(2, 6), false, 'two hits on a 6-mine board is not a probe');
  assert.equal(isBombHitCheat(3, 6), false);

  // Arm 1 — far more mistakes than a bad day. The floor binds below 20 mines.
  assert.equal(isBombHitCheat(10, 20), false, 'floor is inclusive: 10 is allowed');
  assert.equal(isBombHitCheat(11, 20), true);
  assert.equal(isBombHitCheat(14, 28), false, 'half of 28 is 14, and "more than" is strict');
  assert.equal(isBombHitCheat(15, 28), true);
  assert.equal(isBombHitCheat(21, 42), false);
  assert.equal(isBombHitCheat(22, 42), true);

  // Arm 2 — you excavated the board. This is the ONLY arm that can fire where
  // the floor exceeds the mine count, so without it every board of 10 mines or
  // fewer would be ungated even against a total excavation.
  assert.equal(isBombHitCheat(7, 9), false);
  assert.equal(isBombHitCheat(8, 9), true, '8 of 9 mines found by detonation');
  assert.equal(isBombHitCheat(9, 9), true);
  assert.equal(isBombHitCheat(6, 6), true, 'every mine on the board');
  assert.equal(isBombHitCheat(5, 6), true);

  // The three real probing episodes on record stay refused, which is what
  // makes the loosening a no-op on the historical fit.
  assert.equal(isBombHitCheat(34, 34), true);
  assert.equal(isBombHitCheat(32, 32), true);
  assert.equal(isBombHitCheat(34, 42), true);
  // The worst GENUINE run on record (Kate, 2026-05-01) had two hits of headroom
  // under the old rule and comfortably clears the new one.
  assert.equal(isBombHitCheat(7, 28), false);

  assert.equal(isBombHitCheat(0, 20), false);
  // Degenerate inputs never trip — gimmick-free modes pass totalMines but 0
  // hits, and a missing totalMines must fail open (no false cheat flag).
  assert.equal(isBombHitCheat(0, 0), false);
  assert.equal(isBombHitCheat(5, undefined), false);
  assert.equal(isBombHitCheat(undefined, 20), false);
});

test('getActiveBombPenaltyTotal sums the per-hit event log', { skip: !HAS_FEATURE }, () => {
  const { state, getActiveBombPenaltyTotal } = gameState;
  state.gameMode = 'daily';
  state.dailyBombHitEvents = [{ penalty: 7.2 }, { penalty: 3 }];
  state.weeklyBombHitEvents = [];
  assert.equal(getActiveBombPenaltyTotal(), 10.2);
  // Fresh game (no events) → zero, so a stale total can't leak forward.
  state.dailyBombHitEvents = [];
  assert.equal(getActiveBombPenaltyTotal(), 0);
});

test('REGRESSION: the rescale factor belongs to the BOARD, so a fit board is untouched at EVERY strike', async () => {
  // Two bugs live here, an hour apart, and this pin exists for the second.
  //
  // His report, 2026-08-19: marathon boards charged strike penalties in the
  // thousands of par-seconds, because the info-value difference carries the
  // board's whole multiplicative baseline and past a shape's fit ceiling
  // that baseline is raw extrapolation. The rescale prices the move SHARE
  // at the board's sane par instead.
  //
  // Issue #391: the first cut divided by the PER-STRIKE read (prior strikes
  // pre-flagged), which equals the board's own read only until a prior
  // strike removes a pooled deduction. From the second strike on the ratio
  // exceeded 1 and charged MORE than the pre-fix formula, on ordinary fit
  // boards. The pin that shipped with it could not see this: it fed the
  // per-strike read back in as the baseline (true of any denominator) and
  // never passed a prior strike.
  //
  // So the fixture is chosen to MAKE THE MECHANISM BITE: a prior that
  // genuinely reduces resultA's pooled move counts while the target still
  // prices above zero. Both conditions are asserted below rather than
  // assumed, because a prior that removes nothing, or a target that prices
  // 0, turns this whole test back into the tautology it replaces.
  const { generateBoard, cleanSolverArtifacts } = await import('../src/logic/boardGenerator.js');
  const { createDailyRNG } = await import('../src/logic/seededRandom.js');
  const { isBoardSolvable } = await import('../src/logic/boardSolver.js');
  const { computeDailyFeatures, predictPar } = await import('../src/logic/dailyFeatures.js');

  const rows = 12, cols = 12, mines = 30, seed = 'pin-a';
  const fr = 6, fc = 6;
  const board = generateBoard(rows, cols, mines, fr, fc, createDailyRNG(seed));
  cleanSolverArtifacts(board);
  const check = isBoardSolvable(board, rows, cols, fr, fc);
  const features = computeDailyFeatures(
    { board, rows, cols, totalMines: mines, activeGimmicks: [], rngSeed: seed }, check);
  const target = { row: 1, col: 1 };     // prices > 0
  const prior = { row: 8, col: 10 };     // removes a pooled deduction
  const pooled = (r) => (r.canonicalSubsetMoves || 0) + (r.genericSubsetMoves || 0) + (r.advancedLogicMoves || 0);

  const solo = bomb.computeBombInfoValue(board, rows, cols, fr, fc, target.row, target.col, [], features);
  const withPrior = bomb.computeBombInfoValue(
    board, rows, cols, fr, fc, target.row, target.col, [prior], features);
  // NON-VACUITY, the two conditions the old pin lacked.
  assert.ok(solo.infoValue > 0.5, `the target must price above zero (${solo.infoValue})`);
  assert.ok(withPrior.infoValue > 0.5, `and still price above zero behind the prior (${withPrior.infoValue})`);
  assert.ok(pooled(withPrior.resultA) < pooled(solo.resultA),
    `the prior must REMOVE a pooled deduction (${pooled(solo.resultA)} -> ${pooled(withPrior.resultA)}), `
    + 'or the per-strike denominator never diverges and this pin cannot fail on the old code');

  // A FIT board's baseline is predictPar of its own features. Passing it
  // must change nothing, with and without the biting prior. The old code
  // passes the first and fails the second.
  const fitPar = predictPar(features);
  for (const priors of [[], [prior]]) {
    const plain = bomb.computeBombInfoValue(
      board, rows, cols, fr, fc, target.row, target.col, priors, features);
    const based = bomb.computeBombInfoValue(
      board, rows, cols, fr, fc, target.row, target.col, priors, features, fitPar);
    assert.ok(Math.abs(based.infoValue - plain.infoValue) < 1e-9,
      `a fit board must be untouched at ${priors.length} prior strike(s): ${based.infoValue} vs ${plain.infoValue}`);
  }

  // OVERSIZED: the correction applies, and it is CONSTANT across strikes,
  // which is the property the per-strike denominator destroyed.
  const huge = { ...features, cellCount: 660, totalMines: 185 };
  const rawBoardPar = predictPar(huge);
  const sane = 520;                       // an anchored lane par
  assert.ok(rawBoardPar > sane * 2,
    `precondition: the raw board read (${rawBoardPar}s) must dwarf the anchored par`);
  const factors = [];
  for (const priors of [[], [prior]]) {
    const plain = bomb.computeBombInfoValue(
      board, rows, cols, fr, fc, target.row, target.col, priors, huge);
    const scaled = bomb.computeBombInfoValue(
      board, rows, cols, fr, fc, target.row, target.col, priors, huge, sane);
    assert.ok(Math.abs(scaled.infoValue - plain.infoValue * (sane / rawBoardPar)) < 1e-6,
      'the scaled value must be the unscaled one times sane/rawBoardPar');
    assert.ok(scaled.infoValue < plain.infoValue, 'the rescale must shrink an extrapolated penalty');
    factors.push(scaled.infoValue / plain.infoValue);
  }
  assert.ok(Math.abs(factors[0] - factors[1]) < 1e-9,
    `the factor is a property of the BOARD, so it must not move with prior strikes (${factors.join(' vs ')})`);

  // And with no baseline at all, behavior is byte-identical to before.
  const absent = bomb.computeBombInfoValue(
    board, rows, cols, fr, fc, target.row, target.col, [prior], huge);
  const nulled = bomb.computeBombInfoValue(
    board, rows, cols, fr, fc, target.row, target.col, [prior], huge, null);
  assert.equal(absent.infoValue, nulled.infoValue);
});

test('the strike handler prices match boards at the sane par, and the two par re-prices carry the provisional guard', () => {
  // Source pins for the two consumers the 10h incident named: the strike
  // loop must pass the match board's displayed par (the anchored number on
  // an oversized deal), and BOTH client par re-prices (match and Climb)
  // must keep the stored par on a provisional board.
  const wl = readFileSync(new URL('../src/game/winLossHandler.js', import.meta.url), 'utf8');
  // The baseline's own pin lives in the lane test below (#393 moved this
  // expression from `state.matchFeatures ?` to `state.gameMode === 'match'`,
  // so that a stale matchPar cannot price a daily strike either).
  assert.match(wl, /const parBaseline = state\.gameMode === 'match' \? \(state\.matchPar \|\| null\) : null;/,
    'the strike handler must derive the sane baseline from state.matchPar on match boards');
  assert.match(wl, /computeBombInfoValue\([^)]*boardFeatures, parBaseline\)/,
    'the strike call must pass the baseline through');
  const ga = readFileSync(new URL('../src/game/gameActions.js', import.meta.url), 'utf8');
  const guards = ga.match(/res\.parProvisional !== true/g) || [];
  assert.ok(guards.length >= 2,
    `both the match and Climb par re-prices must carry the provisional guard (found ${guards.length})`);
});

test('REGRESSION: a strike prices against the LANE being played, not whatever vector is populated (#393)', { skip: !HAS_FEATURE }, async () => {
  // The chain this replaces was `weeklyFeatures || dailyFeatures ||
  // matchFeatures || coastlineFeatures`, correct only while at most one is
  // populated. `newGame` clears every one of them EXCEPT dailyFeatures, and
  // nothing in src/ ever nulls it, so the real sequence below (play the
  // daily, then start a Challenge run, same session, no reload) priced every
  // match strike against the daily board's vector. Measured on a deltoidal
  // match board with a 121-cell rect daily left behind: 0.29x, 0.41x, 0.54x
  // of the true values, wrong per-shape block included, into permanent
  // daily/match_* fit rows.
  const { state } = gameState;
  const saved = {
    gameMode: state.gameMode, parLab: state.parLab,
    daily: state.dailyFeatures, weekly: state.weeklyFeatures,
    match: state.matchFeatures, coastline: state.coastlineFeatures,
  };
  try {
    // Distinguishable vectors, so the assertion names WHICH board was read.
    const dailyV = { cellCount: 121, totalMines: 24, canonicalSubsetMoves: 9 };
    const weeklyV = { cellCount: 100, totalMines: 20, canonicalSubsetMoves: 7 };
    const matchV = { cellCount: 72, totalMines: 18, canonicalSubsetMoves: 5, tilingType: 'deltoidal' };
    const labV = { cellCount: 50, totalMines: 10, canonicalSubsetMoves: 3 };
    // The daily vector is ALWAYS left behind: that is the whole defect.
    state.dailyFeatures = dailyV;
    state.weeklyFeatures = weeklyV;
    state.matchFeatures = matchV;
    state.coastlineFeatures = labV;

    state.parLab = null;
    state.gameMode = 'match';
    assert.equal(gameState.getStrikeBoardFeatures(), matchV,
      'a Challenge strike must price against the MATCH board, with the daily still in state');
    state.gameMode = 'daily';
    assert.equal(gameState.getStrikeBoardFeatures(), dailyV);
    state.gameMode = 'weekly';
    assert.equal(gameState.getStrikeBoardFeatures(), weeklyV);
    // The Par Lab is a FLAG, not a mode, so it must win over whatever mode
    // the lab board happens to run under (it sat last in the old chain).
    state.parLab = { id: 'probe' };
    state.gameMode = 'daily';
    assert.equal(gameState.getStrikeBoardFeatures(), labV,
      'a Par Lab strike must price against the lab board');
    // Off the strike lanes: no vector at all beats a foreign one.
    state.parLab = null;
    state.gameMode = 'normal';
    assert.equal(gameState.getStrikeBoardFeatures(), null);
    state.gameMode = 'chaos';
    assert.equal(gameState.getStrikeBoardFeatures(), null);
    // A lane whose own vector is missing reports null rather than falling
    // through to a populated neighbour.
    state.gameMode = 'match';
    state.matchFeatures = null;
    assert.equal(gameState.getStrikeBoardFeatures(), null,
      'a match board with no vector must NOT fall through to the daily');
  } finally {
    state.gameMode = saved.gameMode;
    state.parLab = saved.parLab;
    state.dailyFeatures = saved.daily;
    state.weeklyFeatures = saved.weekly;
    state.matchFeatures = saved.match;
    state.coastlineFeatures = saved.coastline;
  }
});

test('the strike handler reads the lane selector, and the baseline keys on the lane too', () => {
  const wl = readFileSync(new URL('../src/game/winLossHandler.js', import.meta.url), 'utf8');
  assert.match(wl, /const boardFeatures = getStrikeBoardFeatures\(\);/,
    'the strike handler must select by lane, never by first-non-null');
  assert.ok(!/state\.weeklyFeatures \|\| state\.dailyFeatures/.test(wl),
    'the first-non-null chain must not return');
  assert.match(wl, /const parBaseline = state\.gameMode === 'match' \? \(state\.matchPar \|\| null\) : null;/,
    'the sane-par baseline must key on the lane as well, or a stale matchPar can price a daily strike');
});

test('a strike is priced from the LIVE board, and the opener reading survives for callers with no live board', { skip: !HAS_FEATURE }, async () => {
  // His report, 2026-08-20: he hit a mine "internal to everything" on a big
  // board and was charged ~90s. The pricing solved from the OPENER, so it
  // billed him for deduction he had already done himself. His ruling: "a
  // check of what the par is now that the mine is hit given the live board".
  const { generateBoard, cleanSolverArtifacts } = await import('../src/logic/boardGenerator.js');
  const { createDailyRNG } = await import('../src/logic/seededRandom.js');
  const { isBoardSolvable } = await import('../src/logic/boardSolver.js');
  const { computeDailyFeatures } = await import('../src/logic/dailyFeatures.js');
  const rows = 12, cols = 12, mines = 30, fr = 6, fc = 6, seed = 'demo-internal';
  const build = () => {
    const b = generateBoard(rows, cols, mines, fr, fc, createDailyRNG(seed));
    cleanSolverArtifacts(b);
    return b;
  };
  const board = build();
  const check = isBoardSolvable(board, rows, cols, fr, fc);
  const features = computeDailyFeatures(
    { board, rows, cols, totalMines: mines, activeGimmicks: [], rngSeed: seed }, check);

  // Untouched board: the live reading and the opener reading agree, because
  // nothing is revealed to make them differ. This is the pin that stops the
  // fix from simply zeroing every strike.
  let target = null;
  for (let r = 0; r < rows && !target; r++) {
    for (let c = 0; c < cols && !target; c++) {
      if (!board[r][c].isMine) continue;
      const s = bomb.computeBombInfoValue(board, rows, cols, fr, fc, r, c, [], features, null, { liveState: false });
      if (s.infoValue > 1) target = { row: r, col: c, scratch: s.infoValue };
    }
  }
  assert.ok(target, 'the fixture must offer a mine that anchors real deduction');
  const untouched = bomb.computeBombInfoValue(
    board, rows, cols, fr, fc, target.row, target.col, [], features);
  assert.ok(Math.abs(untouched.infoValue - target.scratch) < 1e-9,
    `on an untouched board the two readings must agree (${untouched.infoValue} vs ${target.scratch})`);

  // HIS CASE: the mine sits inside territory already cleared. The player has
  // already done that reasoning, so the information is worth nothing.
  const cleared = build();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) if (!cleared[r][c].isMine) cleared[r][c].isRevealed = true;
  }
  const inside = bomb.computeBombInfoValue(
    cleared, rows, cols, fr, fc, target.row, target.col, [], features);
  assert.equal(inside.infoValue, 0,
    'a mine already determined by what is on screen must cost no information');
  const insideScratch = bomb.computeBombInfoValue(
    cleared, rows, cols, fr, fc, target.row, target.col, [], features, null, { liveState: false });
  assert.ok(insideScratch.infoValue > 1,
    'and the opener reading must still charge for it, or this pin proves nothing');
});

test('REGRESSION: the solver resume mode is OPT-IN, so every existing caller is byte-identical', { skip: !HAS_FEATURE }, async () => {
  // Backwards compatibility, his requirement: certification, generation, par
  // features and every stored contract ask the from-scratch question and must
  // keep getting exactly the answer they got before.
  const { generateBoard, cleanSolverArtifacts } = await import('../src/logic/boardGenerator.js');
  const { createDailyRNG } = await import('../src/logic/seededRandom.js');
  const { isBoardSolvable } = await import('../src/logic/boardSolver.js');
  const rows = 12, cols = 12, mines = 30, fr = 6, fc = 6;
  const board = generateBoard(rows, cols, mines, fr, fc, createDailyRNG('demo-internal'));
  cleanSolverArtifacts(board);
  // Reveal the whole board: under resume mode this changes everything, and
  // under the default it must change NOTHING.
  const plain = isBoardSolvable(board, rows, cols, fr, fc);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) if (!board[r][c].isMine) board[r][c].isRevealed = true;
  }
  const again = isBoardSolvable(board, rows, cols, fr, fc);
  assert.deepEqual(
    { t: again.totalClicks, s: again.solvable, p: again.canonicalSubsetMoves, a: again.advancedLogicMoves },
    { t: plain.totalClicks, s: plain.solvable, p: plain.canonicalSubsetMoves, a: plain.advancedLogicMoves },
    'live reveal state must not reach a caller that did not ask for it');
  const resumed = isBoardSolvable(board, rows, cols, fr, fc, undefined, { resumeFromLiveState: true });
  assert.ok(resumed.totalClicks < plain.totalClicks,
    'and the opt-in mode must actually see the revealed board');
});

test('a stored strike can be RE-PRICED under a later model without the board state (his data requirement)', { skip: !HAS_FEATURE }, async () => {
  // "I would love for all the old data to be usable still. I am worried that
  // we do not know the board state for every board when a mine was hit, so
  // you cannot recalculate the hit when the par is recalculated." So the
  // event stores the pooled remaining-move counts, which measure the BOARD
  // and cannot be invalidated by a refit; the seconds are derived from them.
  const { generateBoard, cleanSolverArtifacts } = await import('../src/logic/boardGenerator.js');
  const { createDailyRNG } = await import('../src/logic/seededRandom.js');
  const { isBoardSolvable } = await import('../src/logic/boardSolver.js');
  const { computeDailyFeatures } = await import('../src/logic/dailyFeatures.js');
  const rows = 12, cols = 12, mines = 30, fr = 6, fc = 6, seed = 'demo-internal';
  const board = generateBoard(rows, cols, mines, fr, fc, createDailyRNG(seed));
  cleanSolverArtifacts(board);
  const check = isBoardSolvable(board, rows, cols, fr, fc);
  const features = computeDailyFeatures(
    { board, rows, cols, totalMines: mines, activeGimmicks: [], rngSeed: seed }, check);

  let priced = null;
  for (let r = 0; r < rows && !priced; r++) {
    for (let c = 0; c < cols && !priced; c++) {
      if (!board[r][c].isMine) continue;
      const res = bomb.computeBombInfoValue(board, rows, cols, fr, fc, r, c, [], features);
      if (res.infoValue > 1) priced = res;
    }
  }
  assert.ok(priced, 'need a strike that costs something');
  for (const k of ['patternBefore', 'searchBefore', 'patternAfter', 'searchAfter']) {
    assert.equal(typeof priced[k], 'number', `${k} must ride the result so the event can store it`);
  }
  // THE ROUND TRIP: the stored counts alone reproduce the seconds, with no
  // board and no solver run.
  const ev = {
    patternBefore: priced.patternBefore, searchBefore: priced.searchBefore,
    patternAfter: priced.patternAfter, searchAfter: priced.searchAfter,
  };
  const again = bomb.repriceStoredStrike(ev, features);
  assert.ok(Math.abs(again - Math.round(priced.infoValue * 10) / 10) < 0.11,
    `re-price ${again} should reproduce the live ${priced.infoValue}`);
  // It COMPUTES rather than echoes: a different baseline gives a different
  // answer, which is what lets a refit move it.
  const scaled = bomb.repriceStoredStrike(ev, features, 10);
  assert.ok(scaled < again, 'a smaller baseline must price the same counts cheaper');
  // A pre-2026-08-20 event carries no counts: null means "keep the stored
  // seconds", never zero.
  assert.equal(bomb.repriceStoredStrike({ t: 1, row: 0, col: 0, penalty: 9, infoValue: 6 }, features), null);
  assert.equal(bomb.repriceStoredStrike(null, features), null);
});
