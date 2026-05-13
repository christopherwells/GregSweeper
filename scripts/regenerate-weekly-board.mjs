// Force-regenerate a weekly canonical board. Deletes the existing
// weeklyBoard/{weekStart} record (using service-account auth to
// bypass the write-once rule) and the matching dailyMeta /
// daily/{weekStart}_weekly_first records if any, then re-runs the
// generation pipeline with the current code's rules.
//
// Used when the weekly's generation rules change mid-week (e.g. drop
// from 4 to 3 gimmick stack) and we want next-load players to see the
// new rules instead of being stuck with the old canonical until next
// Monday's precompute.
//
// Usage (via GH Actions workflow_dispatch):
//   FIREBASE_SERVICE_ACCOUNT=<json> node scripts/regenerate-weekly-board.mjs YYYY-MM-DD

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
import { createSign } from 'node:crypto';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';
const CANDIDATE_COUNT = 10;
const __dirname = dirname(fileURLToPath(import.meta.url));

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const header = { alg: 'RS256', typ: 'JWT' };
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${enc(header)}.${enc(claims)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(serviceAccount.private_key, 'base64url');
  const jwt = `${unsigned}.${signature}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!r.ok) throw new Error(`token mint failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.access_token;
}

async function adminDelete(accessToken, path) {
  const url = `${DB_BASE}/${path}.json?access_token=${encodeURIComponent(accessToken)}`;
  const r = await fetch(url, { method: 'DELETE' });
  if (!r.ok && r.status !== 404) {
    throw new Error(`delete ${path} failed: ${r.status} ${await r.text()}`);
  }
  return r.ok;
}

async function adminWrite(accessToken, path, payload) {
  const url = `${DB_BASE}/${path}.json?access_token=${encodeURIComponent(accessToken)}`;
  const body = JSON.stringify({ ...payload, writtenAt: { '.sv': 'timestamp' } });
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
  if (!r.ok) throw new Error(`write ${path} failed: ${r.status} ${await r.text()}`);
}

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

(async () => {
  const weekStart = process.argv[2];
  if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    console.error('usage: node scripts/regenerate-weekly-board.mjs YYYY-MM-DD');
    process.exit(1);
  }
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saJson) {
    console.error('FIREBASE_SERVICE_ACCOUNT env not set — cannot bypass write-once rule');
    process.exit(1);
  }
  const sa = JSON.parse(saJson);
  const accessToken = await getAccessToken(sa);

  console.log(`Force-regenerating weeklyBoard/${weekStart}`);
  console.log('  deleting existing canonical (if any)…');
  await adminDelete(accessToken, `weeklyBoard/${weekStart}`);
  // Also clear the synthetic-daily fit-data records that were paired
  // with the old board, so the R refit doesn't see stale features.
  console.log('  clearing daily/' + weekStart + '_weekly_first and dailyMeta/' + weekStart + '_weekly_first');
  await adminDelete(accessToken, `daily/${weekStart}_weekly_first`);
  await adminDelete(accessToken, `dailyMeta/${weekStart}_weekly_first`);
  // Per-uid weeklyAttempts and the leaderboard rows belong to the
  // PLAYERS, not the board. Wipe them too — old times against the old
  // board don't make sense to compare to the new one.
  console.log('  clearing weekly/' + weekStart + ' leaderboard');
  await adminDelete(accessToken, `weekly/${weekStart}`);

  console.log('  generating new candidate via current code rules…');
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

  await adminWrite(accessToken, `weeklyBoard/${weekStart}`, payload);
  console.log('  written');

  // Per-user attempt markers also need clearing so players who already
  // burned a "Mon attempt" against the old board can play the new one.
  // We can't enumerate users without reading users/* — that's the
  // service-account's job. Iterate over known users and clear each.
  console.log('  clearing per-user weeklyAttempts/' + weekStart + ' for all users…');
  const usersResp = await fetch(`${DB_BASE}/users.json?access_token=${encodeURIComponent(accessToken)}&shallow=true`);
  if (usersResp.ok) {
    const uids = Object.keys((await usersResp.json()) || {});
    for (const uid of uids) {
      await adminDelete(accessToken, `users/${uid}/weeklyAttempts/${weekStart}`);
    }
    console.log(`    cleared for ${uids.length} users`);
  } else {
    console.warn('    users tree fetch failed, attempt markers may linger');
  }

  console.log('Done.');
})().catch(err => {
  console.error('regenerate-weekly-board failed:', err.message);
  process.exit(1);
});
