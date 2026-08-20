// Stamp the `scrolled` flag on score rows written before the client logged it.
//
// HIS RULING, 2026-08-20: "any board larger than one screen that isn't a daily
// should be marked scrolling", and "no one is using the larger screen size
// yet". The second half is what makes this safe to do at all. `scrolled` is a
// statement about the board AS PLAYED, and a fit-legal board scrolls whenever
// the player has raised their own cell-size preference — so normally absence
// cannot be read as false. With nobody on a raised size, it can: every
// existing row is honestly true or honestly false, decided by the board alone.
//
// WHAT IT DOES NOT DO: derive anything from `features.rows`/`cols`. On a
// lattice those are the storage CONTAINER, an arbitrary factorization of the
// cell count rather than the shape on screen, and reading them as geometry is
// the exact proxy that caused the original bug (his standing ruling). Instead:
//
//   - MATCH rows (`match_<hex>`) key off the board's own SEED, and the match
//     library stores `oversized` per board as a FACT recorded when the board
//     was built. That is the grounded answer, so this joins to it.
//   - DAILY and WEEKLY rows are false by construction: since clampRectDims
//     (2026-08-20) neither can scroll at the default cell size, and the draw
//     ranges are swept against the fit rules in test/boardFit.test.mjs.
//
// A match row whose seed is NOT found in the library is left ALONE, never
// guessed at. The library is append-only and boards are never removed, only
// tombstoned, so a miss means something this script does not understand.
//
//   node backfill-scrolled-flag.mjs --dry-run     (default; prints the plan)
//   node backfill-scrolled-flag.mjs --write       (needs FIREBASE_SERVICE_ACCOUNT)
//
// Writes to PLAYED HISTORY, so it is dry-run by default and reports every row
// it would touch before touching any.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, 'data', 'match-library');
const DB = process.env.REFIT_DB_URL
  || 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';
const WRITE = process.argv.includes('--write');

// ── The one grounded lookup: seed -> was this board oversized? ──────────
// Built from the index shards, which carry `oversized` as element 8 of each
// row (appended only when true, so absent means false — exact for any
// self-consistent index). The `mxo-` class is the oversized lane; `mx-` is
// the fit-legal one. Reading both means a seed found in either is answered
// from a stored fact rather than from its file's name.
function buildSeedIndex() {
  const bySeed = new Map();
  let shards = 0;
  for (const f of readdirSync(LIB)) {
    if (!/^mxo?-/.test(f)) continue;
    let j;
    try { j = JSON.parse(readFileSync(join(LIB, f), 'utf8')); } catch { continue; }
    shards++;
    for (const r of (j.rows || [])) {
      // Row shape: [page, idx, shape, cells, mines, par, mods, features, oversized?]
      const page = r[0], idx = r[1];
      const oversized = r[8] === 1 || r[8] === true;
      bySeed.set(`${page}:${idx}`, oversized);
    }
  }
  return { bySeed, shards };
}

// The page files hold the seeds; the index rows hold `oversized`. Join them
// on page:idx, which is stable because eviction tombstones a slot rather than
// compacting it (every survivor keeps its own index).
function seedsToOversized(bySeed) {
  const out = new Map();
  for (const f of readdirSync(LIB)) {
    const m = /^match-(\d+)\.json$/.exec(f);
    if (!m) continue;
    const page = Number(m[1]);
    let rows;
    try { rows = JSON.parse(readFileSync(join(LIB, f), 'utf8')); } catch { continue; }
    const list = Array.isArray(rows) ? rows : (rows.boards || []);
    list.forEach((b, idx) => {
      if (!b || b.evicted || !b.seed) return;
      const flag = bySeed.get(`${page}:${idx}`);
      if (flag !== undefined) out.set(b.seed, flag);
    });
  }
  return out;
}

// A match row's KEY is matchRowKey(seed), a hash, so the seed itself is not on
// the row and the join has to run FORWARD: hash every library seed and match
// on the key. Going the other way (reading a seed off the row) silently
// resolves nothing, which the first dry run showed as 417 unresolved rows.
const { matchRowKey } = await import('../src/logic/matchCodes.js');

const j = async (path, q = '') => (await fetch(`${DB}/${path}.json${q}`)).json();

const { bySeed, shards } = buildSeedIndex();
const oversizedBySeed = seedsToOversized(bySeed);
const oversizedByRowKey = new Map();
for (const [seed, flag] of oversizedBySeed) oversizedByRowKey.set(matchRowKey(seed), flag);
console.log(`library: ${shards} index shard(s), ${oversizedBySeed.size} seed(s) -> `
  + `${oversizedByRowKey.size} row key(s)`);

const dateKeys = Object.keys(await j('daily', '?shallow=true') || {});
const plan = [];
let already = 0, unresolved = 0;

for (const key of dateKeys) {
  const isMatch = key.startsWith('match_');
  const rows = await j(`daily/${key}`);
  if (!rows) continue;
  for (const [pushId, row] of Object.entries(rows)) {
    if (!row || typeof row.time !== 'number') continue;
    if (typeof row.scrolled === 'boolean') { already++; continue; }
    let value;
    if (!isMatch) {
      // Dailies and weeklies cannot scroll at the default cell size.
      value = false;
    } else {
      // A match row's seed is its board's identity. `rngSeed` is omitted when
      // it equals the date key, which never happens for a match_ key.
      if (!oversizedByRowKey.has(key)) { unresolved++; continue; }
      value = oversizedByRowKey.get(key) === true;
    }
    plan.push({ path: `daily/${key}/${pushId}/scrolled`, value, key });
  }
}

const trues = plan.filter((p) => p.value).length;
console.log(`\nrows already carrying the flag: ${already}`);
console.log(`rows this would stamp: ${plan.length}  (${trues} scrolling, ${plan.length - trues} not)`);
if (unresolved > 0) {
  console.log(`rows LEFT ALONE because their seed is not in the library: ${unresolved}`);
}
for (const p of plan.filter((x) => x.value)) console.log(`  scrolling: ${p.path}`);

if (!WRITE) {
  console.log('\ndry run; pass --write (with FIREBASE_SERVICE_ACCOUNT) to apply');
  process.exit(0);
}

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('--write needs FIREBASE_SERVICE_ACCOUNT; refusing to touch played history');
  process.exit(1);
}
// The same auth path every service-account writer here uses.
const { tokenFromEnv } = await import('./service-account-auth.mjs');
const token = await tokenFromEnv();
let wrote = 0;
for (const p of plan) {
  const res = await fetch(`${DB}/${p.path}.json?access_token=${token}`, {
    method: 'PUT', body: JSON.stringify(p.value),
  });
  if (!res.ok) { console.error(`FAILED ${p.path}: ${res.status}`); continue; }
  wrote++;
}
console.log(`wrote ${wrote} of ${plan.length}`);
