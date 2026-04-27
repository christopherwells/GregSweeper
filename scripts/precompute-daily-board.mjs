// Pre-generate the canonical daily board for a given date and write it
// to Firebase. Run by the precompute-daily-board.yml GitHub Actions
// workflow at 00:00 UTC (~5h before midnight ET) so every visitor for
// that ET date fetches the same board.
//
// CRITICAL: this script must mirror gameActions.js's daily branch
// EXACTLY for the seed-to-board pipeline. If the two ever drift, the
// pre-generated board won't match what fresh-cache clients would
// generate, and the first canonical write would either lose the
// experiment or split the player base.
//
// Usage:
//   node scripts/precompute-daily-board.mjs YYYY-MM-DD
//
// Idempotent: write-once Firebase rules silently reject duplicate
// writes, so re-running for the same date is a no-op (returns 0).

import { createDailyRNG } from '../src/logic/seededRandom.js';
import { getDailyGimmick, applyGimmicks } from '../src/logic/gimmicks.js';
import { generateBoard, cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import { isBoardSolvable } from '../src/logic/boardSolver.js';
import { computeDailyFeatures } from '../src/logic/dailyFeatures.js';
import { DAILY_MIN_SIZE, DAILY_SIZE_RANGE, DAILY_MIN_DENSITY, DAILY_DENSITY_RANGE } from '../src/logic/difficulty.js';
import { serializeBoard } from '../src/firebase/dailyBoardSync.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FIREBASE_API_KEY = 'AIzaSyBhiFPIUA0u021Yh7eA35N2nQOIUPVPtpo';
const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';
const CANDIDATE_COUNT = 10;
const __dirname = dirname(fileURLToPath(import.meta.url));

function loadExperimentTarget() {
  // Mirror experimentDesign.js: load the static JSON, fall back to
  // DEFAULT_TARGET if the file is missing. This script lives in the
  // same repo as the JSON, so we just read it from disk.
  try {
    const raw = readFileSync(join(__dirname, '..', 'src', 'logic', 'experimentTarget.json'), 'utf8');
    const data = JSON.parse(raw);
    return data.target || 'advancedLogicMoves';
  } catch {
    return 'advancedLogicMoves';
  }
}

// Mirror src/logic/experimentDesign.js TARGET_TO_GIMMICK. Kept inline
// to avoid pulling in the browser-only fetch path.
const TARGET_TO_GIMMICK = {
  mysteryCellCount:  'mystery',
  liarCellCount:     'liar',
  lockedCellCount:   'locked',
  wormholePairCount: 'wormhole',
  mirrorPairCount:   'mirror',
  sonarCellCount:    'sonar',
  compassCellCount:  'compass',
  wallEdgeCount:     'walls',
};

function buildOneCandidate(seed, forcedGimmick) {
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

  const activeGimmicks = getDailyGimmick(seed, createDailyRNG, forcedGimmick);

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
  return { board, rows, cols, totalMines, activeGimmicks, check };
}

function selectBestCandidate(dateString, target, forcedGimmick) {
  // Mirror selectDailyRngSeed.js: try CANDIDATE_COUNT seeds, pick the
  // one whose board has the highest count of the targeted feature.
  let best = null, bestCount = -1, bestSeed = null;
  for (let i = 0; i < CANDIDATE_COUNT; i++) {
    const seed = `${dateString}:trial${i}`;
    // Lightweight first-attempt-only check matching selectDailyRngSeed
    // (it skips the retry loop too). buildOneCandidate's retry doesn't
    // hurt — if the board needs retries, we'd find that out anyway.
    const cand = buildOneCandidate(seed, forcedGimmick);
    if (!cand.check.solvable && cand.check.remainingUnknowns !== 0) continue;
    const features = computeDailyFeatures(
      { board: cand.board, rows: cand.rows, cols: cand.cols, totalMines: cand.totalMines, activeGimmicks: cand.activeGimmicks },
      cand.check,
    );
    const count = features[target] || 0;
    if (count > bestCount) {
      bestCount = count;
      bestSeed = seed;
      best = cand;
    }
  }
  if (!best) {
    // No solvable candidate — fall back to the plain dateString. This
    // shouldn't happen often; the gameActions retry loop would also
    // have to dig harder if it did.
    const cand = buildOneCandidate(dateString, forcedGimmick);
    best = cand;
    bestSeed = dateString;
  }
  return { ...best, rngSeed: bestSeed };
}

async function signInAnonymously() {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`anonymous sign-in failed: ${r.status} ${txt}`);
  }
  const j = await r.json();
  if (!j.idToken) throw new Error('anonymous sign-in: no idToken in response');
  return j.idToken;
}

async function existsCanonicalBoard(date) {
  const r = await fetch(`${DB_BASE}/dailyBoard/${date}.json`);
  if (!r.ok) return false;
  const j = await r.json();
  return j !== null;
}

async function writeCanonicalBoard(date, idToken, payload) {
  const url = `${DB_BASE}/dailyBoard/${date}.json?auth=${encodeURIComponent(idToken)}`;
  const body = JSON.stringify({
    ...payload,
    writtenAt: { '.sv': 'timestamp' },
  });
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Firebase write failed: ${r.status} ${txt}`);
  }
}

(async () => {
  const date = process.argv[2];
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error('usage: node precompute-daily-board.mjs YYYY-MM-DD');
    process.exit(1);
  }

  console.log(`precompute dailyBoard/${date}`);

  if (await existsCanonicalBoard(date)) {
    console.log('  already written — exiting');
    return;
  }

  const target = loadExperimentTarget();
  const forcedGimmick = TARGET_TO_GIMMICK[target] || null;
  console.log(`  target: ${target}, forcedGimmick: ${forcedGimmick || '(none)'}`);

  const cand = selectBestCandidate(date, target, forcedGimmick);
  console.log(`  selected: ${cand.rngSeed}, ${cand.rows}x${cand.cols}, ${cand.totalMines} mines, gimmicks: ${cand.activeGimmicks.join(',') || '(none)'}`);

  // Read sw.js for codeVersion provenance — useful when debugging which
  // build wrote a given canonical board.
  let codeVersion = 'unknown';
  try {
    const sw = readFileSync(join(__dirname, '..', 'sw.js'), 'utf8');
    const m = sw.match(/CACHE_NAME\s*=\s*['"]([^'"]+)['"]/);
    if (m) codeVersion = m[1];
  } catch {}

  const payload = serializeBoard({
    board: cand.board,
    rows: cand.rows, cols: cand.cols, totalMines: cand.totalMines,
    rngSeed: cand.rngSeed,
    activeGimmicks: cand.activeGimmicks,
    codeVersion,
  });
  console.log(`  payload size: ${JSON.stringify(payload).length} bytes`);

  const idToken = await signInAnonymously();
  await writeCanonicalBoard(date, idToken, payload);
  console.log('  written');
})().catch(err => {
  console.error('precompute failed:', err.message);
  process.exit(1);
});
