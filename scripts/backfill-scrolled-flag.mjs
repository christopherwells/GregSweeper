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

// THE SECOND SHELF. A match can also deal a HARVESTED Climb board, whose seed
// lives in the Climb library's index rather than the match library's, which is
// why the first pass left 53 rows unresolved. Those are all fit-legal, and by
// a TESTED contract rather than an assumption: the harvest's file scan is
// blind to the oversized page class (`endless-over-*`) on purpose, so that a
// harvested oversized board can never deal to a Challenge host who did not opt
// into scrolling. test/matchHarvest.test.mjs pins that boundary.
//
// The guard below re-proves it here rather than trusting it. If a harvest row
// ever DOES come off an oversized page the contract has broken, and this
// script must refuse to mark anything false rather than quietly file a
// scrolling board as flat.
function harvestRowKeys() {
  const dir = join(HERE, 'data', 'climb-library');
  const keys = new Set();
  let scanned = 0, oversized = 0;
  for (const f of readdirSync(dir)) {
    if (!/^cmx-/.test(f)) continue;
    let j;
    try { j = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    for (const r of (j.rows || [])) {
      // Row shape: [file, index, shape, cells, mines, par, mods, SEED, features]
      const file = String(r[0] || '');
      const seed = r[7];
      if (!seed) continue;
      scanned++;
      if (/^endless-over-/.test(file)) oversized++;
      keys.add(matchRowKey(seed));
    }
  }
  if (oversized > 0) {
    throw new Error(
      `${oversized} harvest row(s) come from an oversized page; the harvest is `
      + 'supposed to exclude that class entirely (test/matchHarvest.test.mjs). '
      + 'Refusing to mark harvested rows as not-scrolling until that is understood.');
  }
  return { keys, scanned };
}

// A match row's KEY is matchRowKey(seed), a hash, so the seed itself is not on
// the row and the join has to run FORWARD: hash every library seed and match
// on the key. Going the other way (reading a seed off the row) silently
// resolves nothing, which the first dry run showed as 417 unresolved rows.
const { matchRowKey } = await import('../src/logic/matchCodes.js');
const { fitCeilingCells } = await import('../src/logic/marathonFit.js');

// True when the board is too SMALL to be oversized under any dimensions.
// Returns false when the shape or the cell count cannot be read, so an
// unreadable row is left alone rather than assumed flat.
function belowFitCeiling(meta) {
  const f = meta && meta.features;
  if (!f) return false;
  const cells = Number(f.cellCount) || (Number(f.rows) * Number(f.cols)) || 0;
  if (!(cells > 0)) return false;
  const shape = f.tilingType ? String(f.tilingType) : 'rect';
  let ceiling = 0;
  try { ceiling = fitCeilingCells(shape); } catch { return false; }
  return ceiling > 0 && cells <= ceiling;
}

const j = async (path, q = '') => (await fetch(`${DB}/${path}.json${q}`)).json();

const { bySeed, shards } = buildSeedIndex();
const oversizedBySeed = seedsToOversized(bySeed);
const oversizedByRowKey = new Map();
for (const [seed, flag] of oversizedBySeed) oversizedByRowKey.set(matchRowKey(seed), flag);
const { keys: harvestKeys, scanned: harvestScanned } = harvestRowKeys();
console.log(`library: ${shards} index shard(s), ${oversizedBySeed.size} seed(s) -> `
  + `${oversizedByRowKey.size} row key(s)`);
console.log(`harvest: ${harvestScanned} row(s) -> ${harvestKeys.size} row key(s), `
  + 'all fit-legal by contract');

const dateKeys = Object.keys(await j('daily', '?shallow=true') || {});
const plan = [];
let already = 0, unresolved = 0, harvested = 0, belowCeiling = 0;

for (const key of dateKeys) {
  const isMatch = key.startsWith('match_');
  const rows = await j(`daily/${key}`);
  if (!rows) continue;
  const meta = isMatch ? await j(`dailyMeta/${key}`) : null;
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
      if (oversizedByRowKey.has(key)) {
        value = oversizedByRowKey.get(key) === true;
      } else if (harvestKeys.has(key)) {
        // A harvested Climb board. Fit-legal by the contract re-proved above,
        // so it did not scroll.
        value = false;
        harvested++;
      } else if (belowFitCeiling(meta)) {
        // THE THIRD PATH, and the only one that reasons from the board's own
        // measurements rather than from a stored fact. It is sound in ONE
        // direction only. marathonFits defines an oversized board as LONGER,
        // WIDER or BIGGER than any fit-legal board of its shape, so a board
        // whose total cell count sits below its shape's fit ceiling cannot be
        // oversized under any dimensions at all.
        //
        // This is NOT the proxy the original bug came from. That one read
        // features.rows/cols as geometry, which on a lattice is an arbitrary
        // factorization of the cell count rather than the shape on screen.
        // This reads the CELL COUNT against a per-shape ceiling, which is the
        // same basis inSupportCells uses, and it never claims a board IS
        // oversized: it only rules the possibility out.
        value = false;
        belowCeiling++;
      } else {
        unresolved++;
        continue;
      }
    }
    plan.push({ path: `daily/${key}/${pushId}/scrolled`, value, key });
  }
}

const trues = plan.filter((p) => p.value).length;
console.log(`\nrows already carrying the flag: ${already}`);
console.log(`rows this would stamp: ${plan.length}  (${trues} scrolling, ${plan.length - trues} not)`);
if (belowCeiling > 0) {
  console.log(`rows resolved by SIZE (below their shape's fit ceiling, so they `
    + `cannot be oversized): ${belowCeiling}`);
}
if (harvested > 0) {
  console.log(`rows resolved from the HARVEST (fit-legal Climb boards): ${harvested}`);
}
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
