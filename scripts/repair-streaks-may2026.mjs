// One-time repair for the May 22-24 2026 connectivity incident.
//
// What broke (see the canonical daily/* leaderboard, world-readable):
//   • Chris played every day 2026-03-17 → 05-24, but his May 22 play
//     landed under a STRAY anonymous uid (pWhYDHjYGnalM4WGOeUFkM8nPol2)
//     instead of his primary (V07QPXYaICOOcP5ev6DXa2yG9y92) — so his
//     primary account sees a gap at May 22 and its streak reset.
//   • Kate played 2026-03-23 → 05-24, but her May 22 & 23 scores never
//     reached Firebase (flaky service) — so her streak reset on May 24
//     and she never appeared on the board for those days.
//
// This script runs with the FIREBASE_SERVICE_ACCOUNT (admin) token, which
// bypasses the users/{uid} read/write rules. It:
//   1. Bridges Chris's stray May-22 completion into his primary account
//      (dailyHistory) and rewrites the May-22 leaderboard row's uid.
//   2. Recovers Kate's May 22 & 23: if her own dailyHistory still holds a
//      real time for those days, re-creates her leaderboard rows from it;
//      otherwise writes a completion-only marker (no fabricated time) so
//      her streak is continuous, and her real times recover client-side
//      via the durable upload queue when she next opens the patched app.
//   3. Recomputes each player's streak from their (repaired) completion
//      history — NOT a hardcoded number — and writes dailyStreak /
//      lastDailyDate / bestDailyStreak to match.
//   4. Verifies by re-reading both accounts.
//
// DRY-RUN by default: prints every planned write and changes nothing.
// Pass --apply (the workflow does this only when dry_run=false) to write.
//
// Usage:
//   FIREBASE_SERVICE_ACCOUNT='{...}' node scripts/repair-streaks-may2026.mjs [--apply]

import { createSign } from 'node:crypto';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';
const APPLY = process.argv.includes('--apply');

// ── Incident participants + ground truth ──────────────
const CHRIS_PRIMARY = 'V07QPXYaICOOcP5ev6DXa2yG9y92';
const KATE          = 'AYXrTjKPieYrZI8sksnYqbI3Pmh1';
const PEOPLE = [
  {
    // `name` is the identity we match on — connectivity churn spread Chris's
    // plays across his primary uid, a May-22 stray uid, and a May-5 row with
    // NO uid at all, so only the display name reliably ties them together.
    name: 'Chris',
    uid: CHRIS_PRIMARY,
    // Days played with NO leaderboard row anywhere — recorded as completion-
    // only markers, never a fabricated time. Their real time recovers
    // client-side via the durable upload queue on reopen.
    assertedPlayed: [],
  },
  {
    name: 'Kate',
    uid: KATE,
    assertedPlayed: ['2026-05-22', '2026-05-23'], // played both; uploads failed (no rows)
  },
];

// ── Admin token (mirrors scripts/send-push.mjs getAccessToken) ──
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
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(claims)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
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

// ── REST DB helpers (admin token bypasses rules) ──────
function _url(path, token) {
  return `${DB_BASE}/${path}.json?access_token=${encodeURIComponent(token)}`;
}
async function dbGet(path, token) {
  const r = await fetch(_url(path, token));
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
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
// Maximal consecutive-day run ending at the latest date — identical logic
// to computeStreakFromHistory in src/storage/statsStorage.js.
function computeRun(dates) {
  const s = [...new Set((dates || []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
  if (s.length === 0) return { streak: 0, lastDate: null, startDate: null };
  const lastDate = s[s.length - 1];
  let streak = 1;
  let startDate = lastDate;
  for (let i = s.length - 1; i > 0; i--) {
    const diff = Math.round((new Date(s[i] + 'T00:00:00') - new Date(s[i - 1] + 'T00:00:00')) / 86400000);
    if (diff === 1) { streak++; startDate = s[i - 1]; }
    else break;
  }
  return { streak, lastDate, startDate };
}

// Plan/execute a write. In dry-run it only logs; with --apply it runs `fn`.
async function step(label, fn) {
  if (!APPLY) { console.log(`  [DRY] ${label}`); return; }
  console.log(`  [APPLY] ${label}`);
  await fn();
}

async function repairPerson(token, p, dailyTree) {
  console.log(`\n=== ${p.name} (${p.uid}) ===`);
  const user = (await dbGet(`users/${p.uid}`, token)) || {};
  const hist = { ...(user.dailyHistory || {}) }; // working copy incl. planned additions
  console.log(`  current: dailyStreak=${user.dailyStreak ?? '∅'} lastDailyDate=${user.lastDailyDate ?? '∅'} best=${user.bestDailyStreak ?? '∅'} historyDays=${Object.keys(hist).length}`);

  // ── Reconstruct real plays from the LEADERBOARD (authoritative) ──
  // daily/* holds every actual completion with a real time and is more
  // complete than dailyHistory (on flaky service the score upload often
  // landed while the history write failed). We identify a player's rows by
  // their leaderboard DISPLAY NAME, not uid: connectivity/auth churn spread
  // their plays across several anonymous uids — Chris's May 22 under a stray
  // uid, his May 5 under a row with NO uid at all — so a uid-only union
  // undercounts. On this private friends-only board the name is the stable
  // identity. Synthetic keys (_bonus / _weekly_first) are skipped.
  const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const lbPlays = {};        // date -> { time }
  const strayRewrites = [];  // { date, pushId, from } rows to reattribute to the canonical uid
  for (const date of Object.keys(dailyTree)) {
    if (!PLAIN_DATE.test(date)) continue;
    const rows = dailyTree[date] || {};
    for (const pushId of Object.keys(rows)) {
      const row = rows[pushId];
      if (!row || row.name !== p.name) continue;
      if (typeof row.time === 'number' && !(date in lbPlays)) lbPlays[date] = { time: row.time };
      if (row.uid !== p.uid) strayRewrites.push({ date, pushId, from: row.uid ?? '(no uid)' });
    }
  }

  // Union of every date this player completed, from any source.
  const unionDates = new Set([
    ...Object.keys(hist),
    ...Object.keys(lbPlays),
    ...p.assertedPlayed,
  ]);

  // ── Backfill dailyHistory holes from real leaderboard times ──
  // Makes the per-day completion record match actual plays so the client's
  // history-derived streak agrees with the counter we set. Real times only —
  // never fabricated.
  const backfillDates = [...unionDates].sort().filter(d =>
    (!hist[d] || typeof hist[d].time !== 'number') && lbPlays[d] && typeof lbPlays[d].time === 'number');
  if (backfillDates.length) {
    console.log(`  ${APPLY ? '[APPLY]' : '[DRY]'} backfill ${backfillDates.length} dailyHistory entries from leaderboard times (${backfillDates[0]} … ${backfillDates[backfillDates.length - 1]})`);
    for (const d of backfillDates) {
      hist[d] = { time: lbPlays[d].time, submittedAt: Date.now() };
      if (APPLY) await dbPut(`users/${p.uid}/dailyHistory/${d}`, token, hist[d]);
    }
  }

  // ── Completion markers for asserted-played days with NO recoverable time ──
  for (const d of p.assertedPlayed) {
    if (hist[d]) { console.log(`  ${d}: already in history — no marker needed`); continue; }
    const marker = { completed: true, submittedAt: Date.now() };
    hist[d] = marker;
    await step(`mark users/${p.uid}/dailyHistory/${d} = {completed:true} (asserted played; no recoverable time — client queue fills the real score)`,
      () => dbPut(`users/${p.uid}/dailyHistory/${d}`, token, marker));
  }

  // ── Reattribute stray-uid leaderboard rows to the canonical uid ──
  for (const { date, pushId, from } of strayRewrites) {
    await step(`rewrite daily/${date}/${pushId}.uid: ${from} → ${p.uid}`,
      () => dbPatch(`daily/${date}/${pushId}`, token, { uid: p.uid }));
  }

  // ── Recompute the streak from the union and write it ──
  const { streak, lastDate, startDate } = computeRun([...unionDates]);
  const best = Math.max(user.bestDailyStreak || 0, streak);
  console.log(`  derived streak = ${streak}  (run ${startDate} → ${lastDate}; was stored ${user.dailyStreak ?? '∅'})`);
  await step(`patch users/${p.uid} { dailyStreak:${streak}, lastDailyDate:'${lastDate}', bestDailyStreak:${best} }`,
    () => dbPatch(`users/${p.uid}`, token, { dailyStreak: streak, lastDailyDate: lastDate, bestDailyStreak: best }));

  return { name: p.name, uid: p.uid, derived: streak, lastDate };
}

async function verify(token, summaries) {
  console.log('\n=== VERIFY (post-write re-read) ===');
  for (const s of summaries) {
    const u = (await dbGet(`users/${s.uid}`, token)) || {};
    const ok = u.dailyStreak === s.derived && u.lastDailyDate === s.lastDate;
    console.log(`  ${s.name}: dailyStreak=${u.dailyStreak} lastDailyDate=${u.lastDailyDate} best=${u.bestDailyStreak} ${ok ? '✓' : '✗ MISMATCH'}`);
  }
}

(async () => {
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saJson) {
    console.error('FIREBASE_SERVICE_ACCOUNT env var not set — cannot mint access token');
    process.exit(1);
  }
  let serviceAccount;
  try { serviceAccount = JSON.parse(saJson); }
  catch (err) { console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON:', err.message); process.exit(1); }

  console.log(APPLY
    ? '*** APPLY MODE — writes WILL be made to production ***'
    : '*** DRY RUN — no writes. Pass --apply to execute. ***');

  const token = await getAccessToken(serviceAccount);
  // Load the whole leaderboard once — repairPerson reconstructs real plays
  // from it (it's the authoritative completion record).
  const dailyTree = (await dbGet('daily', token)) || {};
  console.log(`Loaded ${Object.keys(dailyTree).length} leaderboard dates from daily/*.`);
  const summaries = [];
  for (const p of PEOPLE) summaries.push(await repairPerson(token, p, dailyTree));

  if (APPLY) await verify(token, summaries);
  else console.log('\nDry run complete. Review the planned writes above, then re-run with --apply.');
})().catch(err => {
  console.error('repair failed:', err.message);
  process.exit(1);
});
