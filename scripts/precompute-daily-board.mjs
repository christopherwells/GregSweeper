// Pre-generate the canonical daily board for a given date and write it
// to Firebase. Run by the precompute-daily-board.yml GitHub Actions
// workflow at 00:00 UTC (~5h before midnight ET) so every visitor for
// that ET date fetches the same board.
//
// The seed-to-board pipeline lives in scripts/daily-board-pipeline.mjs,
// SHARED with regenerate-daily-board.mjs — and it must mirror
// gameActions.js's daily branch EXACTLY (see the warning there).
//
// Usage:
//   node scripts/precompute-daily-board.mjs YYYY-MM-DD
//
// Idempotent: write-once Firebase rules silently reject duplicate
// writes, so re-running for the same date is a no-op (returns 0).

import {
  TARGET_TO_GIMMICK, loadExperimentSpec, selectBestCandidate,
  readCodeVersion, buildCanonicalPayload, buildCandidateFeatures,
} from './daily-board-pipeline.mjs';

const FIREBASE_API_KEY = 'AIzaSyBhiFPIUA0u021Yh7eA35N2nQOIUPVPtpo';
const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';

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

// Write the board's feature vector to dailyMeta at GENERATION time, so
// the generator's solver counts are canonical before any client can
// upsert its own. This closes the cross-version determinism gap that
// reveal gating opened: an old-code client solving a gated board
// computes ungated (slightly different) move counts, and without this
// write it could land them in dailyMeta first. Write-once rules make a
// duplicate write fail with 401/403 — treated as "already written".
async function writeDailyMeta(date, idToken, features) {
  const url = `${DB_BASE}/dailyMeta/${date}.json?auth=${encodeURIComponent(idToken)}`;
  const body = JSON.stringify({ features, writtenAt: { '.sv': 'timestamp' } });
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) {
      console.log('  dailyMeta already written — skipped');
      return;
    }
    const txt = await r.text();
    throw new Error(`dailyMeta write failed: ${r.status} ${txt}`);
  }
  console.log('  dailyMeta written');
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

  const spec = loadExperimentSpec();
  console.log(`  primary target: ${spec.target} (gimmick: ${TARGET_TO_GIMMICK[spec.target] || '(none)'})`);
  console.log(`  coverage_targets: ${spec.coverage_targets.length} entries`);

  const cand = selectBestCandidate(date, spec);
  const m = cand.mission || {};
  console.log(`  selected: ${cand.rngSeed} [${m.isPrimary ? 'PRIMARY' : 'COVERAGE'} mission: ${m.target}, weight ${m.deficitWeight}]`);
  console.log(`  board: ${cand.rows}x${cand.cols}, ${cand.totalMines} mines, gimmicks: ${cand.activeGimmicks.join(',') || '(none)'}`);

  const payload = buildCanonicalPayload(cand, readCodeVersion());
  console.log(`  payload size: ${JSON.stringify(payload).length} bytes`);

  const idToken = await signInAnonymously();
  await writeCanonicalBoard(date, idToken, payload);
  console.log('  written');

  await writeDailyMeta(date, idToken, buildCandidateFeatures(cand));
})().catch(err => {
  console.error('precompute failed:', err.message);
  process.exit(1);
});
