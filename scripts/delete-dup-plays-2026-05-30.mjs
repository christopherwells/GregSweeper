// One-off cleanup: Chris's daily + weekly Saturday plays on 2026-05-30
// landed under a fresh anonymous uid (eWmFceA0tuUkld3adYC2lqxcqju1) on a
// second device/session, bypassing the per-uid cloud "already played"
// gates and duplicating his canonical V07 plays. This deletes those
// stray rows plus the abandoned anon user's subtree.
//
// Same dry-run-by-default pattern as scripts/repair-streaks-may2026.mjs.
// Uses FIREBASE_SERVICE_ACCOUNT to mint an admin token that bypasses
// the users/{uid} write rules.
//
// Usage:
//   FIREBASE_SERVICE_ACCOUNT='{...}' node scripts/delete-dup-plays-2026-05-30.mjs [--apply]

import { createSign } from 'node:crypto';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';
const APPLY = process.argv.includes('--apply');

const CANONICAL  = 'V07QPXYaICOOcP5ev6DXa2yG9y92';
const DUPLICATE  = 'eWmFceA0tuUkld3adYC2lqxcqju1';
const DAILY_DATE = '2026-05-30';
const WEEK_START = '2026-05-25';

// Mirrors scripts/repair-streaks-may2026.mjs and scripts/send-push.mjs.
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
async function dbPatch(path, token, body) {
  const r = await fetch(_url(path, token), {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PATCH ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}
async function dbPut(path, token, body) {
  const r = await fetch(_url(path, token), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PUT ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

// dayTimes/dayBombHits are stored as a dense ARRAY when keys are 0..N
// (Firebase auto-coerces) or an OBJECT when sparse. Normalise to a
// day-index → value map so we can merge regardless of shape.
function dayMap(v) {
  if (Array.isArray(v)) { const m = {}; v.forEach((x, i) => { if (x != null) m[i] = x; }); return m; }
  return { ...(v || {}) };
}

async function step(label, fn) {
  if (!APPLY) { console.log(`  [DRY] ${label}`); return; }
  console.log(`  [APPLY] ${label}`);
  await fn();
}

(async () => {
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saJson) { console.error('FIREBASE_SERVICE_ACCOUNT not set'); process.exit(1); }
  let serviceAccount;
  try { serviceAccount = JSON.parse(saJson); }
  catch (e) { console.error('FIREBASE_SERVICE_ACCOUNT not valid JSON:', e.message); process.exit(1); }

  console.log(APPLY
    ? '*** APPLY MODE — writes WILL be made to production ***'
    : '*** DRY RUN — no writes. Pass --apply to execute. ***');

  const token = await getAccessToken(serviceAccount);

  // ── 0. Migrate the stray's weekly day-times into the canonical row ──
  // Before deleting the stray weekly row, absorb its real per-day times +
  // bomb-hit counts into the canonical row so the player keeps the actual
  // play. No fabrication — every value is a real time the player got under
  // the stray uid. Never overwrites a day the canonical already has.
  console.log(`\n=== migrate weekly ${WEEK_START}: ${DUPLICATE} → ${CANONICAL} ===`);
  const strayWeekly = await dbGet(`weekly/${WEEK_START}/${DUPLICATE}`, token);
  const canonWeekly = await dbGet(`weekly/${WEEK_START}/${CANONICAL}`, token);
  if (!strayWeekly || !strayWeekly.dayTimes) {
    console.log('  (no stray weekly row to migrate)');
  } else if (!canonWeekly) {
    console.log('  ⚠ no canonical weekly row exists — skipping migrate (would need to promote the stray instead)');
  } else {
    const canTimes = dayMap(canonWeekly.dayTimes);
    const canBombs = dayMap(canonWeekly.dayBombHits);
    const strayTimes = dayMap(strayWeekly.dayTimes);
    const strayBombs = dayMap(strayWeekly.dayBombHits);
    const mergedTimes = { ...canTimes };
    const mergedBombs = { ...canBombs };
    const migrated = [];
    for (const d of Object.keys(strayTimes)) {
      if (!(d in canTimes)) { // never overwrite a day the canonical already has
        mergedTimes[d] = strayTimes[d];
        if (d in strayBombs) mergedBombs[d] = strayBombs[d];
        migrated.push(d);
      } else {
        console.log(`  day ${d}: canonical already has ${canTimes[d]}s — leaving canonical untouched`);
      }
    }
    if (migrated.length === 0) {
      console.log('  no new days to migrate');
    } else {
      const newBest = Math.min(...Object.values(mergedTimes));
      console.log(`  migrating day(s) [${migrated.join(',')}] (times: ${migrated.map(d => strayTimes[d]+'s').join(', ')})`);
      console.log(`  bestTime: ${canonWeekly.bestTime} → ${newBest}`);
      const patch = {
        bestTime: newBest,
        dayTimes: mergedTimes,
        dayBombHits: mergedBombs,
        timestamp: { '.sv': 'timestamp' },
      };
      await step(`patch weekly/${WEEK_START}/${CANONICAL} (add day(s) ${migrated.join(',')} from stray)`,
        () => dbPatch(`weekly/${WEEK_START}/${CANONICAL}`, token, patch));
      // Mark the per-uid attempt cap so V07 can't accidentally re-play this day.
      for (const d of migrated) {
        await step(`mark users/${CANONICAL}/weeklyAttempts/${WEEK_START}/dayAttempts/${d} attempted`,
          () => dbPut(`users/${CANONICAL}/weeklyAttempts/${WEEK_START}/dayAttempts/${d}`, token,
            { timestamp: { '.sv': 'timestamp' } }));
      }
    }
  }

  // ── 1. Find and delete the duplicate daily row ──
  console.log(`\n=== daily/${DAILY_DATE} ===`);
  const dailyRows = (await dbGet(`daily/${DAILY_DATE}`, token)) || {};
  const dupDailyKeys = Object.entries(dailyRows)
    .filter(([_, r]) => r && r.uid === DUPLICATE)
    .map(([pushId, r]) => ({ pushId, time: r.time, name: r.name }));
  if (dupDailyKeys.length === 0) {
    console.log(`  (no rows under ${DUPLICATE} — already cleaned up?)`);
  }
  for (const { pushId, time, name } of dupDailyKeys) {
    await step(`delete daily/${DAILY_DATE}/${pushId} (name=${name}, time=${time}s, uid=${DUPLICATE})`,
      () => dbDelete(`daily/${DAILY_DATE}/${pushId}`, token));
  }

  // ── 2. Delete the duplicate weekly row ──
  console.log(`\n=== weekly/${WEEK_START}/${DUPLICATE} ===`);
  const weeklyRow = await dbGet(`weekly/${WEEK_START}/${DUPLICATE}`, token);
  if (!weeklyRow) {
    console.log('  (not present — already cleaned up?)');
  } else {
    console.log(`  current: name=${weeklyRow.name} bestTime=${weeklyRow.bestTime}s dayTimes=${JSON.stringify(weeklyRow.dayTimes)}`);
    await step(`delete weekly/${WEEK_START}/${DUPLICATE}`,
      () => dbDelete(`weekly/${WEEK_START}/${DUPLICATE}`, token));
  }

  // ── 3. Delete the abandoned anon user's entire subtree ──
  // Also removes its pushSubscription (if any), so the hourly notify cron
  // stops firing to this stray uid in addition to the canonical one.
  console.log(`\n=== users/${DUPLICATE} (abandoned anon user) ===`);
  const userTree = await dbGet(`users/${DUPLICATE}`, token);
  if (!userTree) {
    console.log('  (no user subtree)');
  } else {
    console.log(`  keys: ${Object.keys(userTree).join(', ')}`);
    if (userTree.dailyHistory) {
      console.log(`  dailyHistory dates: ${Object.keys(userTree.dailyHistory).join(', ')}`);
    }
    if (userTree.weeklyAttempts) {
      console.log(`  weeklyAttempts weeks: ${Object.keys(userTree.weeklyAttempts).join(', ')}`);
    }
    if (userTree.pushSubscription) {
      console.log(`  pushSubscription: present (will stop duplicate notifications)`);
    }
    await step(`delete users/${DUPLICATE} subtree`,
      () => dbDelete(`users/${DUPLICATE}`, token));
  }

  // ── 4. Sanity: confirm Chris's canonical rows are still there ──
  console.log(`\n=== CANONICAL preserved? ===`);
  const canonicalDaily = Object.entries(dailyRows).find(([_, r]) => r && r.uid === CANONICAL && r.name === 'Chris');
  if (canonicalDaily) {
    const [pid, r] = canonicalDaily;
    console.log(`  daily/${DAILY_DATE}/${pid}: name=${r.name} time=${r.time}s uid=${CANONICAL} ✓`);
  } else {
    console.log(`  ⚠ no canonical daily row for Chris on ${DAILY_DATE}!`);
  }
  const canonicalWeekly = await dbGet(`weekly/${WEEK_START}/${CANONICAL}`, token);
  if (canonicalWeekly) {
    console.log(`  weekly/${WEEK_START}/${CANONICAL}: bestTime=${canonicalWeekly.bestTime}s dayTimes=${JSON.stringify(canonicalWeekly.dayTimes)} ✓`);
  } else {
    console.log(`  ⚠ no canonical weekly row for Chris!`);
  }

  if (APPLY) {
    // Verify: stray rows gone AND canonical weekly absorbed the migrated day(s).
    console.log(`\n=== VERIFY (post-write re-read) ===`);
    const stillThere = await Promise.all([
      ...dupDailyKeys.map(k => dbGet(`daily/${DAILY_DATE}/${k.pushId}`, token).then(v => `daily/${DAILY_DATE}/${k.pushId} -> ${v == null ? 'gone ✓' : 'STILL PRESENT ✗'}`)),
      dbGet(`weekly/${WEEK_START}/${DUPLICATE}`, token).then(v => `weekly/${WEEK_START}/${DUPLICATE} -> ${v == null ? 'gone ✓' : 'STILL PRESENT ✗'}`),
      dbGet(`users/${DUPLICATE}`, token).then(v => `users/${DUPLICATE} -> ${v == null ? 'gone ✓' : 'STILL PRESENT ✗'}`),
    ]);
    for (const line of stillThere) console.log(`  ${line}`);
    const canonNow = await dbGet(`weekly/${WEEK_START}/${CANONICAL}`, token);
    console.log(`  canonical weekly dayTimes: ${JSON.stringify(canonNow?.dayTimes)} bestTime=${canonNow?.bestTime}`);
    const canonAttempts = await dbGet(`users/${CANONICAL}/weeklyAttempts/${WEEK_START}/dayAttempts`, token);
    console.log(`  canonical weeklyAttempts/dayAttempts: ${JSON.stringify(canonAttempts && Object.keys(canonAttempts))}`);
  } else {
    console.log('\nDry run complete. Review the planned deletes above, then re-run with --apply.');
  }
})().catch(err => {
  console.error('delete-dup-plays failed:', err.message);
  process.exit(1);
});
