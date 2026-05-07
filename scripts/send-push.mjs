// Send push notifications to subscribers whose chosen ET hour matches
// the current ET hour. Run by the notify-daily-ready.yml GitHub
// Actions workflow on `0 * * * *` (every hour at minute 0).
//
// For each subscribed user with notificationPrefs.enabled === true and
// notificationPrefs.hourLocal === currentHourET, send one of three
// notification categories based on the calendar:
//
//   • weekly  — Monday morning, when a fresh weekly puzzle just opened
//   • bonus   — dates listed in BONUS_DAILY_DATES (one-off events)
//   • daily   — the default, fired any other day
//
// FCM REST API is called with an OAuth2 access token derived from the
// service-account JSON in FIREBASE_SERVICE_ACCOUNT (repo secret). FCM
// itself handles VAPID under the hood for tokens generated via
// firebase.messaging().getToken — we don't have to sign per-request
// JWTs ourselves.
//
// Idempotent and resilient: per-user errors logged and skipped, never
// abort the whole batch. Re-running for the same hour is harmless
// (FCM dedupes by tag).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createSign } from 'node:crypto';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';
const FCM_PROJECT_ID = 'gregsweeper-66d02';
const FCM_SEND_URL = `https://fcm.googleapis.com/v1/projects/${FCM_PROJECT_ID}/messages:send`;

const __dirname = dirname(fileURLToPath(import.meta.url));

// Mirror src/main.js BONUS_DAILY_DATES — keeps weekly/bonus push
// content in sync with what the player actually sees on the title.
const BONUS_DAILY_DATES = new Set(['2026-05-07']);

function _etDateParts() {
  // America/New_York anchored YYYY-MM-DD + hour 0..23 + day-of-week.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false, weekday: 'short',
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t)?.value;
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const hour = parseInt(get('hour'), 10);
  const wd = get('weekday'); // 'Mon' .. 'Sun'
  const dowMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { date, hour, dow: dowMap[wd] || 0 };
}

function _categoryFor({ date, dow }) {
  // Monday = a fresh weekly puzzle just opened. Bonus dates take
  // precedence over the regular daily content. Otherwise default to
  // the daily reminder. (Weekly wins over bonus if both apply on the
  // same date — rare but Monday is the dramatic content.)
  if (dow === 1) return 'weekly';
  if (BONUS_DAILY_DATES.has(date)) return 'bonus';
  return 'daily';
}

function _payloadFor(category) {
  if (category === 'weekly') {
    return {
      title: 'GregSweeper — Weekly puzzle live',
      body: "This week's puzzle just opened. Same board for 7 days, best time wins.",
      tag: 'gregsweeper-weekly',
      deepLink: './?mode=weekly',
    };
  }
  if (category === 'bonus') {
    return {
      title: 'GregSweeper — Bonus daily today',
      body: "There's a bonus daily puzzle on top of the regular one — free play.",
      tag: 'gregsweeper-bonus',
      deepLink: './?mode=daily',
    };
  }
  return {
    title: 'GregSweeper — Daily puzzle ready',
    body: "Today's daily is waiting for you.",
    tag: 'gregsweeper-daily',
    deepLink: './?mode=daily',
  };
}

// Mint an OAuth2 access token from the service-account JSON. The token
// needs three scopes: firebase.messaging for FCM REST, firebase.database
// (+ userinfo.email) for the Realtime Database REST users-tree read.
// Without all three the FCM POST works but the users-tree fetch returns
// 401 Unauthorized.
async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: serviceAccount.client_email,
    scope: [
      'https://www.googleapis.com/auth/firebase.messaging',
      'https://www.googleapis.com/auth/firebase.database',
      'https://www.googleapis.com/auth/userinfo.email',
    ].join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const header = { alg: 'RS256', typ: 'JWT' };
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${enc(header)}.${enc(claims)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(serviceAccount.private_key, 'base64url');
  const jwt = `${unsigned}.${signature}`;

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

async function sendOneFcmMessage(accessToken, token, payload) {
  const message = {
    message: {
      token,
      notification: { title: payload.title, body: payload.body },
      data: {
        deepLink: payload.deepLink,
        tag: payload.tag,
      },
      webpush: {
        notification: {
          icon: '/assets/icon-192.png',
          badge: '/assets/icon-192.png',
          tag: payload.tag,
        },
        fcm_options: {
          link: payload.deepLink,
        },
      },
    },
  };
  const resp = await fetch(FCM_SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(message),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`FCM send failed: ${resp.status} ${txt}`);
  }
}

// Fetch the entire users/* tree at once. The /users path requires auth
// for individual sub-tree reads (uid match), but the SERVICE ACCOUNT
// bypasses rules entirely when using its access token via the REST DB
// API. So we read with the access token in the auth query param.
async function fetchAllUsers(accessToken) {
  const r = await fetch(`${DB_BASE}/users.json?access_token=${encodeURIComponent(accessToken)}`);
  if (!r.ok) {
    throw new Error(`users fetch failed: ${r.status} ${await r.text()}`);
  }
  return (await r.json()) || {};
}

(async () => {
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saJson) {
    console.error('FIREBASE_SERVICE_ACCOUNT env var not set — cannot mint access token');
    process.exit(1);
  }
  let serviceAccount;
  try { serviceAccount = JSON.parse(saJson); }
  catch (err) {
    console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON:', err.message);
    process.exit(1);
  }

  const { date, hour, dow } = _etDateParts();
  const category = _categoryFor({ date, dow });
  const payload = _payloadFor(category);

  console.log(`[${date} ${String(hour).padStart(2, '0')}:00 ET] category=${category}`);

  const accessToken = await getAccessToken(serviceAccount);
  const users = await fetchAllUsers(accessToken);

  let matched = 0;
  let sent = 0;
  let failed = 0;

  for (const [uid, userData] of Object.entries(users || {})) {
    const prefs = userData?.notificationPrefs;
    const sub = userData?.pushSubscription;
    if (!prefs || !prefs.enabled || !sub || !sub.token) continue;
    if (prefs.hourLocal !== hour) continue;
    // Per-category opt-outs (default ON if missing — same as the
    // toggle UI's defaults). streakWarning is reserved for a future
    // evening fire; not emitted by this script yet.
    if (category === 'daily' && prefs.dailyReminder === false) continue;

    matched++;
    try {
      await sendOneFcmMessage(accessToken, sub.token, payload);
      sent++;
    } catch (err) {
      failed++;
      console.warn(`  uid=${uid}: ${err.message}`);
      // FCM 404/410 means token invalid — clear the subscription.
      if (/\b40[04]\b/.test(err.message)) {
        try {
          await fetch(`${DB_BASE}/users/${uid}/pushSubscription.json?access_token=${encodeURIComponent(accessToken)}`, { method: 'DELETE' });
          console.warn(`    cleared invalid subscription for ${uid}`);
        } catch {}
      }
    }
  }

  console.log(`Done: matched=${matched}, sent=${sent}, failed=${failed}`);
})().catch(err => {
  console.error('send-push failed:', err.message);
  process.exit(1);
});
