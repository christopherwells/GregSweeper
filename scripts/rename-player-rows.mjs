// Rename the displayed player name on every historical leaderboard row
// belonging to a uid — daily/{date}/{pushId}.name (rows matched by .uid)
// and weekly/{weekStart}/{uid}.name. Run via the rename-player-rows
// GitHub Actions workflow (has FIREBASE_SERVICE_ACCOUNT loaded).
//
// Only the display name changes; times, dates, events, and uids are
// untouched. The player's DEVICE still holds its own saved name in
// localStorage — they should update Settings → name too, or future
// submissions will reintroduce the old spelling.
//
// usage: node rename-player-rows.mjs <uid> <newName> [--dry-run]

import admin from 'firebase-admin';

const uid = process.argv[2];
const newName = process.argv[3];
const dryRun = process.argv.includes('--dry-run');

if (!uid || !newName) {
  console.error('usage: node rename-player-rows.mjs <uid> <newName> [--dry-run]');
  process.exit(2);
}

// Mirror the firebase-rules.json name validation so an admin rename can't
// produce a name the client rules would have rejected.
if (newName.length < 1 || newName.length > 20 || /[<>&"'`@]/.test(newName)) {
  console.error(`newName ${JSON.stringify(newName)} violates the leaderboard name rules (1-20 chars, no <>&"'\`@)`);
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

(async () => {
  let renamed = 0;

  // Daily rows: push-id keyed, matched by the row's uid field.
  const daily = (await db.ref('daily').once('value')).val() || {};
  for (const [date, rows] of Object.entries(daily)) {
    for (const [pushId, row] of Object.entries(rows || {})) {
      if (row && row.uid === uid && row.name !== newName) {
        console.log(`daily/${date}/${pushId}: "${row.name}" -> "${newName}"`);
        if (!dryRun) await db.ref(`daily/${date}/${pushId}/name`).set(newName);
        renamed++;
      }
    }
  }

  // Weekly rows: keyed by uid directly.
  const weekly = (await db.ref('weekly').once('value')).val() || {};
  for (const [week, rows] of Object.entries(weekly)) {
    const row = (rows || {})[uid];
    if (row && row.name !== newName) {
      console.log(`weekly/${week}/${uid}: "${row.name}" -> "${newName}"`);
      if (!dryRun) await db.ref(`weekly/${week}/${uid}/name`).set(newName);
      renamed++;
    }
  }

  console.log(`${dryRun ? '[dry-run] would rename' : 'renamed'} ${renamed} row(s)`);
  process.exit(0);
})().catch(err => {
  console.error('rename failed:', err);
  process.exit(1);
});
