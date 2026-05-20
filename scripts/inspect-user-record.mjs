// One-shot inspection of a single user's record under users/{uid}/.
// Run via the inspect-user-record GitHub Actions workflow (it has the
// FIREBASE_SERVICE_ACCOUNT secret loaded). Prints the whole subtree
// plus counts so we can spot "empty subtree" vs "missing top-level
// streak fields" vs "different shape than expected" at a glance.

import admin from 'firebase-admin';

const uid = process.argv[2];
if (!uid) {
  console.error('usage: node inspect-user-record.mjs <uid>');
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
  const ref = db.ref(`users/${uid}`);
  const snap = await ref.once('value');
  const val = snap.val();
  console.log('=== users/' + uid + ' ===');
  if (val === null) {
    console.log('(does not exist — empty subtree)');
  } else {
    const topKeys = Object.keys(val);
    console.log('top-level keys:', topKeys);
    for (const k of topKeys) {
      const v = val[k];
      if (v && typeof v === 'object') {
        console.log(`  ${k}: object with ${Object.keys(v).length} children`);
        // For dailyHistory, show how many dates and the most recent few
        if (k === 'dailyHistory') {
          const dates = Object.keys(v).sort();
          console.log(`    earliest: ${dates[0]}`);
          console.log(`    latest:   ${dates[dates.length - 1]}`);
          console.log(`    total:    ${dates.length}`);
        }
      } else {
        console.log(`  ${k}: ${JSON.stringify(v)}`);
      }
    }
  }
  process.exit(0);
})().catch(err => {
  console.error('inspect failed:', err);
  process.exit(1);
});
