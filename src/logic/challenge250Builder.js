// Challenge 250 board builder — the ONE builder for ladder specs
// (challenge250.js), called by BOTH the play path (gameActions, PR 2 of the
// build arc) and the offline spec validator
// (scripts/validate-challenge250-specs.mjs), so the boards the validator
// proves are byte-for-byte the boards the ladder deals (the
// buildParLabBoard precedent, and the missionSlots one-copy lesson).
//
// Contract per draw (all rulings from CHALLENGE_250_MAP.md):
//   - CERTIFIED no-guess from the fixed opener (the marked Start-here
//     cell: container centre on a rectangle, the tiling's own centerIndex
//     on a lattice), frozen board — mines never relocate.
//   - STRICT LOAD-BEARING: every testable modifier on the shipped board
//     contributes a needed deduction. No relax-to-ship — a decorative
//     draw is rejected and the search continues; exhaustion returns null
//     rather than a board that breaks the promise (unlike the daily's
//     budgeted escape). Exempt types (mystery/worm delay or remove info,
//     walls/locked are structural) are strict trivially.
//   - Opener specs additionally reject draws needing fewer than
//     spec.minDeductions deductions past the opener click (the map's
//     3-to-5-real-deductions floor; kills one-click cascades).
//
// The result carries features + par so the expected-time surfaces and the
// validator price through the same predictPar dispatch (per-shape model on
// tilings). features.rngSeed threading matters for worm specs: wormLoad
// derives from the SEED string, so the play path must hand the same seed
// to the live hatch (state wiring lands with the engine PR).

import { createEmptyBoard, cleanSolverArtifacts, generateBoard, placeMysteryConstructive } from './boardGenerator.js';
import { applyGimmicks, applyWalls, clearGimmickProperties, getIntensity } from './gimmicks.js';
import { isBoardSolvable, findDecorativeGimmicks, TESTABLE_GIMMICK_TYPES } from './boardSolver.js';
import { createDailyRNG } from './seededRandom.js';
import { generateTilingBoard } from './tilingGenerator.js';
import { computeDailyFeatures, predictPar } from './dailyFeatures.js';

// Rect search budget: base mine layouts × gimmick re-rolls per base (the
// gameActions challenge loop's own amortization, seeded + pure here).
const RECT_BASE_ATTEMPTS = 60;
const RECT_GIMMICK_REROLLS = 25;

// Tiling strictness salts: generateTilingBoard runs with an INFINITE
// load-bearing budget (every in-run attempt demands strictness), so a
// decorative board can only come back via the exhausted-best path. Each
// salt is a fresh 600-attempt search — by the time all are spent the spec
// itself is broken, which is the validator's job to prevent.
const TILING_STRICT_RETRIES = 3;

/**
 * Deterministic seed for a ladder draw. The play path salts `attempt` per
 * death/redraw (and adds its own entropy so two players' L37 attempt-0
 * boards differ); the validator uses sequential attempts for
 * reproducibility.
 */
export function challengeBoardSeed(level, attempt = 0, salt = '') {
  const base = `c250:L${level}${salt ? `:${salt}` : ''}`;
  return attempt > 0 ? `${base}:a${attempt}` : base;
}

/**
 * Build one certified, strictly load-bearing board for a ladder spec.
 *
 * @param {object} spec a challengeSpecForLevel result (or shape-compatible)
 * @param {string} seed full seed string for this draw
 * @returns {null | { board, rows, cols, totalMines, firstClick, check,
 *   activeGimmicks, applied, features, par, seed, tiling? }}
 */
export function buildChallenge250Board(spec, seed) {
  const res = spec.shape === 'rect'
    ? buildRectSpec(spec, seed)
    : buildTilingSpec(spec, seed);
  if (!res) return null;

  let totalMines = 0;
  for (const row of res.board) for (const c of row) if (c.isMine) totalMines++;

  let features = null;
  let par = 0;
  try {
    features = computeDailyFeatures({
      board: res.board, rows: res.rows, cols: res.cols, totalMines,
      activeGimmicks: res.activeGimmicks, rngSeed: seed,
    }, res.check);
    par = predictPar(features);
  } catch (err) {
    // Par is a display + validation aid, never a play blocker; the
    // validator treats a null par as a failure on its own.
    features = null;
    par = 0;
  }
  return { ...res, totalMines, features, par, seed };
}

function buildRectSpec(spec, seed) {
  const { rows, cols, mines } = spec;
  const gimmicks = spec.gimmicks || [];
  const gimmickLevel = spec.gimmickLevel || 1;
  const fr = Math.floor(rows / 2), fc = Math.floor(cols / 2);
  const hasTestable = gimmicks.some((g) => TESTABLE_GIMMICK_TYPES.includes(g));

  for (let attempt = 0; attempt < RECT_BASE_ATTEMPTS; attempt++) {
    const rng = createDailyRNG(`${seed}:c250base:${attempt}`);

    // Walls first, so the constructive generator builds a mine layout that
    // is solvable WITH the walls (the gameActions pre-wall pattern).
    // wallSegments is authored per spec — the ladder's dial, decoupled
    // from the old level-derived estimate.
    let preWallEdges = null;
    if (gimmicks.includes('walls')) {
      const temp = createEmptyBoard(rows, cols);
      applyWalls(temp, rows, cols, spec.wallSegments || 2, rng);
      preWallEdges = temp._wallEdges;
    }

    const board = generateBoard(rows, cols, mines, fr, fc, rng, {
      hasGimmicks: gimmicks.length > 0,
      wallEdges: preWallEdges,
    });
    if (!board) continue;

    if (gimmicks.length === 0) {
      const check = isBoardSolvable(board, rows, cols, fr, fc);
      cleanSolverArtifacts(board);
      if (!accepts(spec, check)) continue;
      return { board, rows, cols, firstClick: fr * cols + fc, check, activeGimmicks: [], applied: {} };
    }

    // Gimmick re-rolls on the same certified-ish base: clearing the cell
    // gimmick layer and re-applying is the proven gameActions sequence
    // (walls survive at board level; applyGimmicks skips re-rolling a
    // populated _wallEdges and ends with recomputeDisplayedMines).
    // Mystery is placed CONSTRUCTIVELY after the other gimmicks — the
    // gameActions pattern, shared via boardGenerator: random mystery on a
    // dense board misses certification most rolls and burns whole bases
    // (measured 5-11s worst on the 11×11 summit stacks before this).
    const wantsMystery = gimmicks.includes('mystery');
    const nonMystery = wantsMystery ? gimmicks.filter((g) => g !== 'mystery') : gimmicks;
    for (let roll = 0; roll < RECT_GIMMICK_REROLLS; roll++) {
      if (preWallEdges) board._wallEdges = preWallEdges;
      for (const r of board) for (const c of r) clearGimmickProperties(c);
      const gRng = createDailyRNG(`${seed}:c250gim:${attempt}:r${roll}`);
      const applied = applyGimmicks(board, gimmickLevel, nonMystery, gRng);
      if (wantsMystery) {
        const targetCount = getIntensity('mystery', gimmickLevel, gRng);
        applied.mystery = placeMysteryConstructive(board, rows, cols, targetCount, gRng, fr, fc);
      }

      const check = isBoardSolvable(board, rows, cols, fr, fc);
      cleanSolverArtifacts(board);
      if (!accepts(spec, check)) continue;

      if (hasTestable) {
        const decorative = findDecorativeGimmicks(board, rows, cols, fr, fc, gimmicks);
        cleanSolverArtifacts(board);
        if (decorative.length > 0) continue; // strict — never relax
      }
      return { board, rows, cols, firstClick: fr * cols + fc, check, activeGimmicks: gimmicks.slice(), applied };
    }
  }
  return null;
}

function buildTilingSpec(spec, seed) {
  const gimmicks = spec.gimmicks || [];
  for (let salt = 0; salt < TILING_STRICT_RETRIES; salt++) {
    const res = generateTilingBoard({
      type: spec.shape, M: spec.M, N: spec.N, mines: spec.mines,
      seed: salt === 0 ? seed : `${seed}:s${salt}`,
      gimmicks,
      gimmickLevel: spec.gimmickLevel || 1,
      loadBearingBudget: Infinity,
      forceConstructive: spec.constructive === true,
    });
    if (!res) continue;
    // Strict load-bearing on the OUTCOME: with an infinite budget the only
    // decorative escape is the exhausted-best return, and the generator
    // stamps its verdict (empty array = strict; null = unmeasured, which
    // an infinite budget never produces — refused defensively anyway).
    if (gimmicks.length > 0 && (res.decorative === null || res.decorative.length > 0)) continue;
    return res;
  }
  return null;
}

function accepts(spec, check) {
  if (!check || !check.solvable || check.remainingUnknowns !== 0) return false;
  if (spec.minDeductions && (check.totalClicks - 1) < spec.minDeductions) return false;
  return true;
}
