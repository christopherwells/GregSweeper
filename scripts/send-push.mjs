// Send push notifications to subscribers whose chosen ET hour matches
// the current ET hour. Run by the notify-daily-ready.yml GitHub
// Actions workflow on `0 * * * *` (every hour at minute 0).
//
// Two passes per run:
//
//   1. Reminder pass — for users with notificationPrefs.enabled === true
//      and notificationPrefs.hourLocal === currentHourET, send a daily
//      or weekly reminder.
//        • weekly — Monday (the fresh weekly puzzle just opened)
//        • daily  — any other day
//
//   2. Streak-warning pass — only when currentHourET === 20 (8pm ET),
//      regardless of each user's hourLocal preference. For every user
//      with notificationPrefs.streakWarning !== false, dailyStreak ≥ 3,
//      and lastDailyDate < today (i.e., they haven't played yet today
//      and their streak is genuinely at risk), send a streak-rescue
//      push naming their streak length. Uses a separate tag so it
//      stacks with the morning reminder rather than replacing it.
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
  // Monday morning has a fresh weekly puzzle dropping; surface that
  // rather than the daily reminder.
  if (dow === 1) return 'weekly';
  return 'daily';
}

// Per-category message rotation. Picked deterministically by date so
// every subscriber on the same day sees the same wording, but day-to-
// day the phrasing varies and doesn't feel scripted.
const DAILY_BODIES = [
  "Today's puzzle is up. ~2 minutes.",
  "Fresh daily — same board for everyone today.",
  "Today's daily is live. Sharpen up.",
  "Quick puzzle break? Daily's waiting.",
  "Time to defuse. Today's daily is open.",
  "One board, one shot. Today's daily is ready.",
  "Daily's open — see if you can beat par.",
];
const WEEKLY_BODIES = [
  "New weekly. One board all week, best time wins.",
  "This week's puzzle is open. 7 chances, fastest run keeps the crown.",
  "Fresh weekly puzzle. Same board Mon–Sun — your best attempt counts.",
];
// Streak-rescue evening pushes. {streak} interpolates the user's current
// dailyStreak. Tone is direct but not panicked — the reader DOES want
// the reminder, that's why they enabled streakWarning.
const STREAK_BODIES = [
  "Your {streak}-day streak ends at midnight ET.",
  "{streak} days in a row. Don't drop it tonight.",
  "Streak alert: {streak} days going. Today's daily is still open.",
];
function _pickBody(date, pool) {
  // Stable per-date hash so all subscribers on the same date see the
  // same line. Sum of the year-month-day digits mod pool length.
  const sum = date.split('-').reduce((s, n) => s + Number(n), 0);
  return pool[sum % pool.length];
}

function _payloadFor(category, date) {
  if (category === 'weekly') {
    return {
      title: 'GregSweeper — Weekly puzzle',
      body: _pickBody(date, WEEKLY_BODIES),
      tag: 'gregsweeper-weekly',
      deepLink: './?mode=weekly',
    };
  }
  return {
    title: 'GregSweeper — Daily puzzle',
    body: _pickBody(date, DAILY_BODIES),
    tag: 'gregsweeper-daily',
    deepLink: './?mode=daily',
  };
}

function _streakPayload(streak, date) {
  const body = _pickBody(date, STREAK_BODIES).replace('{streak}', String(streak));
  return {
    title: 'GregSweeper — Streak warning',
    body,
    tag: 'gregsweeper-streak',
    deepLink: './?mode=daily',
  };
}

// 8pm ET — late enough that a user who plays after work has had their
// chance, early enough to leave them several hours to act on the
// rescue. Hardcoded rather than per-user because the at-risk window
// is the same for everyone (midnight ET).
const STREAK_WARNING_HOUR = 20;

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
  // Belt-and-suspenders payload. Two reasons we ship title/body in both
  // `notification` AND `data`:
  //   1. The current SW (v1.5.52+) reads the FCM-wrapped shape and
  //      pulls from `data.*` first. Belt.
  //   2. Older SWs that pre-date the multi-shape parser pull from the
  //      top-level `notification.*` field that FCM unpacks for them.
  //      Suspenders, so users with stale SWs still see the body.
  // We deliberately do NOT set webpush.notification — that's the
  // override gotcha that silently drops title/body for some browsers.
  // The icon path lives in sw.js's showNotification call, not here.
  // Schema version. The push payload is a permanent contract with the
  // SW handler — a push delivered today might be processed by a SW
  // that's days or weeks old (the user closed the app and opened the
  // notification later). Versioning lets us evolve the payload safely:
  // the SW reads `v` and either handles it natively (matching version)
  // or falls back to the v1 path (lower / missing version). When `v`
  // is incremented, the OLD SW logs an unknown-version warning that
  // surfaces in remote diagnostics so we can see staleness rates.
  // FCM's `data` field accepts strings only, so the version is sent as
  // a numeric string ("1") rather than a number.
  const PUSH_SCHEMA_VERSION = '1';
  const message = {
    message: {
      token,
      notification: {
        title: payload.title,
        body: payload.body,
      },
      data: {
        v: PUSH_SCHEMA_VERSION,
        title: payload.title,
        body: payload.body,
        tag: payload.tag,
        deepLink: payload.deepLink,
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

// Generic send pass: walk every user, ask the caller's perUserPayload
// callback whether and what to send. Centralizes the FCM send + invalid-
// subscription cleanup so the reminder pass and the streak pass don't
// duplicate that boilerplate.
async function _sendPass(accessToken, users, { label, perUserPayload }) {
  let matched = 0, sent = 0, failed = 0;
  for (const [uid, userData] of Object.entries(users || {})) {
    const sub = userData?.pushSubscription;
    if (!sub || !sub.token) continue;
    const payload = perUserPayload(uid, userData);
    if (!payload) continue;
    matched++;
    try {
      await sendOneFcmMessage(accessToken, sub.token, payload);
      sent++;
    } catch (err) {
      failed++;
      console.warn(`  [${label}] uid=${uid}: ${err.message}`);
      // Only clear the subscription on EXPLICIT token-invalidation signals
      // from FCM. UNREGISTERED (token no longer valid) and NOT_FOUND
      // (legacy) are the only error codes that mean "this token will
      // never work again." Everything else (transient 4xx, 5xx) keeps
      // the subscription and lets the next hourly cron retry.
      if (/UNREGISTERED|"NOT_FOUND"|status"\s*:\s*"NOT_FOUND/.test(err.message)) {
        try {
          await fetch(`${DB_BASE}/users/${uid}/pushSubscription.json?access_token=${encodeURIComponent(accessToken)}`, { method: 'DELETE' });
          console.warn(`    cleared invalid subscription for ${uid}`);
        } catch {}
      }
    }
  }
  return { matched, sent, failed };
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
  const reminderPayload = _payloadFor(category, date);

  console.log(`[${date} ${String(hour).padStart(2, '0')}:00 ET] category=${category}`);

  const accessToken = await getAccessToken(serviceAccount);
  const users = await fetchAllUsers(accessToken);

  // ── Reminder pass: hourLocal-matched daily/weekly push ─────
  const r = await _sendPass(accessToken, users, {
    label: 'reminder',
    perUserPayload(uid, userData) {
      const prefs = userData?.notificationPrefs;
      if (!prefs || !prefs.enabled) return null;
      if (prefs.hourLocal !== hour) return null;
      // Per-category opt-outs (default ON if missing — matches the toggle defaults).
      if (category === 'daily' && prefs.dailyReminder === false) return null;
      return reminderPayload;
    },
  });

  // ── Streak-warning pass: 8pm ET evening rescue ─────────────
  let s = { matched: 0, sent: 0, failed: 0 };
  if (hour === STREAK_WARNING_HOUR) {
    s = await _sendPass(accessToken, users, {
      label: 'streak-warning',
      perUserPayload(uid, userData) {
        const prefs = userData?.notificationPrefs;
        if (!prefs || !prefs.enabled) return null;
        // Default ON if missing — same convention as dailyReminder.
        if (prefs.streakWarning === false) return null;
        const streak = userData?.dailyStreak || 0;
        if (streak < 3) return null;
        const lastDate = userData?.lastDailyDate || '';
        // String comparison works because YYYY-MM-DD is lexicographically
        // ordered. If lastDate >= today, they already played today.
        if (lastDate >= date) return null;
        return _streakPayload(streak, date);
      },
    });
  }

  console.log(`Done: reminder matched=${r.matched} sent=${r.sent} failed=${r.failed}; streak matched=${s.matched} sent=${s.sent} failed=${s.failed}`);
})().catch(err => {
  console.error('send-push failed:', err.message);
  process.exit(1);
});
