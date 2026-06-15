// One-off backfill: materialize a crux teaser for every existing
// canonical daily board (cruxes/{date}) so the ?crux= share route starts
// with a populated archive. Going forward the nightly precompute writes
// each day's crux at generation time; this catches up the past.
//
// Reads dailyBoard/{date}, deserializes, runs the SAME cruxExtract the
// win receipt and precompute use, and writes cruxes/{date}. Restricted to
// strictly-past ET dates (the teaser only ever shows yesterday-or-earlier;
// the route gates same-day spoilers, and the nightly job owns today+).
//
// Idempotent: write-once rules reject a date that already has a crux. A
// breather board (no tier>=1 step) or a crux too entangled to crop simply
// gets no teaser.
//
// Usage:
//   node scripts/backfill-cruxes.mjs [--dry-run] [YYYY-MM-DD]
//     --dry-run   report yield, write nothing
//     YYYY-MM-DD  backfill just this one date (else all past canonicals)

import { deserializeBoard } from '../src/firebase/dailyBoardSync.js';
import { cruxPayloadFromBoard } from '../src/logic/cruxExtract.js';

const FIREBASE_API_KEY = 'AIzaSyBhiFPIUA0u021Yh7eA35N2nQOIUPVPtpo';
const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';

async function signInAnonymously() {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  if (!r.ok) throw new Error(`anonymous sign-in failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  if (!j.idToken) throw new Error('anonymous sign-in: no idToken');
  return j.idToken;
}

function todayET() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

async function listBoardDates() {
  const r = await fetch(`${DB_BASE}/dailyBoard.json?shallow=true`);
  if (!r.ok) throw new Error(`list dailyBoard failed: ${r.status}`);
  const j = await r.json();
  return j ? Object.keys(j) : [];
}

async function fetchBoard(date) {
  const r = await fetch(`${DB_BASE}/dailyBoard/${date}.json`);
  if (!r.ok) return null;
  return r.json();
}

async function cruxExists(date) {
  const r = await fetch(`${DB_BASE}/cruxes/${date}.json?shallow=true`);
  if (!r.ok) return false;
  return (await r.json()) !== null;
}

async function writeCrux(date, idToken, payload) {
  const url = `${DB_BASE}/cruxes/${date}.json?auth=${encodeURIComponent(idToken)}`;
  const body = JSON.stringify({ ...payload, writtenAt: { '.sv': 'timestamp' } });
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) return 'exists';
    throw new Error(`crux write failed: ${r.status} ${await r.text()}`);
  }
  return 'written';
}

(async () => {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const oneDate = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const today = todayET();

  let dates = oneDate ? [oneDate] : await listBoardDates();
  // Daily-format, strictly past (the teaser never shows today or future).
  dates = dates
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < today)
    .sort();

  console.log(`backfill cruxes${dryRun ? ' (DRY RUN)' : ''}: ${dates.length} past canonical date(s)`);

  const idToken = dryRun ? null : await signInAnonymously();
  const tally = { written: 0, skippedExists: 0, noCrux: 0, missingBoard: 0 };
  const tierMix = {};

  for (const date of dates) {
    if (!dryRun && await cruxExists(date)) { tally.skippedExists++; continue; }
    const raw = await fetchBoard(date);
    if (!raw) { tally.missingBoard++; continue; }
    let payload = null;
    try {
      const { board, rows, cols } = deserializeBoard(raw);
      payload = cruxPayloadFromBoard(board, rows, cols);
    } catch (err) {
      console.warn(`  ${date}: deserialize/extract failed — ${err.message}`);
    }
    if (!payload) { tally.noCrux++; console.log(`  ${date}: no teaser (breather or too entangled)`); continue; }
    tierMix[payload.tier] = (tierMix[payload.tier] || 0) + 1;
    if (dryRun) {
      console.log(`  ${date}: tier ${payload.tier}, ${payload.rows}x${payload.cols}, ${JSON.stringify(payload).length}b`);
      tally.written++;
      continue;
    }
    const res = await writeCrux(date, idToken, payload);
    if (res === 'exists') { tally.skippedExists++; }
    else { tally.written++; console.log(`  ${date}: written (tier ${payload.tier}, ${payload.rows}x${payload.cols})`); }
  }

  console.log(`\ndone: ${tally.written} ${dryRun ? 'would write' : 'written'}, ${tally.skippedExists} already present, ${tally.noCrux} no-crux, ${tally.missingBoard} missing-board`);
  console.log(`tier mix: ${JSON.stringify(tierMix)}`);
})().catch(err => {
  console.error('backfill-cruxes failed:', err.message);
  process.exit(1);
});
