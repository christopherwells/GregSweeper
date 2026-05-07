// Read-only diagnostic. Lists every user with notification prefs or a
// push subscription, redacted. Useful when troubleshooting whether a
// player's toggle / hour / token actually persisted to Firebase.
//
// Usage (workflow_dispatch only — needs FIREBASE_SERVICE_ACCOUNT):
//   node scripts/diagnose-push.mjs

import { createSign } from 'node:crypto';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  };
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(claims)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const sig = signer.sign(serviceAccount.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${unsigned}.${sig}`,
  });
  if (!r.ok) throw new Error(`token mint failed: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

(async () => {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const accessToken = await getAccessToken(sa);
  const r = await fetch(`${DB_BASE}/users.json?access_token=${encodeURIComponent(accessToken)}`);
  if (!r.ok) {
    console.error(`users fetch failed: ${r.status}`);
    process.exit(1);
  }
  const users = (await r.json()) || {};
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', hour: '2-digit', hour12: false,
  });
  const currentHourET = parseInt(fmt.format(new Date()).split(', ')[1] || fmt.format(new Date()), 10);
  console.log(`Current ET hour: ${currentHourET}`);
  console.log('');

  let count = 0;
  for (const [uid, u] of Object.entries(users)) {
    const prefs = u?.notificationPrefs;
    const sub = u?.pushSubscription;
    if (!prefs && !sub) continue;
    count++;
    const tokenLen = sub?.token?.length || 0;
    const tokenPreview = sub?.token ? `${sub.token.slice(0, 12)}…(${tokenLen} chars)` : '(none)';
    const wouldFireNow = prefs?.enabled === true && prefs?.hourLocal === currentHourET && !!sub?.token;
    console.log(`uid=${uid}`);
    console.log(`  prefs.enabled       = ${prefs?.enabled}`);
    console.log(`  prefs.hourLocal     = ${prefs?.hourLocal}`);
    console.log(`  prefs.dailyReminder = ${prefs?.dailyReminder}`);
    console.log(`  pushSubscription    = ${tokenPreview}`);
    console.log(`  subscribedAt        = ${sub?.subscribedAt ? new Date(sub.subscribedAt).toISOString() : '(none)'}`);
    console.log(`  would-fire-now-${currentHourET}h = ${wouldFireNow}`);
    console.log('');
  }
  if (count === 0) console.log('(no users have prefs or subscription)');
})().catch(err => { console.error(err.message); process.exit(1); });
