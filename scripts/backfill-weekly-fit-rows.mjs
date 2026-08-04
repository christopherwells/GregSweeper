// Recover the weekly completions the par model never saw.
//
// The weekly has ALWAYS been meant to feed the fit: a player's FIRST attempt
// of the week is an honest first encounter with no memorisation advantage,
// which is exactly the observation a daily supplies, and days 2-7 are
// excluded for the opposite reason (they are speedruns of a known board).
// winLossHandler has carried the submission since the weekly shipped, behind
// `WEEKLY_FIT_DATA_ENABLED`, which was set false as a deliberate hold while
// the mode's rules were still moving. The flag outlived its reason and was
// never flipped, so fourteen weeks of real completions went unrecorded.
//
// This recovers them. Everything needed is already stored:
//
//   - WHO and WHEN: `weekly/{weekStart}/{uid}` carries `dayTimes` and
//     `dayBombHits` as day-indexed arrays (0 = Monday, null for an unplayed
//     day), so a player's first attempt is the earliest non-null index. That
//     is the exact row the live path would have written.
//   - WHAT BOARD: `weeklyBoard/{weekStart}` is the canonical, so features and
//     par are recomputed from the real board rather than guessed.
//
// WHAT IS NOT RECOVERABLE, stated rather than faked:
//
//   - `bombHitEvents`. The per-hit penalty and info-value were never stored
//     per attempt, only the COUNT. The refit already has an honest path for
//     this — rows without events are priced at LEGACY_BOMB_RATE per hit, the
//     same treatment every pre-instrument daily row gets — so these rows join
//     that class instead of carrying invented events. Fabricating events to
//     look complete would be worse than the gap.
//   - `wormEvents`. Same: the fit falls back to the SCHEDULED wormLoad, which
//     is what it does for any row from a client that predates the instrument.
//
// Rows are marked `backfilled: true` so the R side can always tell them from
// live submissions, and so this can be re-run idempotently.
//
//   node scripts/backfill-weekly-fit-rows.mjs --dry-run
//   FIREBASE_SERVICE_ACCOUNT=<json> node scripts/backfill-weekly-fit-rows.mjs

import { deserializeBoard } from '../src/firebase/dailyBoardSync.js';
import { isBoardSolvable } from '../src/logic/boardSolver.js';
import { cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import { computeDailyFeatures, predictPar } from '../src/logic/dailyFeatures.js';
import { createSign } from 'node:crypto';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  const jwt = `${unsigned}.${signer.sign(sa.private_key, 'base64url')}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!r.ok) throw new Error(`token mint failed: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

const getJson = async (path) => {
  const r = await fetch(`${DB_BASE}/${path}`);
  return r.ok ? r.json() : null;
};

async function adminPut(token, path, body) {
  const r = await fetch(`${DB_BASE}/${path}?access_token=${encodeURIComponent(token)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`write ${path} failed: ${r.status} ${await r.text()}`);
}

/**
 * The earliest day a player actually played that week, and what it cost them.
 * dayTimes/dayBombHits arrive as day-indexed arrays with holes (Firebase
 * turns a sparse array into an object, so both shapes are handled).
 */
function firstAttempt(rec) {
  const times = rec.dayTimes || {};
  const bombs = rec.dayBombHits || {};
  const days = Object.keys(times)
    .filter((k) => times[k] !== null && times[k] !== undefined && Number.isFinite(Number(times[k])))
    .map(Number)
    .sort((a, b) => a - b);
  if (!days.length) return null;
  const day = days[0];
  return { day, time: Number(times[day]), bombHits: Number(bombs[day] ?? bombs[String(day)] ?? 0) || 0 };
}

(async () => {
  const weeks = Object.keys((await getJson('weekly.json?shallow=true')) || {}).sort();
  console.log(`${weeks.length} weeks with leaderboard rows${DRY ? ' (DRY RUN)' : ''}\n`);

  const plan = [];
  for (const weekStart of weeks) {
    const key = `${weekStart}_weekly_first`;
    const [players, rawBoard, existingScores, existingMeta] = await Promise.all([
      getJson(`weekly/${weekStart}.json`),
      getJson(`weeklyBoard/${weekStart}.json`),
      getJson(`daily/${key}.json?shallow=true`),
      getJson(`dailyMeta/${key}.json`),
    ]);
    if (!players) continue;
    if (!rawBoard) {
      console.log(`  ${weekStart}: SKIP — no stored canonical, so features cannot be recomputed`);
      continue;
    }

    // Features + par from the REAL board, certified from its own opener.
    const d = deserializeBoard(rawBoard);
    const fr = Math.floor(d.firstClick / d.cols);
    const fc = d.firstClick % d.cols;
    const check = isBoardSolvable(d.board, d.rows, d.cols, fr, fc);
    cleanSolverArtifacts(d.board);
    const features = computeDailyFeatures({
      board: d.board, rows: d.rows, cols: d.cols, totalMines: d.totalMines,
      activeGimmicks: d.activeGimmicks, rngSeed: rawBoard.rngSeed,
    }, check, { contributionOpener: { row: fr, col: fc } });
    const par = predictPar(features);

    const already = new Set(Object.keys(existingScores || {}));
    for (const [uid, rec] of Object.entries(players)) {
      const first = firstAttempt(rec);
      if (!first) continue;
      // Idempotent: one row per (uid, week), keyed so a re-run overwrites
      // rather than duplicating.
      const rowKey = `backfill_${uid}`;
      plan.push({
        weekStart, key, rowKey, uid, name: rec.name || 'Anonymous',
        time: first.time, bombHits: first.bombHits, day: first.day,
        par, features, rngSeed: rawBoard.rngSeed, totalMines: d.totalMines,
        metaMissing: !existingMeta, existed: already.has(rowKey),
      });
    }
    console.log(`  ${weekStart}: ${Object.keys(players).length} players`
      + `, par ${par.toFixed(1)}s, ${d.rows}x${d.cols}/${d.totalMines}m`
      + `${existingMeta ? '' : ', meta MISSING (will write)'}`);
  }

  console.log(`\n${plan.length} first-attempt rows to write`
    + ` (${plan.filter((p) => p.existed).length} already present, will be overwritten identically).`);
  const cheats = plan.filter((p) => p.bombHits / p.totalMines > 0.3);
  if (cheats.length) {
    console.log(`  note: ${cheats.length} row(s) exceed the 30% bomb-hit probe threshold`
      + ' and the refit will filter them out on its own — written anyway, since the'
      + ' filter belongs to the fit rather than to the record.');
  }

  if (DRY) {
    for (const p of plan.slice(0, 8)) {
      console.log(`   ${p.weekStart} ${p.name.padEnd(16)} day ${p.day} ${String(p.time).padStart(6)}s`
        + ` ${p.bombHits} bomb(s), par ${p.par.toFixed(1)}s`);
    }
    console.log('DRY RUN — nothing written.');
    return;
  }

  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saJson) {
    console.error('FIREBASE_SERVICE_ACCOUNT not set — cannot write');
    process.exit(1);
  }
  const token = await getAccessToken(JSON.parse(saJson));

  const metaWritten = new Set();
  for (const p of plan) {
    if (p.metaMissing && !metaWritten.has(p.key)) {
      await adminPut(token, `dailyMeta/${p.key}.json`, {
        features: p.features, writtenAt: { '.sv': 'timestamp' },
      });
      metaWritten.add(p.key);
    }
    await adminPut(token, `daily/${p.key}/${p.rowKey}.json`, {
      name: p.name,
      time: p.time,
      bombHits: p.bombHits,
      par: Number(p.par.toFixed(1)),
      uid: p.uid,
      rngSeed: p.rngSeed,
      // No bombHitEvents and no wormEvents: never recorded per attempt. The
      // refit's legacy paths price both, and inventing them would be worse
      // than the gap.
      backfilled: true,
      timestamp: { '.sv': 'timestamp' },
    });
  }
  console.log(`\nWrote ${plan.length} rows and ${metaWritten.size} meta record(s).`);
})().catch((err) => {
  console.error('backfill failed:', err.message);
  process.exit(1);
});
