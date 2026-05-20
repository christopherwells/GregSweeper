// One-shot uid migration. Rewrites all of a user's data in cloud from a
// source uid to a target uid:
//   1. Daily leaderboard entries — rewrite `uid` field on each
//      daily/{date}/{pushId} where v.uid === source.
//   2. Per-user subtree — merge users/{source}/* into users/{target}/*
//      (max-merge for streak/checkpoint, later date wins, union for
//      dailyHistory + weeklyAttempts).
//   3. Delete users/{source}/* after migration.
//
// Used when an anonymous uid changed mid-session (e.g. signOut + sign
// back in created a new anonymous uid) and the user wants to preserve
// their historical leaderboard + streak attribution under their new
// (typically Google-linked) uid.
//
// Idempotent (re-running won't double-write — the source is gone after
// the first run). Run via the `migrate-uid` GitHub Actions workflow.

import admin from 'firebase-admin';

const sourceUid = process.argv[2];
const targetUid = process.argv[3];
if (!sourceUid || !targetUid || sourceUid === targetUid) {
  console.error('usage: migrate-uid.mjs <sourceUid> <targetUid>');
  console.error('  source and target must differ');
  process.exit(2);
}

const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!sa) {
  console.error('FIREBASE_SERVICE_ACCOUNT env not set');
  process.exit(2);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(sa)),
  databaseURL: 'https://gregsweeper-66d02-default-rtdb.firebaseio.com',
});
const db = admin.database();

async function rewriteDailyEntries() {
  console.log(`[1/3] Scanning daily/ for entries with uid=${sourceUid}...`);
  const root = await db.ref('daily').once('value');
  const updates = {};
  let count = 0;
  root.forEach((dateNode) => {
    const date = dateNode.key;
    dateNode.forEach((entryNode) => {
      const pushId = entryNode.key;
      const v = entryNode.val();
      if (v && v.uid === sourceUid) {
        updates[`daily/${date}/${pushId}/uid`] = targetUid;
        count++;
      }
    });
  });
  console.log(`  found ${count} daily entries to rewrite.`);
  if (count === 0) return 0;
  await db.ref().update(updates);
  console.log(`  rewrote ${count} entries.`);
  return count;
}

async function migrateUserSubtree() {
  console.log(`[2/3] Migrating users/${sourceUid} → users/${targetUid}...`);
  const [srcSnap, tgtSnap] = await Promise.all([
    db.ref(`users/${sourceUid}`).once('value'),
    db.ref(`users/${targetUid}`).once('value'),
  ]);
  const src = srcSnap.val() || null;
  const tgt = tgtSnap.val() || {};
  if (!src) {
    console.log(`  users/${sourceUid} is empty — nothing to merge.`);
    return null;
  }

  const merged = { ...tgt };

  // Max-merge for the cumulative counters.
  if (src.maxCheckpoint != null) {
    merged.maxCheckpoint = Math.max(tgt.maxCheckpoint || 0, src.maxCheckpoint);
  }
  if (src.dailyStreak != null) {
    merged.dailyStreak = Math.max(tgt.dailyStreak || 0, src.dailyStreak);
  }
  if (src.bestDailyStreak != null) {
    merged.bestDailyStreak = Math.max(tgt.bestDailyStreak || 0, src.bestDailyStreak);
  }

  // Later date wins for lastDailyDate.
  if (src.lastDailyDate && (!tgt.lastDailyDate || src.lastDailyDate > tgt.lastDailyDate)) {
    merged.lastDailyDate = src.lastDailyDate;
  }

  // Union dailyHistory (target wins on same-date collision — its time is
  // the most recently played one on that date for the user).
  if (src.dailyHistory) {
    merged.dailyHistory = { ...src.dailyHistory, ...(tgt.dailyHistory || {}) };
  }

  // Union weeklyAttempts (target wins on collision).
  if (src.weeklyAttempts) {
    merged.weeklyAttempts = merged.weeklyAttempts || {};
    for (const weekStart of Object.keys(src.weeklyAttempts)) {
      const srcWeek = src.weeklyAttempts[weekStart] || {};
      const tgtWeek = (tgt.weeklyAttempts && tgt.weeklyAttempts[weekStart]) || {};
      const srcDays = srcWeek.dayAttempts || {};
      const tgtDays = tgtWeek.dayAttempts || {};
      merged.weeklyAttempts[weekStart] = {
        dayAttempts: { ...srcDays, ...tgtDays },
      };
    }
  }

  // Keep target's pushSubscription + notificationPrefs (the device's
  // current state). Don't merge — source's are from a stale uid.

  console.log(`  merged shape:`, Object.keys(merged).map(k => {
    const v = merged[k];
    if (v && typeof v === 'object') return `${k}=<obj:${Object.keys(v).length}>`;
    return `${k}=${JSON.stringify(v)}`;
  }).join(' '));

  await db.ref(`users/${targetUid}`).set(merged);
  console.log(`  wrote users/${targetUid}.`);
  return merged;
}

async function deleteSource() {
  console.log(`[3/3] Deleting users/${sourceUid}...`);
  await db.ref(`users/${sourceUid}`).remove();
  console.log(`  done.`);
}

(async () => {
  try {
    const rewrote = await rewriteDailyEntries();
    await migrateUserSubtree();
    await deleteSource();
    console.log(`Migration complete. Rewrote ${rewrote} daily entries; merged users/${sourceUid} → users/${targetUid}.`);
    process.exit(0);
  } catch (err) {
    console.error('Migration FAILED:', err);
    process.exit(1);
  }
})();
