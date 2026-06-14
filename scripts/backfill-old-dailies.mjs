// One-off backfill: give the daily archive boards for the dates that
// predate the canonical-board system (app launch 2026-03-06 through
// 2026-04-26; dailyBoard storage started 2026-04-27). Those boards were
// generated per-device from the date seed and never stored, so the
// originals are unrecoverable. This regenerates a fresh board for each
// missing date with the CURRENT pipeline (same as a normal daily) and
// writes dailyBoard/{date} + cruxes/{date}.
//
// IMPORTANT — does NOT write dailyMeta. Dates 2026-03-09..04-26 already
// have dailyMeta (features for the lost boards) tied to real day-of plays
// in daily/{date}; overwriting it would re-score those plays against a
// board nobody played and corrupt the par model. The archive computes par
// client-side from the loaded board, so it doesn't need dailyMeta, and
// every one of these dates is below ARCHIVE_FIT_EPOCH (2026-05-07) so no
// archive replay of them ever feeds the fit. The regenerated boards are
// fresh no-guess dailies stamped with old dates, NOT recreations of what
// was played (only two people played back then; this is by their call).
//
// Idempotent: write-once rules reject a date that already has a board, so
// re-running skips finished dates and the 04-27+ canonicals are untouched.
//
// Usage: node scripts/backfill-old-dailies.mjs [--dry-run]

import {
  loadExperimentSpec, selectBestCandidate, readCodeVersion,
  buildCanonicalPayload,
} from './daily-board-pipeline.mjs';
import { cruxPayloadFromBoard } from '../src/logic/cruxExtract.js';

const FIREBASE_API_KEY = 'AIzaSyBhiFPIUA0u021Yh7eA35N2nQOIUPVPtpo';
const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';

const START = '2026-03-06'; // app launch (v0.1)
const END = '2026-04-26';   // last date before canonical storage began (04-27)

async function signInAnonymously() {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`;
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  if (!r.ok) throw new Error(`anonymous sign-in failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  if (!j.idToken) throw new Error('anonymous sign-in: no idToken');
  return j.idToken;
}

async function boardExists(date) {
  const r = await fetch(`${DB_BASE}/dailyBoard/${date}.json?shallow=true`);
  return r.ok && (await r.json()) !== null;
}

async function writeOnce(path, idToken, payload) {
  const url = `${DB_BASE}/${path}.json?auth=${encodeURIComponent(idToken)}`;
  const body = JSON.stringify({ ...payload, writtenAt: { '.sv': 'timestamp' } });
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) return 'exists';
    throw new Error(`write ${path} failed: ${r.status} ${await r.text()}`);
  }
  return 'written';
}

function dateRange(start, end) {
  const dates = [];
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const cur = new Date(Date.UTC(sy, sm - 1, sd, 12));
  const last = Date.UTC(ey, em - 1, ed, 12);
  while (cur.getTime() <= last) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

(async () => {
  const dryRun = process.argv.includes('--dry-run');
  const spec = loadExperimentSpec();
  const dates = dateRange(START, END);
  console.log(`backfill old dailies ${START}..${END} (${dates.length} dates)${dryRun ? ' [DRY RUN]' : ''}`);

  const idToken = dryRun ? null : await signInAnonymously();
  const tally = { boards: 0, cruxes: 0, breathers: 0, skipped: 0 };

  for (const date of dates) {
    if (await boardExists(date)) { tally.skipped++; console.log(`  ${date}: board already present — skip`); continue; }
    const cand = selectBestCandidate(date, spec);
    const payload = buildCanonicalPayload(cand, readCodeVersion());
    const crux = cruxPayloadFromBoard(cand.board, cand.rows, cand.cols);
    const gimmicks = cand.activeGimmicks.join(',') || 'none';
    if (dryRun) {
      console.log(`  ${date}: ${cand.rows}x${cand.cols} ${cand.totalMines}m [${gimmicks}] · crux ${crux ? `tier ${crux.tier} ${crux.rows}x${crux.cols}` : 'none'}`);
      tally.boards++; if (crux) tally.cruxes++; else tally.breathers++;
      continue;
    }
    const br = await writeOnce(`dailyBoard/${date}`, idToken, payload);
    if (br === 'written') tally.boards++;
    let cr = 'none';
    if (crux) { cr = await writeOnce(`cruxes/${date}`, idToken, crux); if (cr === 'written') tally.cruxes++; }
    else tally.breathers++;
    console.log(`  ${date}: board ${br}, crux ${crux ? cr : 'breather'} [${gimmicks}]`);
  }

  console.log(`\ndone: ${tally.boards} boards, ${tally.cruxes} cruxes, ${tally.breathers} breathers, ${tally.skipped} skipped`);
})().catch(err => { console.error('backfill-old-dailies failed:', err.message); process.exit(1); });
