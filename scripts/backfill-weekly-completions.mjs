// Seed `users/{uid}/weeklyCompletions/{weekStart}` from the weekly leaderboard.
//
// The per-week COMPLETION record ships with the win path writing it from
// WEEKLY_COMPLETIONS_EPOCH on, so every week before that has only the
// ATTEMPTS record, which proves a board was opened, never that it was
// finished. For a NAMED player the completion evidence of that era does
// exist: a `weekly/{weekStart}/{uid}` row is written only on a win (the
// rules require `bestTime`, which only a completion produces), so each row
// is a per-player, per-week completion certificate. This walks every stored
// week and writes the record those wins would have written.
//
// WHAT IS NOT RECOVERABLE, stated rather than faked: a player who never set
// a name never reached the leaderboard, so their pre-epoch completions have
// no evidence anywhere. Their weeks stay unrecorded, which fails OPEN
// everywhere the record is read: the Past Weeklies list shows those weeks
// playable (a replay records nothing), and the streak heal keeps its
// deliberately generous pre-epoch attempts derivation.
//
// Idempotent and CLIENT-RECORD-SAFE: an existing entry is SKIPPED, never
// overwritten, because from the epoch on the win path writes real
// first-completion stamps and a re-run must not replace one with a
// backfill stamp. Re-running is the intended way to catch completions made
// on stale clients that predate the record.
//
// Service-account auth (users/* is owner-scoped, so both the existence
// reads and the writes need it). Rows are marked `backfilled: true` so the
// record always says which entries are recovered evidence rather than
// live stamps; both fields are whitelisted in the weeklyCompletions rules
// block, pinned by test/weeklyCompletions.test.mjs.
//
//   node scripts/backfill-weekly-completions.mjs --dry-run
//   FIREBASE_SERVICE_ACCOUNT=<json> node scripts/backfill-weekly-completions.mjs
//
// Dry-run without the secret plans from the leaderboard alone and says so;
// with the secret it also checks which entries already exist.

import { pathToFileURL } from 'node:url';
import { tokenFromEnv } from './service-account-auth.mjs';

export const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';

const isWeekString = (w) => typeof w === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(w);

/**
 * The payload one backfilled entry writes. `.sv` is the REST spelling of the
 * server-timestamp sentinel; `backfilled: true` marks the entry as recovered
 * evidence. The keys here must stay inside the weeklyCompletions rules
 * whitelist (the 866683d silent-drop class), which the test pins.
 */
export function backfillPayload() {
  return { timestamp: { '.sv': 'timestamp' }, backfilled: true };
}

/**
 * Decide what to write. Pure so the test can pin the decisions.
 *
 * @param {object|null} weeklyRoot the whole `weekly/` node: {weekStart: {uid: row}}
 * @param {Map<string, Set<string>>} existingByUid uid -> weeks already recorded
 * @returns {{plan: Array<{weekStart: string, uid: string}>, skippedExisting: number,
 *            skippedMalformed: number}}
 */
export function planWeeklyCompletionBackfill(weeklyRoot, existingByUid = new Map()) {
  const plan = [];
  let skippedExisting = 0;
  let skippedMalformed = 0;
  for (const [weekStart, rows] of Object.entries(weeklyRoot || {})) {
    if (!isWeekString(weekStart) || !rows || typeof rows !== 'object') {
      skippedMalformed++;
      continue;
    }
    for (const [uid, rec] of Object.entries(rows)) {
      // Every rules-valid row proves a completion (bestTime only exists on a
      // win); the finite check refuses a malformed row rather than minting a
      // completion from it.
      if (!Number.isFinite(rec?.bestTime)) { skippedMalformed++; continue; }
      if (existingByUid.get(uid)?.has(weekStart)) { skippedExisting++; continue; }
      plan.push({ weekStart, uid });
    }
  }
  plan.sort((a, b) => a.weekStart.localeCompare(b.weekStart) || a.uid.localeCompare(b.uid));
  return { plan, skippedExisting, skippedMalformed };
}

async function getJson(path, token) {
  const url = `${DB_BASE}/${path}${token ? `?access_token=${encodeURIComponent(token)}` : ''}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`read ${path} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function adminPut(token, path, body) {
  const r = await fetch(`${DB_BASE}/${path}?access_token=${encodeURIComponent(token)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`write ${path} failed: ${r.status} ${await r.text()}`);
}

async function main() {
  const DRY = process.argv.includes('--dry-run');
  const weeklyRoot = await getJson('weekly.json');
  const weeks = Object.keys(weeklyRoot || {}).sort();
  console.log(`${weeks.length} weeks with leaderboard rows${DRY ? ' (DRY RUN)' : ''}`);

  // The existence reads need the token as much as the writes do (users/* is
  // owner-scoped). Without it, a dry run still shows the full candidate set.
  let token = null;
  try {
    token = await tokenFromEnv();
  } catch (err) {
    if (!DRY) throw err;
    console.log(`no credentials (${err.message.split('\n')[0]}); existing entries not checked`);
  }

  const uids = new Set();
  for (const rows of Object.values(weeklyRoot || {})) {
    for (const uid of Object.keys(rows || {})) uids.add(uid);
  }
  const existingByUid = new Map();
  if (token) {
    for (const uid of uids) {
      const node = await getJson(`users/${uid}/weeklyCompletions.json`, token);
      existingByUid.set(uid, new Set(Object.keys(node || {})));
    }
  }

  const { plan, skippedExisting, skippedMalformed } = planWeeklyCompletionBackfill(weeklyRoot, existingByUid);
  console.log(`${plan.length} completion record(s) to write`
    + ` (${skippedExisting} already recorded, ${skippedMalformed} malformed row(s) refused)`);
  for (const p of plan) console.log(`   ${p.weekStart}  ${p.uid}`);

  if (DRY) {
    console.log('DRY RUN, nothing written.');
    return;
  }
  for (const p of plan) {
    await adminPut(token, `users/${p.uid}/weeklyCompletions/${p.weekStart}.json`, backfillPayload());
  }
  console.log(`Wrote ${plan.length} record(s).`);
}

// Guarded so the module imports cleanly for tests (the send-push.mjs idiom).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('backfill failed:', err.message);
    process.exit(1);
  });
}
