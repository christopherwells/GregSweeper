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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createSign } from 'node:crypto';
import { coversTonight } from '../src/logic/moltDay.js';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';
const FCM_PROJECT_ID = 'gregsweeper-66d02';
const FCM_SEND_URL = `https://fcm.googleapis.com/v1/projects/${FCM_PROJECT_ID}/messages:send`;

const __dirname = dirname(fileURLToPath(import.meta.url));

// CLI flags. --dry-run prints what each pass WOULD send instead of calling FCM;
// --fixture <path> reads the users tree from a local JSON (so a dry-run needs
// no service account or network); --hour / --date override the ET clock so any
// hour or day (the 8pm pass, a covered-yesterday morning) can be exercised.
const _argv = process.argv.slice(2);
const DRY_RUN = _argv.includes('--dry-run');
function _flagVal(flag) { const i = _argv.indexOf(flag); return i >= 0 ? _argv[i + 1] : null; }
const FIXTURE = _flagVal('--fixture');
const HOUR_OVERRIDE = _flagVal('--hour');
const DATE_OVERRIDE = _flagVal('--date');

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
// Covered-night nudges: a banked molt day means skipping tonight won't break
// the streak, so the at-risk warning would be a lie. Send a calm "no pressure"
// line instead (the player opted into streak pushes, so we still say hello).
const STREAK_COVERED_BODIES = [
  "No pressure tonight — your molt day's got the streak. The board's still open.",
  "Streak's covered tonight. Play if you feel like it.",
  "A molt day has your streak tonight. The daily's there if you want it.",
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

// 8pm soft nudge when a molt day covers tonight (the streak is not at risk).
function _coveredPayload(date) {
  return {
    title: 'GregSweeper — Streak covered',
    body: _pickBody(date, STREAK_COVERED_BODIES),
    tag: 'gregsweeper-streak',
    deepLink: './?mode=daily',
  };
}

// Morning acknowledgment when a molt day covered yesterday's gap.
function _moltAckPayload(lastUse, date) {
  return {
    title: 'GregSweeper — Daily puzzle',
    body: `Your molt day covered ${_coveredPhrase(lastUse.covered)}. Streak intact at ${lastUse.streakKept || 0}. Today's daily is up.`,
    tag: 'gregsweeper-daily',
    deepLink: './?mode=daily',
  };
}

// Friendly weekday phrase for a covered gap (always 1-2 recent days). Parsed
// and formatted in UTC so the weekday matches the date string deterministically
// in the runner. Presentation only — the bank math lives in src/logic/moltDay.js.
function _coveredPhrase(dates) {
  const names = (dates || []).map(d =>
    new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }));
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.length} days`;
}

// Shift a YYYY-MM-DD by n calendar days (UTC, so no TZ drift on the date key).
function _shiftDate(d, n) {
  const dt = new Date(d + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

// Day-of-week (Mon=1..Sun=7) for a YYYY-MM-DD, for the --date dry-run override.
function _dowFromDate(d) {
  const day = new Date(d + 'T12:00:00Z').getUTCDay(); // 0=Sun..6=Sat
  return day === 0 ? 7 : day;
}

// ── Pure pass decisions (exported for test/sendPushMolt.test.mjs) ──────────
// Both return the FCM payload to send for one user, or null to skip them.

// Morning reminder: the per-category nudge, with a molt-day acknowledgment
// swapped in when a cover saved yesterday's gap.
export function reminderDecision({ prefs, category, hour, moltDay, date, yesterday }) {
  if (!prefs || !prefs.enabled) return null;
  if (prefs.hourLocal !== hour) return null;
  if (category === 'daily' && prefs.dailyReminder === false) return null;
  const lastUse = moltDay?.lastUse;
  if (category === 'daily' && lastUse?.date === yesterday &&
      Array.isArray(lastUse.covered) && lastUse.covered.length > 0) {
    return _moltAckPayload(lastUse, date);
  }
  return _payloadFor(category, date);
}

// 8pm streak rescue: the at-risk warning, suppressed (replaced by a soft
// covered-nudge) when a banked molt day means skipping tonight is safe.
export function streakDecision({ prefs, dailyStreak, lastDailyDate, moltDay, date }) {
  if (!prefs || !prefs.enabled) return null;
  if (prefs.streakWarning === false) return null;
  const streak = dailyStreak || 0;
  if (streak < 3) return null;
  const lastDate = lastDailyDate || '';
  if (lastDate >= date) return null; // already played today
  const banked = moltDay?.banked || 0;
  if (coversTonight({ lastDailyDate: lastDate, banked, today: date })) {
    return _coveredPayload(date);
  }
  return _streakPayload(streak, date);
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
    if (DRY_RUN) {
      console.log(`  [${label}] would send → uid=${uid}: "${payload.title}" — ${payload.body} (tag=${payload.tag})`);
      sent++;
      continue;
    }
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

async function main() {
  // A dry-run reading from a fixture needs no credentials or network.
  const needSecret = !(DRY_RUN && FIXTURE);
  let serviceAccount = null;
  if (needSecret) {
    const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!saJson) {
      console.error('FIREBASE_SERVICE_ACCOUNT env var not set — cannot mint access token');
      process.exit(1);
    }
    try { serviceAccount = JSON.parse(saJson); }
    catch (err) {
      console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON:', err.message);
      process.exit(1);
    }
  }

  let { date, hour, dow } = _etDateParts();
  if (DRY_RUN && DATE_OVERRIDE) { date = DATE_OVERRIDE; dow = _dowFromDate(date); }
  if (DRY_RUN && HOUR_OVERRIDE != null) hour = parseInt(HOUR_OVERRIDE, 10);
  const category = _categoryFor({ date, dow });
  const yesterday = _shiftDate(date, -1);

  console.log(`[${date} ${String(hour).padStart(2, '0')}:00 ET] category=${category}${DRY_RUN ? ' (DRY RUN)' : ''}`);

  const accessToken = needSecret ? await getAccessToken(serviceAccount) : 'dry-run';
  const users = FIXTURE ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : await fetchAllUsers(accessToken);

  // ── Reminder pass: hourLocal-matched daily/weekly push ─────
  const r = await _sendPass(accessToken, users, {
    label: 'reminder',
    perUserPayload: (uid, userData) => reminderDecision({
      prefs: userData?.notificationPrefs,
      category, hour,
      moltDay: userData?.moltDay,
      date, yesterday,
    }),
  });

  // ── Streak-warning pass: 8pm ET evening rescue ─────────────
  let s = { matched: 0, sent: 0, failed: 0 };
  if (hour === STREAK_WARNING_HOUR) {
    s = await _sendPass(accessToken, users, {
      label: 'streak-warning',
      perUserPayload: (uid, userData) => streakDecision({
        prefs: userData?.notificationPrefs,
        dailyStreak: userData?.dailyStreak,
        lastDailyDate: userData?.lastDailyDate,
        moltDay: userData?.moltDay,
        date,
      }),
    });
  }

  console.log(`Done: reminder matched=${r.matched} sent=${r.sent} failed=${r.failed}; streak matched=${s.matched} sent=${s.sent} failed=${s.failed}`);
}

// Run only when invoked directly (so test/sendPushMolt.test.mjs can import the
// pure decision helpers without the IIFE firing and exiting).
const _isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (_isMain) {
  main().catch(err => {
    console.error('send-push failed:', err.message);
    process.exit(1);
  });
}
