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
// SHAPE OVERRIDE (--shape=<token>): builds the week's board on a chosen
// board shape instead of the rectangular pipeline. There is no weekly shape
// ROTATION, since which shape a week lands on is a deliberate call rather
// than a draw, so this flag IS the whole mechanism. It routes to the one
// shared builder (buildTilingWeeklyBoard in logic/shapeRotation.js) instead
// of growing a second copy of tiling generation here. Added for the v1.10
// launch week, whose weekly is deliberately Octagons.
//
// Usage (via GH Actions workflow_dispatch):
//   FIREBASE_SERVICE_ACCOUNT=<json> node scripts/regenerate-weekly-board.mjs YYYY-MM-DD [--shape=octagons] [--dry-run]

import { signCanonicalPayload, requireSigningKey } from '../src/logic/canonicalSignature.js';
import { createDailyRNG } from '../src/logic/seededRandom.js';
import { getWeeklyGimmicks, applyGimmicks } from '../src/logic/gimmicks.js';
import { generateBoard, cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import { isBoardSolvable } from '../src/logic/boardSolver.js';
import {
  WEEKLY_MIN_SIZE, WEEKLY_SIZE_RANGE, BOARD_WIDTH_CAP,
  DAILY_MIN_DENSITY, DAILY_DENSITY_RANGE,
} from '../src/logic/difficulty.js';
import { serializeBoard } from '../src/firebase/dailyBoardSync.js';
import { selectWeeklyRngSeed } from '../src/logic/selectWeeklyRngSeed.js';
import { buildTilingWeeklyBoard } from '../src/logic/shapeRotation.js';
import { tilingTypeForToken, tilingLabel, CLASSIC_SHAPE_LABEL } from '../src/logic/coastlineLink.js';
import { containerIsStorable } from '../src/logic/tilingGeometry.js';
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
  // ONE copy of the weekly selection rule, matching precompute-weekly-board.mjs:
  // selectWeeklyRngSeed resolves the seed (banded argmax toward the week's
  // target par) and the winner is rebuilt through the same retry loop. The
  // private unbanded contest that lived here predated the par bands, so this
  // tool would have regenerated a board the nightly pipeline would never have
  // produced. That is the mirror-pair drift class, inside the tool built to
  // REPAIR canonicals.
  const rngSeed = selectWeeklyRngSeed(weekStart);
  const best = buildOneCandidate(rngSeed);
  // HARD GATE: never write an uncertified canonical (buildOneCandidate
  // returns its last attempt even on exhaustion).
  if (!best.check || !(best.check.solvable || best.check.remainingUnknowns === 0)) {
    throw new Error(`No solvable weekly board found for ${weekStart} — refusing to write an uncertified canonical`);
  }
  return { ...best, rngSeed };
}

/** The week's board on a chosen lattice, through the one shared builder. */
function selectTilingCandidate(weekStart, type) {
  const built = buildTilingWeeklyBoard(weekStart, type);
  if (!built) {
    throw new Error(`No certified ${type} weekly board for ${weekStart} — every config attempt exhausted`);
  }
  if (!(built.check.solvable || built.check.remainingUnknowns === 0)) {
    throw new Error(`${type} weekly for ${weekStart} came back uncertified — refusing to write`);
  }
  // A prime cell count forces a 1xN container, which the canonical rules
  // reject on rows/cols. serializeBoard throws on it; failing here says why.
  // The band tables are pinned storable, so this is a rail, not a path.
  if (!containerIsStorable(built.rows * built.cols)) {
    throw new Error(`${type} weekly for ${weekStart}: ${built.rows * built.cols} cells is not a storable container`);
  }
  return built;
}

(async () => {
  const args = process.argv.slice(2);
  const weekStart = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const dryRun = args.includes('--dry-run');
  if (!weekStart) {
    console.error('usage: node scripts/regenerate-weekly-board.mjs YYYY-MM-DD [--shape=<token>] [--dry-run]');
    process.exit(1);
  }

  // An unrecognized token is a HARD failure, never a fall-through to the
  // 4.8.8 (buildTiling's default) — the one place a typo would otherwise
  // produce a plausible board on the wrong lattice with no error anywhere.
  const shapeArg = args.find(a => a.startsWith('--shape='));
  let shape = null;
  if (shapeArg) {
    const token = shapeArg.slice('--shape='.length).trim().toLowerCase();
    if (token !== 'rect' && token !== 'classic') {
      shape = tilingTypeForToken(token);
      if (!shape) {
        console.error(`refusing: --shape=${token} names no board shape. `
          + 'Use classic, octagons, honeycomb, paving, petals, cubes or kites.');
        process.exit(1);
      }
    }
  }
  const shapeName = shape ? tilingLabel(shape) : CLASSIC_SHAPE_LABEL;
  const buildCandidate = () => (shape ? selectTilingCandidate(weekStart, shape) : selectBestCandidate(weekStart));

  if (dryRun) {
    console.log(`weeklyBoard/${weekStart} (DRY RUN) shape: ${shapeName}`);
    const cand = buildCandidate();
    console.log(`  selected: ${cand.rngSeed}`);
    console.log(`  board: ${cand.rows}x${cand.cols} = ${cand.rows * cand.cols} cells, ${cand.totalMines} mines, gimmicks: ${cand.activeGimmicks.join(',') || '(none)'}`);
    const payload = serializeBoard({
      board: cand.board, rows: cand.rows, cols: cand.cols, totalMines: cand.totalMines,
      rngSeed: cand.rngSeed, activeGimmicks: cand.activeGimmicks, codeVersion: 'dry-run',
      firstClick: cand.firstClick,
    });
    console.log(`  payload size: ${JSON.stringify(payload).length} bytes`);
    console.log('DRY RUN — nothing written.');
    return;
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

  console.log(`  generating new candidate via current code rules (shape: ${shapeName})…`);
  const cand = buildCandidate();
  console.log(`  selected: ${cand.rngSeed}`);
  console.log(`  board: ${cand.rows}x${cand.cols} = ${cand.rows * cand.cols} cells, ${cand.totalMines} mines, gimmicks: ${cand.activeGimmicks.join(',') || '(none)'}`);

  let codeVersion = 'unknown';
  try {
    const sw = readFileSync(join(__dirname, '..', 'sw.js'), 'utf8');
    const m = sw.match(/CACHE_NAME\s*=\s*['"]([^'"]+)['"]/);
    if (m) codeVersion = m[1];
  } catch {}

  // firstClick is emitted only when it is an integer, so a rectangular
  // regeneration serializes byte-identically to before. The tiling
  // descriptor and the topology are read off the BOARD (board._tiling /
  // board._cellNeighbors), not passed in.
  const payload = serializeBoard({
    board: cand.board,
    rows: cand.rows, cols: cand.cols, totalMines: cand.totalMines,
    rngSeed: cand.rngSeed,
    activeGimmicks: cand.activeGimmicks,
    codeVersion,
    firstClick: cand.firstClick,
  });
  console.log(`  payload size: ${JSON.stringify(payload).length} bytes`);

  // Sign the board (#114) — see regenerate-daily-board.mjs.
  payload.sig = await signCanonicalPayload(payload, requireSigningKey());
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
