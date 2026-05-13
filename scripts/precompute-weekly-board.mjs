// Pre-generate the canonical weekly board for a given week and write it
// to Firebase. Run by the precompute-weekly-board.yml GitHub Actions
// workflow on Monday 00:00 UTC (~7pm Sunday ET) so every visitor that
// week fetches the same board.
//
// Same correctness contract as precompute-daily-board.mjs: this script
// MUST mirror gameActions.js's weekly branch exactly for the seed-to-
// board pipeline. If the two drift, the pre-generated board won't
// match what fresh-cache clients would generate, and the first
// canonical write would split the player base on the same week.
//
// Usage:
//   node scripts/precompute-weekly-board.mjs YYYY-MM-DD     # weekStart (Monday)
//
// Idempotent: write-once Firebase rules silently reject duplicate
// writes for the same weekStart.

import { createDailyRNG } from '../src/logic/seededRandom.js';
import { getWeeklyGimmicks, applyGimmicks } from '../src/logic/gimmicks.js';
import { generateBoard, cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import { isBoardSolvable } from '../src/logic/boardSolver.js';
import {
  WEEKLY_MIN_SIZE, WEEKLY_SIZE_RANGE, BOARD_WIDTH_CAP,
  DAILY_MIN_DENSITY, DAILY_DENSITY_RANGE,
} from '../src/logic/difficulty.js';
import { serializeBoard } from '../src/firebase/dailyBoardSync.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FIREBASE_API_KEY = 'AIzaSyBhiFPIUA0u021Yh7eA35N2nQOIUPVPtpo';
const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';
const CANDIDATE_COUNT = 10;
const __dirname = dirname(fileURLToPath(import.meta.url));

function buildOneCandidate(seed) {
  const dRng = createDailyRNG(seed);
  const rows = WEEKLY_MIN_SIZE + Math.floor(dRng() * WEEKLY_SIZE_RANGE);
  // Cap cols at BOARD_WIDTH_CAP (12); rows can still sample 8-14.
  const cols = Math.min(WEEKLY_MIN_SIZE + Math.floor(dRng() * WEEKLY_SIZE_RANGE), BOARD_WIDTH_CAP);
  const density = DAILY_MIN_DENSITY + dRng() * DAILY_DENSITY_RANGE;
  const totalMines = Math.max(5, Math.round(rows * cols * density));
  const fr = Math.floor(rows / 2), fc = Math.floor(cols / 2);

  const boardRng = createDailyRNG(seed);
  let board = generateBoard(rows, cols, totalMines, fr, fc, boardRng);
  cleanSolverArtifacts(board);

  const activeGimmicks = getWeeklyGimmicks(seed, createDailyRNG);

  let check = null;
  for (let dAttempt = 0; dAttempt < 200; dAttempt++) {
    if (dAttempt > 0) {
      const retryRng = createDailyRNG(seed + '-retry-' + dAttempt);
      board = generateBoard(rows, cols, totalMines, fr, fc, retryRng);
      cleanSolverArtifacts(board);
    }
    if (activeGimmicks.length > 0) {
      const gRng = createDailyRNG(seed + '-gimmick-apply-' + dAttempt);
      applyGimmicks(board, 1, activeGimmicks, gRng);
    }
    check = isBoardSolvable(board, rows, cols, fr, fc);
    cleanSolverArtifacts(board);
    if (check.solvable || check.remainingUnknowns === 0) break;
  }
  return { board, rows, cols, totalMines, activeGimmicks, check };
}

function selectBestCandidate(weekStart) {
  let best = null, bestScore = -Infinity, bestSeed = null;
  for (let i = 0; i < CANDIDATE_COUNT; i++) {
    const seed = `${weekStart}:trial${i}`;
    const cand = buildOneCandidate(seed);
    if (!cand.check.solvable && cand.check.remainingUnknowns !== 0) continue;
    // Score: gimmick count primary, advancedLogicMoves tiebreaker.
    const score = cand.activeGimmicks.length + (cand.check.advancedLogicMoves || 0) * 0.01;
    if (score > bestScore) {
      bestScore = score;
      bestSeed = seed;
      best = cand;
    }
  }
  if (!best) {
    const cand = buildOneCandidate(weekStart);
    best = cand;
    bestSeed = weekStart;
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

async function existsCanonicalBoard(weekStart) {
  const r = await fetch(`${DB_BASE}/weeklyBoard/${weekStart}.json`);
  if (!r.ok) return false;
  const j = await r.json();
  return j !== null;
}

async function writeCanonicalBoard(weekStart, idToken, payload) {
  const url = `${DB_BASE}/weeklyBoard/${weekStart}.json?auth=${encodeURIComponent(idToken)}`;
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
  const weekStart = process.argv[2];
  if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    console.error('usage: node precompute-weekly-board.mjs YYYY-MM-DD');
    process.exit(1);
  }

  console.log(`precompute weeklyBoard/${weekStart}`);

  if (await existsCanonicalBoard(weekStart)) {
    console.log('  already written — exiting');
    return;
  }

  const cand = selectBestCandidate(weekStart);
  console.log(`  selected: ${cand.rngSeed}`);
  console.log(`  board: ${cand.rows}x${cand.cols}, ${cand.totalMines} mines, gimmicks: ${cand.activeGimmicks.join(',') || '(none)'}`);

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
  await writeCanonicalBoard(weekStart, idToken, payload);
  console.log('  written');
})().catch(err => {
  console.error('precompute failed:', err.message);
  process.exit(1);
});
