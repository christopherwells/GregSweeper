// Right-to-erasure script: deletes all of a single user's data from Firebase.
//
// Usage:
//   FIREBASE_SERVICE_ACCOUNT='{...}' node scripts/delete-user-data.mjs <uid> [--dry-run] [--days N]
//
//   <uid>       Anonymous Firebase uid (find in Settings or diagnostics modal)
//   --dry-run   List what would be deleted, but don't actually delete
//   --days N    How many days of daily/* history to scan (default 400)
//
// What it removes:
//   • users/{uid}/*             — cloud progress, streak, push token, prefs
//   • errors/{uid}/*            — per-user error log
//   • daily/{date}/{pushId}     — every entry whose `uid` field matches
//   • weekly/{weekStart}/{uid}  — best-time row for every week scanned
//
// What it leaves alone:
//   • dailyMeta/*, dailyBoard/*, weeklyBoard/* — these are board features
//     and the immutable board itself, neither tied to any user.
//
// Run via FIREBASE_SERVICE_ACCOUNT (same secret as send-push.mjs). The
// service account must have Database write access.
//
// Use after a right-to-erasure request:
//   1. User emails their uid (shown in Settings or ?debug=1).
//   2. Run with --dry-run to confirm scope.
//   3. Re-run without --dry-run to commit deletion.
//   4. Reply to the user that their data has been scrubbed.

import { createSign } from 'node:crypto';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';

// ── arg parsing ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
let uid = null;
let dryRun = false;
let daysToScan = 400;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--dry-run') dryRun = true;
  else if (a === '--days' && args[i + 1]) { daysToScan = parseInt(args[++i], 10) || 400; }
  else if (!uid) uid = a;
}
if (!uid) {
  console.error('Usage: node scripts/delete-user-data.mjs <uid> [--dry-run] [--days N]');
  process.exit(1);
}

// ── service-account auth (mirrors send-push.mjs) ─────────────────────
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

// ── HTTP helpers ─────────────────────────────────────────────────────
async function dbGet(path, token) {
  const r = await fetch(`${DB_BASE}/${path}.json?access_token=${token}`);
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function dbDelete(path, token) {
  const r = await fetch(`${DB_BASE}/${path}.json?access_token=${token}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`DELETE ${path}: ${r.status} ${await r.text()}`);
}

function _etDateBack(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 24 * 3600 * 1000);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = fmt.formatToParts(d);
  const get = (t) => parts.find(p => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function _mondayBack(daysAgo) {
  // Return ET-anchored Monday of the week N days ago.
  const d = new Date(Date.now() - daysAgo * 24 * 3600 * 1000);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  });
  const parts = fmt.formatToParts(d);
  const get = (t) => parts.find(p => p.type === t)?.value;
  const wd = get('weekday');
  const dowMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const offset = dowMap[wd] ?? 0;
  return _etDateBack(daysAgo + offset);
}

// ── main ─────────────────────────────────────────────────────────────
async function main() {
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saJson) {
    console.error('FIREBASE_SERVICE_ACCOUNT env var is required.');
    process.exit(1);
  }
  let sa;
  try { sa = JSON.parse(saJson); } catch (e) {
    console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON:', e.message);
    process.exit(1);
  }

  console.log(`Target uid: ${uid}`);
  console.log(`Mode: ${dryRun ? 'DRY-RUN (no deletions)' : 'COMMIT'}`);
  console.log(`Scanning ${daysToScan} days of daily/* history\n`);

  const token = await getAccessToken(sa);

  // 1. users/{uid}/*
  const userData = await dbGet(`users/${uid}`, token);
  if (userData) {
    console.log(`✓ users/${uid} exists (${Object.keys(userData).length} top-level keys)`);
    if (!dryRun) {
      await dbDelete(`users/${uid}`, token);
      console.log(`  deleted users/${uid}`);
    }
  } else {
    console.log(`  users/${uid}: not present`);
  }

  // 2. errors/{uid}/*
  const errorData = await dbGet(`errors/${uid}`, token);
  if (errorData) {
    console.log(`✓ errors/${uid} exists (${Object.keys(errorData).length} entries)`);
    if (!dryRun) {
      await dbDelete(`errors/${uid}`, token);
      console.log(`  deleted errors/${uid}`);
    }
  } else {
    console.log(`  errors/${uid}: not present`);
  }

  // 3. daily/{date}/{pushId} where uid === target
  let dailyRowCount = 0;
  for (let d = 0; d < daysToScan; d++) {
    const date = _etDateBack(d);
    // Suffix variants: plain, _bonus, _weekly_first
    for (const suffix of ['', '_bonus', '_weekly_first']) {
      const path = `daily/${date}${suffix}`;
      const entries = await dbGet(path, token);
      if (!entries) continue;
      for (const [pushId, row] of Object.entries(entries)) {
        if (row && row.uid === uid) {
          dailyRowCount++;
          console.log(`✓ ${path}/${pushId} (time=${row.time}s, name=${row.name || 'Anonymous'})`);
          if (!dryRun) {
            await dbDelete(`${path}/${pushId}`, token);
          }
        }
      }
    }
  }
  console.log(`  daily rows matched: ${dailyRowCount}`);

  // 4. weekly/{weekStart}/{uid}
  let weeklyRowCount = 0;
  const seenWeeks = new Set();
  for (let d = 0; d < daysToScan; d += 7) {
    const weekStart = _mondayBack(d);
    if (seenWeeks.has(weekStart)) continue;
    seenWeeks.add(weekStart);
    const row = await dbGet(`weekly/${weekStart}/${uid}`, token);
    if (row) {
      weeklyRowCount++;
      console.log(`✓ weekly/${weekStart}/${uid} (bestTime=${row.bestTime}s)`);
      if (!dryRun) {
        await dbDelete(`weekly/${weekStart}/${uid}`, token);
      }
    }
  }
  console.log(`  weekly rows matched: ${weeklyRowCount}`);

  console.log('');
  console.log(`Total: 1 user record + 1 error record + ${dailyRowCount} daily rows + ${weeklyRowCount} weekly rows`);
  if (dryRun) {
    console.log('DRY-RUN complete. Re-run without --dry-run to commit.');
  } else {
    console.log('Deletion complete.');
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
