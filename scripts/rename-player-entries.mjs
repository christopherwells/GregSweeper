// Rename a player's display name across all their EXISTING leaderboard
// rows. Score rows are write-once at the rules layer, so renames go
// through the service account (same auth pattern as delete-user-data).
//
// Usage:
//   FIREBASE_SERVICE_ACCOUNT='{...}' node scripts/rename-player-entries.mjs <uid> <newName> [--apply]
//
// Scans:
//   • daily/{date}/{pushId}.name   — every entry whose uid matches
//   • timed/{pushId}.name          — quick-play rows (same uid match)
//   • weekly/{weekStart}/{uid}.name
//   • users/*/friends/{uid}.name   — how the player appears in OTHERS'
//     friend lists (display fallback; live leaderboard names win when
//     present, but keep the stored copies consistent too)
//
// Does NOT touch the player's device — FUTURE submissions use the name
// set in their Settings; this script only rewrites history.
//
// DEFAULTS TO DRY RUN. Pass --apply to write.

import { createSign } from 'node:crypto';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';
const MAX_NAME_LEN = 20; // mirrors the rules' name validation

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const positional = args.filter(a => !a.startsWith('--'));
const [uid, newNameRaw] = positional;
if (!uid || !newNameRaw) {
  console.error('Usage: node scripts/rename-player-entries.mjs <uid> <newName> [--apply]');
  process.exit(1);
}
const newName = newNameRaw.slice(0, MAX_NAME_LEN);
if (newName !== newNameRaw) {
  console.error(`Name truncated to ${MAX_NAME_LEN} chars: "${newName}"`);
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

async function dbPatch(updates, token) {
  const r = await fetch(`${DB_BASE}/.json?access_token=${token}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!r.ok) throw new Error(`PATCH root: ${r.status} ${await r.text()}`);
}

(async () => {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || 'null');
  if (!sa) { console.error('FIREBASE_SERVICE_ACCOUNT env var required'); process.exit(1); }
  const token = await getAccessToken(sa);

  console.log(`${apply ? 'APPLY' : '[DRY RUN]'} rename uid=${uid} -> "${newName}"`);
  const updates = {};

  const daily = (await dbGet('daily', token)) || {};
  for (const date of Object.keys(daily)) {
    for (const pushId of Object.keys(daily[date] || {})) {
      const row = daily[date][pushId];
      if (row && row.uid === uid && row.name !== newName) {
        console.log(`  daily/${date}/${pushId}: "${row.name}" -> "${newName}"`);
        updates[`daily/${date}/${pushId}/name`] = newName;
      }
    }
  }

  const weekly = (await dbGet('weekly', token)) || {};
  for (const weekStart of Object.keys(weekly)) {
    const row = (weekly[weekStart] || {})[uid];
    if (row && row.name !== newName) {
      console.log(`  weekly/${weekStart}/${uid}: "${row.name}" -> "${newName}"`);
      updates[`weekly/${weekStart}/${uid}/name`] = newName;
    }
  }

  const timed = (await dbGet('timed', token)) || {};
  for (const pushId of Object.keys(timed)) {
    const row = timed[pushId];
    if (row && row.uid === uid && row.name !== newName) {
      console.log(`  timed/${pushId}: "${row.name}" -> "${newName}"`);
      updates[`timed/${pushId}/name`] = newName;
    }
  }

  const users = (await dbGet('users', token)) || {};
  for (const ownerUid of Object.keys(users)) {
    const entry = users[ownerUid]?.friends?.[uid];
    if (entry && entry.name !== newName) {
      console.log(`  users/${ownerUid}/friends/${uid}: "${entry.name}" -> "${newName}"`);
      updates[`users/${ownerUid}/friends/${uid}/name`] = newName;
    }
  }

  const n = Object.keys(updates).length;
  if (n === 0) { console.log('Nothing to rename.'); return; }
  if (apply) {
    await dbPatch(updates, token);
    console.log(`Renamed ${n} field(s).`);
  } else {
    console.log(`[DRY RUN] would rename ${n} field(s). Pass --apply to write.`);
  }
})().catch(err => { console.error('FAILED:', err); process.exit(1); });
