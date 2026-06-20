// Generic leaderboard cleanup: purge every row + subtree belonging to a
// STRAY uid. The recurring failure mode this fixes (seen 2026-05-30 and
// 2026-06-20): a player plays the daily on a device/session that is NOT
// signed in to their linked account, so the score lands under a fresh
// anonymous uid in parallel to their canonical row. The per-uid "already
// played" gates don't catch it because it's a different uid, so the
// player ends up with two rows on the same daily.
//
// This deletes, for TARGET_UID: all daily/{date}/{pushId} rows it owns,
// all weekly/{weekStart}/{uid} rows, and (optionally) its users/{uid}
// subtree (streak / dailyHistory / weeklyAttempts / pushSubscription —
// purging the subtree also stops a duplicate daily push notification
// firing to the abandoned device). KEEP_UID is the canonical account
// that MUST be preserved; the script refuses if TARGET_UID === KEEP_UID
// and reports KEEP_UID's surviving rows so the real account is verified
// intact.
//
// DEFAULTS TO DRY RUN. Mirrors scripts/delete-dup-plays-2026-05-30.mjs:
// raw REST against the RTDB, admin token minted from
// FIREBASE_SERVICE_ACCOUNT (bypasses the append-only / owner-write rules).
//
// Usage (env-driven, set by the delete-leaderboard-row workflow):
//   TARGET_UID=<stray uid> [KEEP_UID=<canonical uid>] [DAILY_DATE=YYYY-MM-DD] \
//   [PURGE_SUBTREE=true] FIREBASE_SERVICE_ACCOUNT='{...}' \
//   node scripts/delete-leaderboard-row.mjs [--apply]

import { createSign } from 'node:crypto';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';
const APPLY = process.argv.includes('--apply');

const TARGET_UID = (process.env.TARGET_UID || '').trim();
const KEEP_UID = (process.env.KEEP_UID || '').trim();
const DAILY_DATE = (process.env.DAILY_DATE || '').trim();
const PURGE_SUBTREE = (process.env.PURGE_SUBTREE || 'true').trim() !== 'false';

// Mirrors scripts/delete-dup-plays-2026-05-30.mjs and scripts/send-push.mjs.
async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: serviceAccount.client_email,
    scope: [
      'https://www.googleapis.com/auth/firebase.database',
      'https://www.googleapis.com/auth/userinfo.email',
    ].join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  };
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(claims)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned); signer.end();
  const jwt = `${unsigned}.${signer.sign(serviceAccount.private_key, 'base64url')}`;
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

function _url(path, token) { return `${DB_BASE}/${path}.json?access_token=${encodeURIComponent(token)}`; }
async function dbGet(path, token) {
  const r = await fetch(_url(path, token));
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}
async function dbDelete(path, token) {
  const r = await fetch(_url(path, token), { method: 'DELETE' });
  if (!r.ok) throw new Error(`DELETE ${path} -> ${r.status} ${await r.text()}`);
}

async function step(label, fn) {
  if (!APPLY) { console.log(`  [DRY] ${label}`); return; }
  console.log(`  [APPLY] ${label}`);
  await fn();
}

// Find every daily/{date}/{pushId} row whose .uid matches `uid`.
function findDailyRows(allDaily, uid) {
  const hits = [];
  for (const [date, rows] of Object.entries(allDaily || {})) {
    for (const [pushId, row] of Object.entries(rows || {})) {
      if (row && row.uid === uid) {
        hits.push({ date, pushId, name: row.name, time: row.time });
      }
    }
  }
  return hits;
}

// Find every weekly/{weekStart}/{uid} row for `uid` (weekly is uid-keyed).
function findWeeklyRows(allWeekly, uid) {
  const hits = [];
  for (const [week, rows] of Object.entries(allWeekly || {})) {
    const row = (rows || {})[uid];
    if (row) hits.push({ week, name: row.name, bestTime: row.bestTime });
  }
  return hits;
}

(async () => {
  if (!TARGET_UID) { console.error('TARGET_UID env not set'); process.exit(2); }
  if (KEEP_UID && KEEP_UID === TARGET_UID) {
    console.error(`REFUSING: TARGET_UID === KEEP_UID (${TARGET_UID}). That would delete the account you want to keep.`);
    process.exit(2);
  }

  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saJson) { console.error('FIREBASE_SERVICE_ACCOUNT not set'); process.exit(1); }
  let serviceAccount;
  try { serviceAccount = JSON.parse(saJson); }
  catch (e) { console.error('FIREBASE_SERVICE_ACCOUNT not valid JSON:', e.message); process.exit(1); }

  console.log(APPLY
    ? '*** APPLY MODE — writes WILL be made to production ***'
    : '*** DRY RUN — no writes. Pass --apply to execute. ***');
  console.log(`TARGET_UID (purge): ${TARGET_UID}`);
  console.log(`KEEP_UID (preserve): ${KEEP_UID || '(none provided)'}`);
  console.log(`PURGE_SUBTREE: ${PURGE_SUBTREE}`);
  console.log(`DAILY_DATE anchor: ${DAILY_DATE || '(none)'}`);

  const token = await getAccessToken(serviceAccount);

  // ── 1. Inventory: what does the stray uid own across leaderboards? ──
  const [allDaily, allWeekly, userTree] = await Promise.all([
    dbGet('daily', token),
    dbGet('weekly', token),
    dbGet(`users/${TARGET_UID}`, token),
  ]);

  const dailyHits = findDailyRows(allDaily, TARGET_UID);
  const weeklyHits = findWeeklyRows(allWeekly, TARGET_UID);

  console.log(`\n=== daily rows owned by ${TARGET_UID} (${dailyHits.length}) ===`);
  for (const h of dailyHits) console.log(`  daily/${h.date}/${h.pushId}  name=${h.name} time=${h.time}s`);
  if (dailyHits.length === 0) console.log('  (none)');

  console.log(`\n=== weekly rows owned by ${TARGET_UID} (${weeklyHits.length}) ===`);
  for (const h of weeklyHits) console.log(`  weekly/${h.week}/${TARGET_UID}  name=${h.name} bestTime=${h.bestTime}s`);
  if (weeklyHits.length === 0) console.log('  (none)');

  console.log(`\n=== users/${TARGET_UID} subtree ===`);
  if (!userTree) {
    console.log('  (no subtree)');
  } else {
    console.log(`  keys: ${Object.keys(userTree).join(', ')}`);
    if (userTree.dailyHistory) console.log(`  dailyHistory dates: ${Object.keys(userTree.dailyHistory).join(', ')}`);
    if (userTree.weeklyAttempts) console.log(`  weeklyAttempts weeks: ${Object.keys(userTree.weeklyAttempts).join(', ')}`);
    if (userTree.pushSubscription) console.log(`  pushSubscription: present (purging stops duplicate notifications)`);
    if (userTree.dailyStreak != null) console.log(`  dailyStreak: ${userTree.dailyStreak}, lastDailyDate: ${userTree.lastDailyDate}`);
  }

  // ── 2. Sanity anchor: confirm the reported dup actually exists on the date ──
  if (DAILY_DATE) {
    const onDate = dailyHits.filter((h) => h.date === DAILY_DATE);
    if (onDate.length === 0) {
      console.log(`\n⚠ DAILY_DATE=${DAILY_DATE} given but ${TARGET_UID} has NO daily row there — double-check the uid before applying.`);
    } else {
      console.log(`\n✓ anchor: ${TARGET_UID} has ${onDate.length} row(s) on ${DAILY_DATE} — matches the reported duplicate.`);
    }
  }

  // ── 3. Show the KEEP_UID rows that must survive ──
  if (KEEP_UID) {
    const keepDaily = findDailyRows(allDaily, KEEP_UID);
    const keepWeekly = findWeeklyRows(allWeekly, KEEP_UID);
    console.log(`\n=== KEEP_UID ${KEEP_UID} — must remain after cleanup ===`);
    console.log(`  daily rows: ${keepDaily.length}` + (DAILY_DATE
      ? ` (on ${DAILY_DATE}: ${keepDaily.filter((h) => h.date === DAILY_DATE).map((h) => `${h.name} ${h.time}s`).join(', ') || 'NONE ⚠'})`
      : ''));
    console.log(`  weekly rows: ${keepWeekly.length}`);
  }

  // ── 4. Plan / execute the deletes ──
  console.log(`\n=== plan ===`);
  for (const h of dailyHits) {
    await step(`delete daily/${h.date}/${h.pushId} (name=${h.name}, time=${h.time}s)`,
      () => dbDelete(`daily/${h.date}/${h.pushId}`, token));
  }
  for (const h of weeklyHits) {
    await step(`delete weekly/${h.week}/${TARGET_UID} (name=${h.name}, bestTime=${h.bestTime}s)`,
      () => dbDelete(`weekly/${h.week}/${TARGET_UID}`, token));
  }
  if (PURGE_SUBTREE && userTree) {
    await step(`delete users/${TARGET_UID} subtree`,
      () => dbDelete(`users/${TARGET_UID}`, token));
  } else if (PURGE_SUBTREE) {
    console.log('  (no users subtree to delete)');
  } else {
    console.log('  (PURGE_SUBTREE=false — leaving users subtree in place)');
  }

  // ── 5. Verify ──
  if (APPLY) {
    console.log(`\n=== VERIFY (post-write re-read) ===`);
    for (const h of dailyHits) {
      const v = await dbGet(`daily/${h.date}/${h.pushId}`, token);
      console.log(`  daily/${h.date}/${h.pushId} -> ${v == null ? 'gone ✓' : 'STILL PRESENT ✗'}`);
    }
    for (const h of weeklyHits) {
      const v = await dbGet(`weekly/${h.week}/${TARGET_UID}`, token);
      console.log(`  weekly/${h.week}/${TARGET_UID} -> ${v == null ? 'gone ✓' : 'STILL PRESENT ✗'}`);
    }
    if (PURGE_SUBTREE) {
      const v = await dbGet(`users/${TARGET_UID}`, token);
      console.log(`  users/${TARGET_UID} -> ${v == null ? 'gone ✓' : 'STILL PRESENT ✗'}`);
    }
    if (KEEP_UID) {
      const keepStill = findDailyRows(await dbGet('daily', token), KEEP_UID);
      console.log(`  KEEP_UID ${KEEP_UID} daily rows still present: ${keepStill.length} ✓`);
    }
  } else {
    console.log('\nDry run complete. Review the planned deletes above, then re-run with --apply.');
  }
})().catch((err) => {
  console.error('delete-leaderboard-row failed:', err.message);
  process.exit(1);
});
