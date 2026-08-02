// ── Par Lab row sync (test-only surface, PRODUCTION data path) ───────────
//
// Pushes lab result rows to the world-readable `parLab/` node so the
// offline prior-seeding analysis can FETCH them (one GET of
// /parLab.json, filtered to Christopher's uid) instead of waiting on a
// manual export. Append-only, uid-stamped, server-timestamped — the same
// posture as the `timed/` score rows the rules block is modeled on.
//
// THIS WRITER IS DELIBERATELY NOT isTestEnvironment()-GATED, and that is
// the point, not an oversight: the Par Lab only EXISTS in test builds, so
// a test-env gate would make the whole path dead code. The gate exists to
// keep test sessions from polluting production datasets; these rows ARE
// the dataset — deliberately collected lab data with its own node, its own
// rules, and no consumer inside the game. Every other write in a test
// session stays gated exactly as before.
//
// Failure posture: quiet null. No auth session (a fresh e2e context never
// mints one — the 2026-07-06 contract), Firebase down, or rules not yet
// deployed (this block ships with the PR; rules deploy from main) all
// leave the row in the localStorage outbox, and parLabUI re-flushes
// unsynced rows on every lab entry and result. Duplicate pushes after an
// interrupted mark-synced write are possible and harmless — rows carry
// (uid, id, attempt), so the analysis dedupes on read.

import { waitForFirebaseReady } from './waitForFirebase.js';
import { getUid } from './firebaseProgress.js';

/**
 * Push one lab row. Returns the new push key, or null when the row could
 * not land (caller keeps it queued locally).
 *
 * @param {Object} row a buildParLabRow result (local bookkeeping fields
 *   like fbKey must be stripped by the caller)
 * @returns {Promise<string|null>}
 */
export async function pushParLabRow(row) {
  const uid = getUid();
  if (!uid || !row || typeof row !== 'object') return null;
  let db;
  try {
    db = await waitForFirebaseReady();
  } catch { return null; }
  try {
    const payload = { ...row, uid, timestamp: firebase.database.ServerValue.TIMESTAMP };
    // Firebase drops empty containers (the #143 lesson) — omit them so the
    // written payload is honest about what lands, and omit absent optionals
    // so the rules whitelist stays tight.
    if (!Array.isArray(payload.gimmicks) || payload.gimmicks.length === 0) delete payload.gimmicks;
    if (!Array.isArray(payload.wormEvents) || payload.wormEvents.length === 0) delete payload.wormEvents;
    if (!payload.features) delete payload.features;
    if (!payload.par) delete payload.par;
    const ref = await db.ref('parLab').push(payload);
    return ref.key || null;
  } catch {
    return null;
  }
}
