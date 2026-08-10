// Writing cruxes/{date}, which only a service account may do.
//
// ISSUE #206. `cruxes/{date}` used to grant `auth != null && !data.exists()`
// — anonymous, write-once, world-readable — with NO client writer behind it.
// The repo's own rule for this node family is that the anonymous write-once
// form is granted ONLY where a real first-client fallback writer exists
// (`dailyBoard` has saveDailyBoard, `dailyMeta` has its first-submission
// upsert); `boardHeatmap` was set to `".write": false` for exactly this
// reason and `cruxes` was the one left over, cloned from `dailyMeta`.
//
// What that cost: 56 past dates with a canonical board and no crux were
// claimable by anyone who minted an anonymous session (the app does this on
// boot), permanently — the teaser renders the payload verbatim under the
// GregSweeper masthead on the public share route, and because both legitimate
// writers also authenticated anonymously, neither could ever replace a node
// someone else had taken.
//
// The rules now refuse every client. This module is the one way the two
// legitimate writers reach the node, and it is deliberately NARROW: the
// precompute keeps its anonymous auth for `dailyBoard` and `dailyMeta`, which
// have real fallback writers and must keep working, so a missing or broken
// service account can cost a crux and can never cost a daily board.

import { tokenFromEnv } from './service-account-auth.mjs';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';

/**
 * Mint the token the crux write needs.
 *
 * `required: false` returns null instead of throwing when the secret is
 * absent or the mint fails — the nightly precompute's contract. A date with
 * no crux is an ordinary state (coverage is ~77% by design: breather boards
 * and cruxes too entangled to crop), so degrading to "no teaser tonight" is
 * indistinguishable from a normal day, while throwing would take the day's
 * BOARD down with it.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.required] throw on failure instead of returning null
 * @returns {Promise<string|null>} an OAuth access token
 */
export async function mintCruxToken({ required = true } = {}) {
  try {
    return await tokenFromEnv();
  } catch (err) {
    if (required) throw err;
    console.warn(`  crux: no service-account token (${err.message}) — skipping the teaser`);
    return null;
  }
}

/** Is there already a crux for this date? */
export async function cruxExists(date) {
  const r = await fetch(`${DB_BASE}/cruxes/${date}.json?shallow=true`);
  if (!r.ok) return false;
  return (await r.json()) !== null;
}

/**
 * Write one crux, preserving write-once semantics BY HAND.
 *
 * A service-account token bypasses the database rules, so the write-once
 * guarantee that used to come from `!data.exists()` is gone and has to be
 * re-established here. It matters less than it looks (the same date rebuilds
 * the same crux from the same canonical, so a re-write is a no-op in
 * content), but "the tool that repairs a node cannot silently replace one"
 * is the property both callers were written against, and the regenerate
 * script is the only thing that should ever overwrite — which it does by
 * deleting first.
 *
 * @param {string} date YYYY-MM-DD
 * @param {string|null} token from mintCruxToken; null skips the write
 * @param {object|null} payload from cruxPayloadFromBoard; null skips the write
 * @returns {Promise<'written'|'exists'|'skipped'>}
 */
export async function writeCrux(date, token, payload) {
  if (!payload) return 'skipped';
  if (!token) return 'skipped';
  if (await cruxExists(date)) return 'exists';

  const url = `${DB_BASE}/cruxes/${date}.json?access_token=${encodeURIComponent(token)}`;
  const body = JSON.stringify({ ...payload, writtenAt: { '.sv': 'timestamp' } });
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
  if (!r.ok) throw new Error(`crux write failed: ${r.status} ${await r.text()}`);
  return 'written';
}
