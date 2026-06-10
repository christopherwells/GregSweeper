// Shared daily-board generation pipeline for the Node-side tools
// (precompute-daily-board.mjs nightly + regenerate-daily-board.mjs
// admin one-off). ONE copy so the two can never drift apart — and
// CRITICAL: this must mirror gameActions.js's daily branch EXACTLY for
// the seed-to-board pipeline. If they drift, a pre-generated board
// won't match what fresh-cache clients would generate locally, and the
// first canonical write would either lose the experiment or split the
// player base.

import { createDailyRNG } from '../src/logic/seededRandom.js';
import { getDailyGimmick, applyGimmicks } from '../src/logic/gimmicks.js';
import { generateBoard, cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import { isBoardSolvable, findDecorativeGimmicks } from '../src/logic/boardSolver.js';
import { computeDailyFeatures } from '../src/logic/dailyFeatures.js';
import { DAILY_MIN_SIZE, DAILY_SIZE_RANGE, DAILY_MIN_DENSITY, DAILY_DENSITY_RANGE } from '../src/logic/difficulty.js';
import { serializeBoard } from '../src/firebase/dailyBoardSync.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CANDIDATE_COUNT = 10;
const __dirname = dirname(fileURLToPath(import.meta.url));

// Mirror src/logic/experimentDesign.js TARGET_TO_GIMMICK. Kept inline
// to avoid pulling in the browser-only fetch path.
export const TARGET_TO_GIMMICK = {
  mysteryCellCount:  'mystery',
  liarCellCount:     'liar',
  lockedCellCount:   'locked',
  wormholePairCount: 'wormhole',
  mirrorPairCount:   'mirror',
  sonarCellCount:    'sonar',
  compassCellCount:  'compass',
  wallEdgeCount:     'walls',
};

const DEFAULT_TARGET = 'advancedLogicMoves';
const PRIMARY_WEIGHT = 0.1; // mirrors src/logic/experimentDesign.js
// Cap the per-feature target count in slot scoring. wallEdgeCount runs
// 10-30 edges per board while cell-based gimmicks (compass/mystery/locked/
// mirror/sonar/liar) cap out at ~3-5 cells, so an uncapped `count × weight`
// score lets walls dominate every selection. Saturating at COUNT_CAP makes
// the deficit_weight (= how undersampled the feature is) the actual driver.
const COUNT_CAP = 5;

export function loadExperimentSpec() {
  // Mirror experimentDesign.js: load the static JSON. Returns the full
  // spec object (target + coverage_targets) so the per-slot mission
  // logic has everything it needs. Falls back to a primary-only spec
  // if the file is missing or malformed.
  try {
    const raw = readFileSync(join(__dirname, '..', 'src', 'logic', 'experimentTarget.json'), 'utf8');
    const data = JSON.parse(raw);
    return {
      target: data.target || DEFAULT_TARGET,
      coverage_targets: Array.isArray(data.coverage_targets) ? data.coverage_targets : [],
    };
  } catch {
    return { target: DEFAULT_TARGET, coverage_targets: [] };
  }
}

// Resolve the mission for slot index i. Mirrors getMissionForSlot in
// experimentDesign.js — slot 0 is primary (low weight, double-allowed),
// slots ≥1 cycle through coverage_targets (single-only). Empty
// coverage list collapses to primary on every slot.
export function missionForSlot(spec, slotIndex) {
  if (slotIndex === 0 || spec.coverage_targets.length === 0) {
    return {
      target:        spec.target,
      deficitWeight: PRIMARY_WEIGHT,
      singleOnly:    false,
      isPrimary:     true,
    };
  }
  const entry = spec.coverage_targets[(slotIndex - 1) % spec.coverage_targets.length];
  return {
    target:        entry.feature,
    deficitWeight: typeof entry.deficit_weight === 'number' ? entry.deficit_weight : 0.1,
    singleOnly:    true,
    isPrimary:     false,
  };
}

export function buildOneCandidate(seed, forcedGimmick, singleOnly) {
  // Mirror gameActions.js daily branch + retry loop.
  const dRng = createDailyRNG(seed);
  const rows = DAILY_MIN_SIZE + Math.floor(dRng() * DAILY_SIZE_RANGE);
  const cols = DAILY_MIN_SIZE + Math.floor(dRng() * DAILY_SIZE_RANGE);
  const density = DAILY_MIN_DENSITY + dRng() * DAILY_DENSITY_RANGE;
  const totalMines = Math.max(5, Math.round(rows * cols * density));
  const fr = Math.floor(rows / 2), fc = Math.floor(cols / 2);

  const boardRng = createDailyRNG(seed);
  let board = generateBoard(rows, cols, totalMines, fr, fc, boardRng);
  cleanSolverArtifacts(board);

  const activeGimmicks = getDailyGimmick(seed, createDailyRNG, forcedGimmick, singleOnly);

  let check = null;
  for (let dAttempt = 0; dAttempt < 200; dAttempt++) {
    if (dAttempt > 0) {
      const retryRng = createDailyRNG(seed + '-retry-' + dAttempt);
      board = generateBoard(rows, cols, totalMines, fr, fc, retryRng);
      cleanSolverArtifacts(board);
    }
    if (activeGimmicks.length > 0) {
      const gimmickApplyRng = createDailyRNG(seed + '-gimmick-apply-' + dAttempt);
      applyGimmicks(board, 1, activeGimmicks, gimmickApplyRng);
    }
    check = isBoardSolvable(board, rows, cols, fr, fc);
    cleanSolverArtifacts(board);
    if (check.solvable || check.remainingUnknowns === 0) break;
  }
  // Compute decorative gimmicks once per candidate. Only meaningful when
  // the board is solvable — otherwise we'd be measuring decoration on a
  // failed candidate. selectBestCandidate uses this to prefer load-bearing
  // candidates and falls back to the best decorative if none pass.
  const decorative = (check && (check.solvable || check.remainingUnknowns === 0))
    ? findDecorativeGimmicks(board, rows, cols, fr, fc, activeGimmicks)
    : [];
  return { board, rows, cols, totalMines, activeGimmicks, check, decorative };
}

export function selectBestCandidate(dateString, spec) {
  // Mirror selectDailyRngSeed.js: per-slot missions (1 primary + 9
  // coverage), score = min(target_count, COUNT_CAP) × deficit_weight, pick
  // max. The cap stops wallEdgeCount (10-30 edges/board) from dwarfing
  // cell-based gimmicks (3-5 cells max) and lets deficit_weight drive.
  //
  // Two-tier preference: among solvable candidates, prefer those whose
  // every non-mystery modifier is load-bearing (no decorative modifiers).
  // Fall back to highest-scoring decorative candidate if no load-bearing
  // candidate exists. This avoids shipping boards where, say, the sonar
  // cell is window-dressing the player can ignore.
  let loadBearingBest = null, loadBearingScore = -Infinity, loadBearingSeed = null, loadBearingMission = null;
  let anyBest = null, anyScore = -Infinity, anySeed = null, anyMission = null;
  let totalSolvable = 0;
  let totalLoadBearing = 0;
  for (let i = 0; i < CANDIDATE_COUNT; i++) {
    const mission = missionForSlot(spec, i);
    const forcedGimmick = TARGET_TO_GIMMICK[mission.target] || null;
    const seed = `${dateString}:trial${i}`;
    const cand = buildOneCandidate(seed, forcedGimmick, mission.singleOnly);
    if (!cand.check.solvable && cand.check.remainingUnknowns !== 0) continue;
    totalSolvable++;
    const features = computeDailyFeatures(
      { board: cand.board, rows: cand.rows, cols: cand.cols, totalMines: cand.totalMines, activeGimmicks: cand.activeGimmicks },
      cand.check,
    );
    const count = features[mission.target] || 0;
    const score = Math.min(count, COUNT_CAP) * mission.deficitWeight;
    if (score > anyScore) {
      anyScore = score;
      anySeed = seed;
      anyBest = cand;
      anyMission = mission;
    }
    if (cand.decorative.length === 0) {
      totalLoadBearing++;
      if (score > loadBearingScore) {
        loadBearingScore = score;
        loadBearingSeed = seed;
        loadBearingBest = cand;
        loadBearingMission = mission;
      }
    }
  }
  console.log(`  candidates: ${totalSolvable} solvable, ${totalLoadBearing} fully load-bearing`);
  let best = loadBearingBest, bestSeed = loadBearingSeed, bestMission = loadBearingMission;
  if (!best) {
    if (anyBest) {
      console.log(`  no fully load-bearing candidate; falling back to highest-scoring (decorative=${anyBest.decorative.join(',')})`);
      best = anyBest; bestSeed = anySeed; bestMission = anyMission;
    } else {
      // No solvable candidate — fall back to the plain dateString. This
      // shouldn't happen often; the gameActions retry loop would also
      // have to dig harder if it did.
      const fallbackForced = TARGET_TO_GIMMICK[spec.target] || null;
      const cand = buildOneCandidate(dateString, fallbackForced, false);
      best = cand;
      bestSeed = dateString;
      bestMission = missionForSlot(spec, 0);
    }
  }
  // HARD GATE: never write an uncertified canonical. buildOneCandidate
  // returns its last attempt even when all attempts failed, so the
  // fallback path above could hand us an unsolvable board — written as
  // canonical, that would break the no-guess contract for every player
  // on this date. Failing the workflow is the correct outcome: the
  // first client of the day falls back to (now-verified) local
  // generation instead.
  if (!best.check || !(best.check.solvable || best.check.remainingUnknowns === 0)) {
    throw new Error(`No solvable board found for ${dateString} — refusing to write an uncertified canonical`);
  }
  return { ...best, rngSeed: bestSeed, mission: bestMission };
}

export function readCodeVersion() {
  // sw.js CACHE_NAME for forensic provenance — which build wrote a board.
  try {
    const sw = readFileSync(join(__dirname, '..', 'sw.js'), 'utf8');
    const m = sw.match(/CACHE_NAME\s*=\s*['"]([^'"]+)['"]/);
    if (m) return m[1];
  } catch {}
  return 'unknown';
}

// Serialize the selected candidate into the canonical payload, stamping
// the winning mission INTO it. Boards are generated up to 7 days before
// they're played, and the nightly refit reorders the coverage list, so
// consumers must never re-derive the mission from the seed's slot index
// against the CURRENT experimentTarget.json — they read it from the
// board (Greg's Field Note does exactly this).
export function buildCanonicalPayload(cand, codeVersion) {
  const payload = serializeBoard({
    board: cand.board,
    rows: cand.rows, cols: cand.cols, totalMines: cand.totalMines,
    rngSeed: cand.rngSeed,
    activeGimmicks: cand.activeGimmicks,
    codeVersion,
  });
  const m = cand.mission || {};
  if (m && typeof m.target === 'string') {
    payload.missionTarget = m.target;
    payload.missionIsPrimary = m.isPrimary === true;
  }
  return payload;
}

export function buildCandidateFeatures(cand) {
  return computeDailyFeatures(
    { board: cand.board, rows: cand.rows, cols: cand.cols, totalMines: cand.totalMines, activeGimmicks: cand.activeGimmicks },
    cand.check,
  );
}
