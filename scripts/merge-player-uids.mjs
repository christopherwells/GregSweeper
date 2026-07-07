// Merge one player identity's data into another (admin tool).
//
// A human who played under several anonymous uids (pre-account-linking
// device fragmentation) can have their history consolidated: leaderboard
// rows are re-attributed, the users/{uid} progress nodes are merged, and
// the emptied source node is removed. The source AUTH RECORD is left
// alone on purpose — once its users node is gone and it owns no rows, it
// is exactly what purge-anon-orphans.mjs sweeps after it ages past the
// filter, so no second deletion pathway exists.
//
// Merge semantics (pure helpers below, node-tested in test/mergeUids.test.mjs):
//   rows      daily/dailyArchive/timed rows get uid rewritten in place
//             (name/time/history untouched — the leaderboard shows what
//             was played under whatever name it was submitted with);
//             weekly rows are KEYED by uid, so they move keys, and a
//             same-week collision keeps the better bestTime with per-day
//             best dayTimes/dayBombHits.
//   users     dailyHistory/weeklyAttempts union (collision keeps the
//             target's); maxCheckpoint/bestDailyStreak take the max;
//             (dailyStreak, lastDailyDate, moltDay) move as ONE SNAPSHOT
//             from whichever side has the later lastDailyDate — the same
//             date-anchored rule the client's cloud merge uses, so a bank
//             can never pair with the other side's streak; powerUps take
//             the per-key max (never summed — no double-granting);
//             lastSeen keeps the later stamp; everything else keeps the
//             target's value and copies source-only keys verbatim.
//
// DRY RUN IS THE DEFAULT; --apply performs the writes (service-account
// auth, bypasses the write-once rules by design — this is the one tool
// whose job is editing history).
//
// Usage:
//   node scripts/merge-player-uids.mjs --sa <serviceAccount.json> \
//     --mappings '[{"from":"<uid>","into":"<uid>"}]' [--apply]
//   (or FIREBASE_SERVICE_ACCOUNT env instead of --sa)

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';

// ── pure merge helpers ──────────────────────────────────────────────

// Normalize an RTDB day-indexed value (sparse arrays come back as
// objects with numeric string keys) into a 7-slot array of numbers/null.
export function normalizeDaySlots(v) {
  const out = [null, null, null, null, null, null, null];
  if (!v) return out;
  for (const [k, val] of Object.entries(v)) {
    const i = Number(k);
    if (Number.isInteger(i) && i >= 0 && i < 7 && val != null) out[i] = val;
  }
  return out;
}

// Merge two weekly leaderboard rows for the SAME week: per-day best
// times/bomb-hits, overall best time; identity fields (name, timestamp,
// totalMoves) follow whichever row owns the winning bestTime.
export function mergeWeeklyRows(target, source) {
  const tTimes = normalizeDaySlots(target.dayTimes);
  const sTimes = normalizeDaySlots(source.dayTimes);
  const tHits = normalizeDaySlots(target.dayBombHits);
  const sHits = normalizeDaySlots(source.dayBombHits);
  const dayTimes = tTimes.map((t, i) => {
    const s = sTimes[i];
    if (t == null) return s;
    if (s == null) return t;
    return Math.min(t, s);
  });
  const dayBombHits = tTimes.map((t, i) => {
    const s = sTimes[i];
    // bomb hits ride with whichever run supplied that day's kept time
    if (t == null) return sHits[i];
    if (s == null) return tHits[i];
    return t <= s ? tHits[i] : sHits[i];
  });
  const winner = (source.bestTime != null && (target.bestTime == null || source.bestTime < target.bestTime))
    ? source : target;
  return {
    ...target,
    name: winner.name,
    timestamp: winner.timestamp,
    totalMoves: winner.totalMoves,
    bestTime: Math.min(...[target.bestTime, source.bestTime].filter((x) => x != null)),
    dayTimes,
    dayBombHits,
  };
}

// Merge users/{source} into users/{target}. Returns { merged, notes }.
export function mergeUserNodes(target, source) {
  const t = { ...(target || {}) };
  const s = source || {};
  const notes = [];

  // (dailyStreak, lastDailyDate, moltDay) move as one date-anchored
  // snapshot — the side with the later lastDailyDate wins whole.
  const tDate = t.lastDailyDate || '';
  const sDate = s.lastDailyDate || '';
  const streakWinner = sDate > tDate ? s : t;
  for (const k of ['dailyStreak', 'lastDailyDate', 'moltDay']) {
    if (streakWinner[k] !== undefined) t[k] = streakWinner[k];
  }
  if (sDate > tDate) notes.push(`streak snapshot adopted from source (lastDailyDate ${sDate} > ${tDate || '(none)'})`);

  for (const k of ['maxCheckpoint', 'bestDailyStreak']) {
    if (s[k] != null && (t[k] == null || s[k] > t[k])) {
      notes.push(`${k}: ${t[k] ?? '(none)'} -> ${s[k]}`);
      t[k] = s[k];
    }
  }

  if (s.dailyHistory) {
    t.dailyHistory = { ...(t.dailyHistory || {}) };
    for (const [date, entry] of Object.entries(s.dailyHistory)) {
      if (t.dailyHistory[date]) notes.push(`dailyHistory collision on ${date}: kept target's`);
      else t.dailyHistory[date] = entry;
    }
  }

  if (s.weeklyAttempts) {
    t.weeklyAttempts = { ...(t.weeklyAttempts || {}) };
    for (const [week, node] of Object.entries(s.weeklyAttempts)) {
      if (!t.weeklyAttempts[week]) { t.weeklyAttempts[week] = node; continue; }
      // union the dayAttempts markers so neither side's played days vanish
      const tDays = { ...(t.weeklyAttempts[week].dayAttempts || {}) };
      for (const [d, v] of Object.entries(node.dayAttempts || {})) if (!tDays[d]) tDays[d] = v;
      t.weeklyAttempts[week] = { ...t.weeklyAttempts[week], dayAttempts: tDays };
      notes.push(`weeklyAttempts collision on ${week}: day markers unioned`);
    }
  }

  if (s.powerUps) {
    t.powerUps = { ...(t.powerUps || {}) };
    for (const [mode, counts] of Object.entries(s.powerUps)) {
      t.powerUps[mode] = { ...(t.powerUps[mode] || {}) };
      for (const [pu, n] of Object.entries(counts || {})) {
        t.powerUps[mode][pu] = Math.max(t.powerUps[mode][pu] || 0, n || 0);
      }
    }
  }

  if (s.lastSeen && (!t.lastSeen || (s.lastSeen.at || 0) > (t.lastSeen.at || 0))) t.lastSeen = s.lastSeen;

  if (s.friends) {
    t.friends = { ...(s.friends || {}), ...(t.friends || {}) }; // target's entry wins a collision
  }

  // Source-only keys the rules above didn't cover (defensive: future fields).
  for (const k of Object.keys(s)) {
    if (t[k] === undefined) { t[k] = s[k]; notes.push(`copied source-only key ${k}`); }
  }
  return { merged: t, notes };
}

// ── admin I/O ───────────────────────────────────────────────────────

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned); signer.end();
  const jwt = `${unsigned}.${signer.sign(sa.private_key, 'base64url')}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!r.ok) throw new Error(`token mint failed: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

const authed = (token) => (path) => `${DB_BASE}/${path}.json?access_token=${encodeURIComponent(token)}`;

async function dbGet(url) { const r = await fetch(url); if (!r.ok) throw new Error(`GET failed: ${r.status}`); return r.json(); }
async function dbPut(url, body) { const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`PUT failed: ${r.status} ${await r.text()}`); }
async function dbPatch(url, body) { const r = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`PATCH failed: ${r.status} ${await r.text()}`); }
async function dbDelete(url) { const r = await fetch(url, { method: 'DELETE' }); if (!r.ok) throw new Error(`DELETE failed: ${r.status} ${await r.text()}`); }

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const saIdx = args.indexOf('--sa');
  const mapIdx = args.indexOf('--mappings');
  if (mapIdx < 0) throw new Error('--mappings \'[{"from":"...","into":"..."}]\' is required');
  const mappings = JSON.parse(args[mapIdx + 1]);
  const saRaw = saIdx >= 0 ? readFileSync(args[saIdx + 1], 'utf8') : process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saRaw) throw new Error('service account required (--sa <path> or FIREBASE_SERVICE_ACCOUNT)');
  const token = await getAccessToken(JSON.parse(saRaw));
  const url = authed(token);

  for (const m of mappings) {
    if (!m.from || !m.into || m.from === m.into) throw new Error(`bad mapping: ${JSON.stringify(m)}`);
  }

  console.log(`merge-player-uids — ${apply ? 'APPLY' : 'dry run'} — ${mappings.length} mapping(s)`);

  // Row scans (world-readable trees, fetched once).
  const [daily, dailyArchive, timed, weekly] = await Promise.all(
    ['daily', 'dailyArchive', 'timed', 'weekly'].map((p) => dbGet(`${DB_BASE}/${p}.json`)),
  );

  for (const { from, into } of mappings) {
    console.log(`\n=== ${from}  ->  ${into} ===`);

    // 1. flat row rewrites
    const rewrites = [];
    for (const [tree, data, keyed] of [['daily', daily, true], ['dailyArchive', dailyArchive, true], ['timed', timed, false]]) {
      if (!data) continue;
      if (keyed) {
        for (const [bucket, rows] of Object.entries(data)) {
          for (const [pushId, row] of Object.entries(rows || {})) {
            if (row && row.uid === from) rewrites.push(`${tree}/${bucket}/${pushId}`);
          }
        }
      } else {
        for (const [pushId, row] of Object.entries(data)) {
          if (row && row.uid === from) rewrites.push(`${tree}/${pushId}`);
        }
      }
    }
    for (const path of rewrites) {
      console.log(`  row uid rewrite: ${path}`);
      if (apply) await dbPatch(url(path), { uid: into });
    }

    // 2. weekly rows (keyed by uid)
    for (const [week, perUid] of Object.entries(weekly || {})) {
      const srcRow = perUid && perUid[from];
      if (!srcRow) continue;
      const tgtRow = perUid[into];
      if (!tgtRow) {
        console.log(`  weekly ${week}: move row (bestTime ${srcRow.bestTime})`);
        if (apply) { await dbPut(url(`weekly/${week}/${into}`), srcRow); await dbDelete(url(`weekly/${week}/${from}`)); }
      } else {
        const merged = mergeWeeklyRows(tgtRow, srcRow);
        console.log(`  weekly ${week}: COLLISION — merged bestTime ${merged.bestTime}, dayTimes ${JSON.stringify(merged.dayTimes)}`);
        if (apply) { await dbPut(url(`weekly/${week}/${into}`), merged); await dbDelete(url(`weekly/${week}/${from}`)); }
      }
    }

    // 3. users node merge
    const [srcNode, tgtNode] = await Promise.all([dbGet(url(`users/${from}`)), dbGet(url(`users/${into}`))]);
    if (!srcNode) {
      console.log('  users node: source has none — nothing to merge');
    } else {
      const { merged, notes } = mergeUserNodes(tgtNode, srcNode);
      for (const n of notes) console.log(`  users: ${n}`);
      console.log(`  users: merged node has keys [${Object.keys(merged).sort().join(', ')}]`);
      if (apply) { await dbPut(url(`users/${into}`), merged); await dbDelete(url(`users/${from}`)); }
    }
    console.log(`  auth record ${from}: LEFT IN PLACE (data-empty now — the aged-orphan purge sweeps it)`);
  }

  console.log(apply ? '\nAPPLIED.' : '\ndry run — nothing written. Re-run with --apply.');
}

// Run only when invoked directly (so test/mergeUids.test.mjs can import
// the pure merge helpers without the CLI firing — the send-push.mjs pattern).
const _isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (_isMain) {
  main().catch((err) => { console.error('merge-player-uids failed:', err.message); process.exit(1); });
}
