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
import { computeDailyFeatures, predictPar } from '../src/logic/dailyFeatures.js';
import {
  resolveMissionForSlot, resolveCandidateCount, missionCandidateScore,
  selectMissionWinner, getTargetGimmickName, missionStamp,
} from '../src/logic/experimentDesign.js';
import { drawDailyTargetPar, DAILY_PAR_BAND } from '../src/logic/parBand.js';
import { resolveDailyShape, buildTilingDailyBoard } from '../src/logic/shapeRotation.js';
import { DAILY_MIN_SIZE, DAILY_SIZE_RANGE, DAILY_MIN_DENSITY, DAILY_DENSITY_RANGE } from '../src/logic/difficulty.js';
import { serializeBoard } from '../src/firebase/dailyBoardSync.js';
import { chooseStartAnchor } from '../src/logic/startAnchor.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { clampRectDims } from '../src/logic/boardFit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_TARGET = 'advancedLogicMoves';
// Nothing about mission resolution or scoring lives in this file any more.
// The slot arithmetic (resolveMissionForSlot), the target→gimmick table
// (getTargetGimmickName), the score formula and its cap (missionCandidateScore
// / COUNT_CAP), and the candidate count (resolveCandidateCount) all come from
// experimentDesign.js, so this precompute and the client's selectDailyRngSeed
// cannot disagree about which board a date gets. They used to keep private
// copies of the slot mapping and it drifted; the rest followed it here for the
// same reason before it could.

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
      // Optional; absent on an ordinary day and on any file written before F1.
      // resolveMissionForSlot validates it, so a malformed one degrades to
      // "no decorrelation today" rather than poisoning the selection.
      decorrelation_mission: data.decorrelation_mission || null,
    };
  } catch {
    return { target: DEFAULT_TARGET, coverage_targets: [], decorrelation_mission: null };
  }
}

// Resolve the mission for slot index i. DELEGATES to the shared pure
// resolveMissionForSlot in experimentDesign.js rather than carrying its own
// copy: this file used to wrap (`% coverage.length`) where the client
// returned null, so a coverage list shorter than 9 made the precompute
// evaluate slots 8-9 as duplicates of coverage[0]/[1] and pick seeds the
// client would never select. Returns null for slots past the coverage list;
// callers skip those.
export function missionForSlot(spec, slotIndex) {
  return resolveMissionForSlot(
    slotIndex, spec.target, spec.coverage_targets, spec.decorrelation_mission,
  );
}

// How many slots this spec's selection evaluates. Delegates for the same
// reason missionForSlot does — the client reads the identical rule out of
// resolveCandidateCount, so the two loops run the same number of times.
export function candidateCountFor(spec) {
  return resolveCandidateCount(spec.coverage_targets, spec.decorrelation_mission);
}

export function buildOneCandidate(seed, forcedGimmick, singleOnly) {
  // Mirror gameActions.js daily branch + retry loop.
  const dRng = createDailyRNG(seed);
    // HIS RULING (2026-08-20): a daily must not scroll at the default cell
  // size. Today this clamp is a proven no-op on the daily's draw range
  // (test/boardFit.test.mjs sweeps every reachable pair), and it is here so
  // that a future edit to the range, the tap floor or the reference phone
  // cannot quietly make one scroll.
  const { rows, cols } = clampRectDims(
    DAILY_MIN_SIZE + Math.floor(dRng() * DAILY_SIZE_RANGE),
    DAILY_MIN_SIZE + Math.floor(dRng() * DAILY_SIZE_RANGE),
  );
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
  return { board, rows, cols, totalMines, activeGimmicks, check, decorative, seed };
}

// The pipeline's uncertified-canonical hard gate, shared by both selection
// branches below: never return a board the shipped certifier did not clear.
function assertCertified(cand, dateString) {
  if (!cand.check || !(cand.check.solvable || cand.check.remainingUnknowns === 0)) {
    throw new Error(`No solvable board found for ${dateString} — refusing to write an uncertified canonical`);
  }
  return cand;
}

export function selectBestCandidate(dateString, spec, dailyShape = resolveDailyShape(dateString)) {
  // Shape rotation (Project Coastline): a tiling day is SINGLE-CANDIDATE —
  // the mission is drawn by weight (selectTilingMission) and force-injected
  // onto the one seed, because the client fallback must replay selection
  // deterministically and a 10-way contest would mean generating ten boards
  // (a rhombille generation is ~seconds, not milliseconds). The shape comes
  // from resolveDailyShape — null (rectangle, always while the rotation is
  // dark) routes to the rectangular contest below; the parameter exists so
  // tests can exercise the tiling branch without flipping the shipped gate.
  if (dailyShape) {
    const t0 = Date.now();
    const built = buildTilingDailyBoard(dateString, dailyShape, spec);
    if (built) {
      console.log(`  tiling day (${dailyShape}): ${built.rows * built.cols} cells / ${built.totalMines} mines (banded config), generated in ${Date.now() - t0} ms`);
      return assertCertified({
        board: built.board, rows: built.rows, cols: built.cols,
        totalMines: built.totalMines, activeGimmicks: built.activeGimmicks,
        check: built.check,
        // The modifier load-bearing filter ran INSIDE generateTilingBoard
        // (budgeted, the same bar the rectangular candidates clear); a single
        // candidate has no two-tier lottery to feed, so this is settled.
        decorative: [],
        seed: built.rngSeed, rngSeed: built.rngSeed, mission: built.mission,
        firstClick: built.firstClick, tilingType: dailyShape,
      }, dateString);
    }
    // Deterministic outcome: the same seed exhausts for every client too, so
    // precompute and fallback clients land on the SAME rectangular board.
    console.log(`  tiling day (${dailyShape}): generation exhausted uncertified — falling back to the rectangular contest`);
  }
  // Mirror selectDailyRngSeed.js: per-slot missions (1 primary + 9
  // coverage), score = min(target_count, COUNT_CAP) × deficit_weight, and
  // the winner drawn by selectMissionWinner's date-seeded weighted lottery
  // (P ∝ score; decorrelation keeps argmax supremacy — the argmax this
  // replaced served worm 10 of 12 days straight, 2026-07-30). The cap stops
  // wallEdgeCount (10-30 edges/board) from dwarfing cell-based gimmicks
  // (3-5 cells max) and lets deficit_weight drive.
  //
  // Two-tier preference: among solvable candidates, the lottery draws from
  // those whose every non-mystery modifier is load-bearing (no decorative
  // modifiers). Fall back to a draw over all solvable candidates if no
  // load-bearing candidate exists. This avoids shipping boards where, say,
  // the sonar cell is window-dressing the player can ignore.
  const scored = [];
  const candidateCount = candidateCountFor(spec);
  for (let i = 0; i < candidateCount; i++) {
    const mission = missionForSlot(spec, i);
    // Slots past the coverage list have no mission (no-wrap) — skip them,
    // exactly as selectDailyRngSeed.js does. Without this the null would
    // throw on mission.target.
    if (!mission || !mission.target) continue;
    const forcedGimmick = getTargetGimmickName(mission.target);
    const seed = `${dateString}:trial${i}`;
    const cand = buildOneCandidate(seed, forcedGimmick, mission.singleOnly);
    if (!cand.check.solvable && cand.check.remainingUnknowns !== 0) continue;
    const features = computeDailyFeatures(
      { board: cand.board, rows: cand.rows, cols: cand.cols, totalMines: cand.totalMines, activeGimmicks: cand.activeGimmicks, rngSeed: seed },
      cand.check,
    );
    const score = missionCandidateScore(mission, features);
    if (score === null) continue;
    // Par rides along for the band, exactly as in selectDailyRngSeed.js.
    scored.push({ score, mission, seed, cand, par: predictPar(features) });
  }
  const loadBearing = scored.filter(e => e.cand.decorative.length === 0);
  const targetPar = drawDailyTargetPar(dateString);
  console.log(`  candidates: ${scored.length} solvable, ${loadBearing.length} fully load-bearing; par target ${targetPar.toFixed(0)}s, pool ${scored.map(e => e.par.toFixed(0)).join('/')}`);
  // The lottery seed is the DATE, so the load-bearing pool and the
  // all-solvable fallback pool resolve through the same single draw —
  // one rng stream, one consumer, exactly like the client path.
  const winner = selectMissionWinner(
    loadBearing.length > 0 ? loadBearing : scored, dateString,
    { targetPar, band: DAILY_PAR_BAND },
  );
  let best = null, bestSeed = null, bestMission = null;
  if (winner) {
    if (loadBearing.length === 0) {
      console.log(`  no fully load-bearing candidate; drawing over all solvable (decorative=${winner.cand.decorative.join(',')})`);
    }
    console.log(`  par band: winner ${winner.par.toFixed(0)}s against target ${targetPar.toFixed(0)}s`);
    best = winner.cand; bestSeed = winner.seed; bestMission = winner.mission;
  }
  if (!best) {
    // No solvable candidate — fall back to the plain dateString. This
    // shouldn't happen often; the gameActions retry loop would also
    // have to dig harder if it did.
    const fallbackForced = getTargetGimmickName(spec.target);
    const cand = buildOneCandidate(dateString, fallbackForced, false);
    best = cand;
    bestSeed = dateString;
    bestMission = missionForSlot(spec, 0);
  }
  // HARD GATE: never write an uncertified canonical. buildOneCandidate
  // returns its last attempt even when all attempts failed, so the
  // fallback path above could hand us an unsolvable board — written as
  // canonical, that would break the no-guess contract for every player
  // on this date. Failing the workflow is the correct outcome: the
  // first client of the day falls back to (now-verified) local
  // generation instead.
  return assertCertified({ ...best, rngSeed: bestSeed, mission: bestMission }, dateString);
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
    // The certified opener — set only on a tiling candidate (a rectangle's
    // opener IS the container centre, and serializeBoard omits non-integers,
    // so rectangular payloads stay byte-identical).
    firstClick: cand.firstClick,
  });
  Object.assign(payload, missionStamp(cand.mission));
  // The STORED "Start here" anchor (his 2026-08-17 ruling: "This should
  // definitely not be client-side ever"). Chosen here, once, for the
  // friendliest certifying opening (longest pass-A run before the first
  // hard move, then cascade size, then centrality), and signed with the
  // payload. Distinct from firstClick, the certification opener that
  // feeds features and par. The center certification this pipeline
  // already requires guarantees SOME anchor certifies, so a null here is
  // an inconsistency worth dying on, never a reason to ship a canonical
  // whose marker the certificate does not stand behind.
  const anchor = chooseStartAnchor(cand.board, cand.rows, cand.cols);
  if (!anchor) {
    throw new Error('buildCanonicalPayload: no certifying start anchor on a center-certified board');
  }
  payload.bestStart = anchor.r * cand.cols + anchor.c;
  return payload;
}

// The candidate's certified opener as a flat index: the stored firstClick on
// a tiling candidate, the container centre on a rectangle — the same
// resolution deserializeBoard applies on the read side.
export function candidateOpener(cand) {
  return Number.isInteger(cand.firstClick)
    ? cand.firstClick
    : Math.floor(cand.rows / 2) * cand.cols + Math.floor(cand.cols / 2);
}

export function buildCandidateFeatures(cand) {
  const opener = candidateOpener(cand);
  return computeDailyFeatures(
    { board: cand.board, rows: cand.rows, cols: cand.cols, totalMines: cand.totalMines, activeGimmicks: cand.activeGimmicks, rngSeed: cand.seed },
    cand.check,
    // Winner-only (this feeds the dailyMeta write, never the per-candidate
    // scoring pass), so the contribution strip-solves are paid once per date.
    // Same certified opener the pipeline certifies from — the container
    // centre on a rectangle, the tiling's own centre cell otherwise.
    { contributionOpener: { row: Math.floor(opener / cand.cols), col: opener % cand.cols } },
  );
}
