// One-off PATCH for a single weekly leaderboard row. Adds the
// dayBombHits and totalMoves fields to a row written under the old
// schema (pre-v1.5.45) so the leaderboard's strikes/pace columns
// don't render '-' for it.
//
// Service-account auth is required because writes to weekly/$weekStart/$uid
// are gated on `auth.uid === $uid` and we're not signed in as that uid.
//
// Usage (workflow_dispatch):
//   weekStart, uid, dayBombHits (JSON map), totalMoves

import { createSign } from 'node:crypto';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  };
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(claims)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(serviceAccount.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${unsigned}.${signature}`,
  });
  if (!r.ok) throw new Error(`token mint failed: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

(async () => {
  const weekStart = process.argv[2];
  const uid = process.argv[3];
  const dayBombHitsJson = process.argv[4];
  const totalMoves = Number(process.argv[5]);

  if (!weekStart || !uid || !dayBombHitsJson || !Number.isFinite(totalMoves)) {
    console.error('usage: node backfill-weekly-row.mjs WEEKSTART UID \'{"3":0}\' TOTALMOVES');
    process.exit(1);
  }
  const dayBombHits = JSON.parse(dayBombHitsJson);

  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const accessToken = await getAccessToken(sa);

  // PATCH (not PUT) so we don't blow away bestTime / dayTimes / name /
  // timestamp. PATCH semantics in Firebase REST: only the fields in
  // the body get replaced; everything else stays untouched.
  const body = JSON.stringify({ dayBombHits, totalMoves });
  const url = `${DB_BASE}/weekly/${weekStart}/${uid}.json?access_token=${encodeURIComponent(accessToken)}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!r.ok) {
    console.error(`patch failed: ${r.status} ${await r.text()}`);
    process.exit(1);
  }
  console.log(`Patched weekly/${weekStart}/${uid}: dayBombHits=${dayBombHitsJson}, totalMoves=${totalMoves}`);
})().catch(err => { console.error(err.message); process.exit(1); });
