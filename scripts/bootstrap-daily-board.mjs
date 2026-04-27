// One-off bootstrap: write today's canonical board to Firebase before the
// canonical-board client logic ships. We need this because today
// (2026-04-27) was already played by Chris under v1.5.18 logic (no
// force-injection); without bootstrapping, the FIRST player after the
// canonical-board ship would generate a v1.5.19 board (with sonar
// force-injected) and write THAT as canonical — diverging from the
// board Chris actually played. Bootstrapping locks Chris's actual
// played board as canonical so future visitors today see the same
// thing he did.
//
// Algorithm:
//   1. Re-derive today's board with the SAME logic v1.5.18 used:
//      - rngSeed = whatever's already on Chris's submitted score
//      - getDailyGimmick(seed, rng, null) — natural roll, no force
//      - same dimension / mine / gimmick-apply flow as gameActions.js
//   2. Sign in to Firebase anonymously via REST to get an idToken
//      (rules require auth for dailyBoard writes).
//   3. PUT the serialised board to /dailyBoard/{date}.json?auth=idToken
//
// Usage (from repo root):  node scripts/bootstrap-daily-board.mjs
// Requires Node 18+ for native fetch.

import { createDailyRNG } from '../src/logic/seededRandom.js';
import { getDailyGimmick, applyGimmicks } from '../src/logic/gimmicks.js';
import { generateBoard, cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import { isBoardSolvable } from '../src/logic/boardSolver.js';
import { DAILY_MIN_SIZE, DAILY_SIZE_RANGE, DAILY_MIN_DENSITY, DAILY_DENSITY_RANGE } from '../src/logic/difficulty.js';
import { serializeBoard } from '../src/firebase/dailyBoardSync.js';

// Hard-coded — this script handles ONE specific bootstrap. The seed is
// what Chris's already-submitted score on Firebase has under
// daily/2026-04-27/{pushId}/rngSeed.
const DATE_STRING = '2026-04-27';
const RNG_SEED    = '2026-04-27:trial1';
const FIREBASE_API_KEY = 'AIzaSyBhiFPIUA0u021Yh7eA35N2nQOIUPVPtpo';
const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';

function buildBoard() {
  const dRng = createDailyRNG(RNG_SEED);
  const rows = DAILY_MIN_SIZE + Math.floor(dRng() * DAILY_SIZE_RANGE);
  const cols = DAILY_MIN_SIZE + Math.floor(dRng() * DAILY_SIZE_RANGE);
  const density = DAILY_MIN_DENSITY + dRng() * DAILY_DENSITY_RANGE;
  const totalMines = Math.max(5, Math.round(rows * cols * density));
  const fr = Math.floor(rows / 2), fc = Math.floor(cols / 2);

  const boardRng = createDailyRNG(RNG_SEED);
  let board = generateBoard(rows, cols, totalMines, fr, fc, boardRng);
  cleanSolverArtifacts(board);

  // CRITICAL: pass null for forcedGimmick — Chris played under v1.5.18
  // which had no force-injection. Natural lottery roll is what produced
  // his actual board.
  const activeGimmicks = getDailyGimmick(RNG_SEED, createDailyRNG, null);

  // Same retry loop gameActions.js runs.
  for (let dAttempt = 0; ; dAttempt++) {
    if (dAttempt > 0) {
      const retryRng = createDailyRNG(RNG_SEED + '-retry-' + dAttempt);
      board = generateBoard(rows, cols, totalMines, fr, fc, retryRng);
      cleanSolverArtifacts(board);
    }
    if (activeGimmicks.length > 0) {
      const gimmickApplyRng = createDailyRNG(RNG_SEED + '-gimmick-apply-' + dAttempt);
      applyGimmicks(board, 1, activeGimmicks, gimmickApplyRng);
    }
    const check = isBoardSolvable(board, rows, cols, fr, fc);
    cleanSolverArtifacts(board);
    if (check.solvable || check.remainingUnknowns === 0) break;
    if (dAttempt > 100) {
      throw new Error('bootstrap: solvability retry runaway — generation deviated from production?');
    }
  }

  return { board, rows, cols, totalMines, activeGimmicks };
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
  if (!j.idToken) throw new Error('anonymous sign-in returned no idToken');
  return j.idToken;
}

async function writeCanonicalBoard(idToken, payload) {
  const url = `${DB_BASE}/dailyBoard/${DATE_STRING}.json?auth=${encodeURIComponent(idToken)}`;
  const body = JSON.stringify({
    ...payload,
    writtenAt: { '.sv': 'timestamp' },
  });
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Firebase write failed: ${r.status} ${txt}`);
  }
  return r.json();
}

async function existsCanonicalBoard() {
  const r = await fetch(`${DB_BASE}/dailyBoard/${DATE_STRING}.json`);
  if (!r.ok) return false;
  const j = await r.json();
  return j !== null;
}

(async () => {
  console.log(`bootstrap dailyBoard/${DATE_STRING} from seed ${RNG_SEED}`);

  if (await existsCanonicalBoard()) {
    console.log('  already written — bailing out (write-once rules would reject anyway)');
    process.exit(0);
  }

  const { board, rows, cols, totalMines, activeGimmicks } = buildBoard();
  console.log(`  built: ${rows}x${cols}, ${totalMines} mines, gimmicks: ${activeGimmicks.join(',') || '(none)'}`);

  const payload = serializeBoard({
    board, rows, cols, totalMines,
    rngSeed: RNG_SEED,
    activeGimmicks,
    codeVersion: 'v1.5.18-bootstrap',
  });
  console.log(`  payload size: ${JSON.stringify(payload).length} bytes`);

  const idToken = await signInAnonymously();
  console.log('  signed in anonymously');

  await writeCanonicalBoard(idToken, payload);
  console.log('  written');

  // Verify by reading back
  const verify = await fetch(`${DB_BASE}/dailyBoard/${DATE_STRING}.json`);
  const verifyJson = await verify.json();
  if (verifyJson?.rngSeed === RNG_SEED && verifyJson?.cells?.length === rows * cols) {
    console.log('  verified ✓');
  } else {
    console.error('  VERIFY FAILED: round-trip mismatch');
    process.exit(1);
  }
})().catch(err => {
  console.error('bootstrap failed:', err.message);
  process.exit(1);
});
