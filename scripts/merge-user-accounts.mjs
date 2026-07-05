// Merge one player's TWO anonymous accounts: move everything FROM_UID owns
// under TO_UID. The failure mode this fixes (Kate, 2026-07-04): a device
// loses its anonymous Firebase session (storage clear, or the pre-#116
// auth-clobber) and mints a fresh uid, splitting one human across two
// accounts. Anonymous accounts carry no credential, so the OLD session can
// never be signed into again — the device IS the new uid from now on. The
// only honest direction is therefore old → new: rewrite the old uid's rows
// and progress under the new one, then the player links Google/email so it
// can't happen again.
//
// What it merges, per store:
//   daily/{date}/{pushId}.uid        rewritten FROM → TO (rows stay put)
//   timed/{pushId}.uid               rewritten FROM → TO
//   dailyArchive/{date}/{pushId}.uid rewritten FROM → TO
//   weekly/{week}/{FROM}             moved to weekly/{week}/{TO}; if TO
//                                    already has the week, per-day MIN merge
//   users/{FROM}/dailyHistory        union into TO (TO wins a date conflict)
//   users/{FROM} streak fields       continued across the boundary with the
//                                    SAME applyStreakContinuation math the
//                                    game uses (molt covers spend properly),
//                                    floored by the history-derived run
//   users/{FROM}/weeklyAttempts      per-week day union (attempt caps stay honest)
//   users/*/friends/{FROM}           re-keyed to {TO} on BOTH sides
//   pushSubscription/notificationPrefs  copied only where TO has none
//   any unrecognized users/{FROM} key   copied-if-absent and REPORTED
// then purges users/{FROM}. handicaps.json still keys FROM until the next
// nightly refit re-fits the rewritten rows under TO (one day of `unrated`
// on the Adjusted views).
//
// DEFAULTS TO DRY RUN. Same auth idiom as delete-leaderboard-row.mjs: raw
// REST against the RTDB with an admin token minted from
// FIREBASE_SERVICE_ACCOUNT (bypasses the append-only / owner-write rules).
//
// Usage (env-driven, set by the merge-user-accounts workflow):
//   FROM_UID=<abandoned uid> TO_UID=<device's current uid> \
//   FIREBASE_SERVICE_ACCOUNT='{...}' node scripts/merge-user-accounts.mjs [--apply]

import { createSign } from 'node:crypto';
import { applyStreakContinuation } from '../src/logic/moltDay.js';
import { streakBearingDates } from '../src/logic/archiveEligibility.js';
import { computeStreakFromHistory } from '../src/storage/statsStorage.js';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';
const APPLY = process.argv.includes('--apply');

const FROM_UID = (process.env.FROM_UID || '').trim();
const TO_UID = (process.env.TO_UID || '').trim();

// Mirrors delete-leaderboard-row.mjs / send-push.mjs.
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
async function dbSet(path, value, token) {
  const r = await fetch(_url(path, token), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`PUT ${path} -> ${r.status} ${await r.text()}`);
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

// The users/{uid} keys this script knows how to merge. Anything else in the
// FROM subtree is copied-if-absent and loudly reported, never silently lost.
const KNOWN_USER_KEYS = new Set([
  'maxCheckpoint', 'dailyStreak', 'bestDailyStreak', 'lastDailyDate',
  'moltDay', 'dailyHistory', 'weeklyAttempts', 'friends',
  'pushSubscription', 'notificationPrefs',
]);

(async () => {
  if (!FROM_UID || !TO_UID) { console.error('FROM_UID and TO_UID env must both be set'); process.exit(2); }
  if (FROM_UID === TO_UID) { console.error('REFUSING: FROM_UID === TO_UID'); process.exit(2); }

  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saJson) { console.error('FIREBASE_SERVICE_ACCOUNT not set'); process.exit(1); }
  let serviceAccount;
  try { serviceAccount = JSON.parse(saJson); }
  catch (e) { console.error('FIREBASE_SERVICE_ACCOUNT not valid JSON:', e.message); process.exit(1); }

  console.log(APPLY
    ? '*** APPLY MODE — writes WILL be made to production ***'
    : '*** DRY RUN — no writes. Pass --apply to execute. ***');
  console.log(`FROM_UID (abandoned): ${FROM_UID}`);
  console.log(`TO_UID   (surviving): ${TO_UID}`);

  const token = await getAccessToken(serviceAccount);

  // ── 1. Inventory ──
  const [allDaily, allWeekly, allTimed, allArchive, allUsers] = await Promise.all([
    dbGet('daily', token),
    dbGet('weekly', token),
    dbGet('timed', token),
    dbGet('dailyArchive', token),
    dbGet('users', token),
  ]);
  const fromTree = (allUsers || {})[FROM_UID] || null;
  const toTree = (allUsers || {})[TO_UID] || null;

  const dailyHits = [];
  const collisions = [];
  for (const [date, rows] of Object.entries(allDaily || {})) {
    const fromRows = Object.entries(rows || {}).filter(([, r]) => r && r.uid === FROM_UID);
    const toRows = Object.values(rows || {}).filter((r) => r && r.uid === TO_UID);
    for (const [pushId, row] of fromRows) dailyHits.push({ date, pushId, name: row.name, time: row.time });
    if (fromRows.length && toRows.length) collisions.push(date);
  }
  const weeklyHits = Object.entries(allWeekly || {})
    .filter(([, rows]) => rows && rows[FROM_UID])
    .map(([week, rows]) => ({ week, row: rows[FROM_UID], toRow: rows[TO_UID] || null }));
  const timedHits = Object.entries(allTimed || {})
    .filter(([, r]) => r && r.uid === FROM_UID).map(([pushId, r]) => ({ pushId, time: r.time }));
  const archiveHits = [];
  for (const [date, rows] of Object.entries(allArchive || {})) {
    for (const [pushId, row] of Object.entries(rows || {})) {
      if (row && row.uid === FROM_UID) archiveHits.push({ date, pushId, time: row.time });
    }
  }
  // Friendships pointing AT the old uid, on any account.
  const friendBackRefs = Object.entries(allUsers || {})
    .filter(([uid, tree]) => uid !== FROM_UID && tree && tree.friends && tree.friends[FROM_UID])
    .map(([uid, tree]) => ({ ownerUid: uid, entry: tree.friends[FROM_UID] }));

  console.log(`\n=== inventory for ${FROM_UID} ===`);
  console.log(`  daily rows: ${dailyHits.length} (${dailyHits[0]?.date || '-'} → ${dailyHits[dailyHits.length - 1]?.date || '-'})`);
  console.log(`  weekly rows: ${weeklyHits.length}${weeklyHits.some(h => h.toRow) ? ' (SOME WEEKS ALSO HAVE A TO_UID ROW — per-day min merge)' : ''}`);
  console.log(`  timed rows: ${timedHits.length}, dailyArchive rows: ${archiveHits.length}`);
  console.log(`  users subtree keys: ${fromTree ? Object.keys(fromTree).join(', ') : '(none)'}`);
  console.log(`  friend lists referencing it: ${friendBackRefs.length}`);
  if (collisions.length) {
    console.log(`  ⚠ SAME-DATE daily rows under BOTH uids on: ${collisions.join(', ')} — after the rewrite`);
    console.log(`    those dates will show two rows for TO_UID (use delete-leaderboard-row.yml to prune).`);
  }
  if (!fromTree && dailyHits.length === 0 && weeklyHits.length === 0) {
    console.log('\nNothing to merge — is FROM_UID right?');
    process.exit(2);
  }

  // ── 2. Leaderboard uid rewrites ──
  console.log(`\n=== plan: leaderboard rewrites ===`);
  for (const h of dailyHits) {
    await step(`daily/${h.date}/${h.pushId}/uid → TO (${h.name} ${h.time}s)`,
      () => dbSet(`daily/${h.date}/${h.pushId}/uid`, TO_UID, token));
  }
  for (const h of timedHits) {
    await step(`timed/${h.pushId}/uid → TO (${h.time}s)`,
      () => dbSet(`timed/${h.pushId}/uid`, TO_UID, token));
  }
  for (const h of archiveHits) {
    await step(`dailyArchive/${h.date}/${h.pushId}/uid → TO (${h.time}s)`,
      () => dbSet(`dailyArchive/${h.date}/${h.pushId}/uid`, TO_UID, token));
  }
  for (const { week, row, toRow } of weeklyHits) {
    let merged = row;
    if (toRow) {
      // Both accounts submitted this week: per-day best, overall best time.
      const dayTimes = { ...(row.dayTimes || {}) };
      for (const [d, t] of Object.entries(toRow.dayTimes || {})) {
        dayTimes[d] = dayTimes[d] == null ? t : Math.min(dayTimes[d], t);
      }
      merged = { ...row, ...toRow, dayTimes, bestTime: Math.min(row.bestTime, toRow.bestTime) };
    }
    await step(`weekly/${week}: move ${FROM_UID} row to ${TO_UID}${toRow ? ' (merged with existing)' : ''}`,
      async () => { await dbSet(`weekly/${week}/${TO_UID}`, merged, token); await dbDelete(`weekly/${week}/${FROM_UID}`, token); });
  }

  // ── 3. users subtree merge ──
  console.log(`\n=== plan: users/${TO_UID} merge ===`);
  const from = fromTree || {};
  const to = toTree || {};

  // dailyHistory union — TO wins a same-date conflict (it is the account
  // the device is live on; a conflict means both accounts recorded the date).
  const mergedHistory = { ...(from.dailyHistory || {}) , ...(to.dailyHistory || {}) };
  const newHistoryDates = Object.keys(from.dailyHistory || {}).filter((d) => !(to.dailyHistory || {})[d]);
  for (const d of newHistoryDates) {
    await step(`dailyHistory/${d} ← FROM row (time=${from.dailyHistory[d].time}s)`,
      () => dbSet(`users/${TO_UID}/dailyHistory/${d}`, from.dailyHistory[d], token));
  }
  const historyConflicts = Object.keys(from.dailyHistory || {}).filter((d) => (to.dailyHistory || {})[d]);
  if (historyConflicts.length) console.log(`  (TO already had, kept TO's: ${historyConflicts.join(', ')})`);

  // Streak: continue FROM's streak across the account boundary with the
  // game's own molt-aware math, then floor by the merged-history-derived run
  // (reconciler semantics — upward only).
  const entries = Object.entries(mergedHistory).map(([date, v]) => ({ date, archive: v && v.archive === true }));
  const liveDates = streakBearingDates(entries);
  const derived = computeStreakFromHistory(liveDates);
  let streak = derived.streak;
  let banked = Math.max(from.moltDay?.banked || 0, to.moltDay?.banked || 0);
  let lastDailyDate = derived.lastDate || to.lastDailyDate || from.lastDailyDate || null;
  if (from.lastDailyDate && to.lastDailyDate && to.lastDailyDate > from.lastDailyDate) {
    const cont = applyStreakContinuation({
      lastDailyDate: from.lastDailyDate,
      streak: from.dailyStreak || 0,
      banked: from.moltDay?.banked || 0,
      today: to.lastDailyDate,
    });
    if (cont.streak >= streak) { streak = cont.streak; banked = cont.banked; }
    lastDailyDate = to.lastDailyDate;
  } else if (from.lastDailyDate && !to.lastDailyDate) {
    streak = Math.max(streak, from.dailyStreak || 0);
    lastDailyDate = from.lastDailyDate;
  }
  const bestDailyStreak = Math.max(from.bestDailyStreak || 0, to.bestDailyStreak || 0, streak);
  const maxCheckpoint = Math.max(from.maxCheckpoint || 0, to.maxCheckpoint || 0);
  const moltLastUse = [from.moltDay?.lastUse, to.moltDay?.lastUse].filter(Boolean)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0] || null;
  console.log(`  streak: derived-from-history=${derived.streak}, final=${streak} (best=${bestDailyStreak}, lastDailyDate=${lastDailyDate}, molt banked=${banked})`);
  await step(`set streak fields on TO (streak=${streak}, best=${bestDailyStreak}, maxCheckpoint=${maxCheckpoint})`,
    async () => {
      await dbSet(`users/${TO_UID}/dailyStreak`, streak, token);
      await dbSet(`users/${TO_UID}/bestDailyStreak`, bestDailyStreak, token);
      if (lastDailyDate) await dbSet(`users/${TO_UID}/lastDailyDate`, lastDailyDate, token);
      if (maxCheckpoint > 0) await dbSet(`users/${TO_UID}/maxCheckpoint`, maxCheckpoint, token);
      await dbSet(`users/${TO_UID}/moltDay`, { banked, lastUse: moltLastUse }, token);
    });

  // weeklyAttempts: per-week day union so the one-attempt-per-day cap stays honest.
  for (const [week, node] of Object.entries(from.weeklyAttempts || {})) {
    const fromDays = node?.dayAttempts || {};
    const toDays = to.weeklyAttempts?.[week]?.dayAttempts || {};
    const newDays = Object.keys(fromDays).filter((d) => !toDays[d]);
    for (const d of newDays) {
      await step(`weeklyAttempts/${week}/dayAttempts/${d} ← true`,
        () => dbSet(`users/${TO_UID}/weeklyAttempts/${week}/dayAttempts/${d}`, fromDays[d], token));
    }
  }

  // Friends — FROM's own list joins TO's, and every back-reference re-keys.
  for (const [fUid, entry] of Object.entries(from.friends || {})) {
    if (fUid === TO_UID) continue; // an account can't befriend itself
    if (to.friends && to.friends[fUid]) continue;
    await step(`friends/${fUid} ← FROM entry (${entry?.name || '?'})`,
      () => dbSet(`users/${TO_UID}/friends/${fUid}`, entry, token));
  }
  for (const { ownerUid, entry } of friendBackRefs) {
    await step(`users/${ownerUid}/friends: re-key ${FROM_UID} → ${TO_UID} (${entry?.name || '?'})`,
      async () => {
        await dbSet(`users/${ownerUid}/friends/${TO_UID}`, entry, token);
        await dbDelete(`users/${ownerUid}/friends/${FROM_UID}`, token);
      });
  }

  // Push subscription + prefs: never clobber the live device's own values.
  for (const key of ['pushSubscription', 'notificationPrefs']) {
    if (from[key] && !to[key]) {
      await step(`${key} ← FROM (TO had none; if pushes don't arrive, re-toggle Notifications in Settings)`,
        () => dbSet(`users/${TO_UID}/${key}`, from[key], token));
    }
  }

  // Unknown keys: copy-if-absent + report, never silently drop.
  const unknown = Object.keys(from).filter((k) => !KNOWN_USER_KEYS.has(k));
  for (const k of unknown) {
    console.log(`  ⚠ unrecognized users key "${k}" on FROM — copying if TO lacks it; review manually.`);
    if (to[k] == null) {
      await step(`${k} ← FROM (unrecognized key)`, () => dbSet(`users/${TO_UID}/${k}`, from[k], token));
    }
  }

  // ── 4. Purge the abandoned subtree ──
  console.log(`\n=== plan: purge ===`);
  if (fromTree) {
    await step(`delete users/${FROM_UID} subtree`, () => dbDelete(`users/${FROM_UID}`, token));
  } else {
    console.log('  (no FROM subtree)');
  }

  // ── 5. Verify ──
  if (APPLY) {
    console.log(`\n=== VERIFY (post-write re-read) ===`);
    const [vDaily, vWeekly, vUsers] = await Promise.all([
      dbGet('daily', token), dbGet('weekly', token), dbGet('users', token),
    ]);
    let fromLeft = 0, toCount = 0;
    for (const rows of Object.values(vDaily || {})) {
      for (const r of Object.values(rows || {})) {
        if (r?.uid === FROM_UID) fromLeft++;
        if (r?.uid === TO_UID) toCount++;
      }
    }
    console.log(`  daily rows: FROM has ${fromLeft} (want 0), TO has ${toCount}`);
    const weeklyLeft = Object.values(vWeekly || {}).filter((rows) => rows && rows[FROM_UID]).length;
    console.log(`  weekly rows: FROM has ${weeklyLeft} (want 0)`);
    console.log(`  users/${FROM_UID}: ${vUsers?.[FROM_UID] == null ? 'gone ✓' : 'STILL PRESENT ✗'}`);
    console.log(`  users/${TO_UID}: dailyHistory dates=${Object.keys(vUsers?.[TO_UID]?.dailyHistory || {}).length}, streak=${vUsers?.[TO_UID]?.dailyStreak}`);
    console.log('\nReminder: handicaps.json still keys the OLD uid until the nightly refit;');
    console.log('the Adjusted views show the player unrated for up to one day.');
    console.log('Have the player link Google/email in Settings so this cannot recur.');
  } else {
    console.log('\nDry run complete. Review the plan above, then re-run with --apply (dry_run=false).');
  }
})().catch((err) => {
  console.error('merge-user-accounts failed:', err.message);
  process.exit(1);
});
