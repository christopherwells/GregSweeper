// Reset a week's weekly SCORES without touching the puzzle.
//
// Unlike regenerate-weekly-board.mjs (which also nukes + rebuilds the
// canonical board), this keeps weeklyBoard/{weekStart} intact — every
// player keeps playing the SAME puzzle they've been on all week — and
// only clears:
//   - weekly/{weekStart}                       (the leaderboard)
//   - daily/{weekStart}_weekly_first           (par-model fit data)
//   - dailyMeta/{weekStart}_weekly_first       (its feature vector)
//   - users/{uid}/weeklyAttempts/{weekStart}   (one-per-day caps)
//
// Use when the GAMEPLAY changed mid-week (e.g. the bomb-hit mechanic
// fix) and earlier scores were set under broken rules — everyone gets
// a fair shot at the same board with the corrected mechanic. Clearing
// the synthetic-daily fit records also keeps the par model from
// learning off the broken-mechanic completion times.
//
// Service-account auth required (same FIREBASE_SERVICE_ACCOUNT secret
// as send-push.mjs / regenerate-weekly-board.mjs) — the per-user
// weeklyAttempts paths are owner-write-only under the security rules,
// so only the service account can clear them across all users.
//
// Triggered via GH Actions workflow_dispatch:
//   gh workflow run reset-weekly-scores.yml -f weekStart=2026-05-11

import { createSign } from 'node:crypto';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';

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

async function adminDelete(accessToken, path) {
  const url = `${DB_BASE}/${path}.json?access_token=${encodeURIComponent(accessToken)}`;
  const r = await fetch(url, { method: 'DELETE' });
  if (!r.ok && r.status !== 404) {
    throw new Error(`delete ${path} failed: ${r.status} ${await r.text()}`);
  }
  return r.ok;
}

(async () => {
  const weekStart = process.argv[2];
  if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    console.error('usage: node scripts/reset-weekly-scores.mjs YYYY-MM-DD');
    process.exit(1);
  }
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saJson) {
    console.error('FIREBASE_SERVICE_ACCOUNT env not set — cannot clear owner-write paths');
    process.exit(1);
  }
  const sa = JSON.parse(saJson);
  const accessToken = await getAccessToken(sa);

  console.log(`Resetting weekly SCORES for ${weekStart} (board left intact)`);

  console.log(`  clearing weekly/${weekStart} (leaderboard)`);
  await adminDelete(accessToken, `weekly/${weekStart}`);

  console.log(`  clearing daily/${weekStart}_weekly_first + dailyMeta/${weekStart}_weekly_first (par-fit data)`);
  await adminDelete(accessToken, `daily/${weekStart}_weekly_first`);
  await adminDelete(accessToken, `dailyMeta/${weekStart}_weekly_first`);

  console.log(`  clearing per-user weeklyAttempts/${weekStart} for all users…`);
  const usersResp = await fetch(`${DB_BASE}/users.json?access_token=${encodeURIComponent(accessToken)}&shallow=true`);
  if (usersResp.ok) {
    const uids = Object.keys((await usersResp.json()) || {});
    let cleared = 0;
    for (const uid of uids) {
      await adminDelete(accessToken, `users/${uid}/weeklyAttempts/${weekStart}`);
      cleared++;
    }
    console.log(`    cleared for ${cleared} users`);
  } else {
    console.warn('    users tree fetch failed, attempt markers may linger');
  }

  // Sanity: confirm the board is still there (we must NOT have touched it).
  const boardResp = await fetch(`${DB_BASE}/weeklyBoard/${weekStart}.json?access_token=${encodeURIComponent(accessToken)}&shallow=true`);
  const boardStillThere = boardResp.ok && (await boardResp.json()) !== null;
  console.log(`  weeklyBoard/${weekStart} intact: ${boardStillThere ? 'YES (good)' : 'NO — investigate!'}`);

  console.log('Done. Same puzzle, fresh scoreboard, everyone can replay.');
})().catch(err => {
  console.error('reset-weekly-scores failed:', err.message);
  process.exit(1);
});
