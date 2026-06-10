// Force-regenerate a daily canonical board. Deletes the existing
// dailyBoard/{date} and dailyMeta/{date} records (service-account auth
// bypasses the write-once rule), then re-runs the SAME generation
// pipeline as the nightly precompute with the current code's rules and
// writes the new canonical + features.
//
// Built for the 2026-06-14 reveal-gating re-certification: the old
// canonical's no-guess certificate relied on a fogged compass clue and
// no gated anchor exists, so it must be replaced BEFORE its date goes
// live. Generation under the gated solver happens automatically — the
// pipeline's boards carry _gatedCert and the acceptance check reads it.
//
// SAFETY RAILS (this tool replaces a board people may have played):
//   - refuses dates that are not strictly in the future (ET), unless
//     --force-past is passed;
//   - refuses if ANY score rows exist under daily/{date} — a played
//     board is history, not a mistake to erase;
//   - --dry-run generates + certifies + prints, writes nothing.
//
// Usage (via GH Actions workflow_dispatch, FIREBASE_SERVICE_ACCOUNT set):
//   node scripts/regenerate-daily-board.mjs YYYY-MM-DD [--dry-run] [--force-past]

import {
  TARGET_TO_GIMMICK, loadExperimentSpec, selectBestCandidate,
  readCodeVersion, buildCanonicalPayload, buildCandidateFeatures,
} from './daily-board-pipeline.mjs';
import { isBoardSolvable } from '../src/logic/boardSolver.js';
import { cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import { createSign } from 'node:crypto';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';

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

// Today's ET date, same anchoring as getLocalDateString in the client.
function todayET() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

(async () => {
  const args = process.argv.slice(2);
  const date = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const dryRun = args.includes('--dry-run');
  const forcePast = args.includes('--force-past');
  if (!date) {
    console.error('usage: node scripts/regenerate-daily-board.mjs YYYY-MM-DD [--dry-run] [--force-past]');
    process.exit(1);
  }

  if (date <= todayET() && !forcePast) {
    console.error(`refusing: ${date} is not strictly in the future (ET today is ${todayET()}). ` +
      'Replacing a live or past board needs --force-past.');
    process.exit(1);
  }

  // A played board is history — never erase it out from under scores.
  const scoresResp = await fetch(`${DB_BASE}/daily/${date}.json?shallow=true`);
  const scores = scoresResp.ok ? await scoresResp.json() : null;
  if (scores && Object.keys(scores).length > 0) {
    console.error(`refusing: daily/${date} already has ${Object.keys(scores).length} score row(s) — this board has been played.`);
    process.exit(1);
  }

  const spec = loadExperimentSpec();
  console.log(`regenerate dailyBoard/${date}${dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`  primary target: ${spec.target} (gimmick: ${TARGET_TO_GIMMICK[spec.target] || '(none)'})`);
  console.log(`  coverage_targets: ${spec.coverage_targets.length} entries`);

  const cand = selectBestCandidate(date, spec);
  const m = cand.mission || {};
  console.log(`  selected: ${cand.rngSeed} [${m.isPrimary ? 'PRIMARY' : 'COVERAGE'} mission: ${m.target}]`);
  console.log(`  board: ${cand.rows}x${cand.cols}, ${cand.totalMines} mines, gimmicks: ${cand.activeGimmicks.join(',') || '(none)'}`);

  // Belt-and-braces certification report: the pipeline's acceptance is
  // already gated (boards carry _gatedCert), but say so explicitly —
  // this tool exists precisely to replace a board that failed gating.
  const fr = Math.floor(cand.rows / 2), fc = Math.floor(cand.cols / 2);
  const gated = isBoardSolvable(cand.board, cand.rows, cand.cols, fr, fc, undefined, { gateGimmickOrigins: true });
  cleanSolverArtifacts(cand.board);
  const ungated = isBoardSolvable(cand.board, cand.rows, cand.cols, fr, fc, undefined, { gateGimmickOrigins: false });
  cleanSolverArtifacts(cand.board);
  const cert = (c) => (c.solvable || c.remainingUnknowns === 0) ? 'CERTIFIED' : `FAILS (${c.remainingUnknowns} unknowns)`;
  console.log(`  gated certification:   ${cert(gated)}`);
  console.log(`  ungated certification: ${cert(ungated)} (old clients re-certify this way)`);
  if (!(gated.solvable || gated.remainingUnknowns === 0)) {
    throw new Error('selected candidate is not gated-certified — refusing to write');
  }

  const payload = buildCanonicalPayload(cand, readCodeVersion());
  console.log(`  payload size: ${JSON.stringify(payload).length} bytes, gatedCert=${payload.gatedCert === true}`);

  if (dryRun) {
    console.log('DRY RUN — nothing written.');
    return;
  }

  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saJson) {
    console.error('FIREBASE_SERVICE_ACCOUNT env not set — cannot bypass write-once rule');
    process.exit(1);
  }
  const accessToken = await getAccessToken(JSON.parse(saJson));

  console.log('  deleting existing dailyBoard + dailyMeta (if any)…');
  await adminDelete(accessToken, `dailyBoard/${date}`);
  await adminDelete(accessToken, `dailyMeta/${date}`);

  console.log('  writing new canonical…');
  await adminWrite(accessToken, `dailyBoard/${date}`, payload);
  console.log('  writing dailyMeta…');
  await adminWrite(accessToken, `dailyMeta/${date}`, { features: buildCandidateFeatures(cand) });
  console.log('Done.');
})().catch(err => {
  console.error('regenerate-daily-board failed:', err.message);
  process.exit(1);
});
