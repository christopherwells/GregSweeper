// Backfill ONE daily leaderboard row that a player's device completed
// but never managed to upload (failed submissions whose retry queue
// aged out). The real time comes off the device via the diagnostics
// modal's "Copy diagnostics as JSON" button (pendingDaily /
// localResiduals entries) — NEVER fabricate a number.
//
// Writes daily/{date}/{pushId} ({name, time, bombHits, uid, timestamp})
// and users/{uid}/dailyHistory/{date} ({time, submittedAt}) so the
// player's history chart picks the day up too.
//
// usage: node backfill-score-row.mjs <date> <uid> <name> <time> [bombHits] [--write]
//        (dry-run by default; pass --write to commit)

import admin from 'firebase-admin';

const [date, uid, name, timeArg, maybeBombs] = process.argv.slice(2);
const doWrite = process.argv.includes('--write');
const time = parseFloat(timeArg);
const bombHits = /^\d+$/.test(maybeBombs || '') ? parseInt(maybeBombs, 10) : 0;

if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !uid || !name || !(time >= 5 && time <= 3600)) {
  console.error('usage: node backfill-score-row.mjs <YYYY-MM-DD> <uid> <name> <time 5-3600> [bombHits] [--write]');
  process.exit(2);
}
if (name.length > 20 || /[<>&"'`@]/.test(name)) {
  console.error('name violates leaderboard rules (1-20 chars, no <>&"\'`@)');
  process.exit(2);
}

const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!sa) { console.error('FIREBASE_SERVICE_ACCOUNT env not set'); process.exit(2); }
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(sa)),
  databaseURL: 'https://gregsweeper-66d02-default-rtdb.firebaseio.com',
});
const db = admin.database();

(async () => {
  // Refuse to double-write: if a row for this uid already exists on the
  // date, stop.
  const existing = (await db.ref(`daily/${date}`).once('value')).val() || {};
  for (const row of Object.values(existing)) {
    if (row && row.uid === uid) {
      console.error(`daily/${date} already has a row for this uid (${row.name}, ${row.time}s) — refusing to backfill`);
      process.exit(1);
    }
  }

  console.log(`${doWrite ? 'WRITE' : 'dry-run'}: daily/${date} <- { name: ${name}, time: ${time}, bombHits: ${bombHits}, uid: ${uid} }`);
  console.log(`${doWrite ? 'WRITE' : 'dry-run'}: users/${uid}/dailyHistory/${date} <- { time: ${time} }`);
  if (doWrite) {
    await db.ref(`daily/${date}`).push({
      name, time, bombHits, uid,
      timestamp: admin.database.ServerValue.TIMESTAMP,
    });
    await db.ref(`users/${uid}/dailyHistory/${date}`).set({
      time,
      submittedAt: admin.database.ServerValue.TIMESTAMP,
    });
    console.log('written');
  }
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
