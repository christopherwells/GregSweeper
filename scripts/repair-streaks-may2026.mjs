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
const CHRIS_STRAY   = 'pWhYDHjYGnalM4WGOeUFkM8nPol2';
const KATE          = 'AYXrTjKPieYrZI8sksnYqbI3Pmh1';
const RUN_END       = '2026-05-24'; // most recent completed day at incident time

const PEOPLE = [
  {
    name: 'Chris',
    uid: CHRIS_PRIMARY,
    stray: CHRIS_STRAY,
    strayDays: ['2026-05-22'], // bridge from stray uid → primary
    recoverDays: [],
    expectStreak: 69,          // 2026-03-17 .. 2026-05-24 inclusive
  },
  {
    name: 'Kate',
    uid: KATE,
    stray: null,
    strayDays: [],
    recoverDays: ['2026-05-22', '2026-05-23'], // missing uploads (she played both)
    expectStreak: 63,          // 2026-03-23 .. 2026-05-24 inclusive
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
async function dbPush(path, token, body) {
  const r = await fetch(_url(path, token), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${path} -> ${r.status} ${await r.text()}`);
  return r.json(); // { name: '<pushId>' }
}

// Maximal consecutive-day run ending at the latest date — identical logic
// to computeStreakFromHistory in src/storage/statsStorage.js.
function computeRun(dates) {
  const s = [...new Set((dates || []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
  if (s.length === 0) return { streak: 0, lastDate: null };
  const lastDate = s[s.length - 1];
  let streak = 1;
  for (let i = s.length - 1; i > 0; i--) {
    const diff = Math.round((new Date(s[i] + 'T00:00:00') - new Date(s[i - 1] + 'T00:00:00')) / 86400000);
    if (diff === 1) streak++;
    else break;
  }
  return { streak, lastDate };
}

// Plan/execute a write. In dry-run it only logs; with --apply it runs `fn`.
async function step(label, fn) {
  if (!APPLY) { console.log(`  [DRY] ${label}`); return; }
  console.log(`  [APPLY] ${label}`);
  await fn();
}

async function lookupParAndSeed(token, day) {
  const rows = (await dbGet(`daily/${day}`, token)) || {};
  let par = null;
  for (const k of Object.keys(rows)) {
    if (rows[k] && typeof rows[k].par === 'number') { par = rows[k].par; break; }
  }
  const seed = (await dbGet(`dailyBoard/${day}/rngSeed`, token)) || day;
  return { par, seed, rows };
}

async function repairPerson(token, p) {
  console.log(`\n=== ${p.name} (${p.uid}) ===`);
  const user = (await dbGet(`users/${p.uid}`, token)) || {};
  const hist = { ...(user.dailyHistory || {}) }; // working copy incl. planned additions
  console.log(`  current: dailyStreak=${user.dailyStreak ?? '∅'} lastDailyDate=${user.lastDailyDate ?? '∅'} best=${user.bestDailyStreak ?? '∅'} historyDays=${Object.keys(hist).length}`);

  // ── Step 1: bridge stray-uid completions into the primary account ──
  if (p.stray && p.strayDays.length) {
    const strayHist = (await dbGet(`users/${p.stray}/dailyHistory`, token)) || {};
    for (const day of p.strayDays) {
      if (hist[day]) {
        console.log(`  ${day}: primary already has history — no bridge needed`);
      } else if (strayHist[day]) {
        const entry = strayHist[day];
        hist[day] = entry;
        await step(`bridge users/${p.uid}/dailyHistory/${day} = ${JSON.stringify(entry)} (from stray)`,
          () => dbPut(`users/${p.uid}/dailyHistory/${day}`, token, entry));
      } else {
        // Stray had no history row either — fall back to a completion marker
        // so the streak is preserved (the leaderboard row proves the play).
        const marker = { completed: true, submittedAt: Date.now() };
        hist[day] = marker;
        await step(`mark users/${p.uid}/dailyHistory/${day} = ${JSON.stringify(marker)} (stray had no history)`,
          () => dbPut(`users/${p.uid}/dailyHistory/${day}`, token, marker));
      }
      // Rewrite the leaderboard row's uid stray → primary so the play is
      // attributed to the canonical account.
      const rows = (await dbGet(`daily/${day}`, token)) || {};
      let rewrote = false;
      for (const pushId of Object.keys(rows)) {
        if (rows[pushId] && rows[pushId].uid === p.stray) {
          await step(`rewrite daily/${day}/${pushId}.uid: ${p.stray} → ${p.uid}`,
            () => dbPatch(`daily/${day}/${pushId}`, token, { uid: p.uid }));
          rewrote = true;
        }
      }
      if (!rewrote) console.log(`  ${day}: no stray-uid leaderboard row to rewrite`);
    }
  }

  // ── Step 2: recover missing-upload days (Kate's 22/23) ──
  for (const day of p.recoverDays) {
    const existing = hist[day];
    if (existing && typeof existing.time === 'number') {
      // Her completion history survived — only the leaderboard push failed.
      // Re-create the leaderboard row from the real time she actually got.
      const { par, seed, rows } = await lookupParAndSeed(token, day);
      const already = Object.values(rows).some(r => r && r.uid === p.uid);
      if (already) {
        console.log(`  ${day}: leaderboard row already present (client queue may have flushed) — skip`);
      } else {
        const row = {
          name: p.name, time: existing.time, bombHits: 0, uid: p.uid,
          rngSeed: seed, timestamp: { '.sv': 'timestamp' },
        };
        if (typeof par === 'number') row.par = par;
        await step(`push daily/${day} row ${JSON.stringify({ ...row, timestamp: 'SERVER' })} (recovered time ${existing.time}s)`,
          () => dbPush(`daily/${day}`, token, row));
      }
    } else if (existing) {
      console.log(`  ${day}: completion marker already present — streak preserved, leaderboard deferred to client`);
    } else {
      // No server-side record of her time. Preserve the streak with a
      // completion-only marker (NO fabricated time). Her real time recovers
      // client-side when she reopens the patched app (durable upload queue).
      const marker = { completed: true, submittedAt: Date.now() };
      hist[day] = marker;
      await step(`mark users/${p.uid}/dailyHistory/${day} = ${JSON.stringify(marker)} (no recoverable time; client queue will fill the real score)`,
        () => dbPut(`users/${p.uid}/dailyHistory/${day}`, token, marker));
    }
  }

  // ── Step 3: recompute the streak from the repaired history ──
  const { streak, lastDate } = computeRun(Object.keys(hist));
  const best = Math.max(user.bestDailyStreak || 0, streak);
  console.log(`  derived from repaired history: streak=${streak} lastDate=${lastDate} (expected ${p.expectStreak})`);
  if (streak !== p.expectStreak) {
    console.warn(`  ⚠ derived streak ${streak} != expected ${p.expectStreak} — review the history above before applying.`);
  }
  await step(`patch users/${p.uid} { dailyStreak:${streak}, lastDailyDate:'${lastDate}', bestDailyStreak:${best} }`,
    () => dbPatch(`users/${p.uid}`, token, { dailyStreak: streak, lastDailyDate: lastDate, bestDailyStreak: best }));

  return { name: p.name, uid: p.uid, expectStreak: p.expectStreak, derived: streak, lastDate };
}

async function verify(token, summaries) {
  console.log('\n=== VERIFY (post-write re-read) ===');
  for (const s of summaries) {
    const u = (await dbGet(`users/${s.uid}`, token)) || {};
    const ok = u.dailyStreak === s.expectStreak && u.lastDailyDate === RUN_END;
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
  const summaries = [];
  for (const p of PEOPLE) summaries.push(await repairPerson(token, p));

  if (APPLY) await verify(token, summaries);
  else console.log('\nDry run complete. Review the planned writes above, then re-run with --apply.');
})().catch(err => {
  console.error('repair failed:', err.message);
  process.exit(1);
});
