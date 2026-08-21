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

import { signCanonicalPayload, requireSigningKey } from '../src/logic/canonicalSignature.js';
import { createDailyRNG } from '../src/logic/seededRandom.js';
import { getWeeklyGimmicks, applyGimmicks } from '../src/logic/gimmicks.js';
import { generateBoard, cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import { isBoardSolvable } from '../src/logic/boardSolver.js';
import { computeDailyFeatures } from '../src/logic/dailyFeatures.js';
import {
  WEEKLY_MIN_SIZE, WEEKLY_SIZE_RANGE, BOARD_WIDTH_CAP,
  DAILY_MIN_DENSITY, DAILY_DENSITY_RANGE,
} from '../src/logic/difficulty.js';
import { serializeBoard } from '../src/firebase/dailyBoardSync.js';
import { selectWeeklyRngSeed } from '../src/logic/selectWeeklyRngSeed.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { signInAnonymously, deleteSelf } from './anon-auth-rest.mjs';
import { clampRectDims } from '../src/logic/boardFit.js';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';
const __dirname = dirname(fileURLToPath(import.meta.url));

function buildOneCandidate(seed) {
  const dRng = createDailyRNG(seed);
  // HIS RULING (2026-08-20): a weekly must not scroll at the default cell
  // size. clampRectDims is the ONE rule, and it replaces the old cols-only
  // cap: a NARROW board is the one that got too tall, because cells grow to
  // fill the width, so 14x8 stood 502px against a 462px budget while 14x12
  // is 362px. Clamping consumes no extra rng() call, so every stored
  // canonical's seed stream is untouched and only an illegal draw moves.
  const { rows, cols } = clampRectDims(
    WEEKLY_MIN_SIZE + Math.floor(dRng() * WEEKLY_SIZE_RANGE),
    WEEKLY_MIN_SIZE + Math.floor(dRng() * WEEKLY_SIZE_RANGE),
  );
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
  // ONE copy of the weekly selection rule: the client's selectWeeklyRngSeed
  // resolves the seed (banded argmax toward the week's target par — see
  // parBand.js), and the winner is rebuilt through the same retry loop the
  // play path runs. The private contest copy that lived here was the weekly
  // half of the mirror-pair drift class the daily side closed when its slot
  // arithmetic drifted; its no-solvable-candidate fallback (the bare
  // weekStart seed) is what selectWeeklyRngSeed returns in that case, so
  // the fallback shape is unchanged.
  const rngSeed = selectWeeklyRngSeed(weekStart);
  const best = buildOneCandidate(rngSeed);
  // HARD GATE: never write an uncertified canonical (buildOneCandidate
  // returns its last attempt even on exhaustion). Failing the workflow
  // is correct — Monday's first client falls back to verified local gen.
  if (!best.check || !(best.check.solvable || best.check.remainingUnknowns === 0)) {
    throw new Error(`No solvable weekly board found for ${weekStart} — refusing to write an uncertified canonical`);
  }
  return { ...best, rngSeed };
}

async function existsCanonicalBoard(weekStart) {
  const r = await fetch(`${DB_BASE}/weeklyBoard/${weekStart}.json`);
  if (!r.ok) return false;
  const j = await r.json();
  return j !== null;
}

async function writeCanonicalBoard(weekStart, idToken, payload) {
  const url = `${DB_BASE}/weeklyBoard/${weekStart}.json?auth=${encodeURIComponent(idToken)}`;
  // Sign the board (#114) — see precompute-daily-board.mjs.
  const body = JSON.stringify({
    ...payload,
    sig: await signCanonicalPayload(payload, requireSigningKey()),
    writtenAt: { '.sv': 'timestamp' },
  });
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Firebase write failed: ${r.status} ${txt}`);
  }
}

// Write the week's feature vector to dailyMeta/{weekStart}_weekly_first
// at GENERATION time (the key first-of-week win submissions join
// against). Same determinism rationale as the daily script: the
// generator's gated solver counts become canonical before any client —
// possibly on older code, solving ungated — can upsert its own.
// Write-once: 401/403 means already written.
async function writeWeeklyMeta(weekStart, idToken, features) {
  const url = `${DB_BASE}/dailyMeta/${weekStart}_weekly_first.json?auth=${encodeURIComponent(idToken)}`;
  const body = JSON.stringify({ features, writtenAt: { '.sv': 'timestamp' } });
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) {
      console.log('  weekly dailyMeta already written — skipped');
      return;
    }
    const txt = await r.text();
    throw new Error(`weekly dailyMeta write failed: ${r.status} ${txt}`);
  }
  console.log('  weekly dailyMeta written');
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
  try {
    await writeCanonicalBoard(weekStart, idToken, payload);
    console.log('  written');

    const features = computeDailyFeatures(
      { board: cand.board, rows: cand.rows, cols: cand.cols, totalMines: cand.totalMines, activeGimmicks: cand.activeGimmicks, rngSeed: cand.rngSeed },
      cand.check,
      // Weekly boards stack 2-4 modifiers, so the contribution features are
      // at their most informative here; same center opener the board
      // certifies from.
      { contributionOpener: { row: Math.floor(cand.rows / 2), col: Math.floor(cand.cols / 2) } },
    );
    await writeWeeklyMeta(weekStart, idToken, features);
  } finally {
    await deleteSelf(idToken);
  }
})().catch(err => {
  console.error('precompute failed:', err.message);
  process.exit(1);
});
