// Backfill stored "Start here" anchors onto ALREADY-WRITTEN future
// canonicals (his 2026-08-17 ruling: "This should definitely not be
// client-side ever").
//
// Boards precompute up to PREFETCH_DAILY_DAYS ahead, so on the day the
// stored-anchor pipeline ships, the horizon is full of canonicals that
// predate the field; without this, players spend up to a week on the
// legacy client-side search the ruling retired. This tool is BYTE
// PRESERVING where it matters: the board itself is untouched (no
// re-draw, no regeneration, so a measured or previewed date's bytes
// cannot shift), `writtenAt` is carried verbatim (the trust policy
// reads it), and the only changes are the added `bestStart` and the
// re-signed `sig`, which excludes both `sig` and `writtenAt` by the
// signing contract in canonicalSignature.js.
//
// Scope: dailyBoard dates from TOMORROW (ET) through the prefetch
// horizon, and NEXT week's weeklyBoard only (usually absent until the
// Monday precompute, which then stores the anchor itself). Never today,
// never the current week, never the past: a live board's marker must not
// move under anyone mid-play, and past boards are history.
//
//   node scripts/backfill-start-anchors.mjs [--dry-run]
//
// Requires FIREBASE_SERVICE_ACCOUNT (rules bypass: the stored writtenAt
// number would fail the client-facing `=== now` validation) and
// CANONICAL_SIGNING_KEY (the re-sign).

import { deserializeBoard } from '../src/firebase/dailyBoardSync.js';
import { chooseStartAnchor } from '../src/logic/startAnchor.js';
import { signCanonicalPayload, requireSigningKey } from '../src/logic/canonicalSignature.js';
import { PREFETCH_DAILY_DAYS, addDays } from '../src/firebase/boardCache.js';
import { createSign } from 'node:crypto';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';
const DRY = process.argv.includes('--dry-run');

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
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
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!r.ok) throw new Error(`token mint failed: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

function todayET() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

// The Monday of the ET week containing the given date string.
function weekStartOf(dateString) {
  const d = new Date(`${dateString}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

async function fetchNode(token, path) {
  const r = await fetch(`${DB_BASE}/${path}.json?access_token=${encodeURIComponent(token)}`);
  if (!r.ok) throw new Error(`read ${path} failed: ${r.status}`);
  return r.json();
}

async function writeNode(token, path, payload) {
  const r = await fetch(`${DB_BASE}/${path}.json?access_token=${encodeURIComponent(token)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`write ${path} failed: ${r.status} ${await r.text()}`);
}

async function backfillOne(token, path, signingKey) {
  const payload = await fetchNode(token, path);
  if (!payload) return 'absent';
  if (Number.isInteger(payload.bestStart)) return 'already-stored';
  const { board, rows, cols } = deserializeBoard(payload);
  const anchor = chooseStartAnchor(board, rows, cols);
  if (!anchor) return 'NO-CERTIFYING-ANCHOR';
  payload.bestStart = anchor.r * cols + anchor.c;
  // Re-sign over the payload minus sig/writtenAt (the signing surface);
  // the stored writtenAt number rides through the write verbatim.
  payload.sig = await signCanonicalPayload(payload, signingKey);
  if (!DRY) await writeNode(token, path, payload);
  return `anchored (${anchor.r},${anchor.c})${DRY ? ' [dry]' : ''}`;
}

(async () => {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || 'null');
  if (!serviceAccount) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  const signingKey = requireSigningKey();
  const token = await getAccessToken(serviceAccount);

  const today = todayET();
  const paths = [];
  for (let i = 1; i <= PREFETCH_DAILY_DAYS; i++) {
    paths.push(`dailyBoard/${addDays(today, i)}`);
  }
  // The current week is LIVE all week (the same reason today's daily is
  // skipped); only the next week's board, when the Monday precompute has
  // not yet claimed it, is safely pre-anchored here.
  const thisWeek = weekStartOf(today);
  paths.push(`weeklyBoard/${addDays(thisWeek, 7)}`);

  let failures = 0;
  for (const p of paths) {
    try {
      const verdict = await backfillOne(token, p, signingKey);
      console.log(`${p}: ${verdict}`);
      if (verdict === 'NO-CERTIFYING-ANCHOR') failures++;
    } catch (err) {
      console.error(`${p}: FAILED ${err.message}`);
      failures++;
    }
  }
  if (failures > 0) {
    console.error(`${failures} node(s) failed; the client legacy fallback covers them until re-run.`);
    process.exit(1);
  }
})();
