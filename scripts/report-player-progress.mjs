// Read-only report: who plays, and how far they have actually got.
//
// `users/{uid}` is owner-read (`auth.uid === $uid`), so challenge progression,
// streaks and the molt bank are invisible to every tool that is not holding
// the service account — including a browser, including the app itself looking
// at anyone but you. This is the only way to see the distribution.
//
// WRITES NOTHING. It issues GETs and prints a table.
//
// THE UID COUNT IS NOT THE PLAYER COUNT, and that is the first thing this
// report exists to separate. Every visitor gets an anonymous auth session on
// boot and a `users/{uid}/lastSeen` beacon lands shortly after, so the `users`
// node accumulates a node per BROWSER that ever opened the site — most of them
// carrying nothing else. On top of that one human can hold several uids
// (per-device anonymous sessions before account linking; the 2026-07-07 merge
// pass consolidated anemone-guy ×3, MJP+Stickleback and Hieronymus Bosch ×2,
// and more have accrued since). So the report buckets every uid as PLAYER
// (has real progression) or VISITOR (a node with nothing but a heartbeat), and
// only the players are listed.
//
// Names come from the same join-at-read the leaderboard modal uses: the
// `playerNames` node first, then any name on that uid's own leaderboard rows.
//
// DELIBERATELY NOT PRINTED: `pushSubscription` (an FCM token is a credential),
// and nothing from the Auth records at all — the token this mints carries
// database scope only, so it cannot read them even if asked.
//
// Usage:
//   node scripts/report-player-progress.mjs                 # players only
//   node scripts/report-player-progress.mjs --all           # + visitor uids
//   node scripts/report-player-progress.mjs --json          # machine-readable
//   node scripts/report-player-progress.mjs --limit 50

import { tokenFromEnv } from './service-account-auth.mjs';
import { CHALLENGE_250_EPOCH } from '../src/logic/challenge250.js';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';
const args = process.argv.slice(2);
const SHOW_ALL = args.includes('--all');
const AS_JSON = args.includes('--json');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 ? Math.max(1, Number(args[i + 1]) || 0) : Infinity;
})();
// Offline debug: render the whole report from a JSON file instead of Firebase
// (see main). Mirrors send-push.mjs's --fixture.
const FIXTURE = (() => {
  const i = args.indexOf('--fixture');
  return i >= 0 ? args[i + 1] : null;
})();

/** Read one RTDB path. The token is only needed for the owner-scoped nodes. */
const get = async (path, token) => {
  const url = new URL(`${DB_BASE}/${path}`);
  if (token) url.searchParams.set('access_token', token);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${path} failed: ${r.status} ${await r.text()}`);
  return r.json();
};

/** Best display name for a uid, by the leaderboard's own join-at-read order. */
export function resolveName(uid, playerNames, rowNames) {
  const pn = playerNames?.[uid];
  const fromNode = typeof pn === 'string' ? pn : (pn && typeof pn === 'object' ? pn.name : null);
  if (fromNode) return fromNode;
  const seen = rowNames.get(uid);
  if (seen && seen.size) return [...seen].sort()[0];
  return '(unnamed)';
}

/**
 * Split a users/{uid} record into the numbers worth reporting.
 *
 * The challenge position is read from the epoch-gated `challenge250` node,
 * which is where post-reset progression lives; the legacy top-level
 * `maxCheckpoint` is reported ALONGSIDE it rather than merged, because the two
 * describe different ladders. The old one is capped at 120 by its own rule
 * (the pre-C250 ladder's length) and no current client reads it — see the
 * Challenge 250 section of CLAUDE.md.
 */
export function summarize(uid, rec) {
  const c250 = rec?.challenge250;
  const epochOk = c250 && c250.epoch === CHALLENGE_250_EPOCH;
  const history = rec?.dailyHistory && typeof rec.dailyHistory === 'object'
    ? Object.keys(rec.dailyHistory) : [];
  const weeks = rec?.weeklyAttempts && typeof rec.weeklyAttempts === 'object'
    ? Object.keys(rec.weeklyAttempts) : [];
  const ws = rec?.weekStreak || {};
  return {
    uid,
    ladder: epochOk && typeof c250.maxCheckpoint === 'number' ? c250.maxCheckpoint : null,
    ladderEpoch: c250?.epoch ?? null,
    legacyMax: typeof rec?.maxCheckpoint === 'number' ? rec.maxCheckpoint : null,
    dailyStreak: rec?.dailyStreak ?? 0,
    bestDailyStreak: rec?.bestDailyStreak ?? 0,
    lastDailyDate: rec?.lastDailyDate ?? null,
    molt: rec?.moltDay?.banked ?? 0,
    weekStreak: ws.streak ?? 0,
    bestWeekStreak: ws.best ?? 0,
    lastWeek: ws.lastWeek ?? null,
    dailiesRecorded: history.length,
    weeksAttempted: weeks.length,
    lastSeen: rec?.lastSeen ?? null,
  };
}

/** A uid is a PLAYER when it carries progression, not merely a heartbeat. */
export function isPlayer(s) {
  return (s.ladder != null && s.ladder > 1)
    || s.legacyMax != null
    || s.dailiesRecorded > 0
    || s.weeksAttempted > 0
    || s.bestDailyStreak > 0
    || s.bestWeekStreak > 0;
}

const pad = (v, w, right = false) => {
  const s = v == null ? '-' : String(v);
  return right ? s.padStart(w) : s.padEnd(w);
};

export async function main() {
  let users, playerNames, daily, weekly, timed;

  if (FIXTURE) {
    // Offline rendering path, the send-push.mjs idiom: exercise the whole
    // report against a JSON file of the same shape, with no credentials and no
    // network. This is how the table gets checked without spending an Actions
    // run on it.
    const { readFileSync } = await import('node:fs');
    ({ users, playerNames, daily, weekly, timed } = {
      playerNames: {}, daily: {}, weekly: {}, timed: {},
      ...JSON.parse(readFileSync(FIXTURE, 'utf8')),
    });
  } else {
    const token = await tokenFromEnv();
    // One read of the whole node. It carries every uid's dailyHistory, which is
    // the bulk of it, but those rows are two fields each — cheap at this scale.
    // If the node ever outgrows a single read, switch to a shallow uid list plus
    // per-uid field reads; the shape below does not change.
    [users, playerNames, daily, weekly, timed] = await Promise.all([
      get('users.json', token),
      get('playerNames.json'),
      get('daily.json'),
      get('weekly.json'),
      get('timed.json'),
    ]);
  }

  // Names seen on public leaderboard rows, as the fallback join.
  const rowNames = new Map();
  const note = (uid, name) => {
    if (!uid || !name) return;
    if (!rowNames.has(uid)) rowNames.set(uid, new Set());
    rowNames.get(uid).add(name);
  };
  for (const rows of Object.values(daily || {})) {
    for (const r of Object.values(rows || {})) if (r && typeof r === 'object') note(r.uid, r.name);
  }
  for (const rows of Object.values(weekly || {})) {
    for (const [uid, r] of Object.entries(rows || {})) if (r && typeof r === 'object') note(uid, r.name);
  }
  for (const r of Object.values(timed || {})) if (r && typeof r === 'object') note(r.uid, r.name);

  const all = Object.entries(users || {}).map(([uid, rec]) => summarize(uid, rec));
  const players = all.filter(isPlayer);
  const visitors = all.length - players.length;

  // Ladder position first — that is the question this report was asked. Ties
  // fall back to how much they have actually played.
  players.sort((a, b) => (b.ladder ?? -1) - (a.ladder ?? -1)
    || (b.legacyMax ?? -1) - (a.legacyMax ?? -1)
    || b.dailiesRecorded - a.dailiesRecorded);

  const named = players.map((s) => ({ ...s, name: resolveName(s.uid, playerNames, rowNames) }));

  if (AS_JSON) {
    console.log(JSON.stringify({
      generatedFor: 'challenge250 epoch ' + CHALLENGE_250_EPOCH,
      uidsTotal: all.length,
      players: named.length,
      visitorUids: visitors,
      rows: named.slice(0, LIMIT),
    }, null, 2));
    return;
  }

  console.log(`\n${all.length} uid node(s) under users/ — ${named.length} player(s), `
    + `${visitors} visitor-only uid(s) (a browser that opened the site and left a heartbeat).`);
  console.log('One human can hold several uids: per-device anonymous sessions predate account linking.\n');

  const H = ['player', 'uid', 'ladder', 'legacy', 'dailies', 'D-streak', 'best', 'molt', 'weeks', 'W-streak', 'best', 'last daily'];
  const W = [20, 10, 7, 7, 8, 9, 6, 5, 6, 9, 6, 12];
  console.log(H.map((h, i) => pad(h, W[i], i >= 2 && i < 11)).join(' '));
  console.log(W.map((w) => '-'.repeat(w)).join(' '));
  for (const s of named.slice(0, LIMIT)) {
    console.log([
      pad(s.name.slice(0, 19), W[0]),
      pad(s.uid.slice(0, 9), W[1]),
      pad(s.ladder, W[2], true),
      pad(s.legacyMax, W[3], true),
      pad(s.dailiesRecorded, W[4], true),
      pad(s.dailyStreak, W[5], true),
      pad(s.bestDailyStreak, W[6], true),
      pad(s.molt, W[7], true),
      pad(s.weeksAttempted, W[8], true),
      pad(s.weekStreak, W[9], true),
      pad(s.bestWeekStreak, W[10], true),
      pad(s.lastDailyDate, W[11]),
    ].join(' '));
  }

  // The distribution the report was actually asked for.
  const onLadder = named.filter((s) => s.ladder != null);
  console.log('\nChallenge ladder (challenge250, epoch ' + CHALLENGE_250_EPOCH + '):');
  if (!onLadder.length) {
    console.log('  nobody has banked a checkpoint on the new ladder yet — the epoch reset');
    console.log('  wiped every position, and the node is only written when a checkpoint advances.');
  } else {
    const vals = onLadder.map((s) => s.ladder).sort((a, b) => a - b);
    const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * (vals.length - 1)))];
    console.log(`  n=${vals.length}  min ${vals[0]}  median ${q(0.5)}  max ${vals.at(-1)}`);
    for (const s of onLadder) console.log(`  ${s.name.padEnd(20)} L${s.ladder}`);
  }

  const legacy = named.filter((s) => s.legacyMax != null);
  if (legacy.length) {
    console.log('\nPRE-RESET history (legacy maxCheckpoint, the retired 120-level ladder —');
    console.log('no current client reads this; it is here so the two are never confused):');
    for (const s of legacy) console.log(`  ${s.name.padEnd(20)} L${s.legacyMax}`);
  }

  if (SHOW_ALL && visitors) {
    console.log(`\nVisitor-only uids (${visitors}) — a node with no progression on it:`);
    for (const s of all.filter((x) => !isPlayer(x)).slice(0, LIMIT)) {
      console.log(`  ${s.uid}  lastSeen ${s.lastSeen ?? '-'}`);
    }
  }
  console.log('');
}

// Guarded like send-push.mjs's: importing this module (the tests do, to reach
// the pure classifiers above) must not fire a live Firebase read.
// endsWith on the raw path needs no separator normalization: the filename is
// the same on both platforms, only what precedes it differs.
const invokedDirectly = !!process.argv[1]
  && process.argv[1].endsWith('report-player-progress.mjs');
if (invokedDirectly) {
  main().catch((err) => {
    console.error('report failed:', err.message);
    process.exit(1);
  });
}
