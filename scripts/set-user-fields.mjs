// One-shot admin-SDK write to update fields under users/{uid}/.
// Used for live-listener verification: a Firebase write from this
// script triggers any client's on('value') listener for the same uid,
// letting us prove cross-device real-time sync without involving a
// game-completion event. Run via the set-user-fields GitHub Actions
// workflow.
//
// Usage (from workflow):
//   node scripts/set-user-fields.mjs <uid> '<json-payload>'
//
// The payload is a flat object of top-level fields. Existing fields
// not in the payload are left alone (Firebase .update semantics).

import admin from 'firebase-admin';

const uid = process.argv[2];
const payloadJson = process.argv[3];
if (!uid || !payloadJson) {
  console.error('usage: set-user-fields.mjs <uid> <jsonPayload>');
  process.exit(2);
}

let payload;
try { payload = JSON.parse(payloadJson); }
catch (err) {
  console.error('payload must be valid JSON:', err.message);
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
  console.log(`Writing to users/${uid}:`, payload);
  await db.ref(`users/${uid}`).update(payload);
  const snap = await db.ref(`users/${uid}`).once('value');
  console.log('Post-write snapshot:', JSON.stringify(snap.val(), null, 2));
  process.exit(0);
})().catch(err => {
  console.error('Set failed:', err);
  process.exit(1);
});
