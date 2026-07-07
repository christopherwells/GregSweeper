// One-time purge of orphan anonymous Firebase Auth accounts.
//
// Where the orphans came from: until 2026-07-06, every e2e boot (fresh
// browser context, ~9 per CI run since 2026-06-23) and every nightly/weekly
// precompute script run minted a real anonymous user in production Auth —
// only database WRITES were test-gated, account creation was not. The mint
// gate (firebaseProgress.js) and the scripts' self-delete (anon-auth-rest.mjs)
// stopped the inflow; this tool clears the accumulated backlog so the Auth
// console reflects real players again.
//
// An account is deleted ONLY when ALL of these hold:
//   1. anonymous — no provider credentials, no email/phone attached;
//   2. older than --age-days (default 14) since creation;
//   3. no users/{uid} node — since the lastSeen beacon shipped (2026-06-09),
//      essentially every real session that survives a few seconds writes
//      one, so a node-less account is an e2e/script orphan or a bounce
//      visitor who by construction has zero cloud data to lose;
//   4. uid absent from every leaderboard row path (daily, dailyArchive,
//      timed, weekly) — covers the transient-failure case of a row landing
//      without a users node;
//   5. uid absent from the shipped handicaps.json (belt and suspenders —
//      fit players always fail 3 and 4 anyway).
//
// A deleted bounce visitor who ever returns silently re-mints a fresh
// anonymous uid on boot; their localStorage stats are untouched.
//
// DRY RUN IS THE DEFAULT. The full candidate list is written to
// purge-anon-orphans-candidates.json for review (the workflow uploads it as
// an artifact); deletion requires an explicit --delete flag, and the
// users/{uid} snapshot is re-fetched immediately before deleting to close
// the review-gap race.
//
// Usage (via purge-anon-orphans.yml workflow_dispatch, FIREBASE_SERVICE_ACCOUNT set):
//   node scripts/purge-anon-orphans.mjs [--delete] [--age-days N]

import { createSign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';
const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_AGE_DAYS = 14;
const BATCH_DELETE_CHUNK = 500;

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: serviceAccount.client_email,
    // identitytoolkit for the Auth admin endpoints (batchGet/batchDelete),
    // firebase.database + userinfo.email for the owner-only users/ read.
    scope: [
      'https://www.googleapis.com/auth/identitytoolkit',
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
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!r.ok) throw new Error(`token mint failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.access_token;
}

async function listAllAuthUsers(projectId, accessToken) {
  const users = [];
  let pageToken = '';
  for (;;) {
    const url = `https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:batchGet`
      + `?maxResults=500${pageToken ? `&nextPageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) throw new Error(`accounts:batchGet failed: ${r.status} ${await r.text()}`);
    const j = await r.json();
    users.push(...(j.users || []));
    if (!j.nextPageToken) return users;
    pageToken = j.nextPageToken;
  }
}

// uids owning a users/{uid} node. Owner-only read, so this is the one
// database fetch that needs the admin token.
async function fetchUsersNodeUids(accessToken) {
  const r = await fetch(`${DB_BASE}/users.json?shallow=true&access_token=${encodeURIComponent(accessToken)}`);
  if (!r.ok) throw new Error(`users shallow read failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return new Set(j ? Object.keys(j) : []);
}

// Every uid carried by any leaderboard row. All four paths are
// world-readable; the whole trees are small enough to pull wholesale
// (the nightly refit already downloads daily + dailyArchive this way).
async function fetchRowUids() {
  const uids = new Set();
  for (const path of ['daily', 'dailyArchive', 'timed']) {
    const r = await fetch(`${DB_BASE}/${path}.json`);
    if (!r.ok) throw new Error(`${path} read failed: ${r.status}`);
    const tree = (await r.json()) || {};
    // daily/dailyArchive: {date: {pushId: row}}; timed: {pushId: row}.
    for (const bucket of Object.values(tree)) {
      if (!bucket || typeof bucket !== 'object') continue;
      if (typeof bucket.uid === 'string') { uids.add(bucket.uid); continue; }
      for (const row of Object.values(bucket)) {
        if (row && typeof row.uid === 'string') uids.add(row.uid);
      }
    }
  }
  // weekly/{weekStart}/{uid} is KEYED by uid.
  const r = await fetch(`${DB_BASE}/weekly.json`);
  if (!r.ok) throw new Error(`weekly read failed: ${r.status}`);
  const weekly = (await r.json()) || {};
  for (const week of Object.values(weekly)) {
    if (!week || typeof week !== 'object') continue;
    for (const uid of Object.keys(week)) uids.add(uid);
  }
  return uids;
}

function loadHandicapUids() {
  try {
    const raw = JSON.parse(readFileSync(join(__dirname, '..', 'src', 'logic', 'handicaps.json'), 'utf8'));
    return new Set([
      ...Object.keys(raw.handicaps || {}),
      ...Object.keys(raw.handicapDetails || {}),
    ]);
  } catch {
    return new Set();
  }
}

function isAnonymous(u) {
  const providers = (u.providerUserInfo || []).filter(p => p && p.providerId);
  return providers.length === 0 && !u.email && !u.phoneNumber;
}

function findOrphans(authUsers, { cutoffMs, usersNodeUids, rowUids, handicapUids }) {
  const kept = { notAnonymous: 0, tooYoung: 0, hasUsersNode: 0, hasRows: 0, inHandicaps: 0 };
  const orphans = [];
  for (const u of authUsers) {
    if (!isAnonymous(u)) { kept.notAnonymous++; continue; }
    // Unparseable createdAt → cannot age-verify → never delete. (Every
    // account here was minted by signInAnonymously, which always stamps
    // it, but a deletion tool doesn't get to assume that.)
    const created = Number(u.createdAt);
    if (!Number.isFinite(created) || created >= cutoffMs) { kept.tooYoung++; continue; }
    if (usersNodeUids.has(u.localId)) { kept.hasUsersNode++; continue; }
    if (rowUids.has(u.localId)) { kept.hasRows++; continue; }
    if (handicapUids.has(u.localId)) { kept.inHandicaps++; continue; }
    orphans.push({
      uid: u.localId,
      createdAt: new Date(created).toISOString(),
      lastLoginAt: Number.isFinite(Number(u.lastLoginAt)) && u.lastLoginAt
        ? new Date(Number(u.lastLoginAt)).toISOString() : null,
    });
  }
  return { orphans, kept };
}

async function batchDelete(projectId, accessToken, uids) {
  let deleted = 0;
  const failures = [];
  for (let i = 0; i < uids.length; i += BATCH_DELETE_CHUNK) {
    const chunk = uids.slice(i, i + BATCH_DELETE_CHUNK);
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:batchDelete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      // force: batchDelete only touches DISABLED accounts without it.
      body: JSON.stringify({ localIds: chunk, force: true }),
    });
    if (!r.ok) throw new Error(`accounts:batchDelete failed: ${r.status} ${await r.text()}`);
    const j = await r.json();
    const errs = j.errors || [];
    failures.push(...errs);
    deleted += chunk.length - errs.length;
    console.log(`  deleted ${deleted}/${uids.length}${errs.length ? ` (${errs.length} errors so far)` : ''}`);
  }
  return { deleted, failures };
}

(async () => {
  const args = process.argv.slice(2);
  const doDelete = args.includes('--delete');
  const ageIdx = args.indexOf('--age-days');
  const ageDays = ageIdx >= 0 ? Number(args[ageIdx + 1]) : DEFAULT_AGE_DAYS;
  if (!Number.isFinite(ageDays) || ageDays < 7) {
    throw new Error(`--age-days must be a number >= 7 (got ${args[ageIdx + 1]})`);
  }

  const saRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saRaw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var not set');
  const serviceAccount = JSON.parse(saRaw);
  const projectId = serviceAccount.project_id;

  console.log(`purge-anon-orphans on ${projectId} — ${doDelete ? 'DELETE MODE' : 'dry run'}, age >= ${ageDays}d`);

  const accessToken = await getAccessToken(serviceAccount);
  const [authUsers, rowUids] = await Promise.all([
    listAllAuthUsers(projectId, accessToken),
    fetchRowUids(),
  ]);
  const handicapUids = loadHandicapUids();
  // Fetch the users/ snapshot LAST so the no-node check is as fresh as
  // possible relative to the decision it feeds.
  const usersNodeUids = await fetchUsersNodeUids(accessToken);

  const cutoffMs = Date.now() - ageDays * 86400000;
  const { orphans, kept } = findOrphans(authUsers, { cutoffMs, usersNodeUids, rowUids, handicapUids });

  console.log(`\nAuth accounts total:        ${authUsers.length}`);
  console.log(`kept (not anonymous):       ${kept.notAnonymous}`);
  console.log(`kept (younger than ${ageDays}d):   ${kept.tooYoung}`);
  console.log(`kept (has users/{uid}):     ${kept.hasUsersNode}`);
  console.log(`kept (has leaderboard row): ${kept.hasRows}`);
  console.log(`kept (in handicaps.json):   ${kept.inHandicaps}`);
  console.log(`ORPHAN CANDIDATES:          ${orphans.length}`);

  writeFileSync('purge-anon-orphans-candidates.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    mode: doDelete ? 'delete' : 'dry-run',
    ageDays,
    totals: { authUsers: authUsers.length, orphans: orphans.length, kept },
    orphans,
  }, null, 2));
  console.log('\nfull candidate list written to purge-anon-orphans-candidates.json');

  for (const o of orphans.slice(0, 15)) {
    console.log(`  ${o.uid}  created ${o.createdAt}`);
  }
  if (orphans.length > 15) console.log(`  … and ${orphans.length - 15} more (see the JSON)`);

  if (!doDelete) {
    console.log('\ndry run — nothing deleted. Re-run with --delete after reviewing the list.');
    return;
  }
  if (orphans.length === 0) {
    console.log('\nnothing to delete.');
    return;
  }

  // Close the review-gap race: an orphan candidate that came back and
  // played since the listing above would now own a users/{uid} node.
  const freshNodes = await fetchUsersNodeUids(accessToken);
  const uids = orphans.map(o => o.uid).filter(uid => !freshNodes.has(uid));
  if (uids.length < orphans.length) {
    console.log(`\n${orphans.length - uids.length} candidate(s) gained a users node since listing — skipped`);
  }

  console.log(`\ndeleting ${uids.length} orphan account(s)…`);
  const { deleted, failures } = await batchDelete(projectId, accessToken, uids);
  console.log(`\ndone: ${deleted} deleted, ${failures.length} failed`);
  // batchDelete error indices are relative to their own 500-uid chunk;
  // localId is the unambiguous identifier.
  for (const f of failures.slice(0, 10)) console.log(`  failed ${f.localId || `(chunk index ${f.index})`}: ${f.message}`);
  if (failures.length > 0) process.exit(1);
})().catch(err => {
  console.error('purge-anon-orphans failed:', err.message);
  process.exit(1);
});
