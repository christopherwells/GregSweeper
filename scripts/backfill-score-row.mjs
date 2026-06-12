// Backfill ONE daily leaderboard row that a player's device completed
// but never managed to upload (failed submissions whose retry queue
// aged out). The real time comes off the device via the diagnostics
// modal's "Copy diagnostics as JSON" button (pendingDaily /
// localResiduals entries) — NEVER fabricate a number.
//
// Writes daily/{date}/{pushId} ({name, time, bombHits, uid, timestamp})
// and users/{uid}/dailyHistory/{date} ({time, submittedAt}) so the
// player's history chart picks the day up too.
//
// Service-account auth via the dependency-free JWT pattern (same as
// rename-player-entries.mjs / delete-user-data.mjs) — this repo has no
// package.json by design, so firebase-admin can never be imported.
//
// usage: node backfill-score-row.mjs <date> <uid> <name> <time> [bombHits] [--write]
//        (dry-run by default; pass --write to commit)

import { createSign } from 'node:crypto';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';

const [date, uid, name, timeArg, maybeBombs] = process.argv.slice(2);
const doWrite = process.argv.includes('--write');
const time = parseFloat(timeArg);
const bombHits = /^\d+$/.test(maybeBombs || '') ? parseInt(maybeBombs, 10) : 0;

if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !uid || !name || !(time >= 5 && time <= 3600)) {
  console.error('usage: node backfill-score-row.mjs <YYYY-MM-DD> <uid> <name> <time 5-3600> [bombHits] [--write]');
  process.exit(2);
}
if (name.length > 20 || /[<>&"'`@]/.test(name)) {
  console.error('name violates leaderboard rules (1-20 chars, no <>&"\'`@)');
  process.exit(2);
}

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: serviceAccount.client_email,
    scope: [
      'https://www.googleapis.com/auth/firebase.database',
      'https://www.googleapis.com/auth/userinfo.email',
    ].join(' '),
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
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!resp.ok) throw new Error(`Token mint failed: ${resp.status} ${await resp.text()}`);
  const j = await resp.json();
  if (!j.access_token) throw new Error('No access_token in response');
  return j.access_token;
}

async function dbGet(path, token) {
  const r = await fetch(`${DB_BASE}/${path}.json?access_token=${token}`);
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function dbPost(path, body, token) {
  const r = await fetch(`${DB_BASE}/${path}.json?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function dbPut(path, body, token) {
  const r = await fetch(`${DB_BASE}/${path}.json?access_token=${token}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PUT ${path}: ${r.status} ${await r.text()}`);
}

// REST writes can't use the client SDK's ServerValue sentinel object,
// but the equivalent {".sv": "timestamp"} payload is honored by the
// Realtime Database REST API and satisfies the `=== now` rules.
const SERVER_TS = { '.sv': 'timestamp' };

(async () => {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || 'null');
  if (!sa) { console.error('FIREBASE_SERVICE_ACCOUNT env not set'); process.exit(2); }
  const token = await getAccessToken(sa);

  // Refuse to double-write: if a row for this uid already exists on the
  // date, stop.
  const existing = (await dbGet(`daily/${date}`, token)) || {};
  for (const row of Object.values(existing)) {
    if (row && row.uid === uid) {
      console.error(`daily/${date} already has a row for this uid (${row.name}, ${row.time}s) — refusing to backfill`);
      process.exit(1);
    }
  }

  console.log(`${doWrite ? 'WRITE' : 'dry-run'}: daily/${date} <- { name: ${name}, time: ${time}, bombHits: ${bombHits}, uid: ${uid} }`);
  console.log(`${doWrite ? 'WRITE' : 'dry-run'}: users/${uid}/dailyHistory/${date} <- { time: ${time} }`);
  if (doWrite) {
    await dbPost(`daily/${date}`, { name, time, bombHits, uid, timestamp: SERVER_TS }, token);
    await dbPut(`users/${uid}/dailyHistory/${date}`, { time, submittedAt: SERVER_TS }, token);
    console.log('written');
  }
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
