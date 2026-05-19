// Surgically clear ONE user's ONE weekly day-attempt marker.
//
// Unlike reset-weekly-scores.mjs (which nukes the whole week's
// leaderboard + every user's caps + par-fit data), this touches
// exactly one leaf:
//   users/{uid}/weeklyAttempts/{weekStart}/dayAttempts/{day}
//
// Nothing else — not the board, not the leaderboard, not other days,
// not other users. Use when a single player got locked out of a
// single day (e.g. an attempt was consumed by a UI bug without a real
// play) and should get that one day back.
//
// Service-account auth required (same FIREBASE_SERVICE_ACCOUNT secret
// as reset-weekly-scores.mjs / send-push.mjs) — per-user
// weeklyAttempts paths are owner-write-only under the security rules.
//
// Triggered via GH Actions workflow_dispatch:
//   gh workflow run reset-user-weekly-day.yml \
//     -f uid=AYXrTjKPieYrZI8sksnYqbI3Pmh1 -f weekStart=2026-05-18 -f day=1

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
  return (await r.json()).access_token;
}

(async () => {
  const uid = process.argv[2];
  const weekStart = process.argv[3];
  const dayRaw = process.argv[4];

  // Strict validation — these compose a DB path, so a stray '/', '.',
  // '#', '$', '[' or ']' could widen the target. Reject anything that
  // isn't a clean Firebase key / ISO date / single digit 0-6.
  if (!uid || !/^[A-Za-z0-9_-]{8,128}$/.test(uid)) {
    console.error(`usage: node scripts/reset-user-weekly-day.mjs <uid> <YYYY-MM-DD> <day 0-6>`);
    console.error(`  bad uid: ${JSON.stringify(uid)}`);
    process.exit(1);
  }
  if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    console.error(`  bad weekStart (need YYYY-MM-DD): ${JSON.stringify(weekStart)}`);
    process.exit(1);
  }
  if (!/^[0-6]$/.test(String(dayRaw))) {
    console.error(`  bad day (need integer 0-6, Mon=0..Sun=6): ${JSON.stringify(dayRaw)}`);
    process.exit(1);
  }
  const day = Number(dayRaw);

  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saJson) {
    console.error('FIREBASE_SERVICE_ACCOUNT env not set — cannot clear owner-write path');
    process.exit(1);
  }
  const sa = JSON.parse(saJson);
  const accessToken = await getAccessToken(sa);
  const at = encodeURIComponent(accessToken);

  const path = `users/${uid}/weeklyAttempts/${weekStart}/dayAttempts/${day}`;
  console.log(`Target: ${path}`);

  // Snapshot the before-state for an auditable log line.
  const beforeResp = await fetch(`${DB_BASE}/${path}.json?access_token=${at}`);
  const before = beforeResp.ok ? await beforeResp.json() : '(read failed)';
  console.log(`  before: ${JSON.stringify(before)}`);

  const delResp = await fetch(`${DB_BASE}/${path}.json?access_token=${at}`, { method: 'DELETE' });
  if (!delResp.ok && delResp.status !== 404) {
    throw new Error(`delete failed: ${delResp.status} ${await delResp.text()}`);
  }

  // Read back — the path MUST be null now or the reset didn't take.
  const afterResp = await fetch(`${DB_BASE}/${path}.json?access_token=${at}`);
  const after = afterResp.ok ? await afterResp.json() : '(read failed)';
  if (after !== null) {
    throw new Error(`verification failed — path still present after delete: ${JSON.stringify(after)}`);
  }

  console.log(`  after:  null  → VERIFIED cleared`);
  console.log(`Done. ${uid} can replay weekly day ${day} of week ${weekStart}.`);
})().catch(err => {
  console.error('reset-user-weekly-day failed:', err.message);
  process.exit(1);
});
