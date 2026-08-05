// Service-account auth for the admin scripts — the counterpart to
// anon-auth-rest.mjs, which does the same job for the anonymous-auth scripts.
//
// Mints a Google OAuth access token from the FIREBASE_SERVICE_ACCOUNT secret
// (a one-line JSON blob in the repo's Actions secrets). That token bypasses
// the database rules, which is the ONLY way to read an owner-scoped path like
// `users/{uid}` or to write a write-once canonical.
//
// Extracted 2026-08-05 because eighteen scripts already carry a hand-rolled
// copy of this mint and the nineteenth was about to be written. The existing
// eighteen are deliberately NOT migrated here — that is a separate sweep, and
// rewriting the auth of every admin tool in passing is how a reporting script
// turns into an outage. New scripts should import this one.

import { createSign } from 'node:crypto';

// firebase.database for the RTDB REST reads/writes, userinfo.email because the
// token exchange requires an identity claim. Scripts that also touch the Auth
// admin endpoints (batchGet/batchDelete) need identitytoolkit as well and pass
// it explicitly — this default is the database-only set, so a reporting script
// cannot accidentally hold delete rights over user accounts.
export const DB_SCOPES = [
  'https://www.googleapis.com/auth/firebase.database',
  'https://www.googleapis.com/auth/userinfo.email',
];

export const AUTH_ADMIN_SCOPE = 'https://www.googleapis.com/auth/identitytoolkit';

/**
 * Mint an access token for a parsed service-account object.
 *
 * @param {object} serviceAccount parsed FIREBASE_SERVICE_ACCOUNT JSON
 * @param {string[]} [scopes] defaults to database-only (see DB_SCOPES)
 * @returns {Promise<string>}
 */
export async function getAccessToken(serviceAccount, scopes = DB_SCOPES) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: serviceAccount.client_email,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  const jwt = `${unsigned}.${signer.sign(serviceAccount.private_key, 'base64url')}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`token mint failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

/**
 * Read the service account out of the environment and mint a token in one
 * step. Throws with a usable message when the secret is missing, which is the
 * failure every one of these scripts hits first when run locally.
 */
export async function tokenFromEnv(scopes = DB_SCOPES) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT not set — this script only runs in Actions '
      + '(the service account is a repo secret, not a local file)');
  }
  return getAccessToken(JSON.parse(raw), scopes);
}
